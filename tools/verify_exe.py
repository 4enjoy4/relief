"""Launches the built FauxCode.exe and checks that the window is a normal, resizable
window: it finds the window, inspects its style bits, resizes and moves it, then closes
it and confirms the geometry file was updated. Prints PASS/FAIL lines.

Usage: python tools/verify_exe.py [path/to/FauxCode.exe]
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import time

user32 = ctypes.windll.user32
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "fauxcode-app", "dist", "FauxCode.exe")
STATE = os.path.join(os.environ.get("APPDATA", ""), "FauxCode", "window.json")

GWL_STYLE = -16
WS_THICKFRAME = 0x00040000
WS_MAXIMIZEBOX = 0x00010000
WS_MINIMIZEBOX = 0x00020000
WS_CAPTION = 0x00C00000
WM_CLOSE = 0x0010

EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def exe_pids():
    """PyInstaller onefile runs a bootloader that spawns the real process: accept both."""
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq " + os.path.basename(EXE), "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1 and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def find_window(pid):
    found = []
    pids = exe_pids() | {pid}

    def cb(hwnd, _):
        owner = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value in pids and user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, buf, 512)
            if buf.value:
                found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    return found


def rect(hwnd):
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def main():
    ok = True
    if not os.path.exists(EXE):
        print("FAIL exe not found:", EXE)
        return 1
    before = None
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            before = fh.read()
    proc = subprocess.Popen([EXE])
    hwnd = None
    for _ in range(60):
        time.sleep(0.5)
        wins = find_window(proc.pid)
        if wins:
            hwnd, title = wins[0]
            break
    if not hwnd:
        print("FAIL no window appeared within 30s")
        proc.kill()
        return 1
    print("PASS window appeared:", title)
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    for name, bit in [("WS_THICKFRAME (resizable border)", WS_THICKFRAME), ("WS_MAXIMIZEBOX", WS_MAXIMIZEBOX), ("WS_MINIMIZEBOX", WS_MINIMIZEBOX), ("WS_CAPTION (native title bar)", WS_CAPTION)]:
        has = bool(style & bit)
        ok &= has
        print(("PASS" if has else "FAIL"), name)
    x, y, w, h = rect(hwnd)
    print("INFO initial geometry", (x, y, w, h))
    user32.MoveWindow(hwnd, 120, 90, 990, 640, True)
    time.sleep(1.5)
    x2, y2, w2, h2 = rect(hwnd)
    resized = abs(w2 - 990) < 40 and abs(h2 - 640) < 40
    ok &= resized
    print(("PASS" if resized else "FAIL"), "window accepted a resize:", (x2, y2, w2, h2))
    time.sleep(6)  # let the page boot and the title follower run
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    print("INFO title after boot:", buf.value)
    ok &= "Visual Studio Code" in buf.value
    print(("PASS" if "Visual Studio Code" in buf.value else "FAIL"), "title follows the page")
    user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        print("FAIL process did not exit on close")
        ok = False
    else:
        print("PASS process exited on close")
    time.sleep(0.5)
    if os.path.exists(STATE):
        with open(STATE, encoding="utf-8") as fh:
            after = fh.read()
        data = json.loads(after)
        remembered = abs(int(data.get("width", 0)) - w2) < 40 and abs(int(data.get("height", 0)) - h2) < 40
        ok &= remembered
        print(("PASS" if remembered else "FAIL"), "geometry remembered:", data)
    else:
        ok = False
        print("FAIL no geometry file written at", STATE)
    print("RESULT", "OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
