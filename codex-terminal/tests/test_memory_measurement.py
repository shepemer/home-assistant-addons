"""Memory accounting must not conflate proportional resident RAM and swap."""

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "measure-ha-mcp.py"
SPEC = importlib.util.spec_from_file_location("measurement", SCRIPT)
measurement = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(measurement)


class MemoryMeasurementTests(unittest.TestCase):
    def test_proportional_memory_and_compressed_swap_are_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            proc, cgroup, block = (root / name for name in ("proc", "cgroup", "block"))
            for path in (proc / "1", proc / "2", proc / "3", cgroup, block / "zram0"):
                path.mkdir(parents=True)
            (proc / "1/cmdline").write_bytes(b"python\0-m\0ha_mcp\0")
            (proc / "2/cmdline").write_bytes(b"uvx\0--from\0ha-mcp==3.5.1\0python\0-m\0ha_mcp\0")
            (proc / "3/cmdline").write_bytes(b"python\0ha-mcp-server.py\0--check\0")
            for pid in (1, 2, 3):
                (proc / f"{pid}/smaps_rollup").write_text(
                    "00400000-7fffffff ---p 00000000 00:00 0 [rollup]\n"
                    "Rss: 100 kB\nPss: 70 kB\nSwap: 40 kB\nSwapPss: 30 kB\n")
            (cgroup / "memory.current").write_text("4096")
            (cgroup / "memory.swap.current").write_text("8192")
            (cgroup / "memory.zswap.current").write_text("1024")
            (cgroup / "memory.stat").write_text("anon 2048\nfile 2048\nzswapped 8192\n")
            (block / "zram0/mm_stat").write_text("16384 2048 4096 0 0 0 0")
            result = measurement.collect(proc, cgroup, block)
            self.assertEqual(result["connector_totals"]["ha_server"]["count"], 1)
            self.assertEqual(result["connector_totals"]["uv_launcher"]["count"], 1)
            self.assertEqual(result["connector_totals"]["ha_server"]["pss_resident_bytes"], 70 * 1024)
            self.assertEqual(result["connector_totals"]["ha_server"]["swap_pss_logical_bytes"], 30 * 1024)
            self.assertEqual(result["container"]["zswap_compressed_bytes"], 1024)
            self.assertEqual(result["container"]["swap_logical_bytes"], 8192)
            self.assertEqual(result["host_zram"][0]["physical_allocated_bytes"], 4096)

    def test_unavailable_counters_are_not_claimed_as_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "1").mkdir()
            (root / "1/cmdline").write_bytes(b"python\0ha-mcp-server.py\0")
            result = measurement.collect(root, root, root)
            self.assertIsNone(result["connector_totals"]["ha_server"]["pss_resident_bytes"])
            self.assertIsNone(result["container"]["zswap_compressed_bytes"])
            self.assertIsNone(result["container"]["swap_logical_bytes"])


if __name__ == "__main__":
    unittest.main()
