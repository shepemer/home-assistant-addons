#!/usr/bin/env python3
"""Controlled Linux benchmark; run each transport in a fresh test container.

This uses fake HA state and credentials. It neither connects to nor restarts a
running add-on. Sampled container charges include the identical test harness.
"""

import argparse
from contextlib import nullcontext
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import statistics
import time

from mcp_fixture import ADDON, FakeHA, HTTPClient, StdioClient, initialize_clients, shared_server


def benchmark(transport, count):
    spec = spec_from_file_location("measurement", ADDON / "scripts/measure-ha-mcp.py")
    measurement = module_from_spec(spec)
    spec.loader.exec_module(measurement)
    with FakeHA() as ha:
        with shared_server(ha.env) if transport == "http" else nullcontext():
            clients = []
            try:
                for _ in range(count):
                    clients.append(HTTPClient() if transport == "http" else StdioClient(ha.env, [
                        "uvx", "--offline",
                        "--index-strategy", "unsafe-best-match", "--from", "ha-mcp==3.5.1",
                        "python", "-m", "ha_mcp"]))
                tools = initialize_clients(clients)
                time.sleep(2)
                samples = []
                for _ in range(5):
                    samples.append(measurement.collect())
                    time.sleep(0.2)
                # Include all raw samples; median suppresses brief allocator/charge noise.
                metrics = {
                    "connector_pss_resident_bytes": statistics.median(
                        sum(sample["connector_totals"][kind]["pss_resident_bytes"]
                            for kind in ("ha_server", "uv_launcher")) for sample in samples),
                    "container_memory_current_bytes": statistics.median(
                        sample["container"]["memory_current_bytes"] for sample in samples),
                    "container_anon_resident_bytes": statistics.median(
                        sample["container"]["anon_resident_bytes"] for sample in samples),
                }
                print(json.dumps({"transport": transport, "clients": count,
                                  "tool_count": len(tools[0]), "metrics_median": metrics,
                                  "samples": samples}, indent=2))
            finally:
                for client in clients:
                    client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transport", choices=("stdio", "http"))
    parser.add_argument("--clients", type=int, default=7)
    args = parser.parse_args()
    benchmark(args.transport, args.clients)
