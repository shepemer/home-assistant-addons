# Shared HA MCP regression and memory comparison

Run the tests without a Home Assistant instance or real credentials:

```sh
docker build -f codex-terminal/tests/Dockerfile -t codex-ha-mcp-validation codex-terminal
docker run --rm --network none \
  -v "$PWD/codex-terminal:/work:ro" codex-ha-mcp-validation
```

The fixture serves only fake, authenticated, read-only Home Assistant API
responses on loopback. The real pinned ha-mcp package handles seven simultaneous
MCP sessions, lists tools and reads fixture state. The test checks tool schemas
against stdio, disconnect isolation, persistence after all clients leave, ten
subsequent sessions using the same process, no extra uv launchers, and SIGTERM
shutdown. Configuration and startup tests cover persistent migration, readiness
ordering and continued CLI autostart on success and failure. These are MCP wire
clients; they do not claim a model-driven Codex conversation or a production HA
integration test.

The actual Home Assistant base/s6 lifecycle fixture additionally verifies the
service starts only when enabled, restarts after SIGKILL, shuts down on SIGTERM,
and retains configuration on restart:

```sh
docker build -f codex-terminal/tests/Dockerfile.lifecycle -t codex-ha-mcp-lifecycle codex-terminal
docker run --rm --network none codex-ha-mcp-lifecycle
```

Full-image checks also use the actual Codex binary. This command uses aarch64;
use `BUILD_ARCH=amd64` on x86. Codex 0.162.1 is pinned only for this reproducible
test; the add-on's CLI installation and autostart policy are preserved.

```sh
docker build -t codex-terminal:shared-ha-mcp \
  --build-arg BUILD_ARCH=aarch64 --build-arg CODEX_VERSION=0.162.1 codex-terminal
docker run --rm --network none --entrypoint /opt/ha-mcp/bin/python \
  -e HA_MCP_TEST_CODEX=1 -v "$PWD/codex-terminal:/work:ro" -w /work \
  codex-terminal:shared-ha-mcp \
  -m unittest discover -s tests -p test_codex_clients.py -v
python3 codex-terminal/tests/addon_smoke.py --cli-version 0.162.1
```

The Codex integration test passed with three real app-server processes and seven
chat threads listing HA tools and making read-only fixture calls concurrently.
After one client exited, remaining clients still read successfully. This uses
the real Codex MCP transport without a model API call. The startup smoke checks
real `/run.sh`, CLI activity in tmux, `codex mcp get`, one HA process with no uv
launcher, credential privacy and configuration persistence after container restart.
All of these containers are disposable, use fake credentials and have external
networking disabled. No existing chats or running add-on are touched.

To reproduce the controlled Linux memory comparison, run each mode in a fresh
container. Both use the same package versions, fake HA data and client count.
The stdio cache is populated and synchronized to the same locked packages during
image build. The measured command is the original `uvx --index-strategy
unsafe-best-match --from ha-mcp==3.5.1 python -m ha_mcp`, with `--offline` added
for the network-disabled fixture. No extra requirements are passed to the
measured launcher. The HTTP case launches the new persistent wrapper.

```sh
for transport in stdio http; do
  docker run --rm --network none \
    -v "$PWD/codex-terminal:/work:ro" codex-ha-mcp-validation \
    /opt/ha-mcp/bin/python tests/benchmark_shared_mcp.py "$transport" \
    > "/tmp/ha-mcp-$transport.json"
done
```

Measured on 2026-10-13 in isolated Docker Desktop Linux aarch64 containers,
Alpine 3.21 / Python 3.12.15 / uv 0.5.31; ha-mcp 3.5.1, FastMCP 2.14.7 and
MCP 1.30.0 in both cases. Seven simultaneously initialized clients each listed
the same 30 tools and performed a read-only `ha_get_state` call. Five samples
were taken after initialization. Full samples are in [benchmark-results.json](benchmark-results.json).

| Measurement | Seven stdio connectors | One shared HTTP connector | Reduction |
| --- | ---: | ---: | ---: |
| HA Python processes | 7 | 1 | 6 |
| uv launchers | 7 | 0 | 7 |
| HA Python proportional resident RAM | 570.68 MiB | 97.99 MiB | 472.69 MiB |
| uv launcher proportional resident RAM | 1,056.94 MiB | 0 MiB | 1,056.94 MiB |
| Total connector proportional resident RAM | 1,627.62 MiB | 97.99 MiB | 1,529.63 MiB |
| Container `memory.current` (median) | 1,662.00 MiB | 125.33 MiB | 1,536.67 MiB |
| Container anonymous resident RAM (median) | 1,606.08 MiB | 98.02 MiB | 1,508.06 MiB |
| Logical swap / compressed zswap | 0 / 0 MiB | 0 / 0 MiB | 0 / 0 MiB |

These are **mocked benchmark results, not production savings**. The large uv
launcher component is specific to this uv version and its cache/allocator
behavior; use the separate 472.69 MiB HA Python reduction when assessing the
benefit independent of launcher overhead. This benchmark did not induce memory
pressure or compressed swap. No physical savings from swapped pages are claimed.

`scripts/measure-ha-mcp.py` also supports a read-only measurement in a running
Linux add-on container. It outputs process counts, summed proportional resident
memory (PSS), per-process logical swap, container memory and swap, and compressed
swap counters when the kernel exposes them. It never prints command lines,
environment variables or credentials and never signals a process.

PSS measures a process's proportional share of physical resident memory; summing
RSS double-counts shared pages. `memory.current` also includes file cache and
kernel charges, so its change need not match summed PSS. Logical swap describes
uncompressed page sizes and must not be reported as physical RAM savings.
Per-container zswap counters can show compressed backing memory. Zram counters
are host-wide and cannot be attributed to this add-on. `null` means unavailable.
The controlled benchmark does not induce swapping and cannot predict production
compression ratios. Record production counters before rollout and again after
the same set of chats and CLI sessions reconnect following the scheduled restart.
