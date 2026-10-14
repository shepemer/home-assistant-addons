"""Regression coverage for persistent stdio-to-HTTP migration."""

import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import tomlkit

SOURCE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("ha_mcp_config", SOURCE / "ha-mcp-config.py")
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "config.toml"
        self.environment = self.path.with_name("ha-mcp-env.json")

    def migrate(self, token="supervisor-token"):
        with patch.dict(os.environ, {"SUPERVISOR_TOKEN": token}, clear=True):
            config.migrate(self.path, self.environment)
        return tomlkit.parse(self.path.read_text())

    def test_upgrade_and_restart_preserve_tools_credentials_and_other_servers(self):
        self.path.write_text('''# User configuration
model = "example"
[mcp_servers.other]
command = "other-mcp"
args = ["--custom"]
[mcp_servers.home_assistant]
command = "uvx"
args = ["--from", "ha-mcp==3.5.1", "python", "-m", "ha_mcp"]
tool_timeout_sec = 90
enabled_tools = ["ha_get_state"]
disabled_tools = ["ha_call_service"]
enabled = true
[mcp_servers.home_assistant.env]
HOMEASSISTANT_URL = "https://custom.invalid"
HOMEASSISTANT_TOKEN = "private-custom-token"
ENABLE_ALL_TOOLS = "true"
[mcp_servers.home_assistant.tools.ha_get_state]
approval_mode = "approve"
[projects."/config"]
trust_level = "trusted"
''')
        before = tomlkit.parse(self.path.read_text()).unwrap()
        after = self.migrate().unwrap()
        ha = after["mcp_servers"]["home_assistant"]
        self.assertEqual(ha["url"], config.ENDPOINT)
        self.assertFalse({"env", "args", "command"} & ha.keys())
        for key in ("tool_timeout_sec", "enabled_tools", "disabled_tools", "enabled", "tools"):
            self.assertEqual(ha[key], before["mcp_servers"]["home_assistant"][key])
        self.assertEqual(after["mcp_servers"]["other"], before["mcp_servers"]["other"])
        self.assertEqual(after["projects"], before["projects"])
        self.assertIn("# User configuration", self.path.read_text())
        saved = json.loads(self.environment.read_text())
        self.assertEqual(saved["HOMEASSISTANT_TOKEN"], "private-custom-token")
        self.assertEqual(saved["ENABLE_ALL_TOOLS"], "true")
        self.assertNotIn("private-custom-token", self.path.read_text())
        for path in (self.path, self.environment):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(self.migrate().unwrap(), after)
        self.assertEqual(json.loads(self.environment.read_text()), saved)

    def test_fresh_install_and_rotated_supervisor_token(self):
        self.migrate("first")
        self.migrate("rotated")
        self.assertEqual(json.loads(self.environment.read_text()), {
            "HOMEASSISTANT_URL": config.SUPERVISOR_URL,
            "HOMEASSISTANT_TOKEN": "rotated",
        })

    def test_quoted_inline_table_and_disabled_policy(self):
        self.path.write_text('mcp_servers = { "home_assistant" = { command = "uvx", enabled = false } }\n')
        self.assertFalse(self.migrate()["mcp_servers"]["home_assistant"]["enabled"])

    def test_invalid_config_is_untouched(self):
        original = 'model = "unterminated'
        self.path.write_text(original)
        with self.assertRaises(Exception):
            self.migrate()
        self.assertEqual(self.path.read_text(), original)
        self.assertFalse(self.environment.exists())

    def test_missing_credentials_does_not_partially_write_config(self):
        self.path.write_text('[mcp_servers.home_assistant]\ncommand = "uvx"\n')
        original = self.path.read_text()
        with self.assertRaises(ValueError):
            self.migrate("")
        self.assertEqual(self.path.read_text(), original)


if __name__ == "__main__":
    unittest.main()
