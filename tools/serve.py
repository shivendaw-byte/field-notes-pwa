"""Local dev server with caching off, so tests always see the files on disk.
Usage: python tools/serve.py [port]   (serves the repo root)"""
import http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8780
http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
