"""FauxCode — desktop wrapper around workbench.html (pywebview + WebView2).

The window uses the normal Windows frame, so it can be resized from any edge,
snapped, maximized and minimized like any other application. Its size, position
and maximized state are remembered between runs in %APPDATA%\\FauxCode\\window.json.
The page's fake title bar keeps its menus; the in-page window buttons are hidden
in the desktop build because the real ones are right above them.
"""

import json
import os
import sys
import threading
import time

import webview

APP_NAME = "FauxCode"
DEFAULT_SIZE = (1280, 800)
MIN_SIZE = (680, 480)


def resource(name: str) -> str:
    # PyInstaller onefile extracts bundled data to sys._MEIPASS at runtime
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, name)


def state_path() -> str:
    root = os.environ.get("APPDATA") or os.path.expanduser("~")
    folder = os.path.join(root, APP_NAME)
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "window.json")


def load_state() -> dict:
    try:
        with open(state_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            return {}
        return data
    except Exception:
        return {}


def save_state(data: dict) -> None:
    try:
        with open(state_path(), "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
    except Exception:
        pass


def clamp_geometry(state: dict) -> dict:
    """Keep a remembered window on screen even if the monitor layout changed."""
    width = int(state.get("width", DEFAULT_SIZE[0]))
    height = int(state.get("height", DEFAULT_SIZE[1]))
    width = max(MIN_SIZE[0], width)
    height = max(MIN_SIZE[1], height)
    x = state.get("x")
    y = state.get("y")
    try:
        screens = webview.screens
        if screens:
            sw = max(s.width for s in screens)
            sh = max(s.height for s in screens)
            width = min(width, sw)
            height = min(height, sh)
            if x is not None and (x < -width + 80 or x > sw - 80):
                x = None
            if y is not None and (y < 0 or y > sh - 80):
                y = None
    except Exception:
        pass
    return {"width": width, "height": height, "x": x, "y": y, "maximized": bool(state.get("maximized"))}


class Api:
    """Exposed to the page as window.pywebview.api."""

    def __init__(self):
        self.window = None
        self.is_maximized = False

    def minimize(self):
        self.window.minimize()

    def toggle_max(self):
        if self.is_maximized:
            self.window.restore()
        else:
            self.window.maximize()

    def close(self):
        self.window.destroy()

    def set_title(self, title):
        if title:
            self.window.set_title(str(title)[:200])

    def version(self):
        return {"app": APP_NAME, "webview": getattr(webview, "__version__", "?"), "frame": "native"}


class GeometryTracker:
    """Debounced writer for the window geometry file."""

    def __init__(self, window, api):
        self.window = window
        self.api = api
        self.timer = None
        self.lock = threading.Lock()

    def schedule(self):
        with self.lock:
            if self.timer:
                self.timer.cancel()
            self.timer = threading.Timer(0.6, self.flush)
            self.timer.daemon = True
            self.timer.start()

    def flush(self):
        try:
            state = load_state()
            if self.api.is_maximized:
                state["maximized"] = True
            else:
                state.update({
                    "maximized": False,
                    "width": int(self.window.width),
                    "height": int(self.window.height),
                    "x": int(self.window.x),
                    "y": int(self.window.y),
                })
            save_state(state)
        except Exception:
            pass


CLOSED = threading.Event()


def follow_title(window):
    """Mirror the page's <title> into the taskbar (the page changes it per file)."""
    while not CLOSED.is_set():
        try:
            title = window.evaluate_js("document.title")
            if title:
                window.set_title(title)
        except Exception:
            pass
        CLOSED.wait(2)


def main():
    api = Api()
    geometry = clamp_geometry(load_state())
    window = webview.create_window(
        APP_NAME,
        resource("workbench.html"),
        js_api=api,
        width=geometry["width"],
        height=geometry["height"],
        x=geometry["x"],
        y=geometry["y"],
        min_size=MIN_SIZE,
        resizable=True,
        maximized=geometry["maximized"],
        fullscreen=False,
        frameless=False,
        easy_drag=False,
        background_color="#1e1e1e",
        text_select=True,
    )
    api.window = window
    tracker = GeometryTracker(window, api)

    def on_maximized():
        api.is_maximized = True
        tracker.schedule()

    def on_restored():
        api.is_maximized = False
        tracker.schedule()

    window.events.maximized += on_maximized
    window.events.restored += on_restored
    window.events.resized += lambda *args: tracker.schedule()
    window.events.moved += lambda *args: tracker.schedule()
    window.events.closing += lambda: tracker.flush()
    window.events.closed += lambda: CLOSED.set()
    webview.start(follow_title, window)
    CLOSED.set()
    tracker.flush()
    # nothing useful can outlive the window; make sure no helper thread keeps the process around
    os._exit(0)


if __name__ == "__main__":
    main()
