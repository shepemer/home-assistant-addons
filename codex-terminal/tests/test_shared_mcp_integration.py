"""Real ha-mcp transport regression; run with the add-on's locked virtualenv."""

from concurrent.futures import ThreadPoolExecutor
from importlib.util import find_spec
import os
from pathlib import Path
import unittest

from mcp_fixture import FakeHA, HTTPClient, StdioClient, initialize_clients, shared_server


@unittest.skipUnless(find_spec("ha_mcp"), "Install ha-mcp-requirements.txt to run the real transport integration")
class SharedMCPIntegrationTests(unittest.TestCase):
    def test_concurrent_clients_disconnects_and_tool_parity(self):
        with FakeHA() as ha, shared_server(ha.env) as server:
            clients = [HTTPClient() for _ in range(7)]
            try:
                tools = initialize_clients(clients)
                self.assertEqual(len({client.session_id for client in clients}), 7)
                self.assertTrue(all(item == tools[0] for item in tools))
                # Preserve every schema and tool annotation exposed by existing stdio.
                stdio = StdioClient(ha.env)
                try:
                    stdio.initialize()
                    old_tools = stdio.tools()
                    stdio.state()
                finally:
                    stdio.close()
                self.assertEqual(old_tools, tools[0])
                clients[0].close()
                self.assertIsNone(server.poll())
                with ThreadPoolExecutor(max_workers=6) as pool:
                    list(pool.map(lambda client: client.state(), clients[1:]))
                # Further chats reuse the same process, including after all disconnect.
                for client in clients:
                    client.close()
                self.assertIsNone(server.poll())
                clients = [HTTPClient() for _ in range(10)]
                initialize_clients(clients)
                self.assertIsNone(server.poll())
                if Path("/proc").is_dir():
                    matches = []
                    for path in Path("/proc").glob("[0-9]*/cmdline"):
                        try:
                            args = path.read_bytes().split(b"\0")
                            if any(arg.endswith(b"ha-mcp-server.py") for arg in args):
                                matches.append(int(path.parent.name))
                            self.assertFalse(Path(os.fsdecode(args[0])).name in {"uv", "uvx"}
                                             and any(b"ha-mcp" in arg for arg in args[1:]))
                        except (FileNotFoundError, ProcessLookupError, PermissionError):
                            continue
                    self.assertEqual(matches, [server.pid])
                self.assertTrue(ha.requests)
                self.assertTrue(all(method == "GET" for method, _ in ha.requests))
            finally:
                for client in clients:
                    client.close()


if __name__ == "__main__":
    unittest.main()
