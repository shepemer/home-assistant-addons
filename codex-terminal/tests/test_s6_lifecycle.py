"""Real s6 regression; run in tests/Dockerfile.lifecycle, with no published ports."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import unittest

from mcp_fixture import FakeHA, HTTPClient


SERVICE = "/run/service/ha-mcp"
CONFIG = Path("/data/.codex/config.toml")
ENVIRONMENT = CONFIG.with_name("ha-mcp-env.json")
WRAPPER = "/usr/local/libexec/ha-mcp-server.py"


@unittest.skipUnless(os.environ.get("HA_MCP_TEST_S6") == "1", "Run in the isolated s6 lifecycle image")
class SharedMCPLifecycleTests(unittest.TestCase):
    def command(self, *args):
        return subprocess.check_output(args, text=True).strip()

    def wait_for(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.1)
        self.fail("Timed out waiting for the supervised HA MCP service")

    def ready(self):
        return subprocess.run([sys.executable, WRAPPER, "--check"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

    def pids(self):
        result = []
        for path in Path("/proc").glob("[0-9]*/cmdline"):
            try:
                args = path.read_bytes().split(b"\0")
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            if WRAPPER.encode() in args and b"--check" not in args:
                result.append(int(path.parent.name))
            # Startup, clients and restarts must never reintroduce uv launchers.
            self.assertFalse(args and Path(os.fsdecode(args[0])).name in {"uv", "uvx"}
                             and any(b"ha-mcp" in arg for arg in args[1:]))
        return sorted(result)

    def read_state(self):
        client = HTTPClient()
        try:
            client.initialize()
            client.state()
        finally:
            client.close()

    def test_initially_down_restart_shutdown_and_persistent_configuration(self):
        # An initially-down service deadlocks the base image's default wait=1:
        # CMD cannot run to migrate credentials and enable it. Keep the fixture
        # and production settings aligned so this test guards that startup bug.
        production = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
        self.assertIn("ENV S6_CMD_WAIT_FOR_SERVICES=0", production)
        self.assertIn("ENV S6_SERVICES_GRACETIME=15000", production)
        self.wait_for(lambda: subprocess.run(["s6-svok", SERVICE], capture_output=True).returncode == 0)
        self.assertEqual(self.command("s6-svstat", "-o", "up", SERVICE), "false")
        self.assertEqual(self.pids(), [])

        with FakeHA() as ha:
            CONFIG.parent.mkdir(parents=True, exist_ok=True)
            environment = {name: ha.env[name] for name in ("HOMEASSISTANT_URL", "HOMEASSISTANT_TOKEN")}
            CONFIG.write_text('[mcp_servers.home_assistant]\ncommand = "uvx"\n'
                              'args = ["--from", "ha-mcp==3.5.1", "python", "-m", "ha_mcp"]\n'
                              '[mcp_servers.home_assistant.env]\n' +
                              "".join(f"{key} = {json.dumps(value)}\n" for key, value in environment.items()))
            self.command(sys.executable, "/usr/local/libexec/ha-mcp-config.py")
            migrated = CONFIG.read_bytes()
            self.assertIn(b'url = "http://127.0.0.1:8765/mcp"', migrated)
            self.assertNotIn(b"uvx", migrated)
            self.assertEqual(ENVIRONMENT.stat().st_mode & 0o777, 0o600)

            try:
                self.command("s6-svc", "-u", SERVICE)
                self.wait_for(self.ready)
                self.assertEqual(len(self.pids()), 1)
                initial_pid = self.pids()[0]
                self.read_state()
                self.assertEqual(self.pids(), [initial_pid])

                # Only the child dies; s6 and the test client process stay alive.
                os.kill(initial_pid, signal.SIGKILL)
                self.wait_for(lambda: len(self.pids()) == 1 and self.pids()[0] != initial_pid and self.ready())
                self.assertEqual(len(self.pids()), 1)
                self.read_state()

                # Explicit service shutdown delivers TERM and must not restart.
                self.command("s6-svc", "-d", SERVICE)
                self.wait_for(lambda: not self.pids())
                self.wait_for(lambda: self.command("s6-svstat", "-o", "up", SERVICE) == "false")
                time.sleep(3)  # Exceeds the finish script's restart backoff.
                self.assertEqual(self.pids(), [])
                self.assertFalse(self.ready())

                # Uvicorn completes ASGI shutdown, then replays the TERM signal.
                self.assertEqual(self.command("s6-svstat", "-o", "signal", SERVICE), "SIGTERM")
                self.command(sys.executable, "/usr/local/libexec/ha-mcp-config.py")
                self.assertEqual(CONFIG.read_bytes(), migrated)
                self.command("s6-svc", "-u", SERVICE)
                self.wait_for(self.ready)
                self.assertEqual(len(self.pids()), 1)
                self.read_state()
                self.assertTrue(ha.requests)
                self.assertTrue(all(method == "GET" for method, _ in ha.requests))
            finally:
                self.command("s6-svc", "-d", SERVICE)
                self.wait_for(lambda: not self.pids())


if __name__ == "__main__":
    unittest.main()
