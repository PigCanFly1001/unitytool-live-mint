#!/usr/bin/env python3
# 本地开发服务器 — 禁用缓存, 每次刷新都拿最新文件 (改完不用硬刷新)
import http.server, socketserver, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8090

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    print(f"mint-radar (no-cache) on http://localhost:{PORT}/")
    httpd.serve_forever()
