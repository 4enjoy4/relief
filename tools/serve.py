"""Static dev server for the workbench with caching disabled.

Usage: python tools/serve.py [port]   (default 8770)
Serves the relief/ directory so http://127.0.0.1:<port>/workbench.html always
reflects the files on disk. Only for local previews; the desktop build loads
workbench.html straight from disk and needs no server.
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8770"))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


if __name__ == "__main__":
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}/workbench.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), NoCacheHandler).serve_forever()
