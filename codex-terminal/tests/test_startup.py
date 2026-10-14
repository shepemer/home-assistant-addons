"""Exercise real shell startup functions with external commands substituted."""

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
SCRIPT = (SOURCE / "run.sh").read_text()
FUNCTIONS = SCRIPT[SCRIPT.index("redact_log() {"):SCRIPT.index('bashio::log.info "Starting Codex Terminal"')]


class StartupTests(unittest.TestCase):
    def run_shell(self, body, *, ready=True, migrate=True, timeout=2):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / "python"
            helper.write_text("#!/bin/bash\n" + '''
echo "helper:$*" >> "$TEST_EVENTS"
case "$1" in
  */ha-mcp-config.py) exit "$TEST_MIGRATE_STATUS" ;;
  */ha-mcp-server.py) exit "$TEST_READY_STATUS" ;;
esac
''')
            helper.chmod(0o755)
            events = root / "events"
            env = dict(os.environ, TEST_EVENTS=str(events),
                       TEST_MIGRATE_STATUS="0" if migrate else "1",
                       TEST_READY_STATUS="0" if ready else "1")
            prelude = f'''
set -e
HA_MCP_PYTHON={shlex.quote(str(helper))}
HA_MCP_SERVICE=/run/service/ha-mcp
HA_MCP_READY_TIMEOUT_SECONDS={timeout}
SUPERVISOR_TOKEN=fake-supervisor-token
SESSION_NAME=codex
CODEX_BIN=/bin/sh
CODEX_RUNTIME_PATH=/usr/bin:/bin
bashio::config() {{ echo "${{TEST_OPTION:-true}}"; }}
bashio::log.info() {{ echo "info:$*" >> "$TEST_EVENTS"; }}
bashio::log.warning() {{ echo "warning:$*" >> "$TEST_EVENTS"; }}
'''
            stubs = '''
probe_homeassistant_api() { return 0; }
s6-svc() { echo "s6:$*" >> "$TEST_EVENTS"; }
tmux() {
    echo "tmux:$*" >> "$TEST_EVENTS"
    [ "$1" != has-session ]
}
cd() { :; }
'''
            result = subprocess.run(["bash", "-c", prelude + FUNCTIONS + stubs + body],
                                    env=env, text=True, capture_output=True, timeout=8)
            self.assertEqual(result.returncode, 0, result.stderr)
            return events.read_text() if events.exists() else ""

    def test_ready_before_cli_autostart(self):
        events = self.run_shell("configure_ha_mcp\nconfigure_tmux_session\n")
        self.assertLess(events.index("ha-mcp-config.py"), events.index("s6:-u"))
        self.assertLess(events.index("server ready"), events.index("tmux:new-session"))
        self.assertIn('tmux:send-keys -t codex "/bin/sh" --dangerously-bypass-approvals-and-sandbox Enter', events)
        self.assertNotIn("uvx", events)

    def test_timeout_leaves_supervision_and_cli_running(self):
        events = self.run_shell("configure_ha_mcp\nconfigure_tmux_session\n", ready=False, timeout=1)
        self.assertIn("s6:-u /run/service/ha-mcp", events)
        self.assertIn("readiness timed out", events)
        self.assertIn("tmux:new-session", events)
        self.assertNotIn("s6:-d", events)

    def test_config_failure_does_not_start_service_or_block_cli(self):
        events = self.run_shell("configure_ha_mcp\nconfigure_tmux_session\n", migrate=False)
        self.assertNotIn("s6:", events)
        self.assertIn("tmux:new-session", events)

    def test_disabled_option_does_not_start_mcp(self):
        events = self.run_shell("TEST_OPTION=false\nconfigure_ha_mcp\n")
        self.assertNotIn("helper:", events)
        self.assertNotIn("s6:", events)

    def test_cli_auto_launch_false_still_creates_terminal(self):
        events = self.run_shell("TEST_OPTION=false\nconfigure_tmux_session\n")
        self.assertIn("tmux:new-session", events)
        self.assertNotIn('tmux:send-keys -t codex "/bin/sh"', events)


if __name__ == "__main__":
    unittest.main()
