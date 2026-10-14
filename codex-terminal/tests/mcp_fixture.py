"""Isolated fake HA API and real MCP wire clients; never uses real HA credentials."""

from concurrent.futures import ThreadPoolExecutor
import codecs
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


ADDON = Path(__file__).resolve().parents[1]
ENDPOINT = "http://127.0.0.1:8765/mcp"
TOKEN = "integration-fixture-token-do-not-log"
STATE = {"entity_id": "sensor.mcp_fixture", "state": "22",
         "attributes": {"friendly_name": "MCP fixture", "unit_of_measurement": "°C"},
         "last_changed": "2026-01-01T00:00:00+00:00",
         "last_updated": "2026-01-01T00:00:00+00:00",
         "context": {"id": "fixture", "parent_id": None, "user_id": None}}


class FakeHA:
    def __enter__(self):
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.requests.append((self.command, self.path))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self.send_error(401)
                    return
                endpoints = {
                    "/api/": {"message": "API running."},
                    "/api/config": {"location_name": "MCP fixture", "time_zone": "UTC",
                                    "version": "2026.1.0", "components": []},
                    "/api/states": [STATE],
                    "/api/states/sensor.mcp_fixture": STATE,
                }
                if self.path not in endpoints:
                    self.send_error(404)
                    return
                data = json.dumps(endpoints[self.path]).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                owner.requests.append((self.command, self.path))
                self.send_error(405, "Fixture only permits reads")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = {**os.environ, "HOMEASSISTANT_URL": f"http://127.0.0.1:{self.server.server_port}",
                    "HOMEASSISTANT_TOKEN": TOKEN, "LOG_LEVEL": "WARNING",
                    "PYTHONUNBUFFERED": "1"}
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class MCPClient:
    def initialize(self):
        result = self.request("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "codex-terminal-regression", "version": "1"}})
        self.notify("notifications/initialized")
        return result

    def tools(self):
        return self.request("tools/list")["tools"]

    def state(self):
        result = self.request("tools/call", {"name": "ha_get_state", "arguments": {"entity_id": STATE["entity_id"]}})
        if result.get("isError"):
            raise AssertionError("HA fixture read failed")
        content = [json.loads(item["text"]) for item in result["content"] if item["type"] == "text"]
        if not any(item.get("data", item).get("state") == STATE["state"] for item in content):
            raise AssertionError(f"HA fixture returned an unexpected state: {content}")
        return result


class HTTPClient(MCPClient):
    def __init__(self):
        self.session_id = None
        self.request_id = 0

    def _send(self, method, params, notification=False):
        self.request_id += 1
        payload = {"jsonrpc": "2.0", "method": method}
        if not notification:
            payload["id"] = self.request_id
        if params is not None:
            payload["params"] = params
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": "2025-03-26"}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(ENDPOINT, json.dumps(payload).encode(), headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            self.session_id = response.headers.get("Mcp-Session-Id", self.session_id)
            body = response.read().decode()
            content_type = response.headers.get("Content-Type", "")
        if notification:
            return None
        messages = ([json.loads(line[5:].strip()) for line in body.splitlines() if line.startswith("data:")]
                    if "text/event-stream" in content_type else [json.loads(body)])
        result = next(item for item in messages if item.get("id") == self.request_id)
        if "error" in result:
            raise AssertionError(result["error"])
        return result["result"]

    def request(self, method, params=None):
        return self._send(method, params)

    def notify(self, method):
        self._send(method, None, notification=True)

    def close(self):
        if self.session_id:
            request = urllib.request.Request(ENDPOINT, method="DELETE", headers={
                "Mcp-Session-Id": self.session_id, "MCP-Protocol-Version": "2025-03-26"})
            with urllib.request.urlopen(request, timeout=10) as response:
                response.read()
            self.session_id = None


class StdioClient(MCPClient):
    def __init__(self, env, command=None):
        self.request_id = 0
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")()
        self.log = tempfile.TemporaryFile()
        self.directory = tempfile.TemporaryDirectory()
        self.process = subprocess.Popen(command or [sys.executable, "-m", "ha_mcp"], env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, bufsize=1, cwd=self.directory.name)

    def request(self, method, params=None):
        self.request_id += 1
        payload = {"jsonrpc": "2.0", "id": self.request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 45
        # ha-mcp 3.5.1 prints an environment warning before its JSON RPC stream.
        while time.monotonic() < deadline:
            if "\n" not in self.pending:
                with selectors.DefaultSelector() as selector:
                    selector.register(self.process.stdout, selectors.EVENT_READ)
                    if not selector.select(timeout=max(0.1, deadline - time.monotonic())):
                        break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    break
                self.pending += self.decoder.decode(chunk)
                continue
            line, self.pending = self.pending.split("\n", 1)
            try:
                result = json.loads(line)
            except json.JSONDecodeError:
                continue
            if result.get("id") == self.request_id:
                if "error" in result:
                    raise AssertionError(result["error"])
                return result["result"]
        raise AssertionError("stdio server did not return an MCP response")

    def notify(self, method):
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.process.stdin.flush()

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.process.stdout.close()
        self.log.close()
        self.directory.cleanup()


@contextmanager
def shared_server(env):
    with tempfile.TemporaryFile() as log, tempfile.TemporaryDirectory() as directory:
        process = subprocess.Popen([sys.executable, str(ADDON / "ha-mcp-server.py")], env=env,
                                   stdout=log, stderr=log, cwd=directory)
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline and process.poll() is None:
                check = subprocess.run([sys.executable, str(ADDON / "ha-mcp-server.py"), "--check"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                if check.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise AssertionError("Shared server did not become ready")
            yield process
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    raise AssertionError("Shared server did not exit cleanly on SIGTERM")
            log.seek(0)
            if TOKEN.encode() in log.read():
                raise AssertionError("Shared server logged the HA token")


def initialize_clients(clients):
    def connect(client):
        client.initialize()
        tools = client.tools()
        state = next(tool for tool in tools if tool["name"] == "ha_get_state")
        assert state["annotations"]["readOnlyHint"] is True
        client.state()
        return tools
    with ThreadPoolExecutor(max_workers=len(clients)) as pool:
        return list(pool.map(connect, clients))
