#!/usr/bin/env python3
"""Read Linux connector and container memory counters without reading credentials.

Run inside the add-on container before and after rollout. No process is signalled
or modified. PSS is proportional *resident* memory; swap is reported separately.
Host-wide zram counters cannot be attributed to this container.
"""

import argparse
import json
from pathlib import Path


def read_number(path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def read_fields(path):
    result = {}
    try:
        for line in path.read_text().splitlines():
            parts = line.replace(":", "").split()
            if len(parts) >= 2:
                try:
                    result[parts[0]] = int(parts[1])
                except ValueError:
                    continue  # smaps_rollup starts with an address-range header.
    except OSError:
        pass
    return result


def process_kind(argv):
    if not argv:
        return None
    executable = Path(argv[0]).name
    is_ha = any("ha-mcp" in arg or arg == "ha_mcp" for arg in argv[1:])
    if executable in {"uv", "uvx"} and is_ha:
        return "uv_launcher"
    is_server = any(arg == "ha_mcp" or Path(arg).name == "ha-mcp-server.py" for arg in argv[1:])
    if executable.startswith("python") and is_server:
        # Exclude the short-lived readiness probe from the persistent count.
        if "--check" not in argv and "--wait" not in argv:
            return "ha_server"
    return None


def collect(proc=Path("/proc"), cgroup=Path("/sys/fs/cgroup"), sys_block=Path("/sys/block")):
    processes = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            argv = entry.joinpath("cmdline").read_bytes().decode(errors="replace").strip("\0").split("\0")
            kind = process_kind(argv)
            if kind is None:
                continue
            fields = read_fields(entry / "smaps_rollup")
            def byte_count(name):
                return fields[name] * 1024 if name in fields else None
            processes.append({
                "pid": int(entry.name),
                "kind": kind,
                "rss_bytes": byte_count("Rss"),
                "pss_resident_bytes": byte_count("Pss"),
                "swap_logical_bytes": byte_count("Swap"),
                "swap_pss_logical_bytes": byte_count("SwapPss"),
            })
        except (OSError, ValueError):
            continue  # A process may exit while /proc is being sampled.
    totals = {}
    for kind in ("ha_server", "uv_launcher"):
        group = [item for item in processes if item["kind"] == kind]
        totals[kind] = {"count": len(group)}
        for field in ("rss_bytes", "pss_resident_bytes", "swap_logical_bytes", "swap_pss_logical_bytes"):
            totals[kind][field] = (
                sum(item[field] for item in group)
                if all(item[field] is not None for item in group) else None
            )

    stats = read_fields(cgroup / "memory.stat")
    container = {
        "memory_current_bytes": read_number(cgroup / "memory.current"),
        "anon_resident_bytes": stats.get("anon"),
        "file_cache_bytes": stats.get("file"),
        "swap_logical_bytes": read_number(cgroup / "memory.swap.current"),
        "zswap_compressed_bytes": read_number(cgroup / "memory.zswap.current"),
        "zswapped_logical_bytes": stats.get("zswapped"),
    }
    if container["zswap_compressed_bytes"] is None:
        container["zswap_compressed_bytes"] = stats.get("zswap")
    # Older cgroup-v1 kernels expose different counters and no per-cgroup zswap.
    if container["memory_current_bytes"] is None:
        v1 = cgroup / "memory"
        stats = read_fields(v1 / "memory.stat")
        container["memory_current_bytes"] = read_number(v1 / "memory.usage_in_bytes")
        container["anon_resident_bytes"] = stats.get("total_rss", stats.get("rss"))
        container["file_cache_bytes"] = stats.get("total_cache", stats.get("cache"))
        container["swap_logical_bytes"] = stats.get("total_swap", stats.get("swap"))

    zram = []
    for path in sys_block.glob("zram*/mm_stat"):
        try:
            values = [int(value) for value in path.read_text().split()]
            zram.append({"device": path.parent.name, "logical_bytes": values[0],
                         "compressed_bytes": values[1], "physical_allocated_bytes": values[2]})
        except (OSError, ValueError, IndexError):
            pass
    return {"connector_processes": sorted(processes, key=lambda item: item["pid"]),
            "connector_totals": totals, "container": container, "host_zram": zram,
            "notes": ["PSS counts proportional resident RAM, excluding logical swap.",
                      "memory.current includes file cache and kernel charges; it is not process PSS.",
                      "Swap logical bytes are uncompressed page sizes, not physical RAM saved.",
                      "zswap is container-attributed when available; zram is host-wide.",
                      "null means unavailable, not zero. No credentials or command lines are emitted."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proc", type=Path, default=Path("/proc"))
    parser.add_argument("--cgroup", type=Path, default=Path("/sys/fs/cgroup"))
    args = parser.parse_args()
    print(json.dumps(collect(args.proc, args.cgroup), indent=2))
