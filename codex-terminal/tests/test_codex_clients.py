"""Use the installed Codex client against fake HA; no OpenAI account or model call."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from mcp_fixture import ENDPOINT, FakeHA, StdioClient, shared_server


@unittest.skipUnless(os.environ.get("HA_MCP_TEST_CODEX") == "1" and shutil.which("codex"),
                     "Run in the full add-on image with HA_MCP_TEST_CODEX=1")
class CodexClientTests(unittest.TestCase):
    def test_multiple_codex_app_servers_and_chat_threads_share_ha(self):
        with FakeHA() as ha, shared_server(ha.env) as server, tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.toml"
            config.write_text(f'[mcp_servers.home_assistant]\nurl = "{ENDPOINT}"\n')
            clients = []
            try:
                # Seed Codex's SQLite schema once before other processes open it.
                for _ in range(3):
                    client = StdioClient({**ha.env, "CODEX_HOME": directory}, ["codex", "app-server"])
                    clients.append(client)
                    client.request("initialize", {"clientInfo": {"name": "ha-mcp-regression", "version": "1"},
                                                  "capabilities": {"experimentalApi": True}})
                    client.notify("initialized")

                def connect(item):
                    client, count = item
                    threads = []
                    for _ in range(count):
                        thread = client.request("thread/start", {"ephemeral": True, "cwd": directory,
                                                                 "approvalPolicy": "never"})
                        thread_id = thread["thread"]["id"]
                        status = client.request("mcpServerStatus/list", {"threadId": thread_id,
                                                                         "serverName": "home_assistant"})
                        ha_status = next(item for item in status["data"] if item["name"] == "home_assistant")
                        self.assertFalse(ha_status.get("toolsError"))
                        self.assertTrue(any(tool["name"] == "ha_get_state" for tool in ha_status["tools"].values()))
                        result = client.request("mcpServer/tool/call", {"threadId": thread_id,
                                                                       "server": "home_assistant",
                                                                       "tool": "ha_get_state",
                                                                       "arguments": {"entity_id": "sensor.mcp_fixture"}})
                        self.assertIn('"state": "22"', json.dumps(result))
                        threads.append(thread_id)
                    return threads

                with ThreadPoolExecutor(max_workers=3) as pool:
                    threads = list(pool.map(connect, zip(clients, (3, 2, 2))))
                self.assertEqual(sum(map(len, threads)), 7)
                clients[0].close()
                clients[0] = None
                for client, thread_ids in zip(clients[1:], threads[1:]):
                    result = client.request("mcpServer/tool/call", {"threadId": thread_ids[0],
                                                                   "server": "home_assistant",
                                                                   "tool": "ha_get_state",
                                                                   "arguments": {"entity_id": "sensor.mcp_fixture"}})
                    self.assertIn('"state": "22"', json.dumps(result))
                self.assertIsNone(server.poll())
                self.assertTrue(all(method == "GET" for method, _ in ha.requests))
            finally:
                for client in clients:
                    if client is not None:
                        client.close()


if __name__ == "__main__":
    unittest.main()
