"""Exercise the real ingress proxy with HTTP and WebSocket upgrade requests."""

from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest


SOURCE = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("nginx"), "Install nginx to test ingress access control")
class IngressTests(unittest.TestCase):
    @contextmanager
    def proxy(self, *, supervisor=False):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                requests.append(self.path)
                if self.headers.get("Upgrade") == "websocket":
                    self.send_response(101)
                    self.send_header("Upgrade", "websocket")
                    self.send_header("Connection", "Upgrade")
                    self.send_header("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "8")
                    self.end_headers()
                    self.wfile.write(b"terminal")

        backend = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=backend.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    port = probe.getsockname()[1]
                configuration = (SOURCE / "nginx.conf").read_text()
                configuration = configuration.replace("listen 7681;", f"listen 127.0.0.1:{port};")
                configuration = configuration.replace("127.0.0.1:7682", f"127.0.0.1:{backend.server_port}")
                configuration = configuration.replace("/run/nginx", str(root))
                if supervisor:
                    # Emulate the Supervisor peer on loopback without configuring
                    # host interfaces. Denial tests use the production ACL unchanged.
                    configuration = configuration.replace("allow 172.30.32.2;", "allow 127.0.0.1;")
                config = root / "nginx.conf"
                config.write_text(configuration)
                with (root / "nginx.log").open("w+") as log:
                    process = subprocess.Popen(
                        ["nginx", "-p", directory, "-c", str(config), "-g", "daemon off;"],
                        stdout=log, stderr=log,
                    )
                    try:
                        deadline = time.monotonic() + 5
                        while True:
                            if process.poll() is not None or time.monotonic() >= deadline:
                                log.seek(0)
                                self.fail(f"Ingress proxy did not start: {log.read()}")
                            try:
                                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                                    break
                            except OSError:
                                time.sleep(0.02)
                        yield port, requests
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
        finally:
            backend.shutdown()
            backend.server_close()
            thread.join(timeout=5)

    def request(self, port, *, websocket=False, headers=None):
        headers = dict(headers or {})
        if websocket:
            headers.update({"Connection": "Upgrade", "Upgrade": "websocket",
                            "Sec-WebSocket-Version": "13",
                            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="})
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("GET", "/ws" if websocket else "/", headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_direct_http_and_websocket_connections_are_denied(self):
        with self.proxy() as (port, requests):
            for websocket in (False, True):
                for headers in ({}, {"X-Forwarded-For": "172.30.32.2",
                                     "X-Real-IP": "172.30.32.2",
                                     "X-Remote-User-Id": "admin",
                                     "Forwarded": "for=172.30.32.2"}):
                    with self.subTest(websocket=websocket, headers=headers):
                        self.assertEqual(self.request(port, websocket=websocket, headers=headers)[0], 403)
            self.assertEqual(requests, [])

    def test_supervisor_http_and_websocket_connections_are_proxied(self):
        with self.proxy(supervisor=True) as (port, requests):
            self.assertEqual(self.request(port), (200, b"terminal"))
            self.assertEqual(self.request(port, websocket=True)[0], 101)
            self.assertEqual(requests, ["/", "/ws"])


if __name__ == "__main__":
    unittest.main()
