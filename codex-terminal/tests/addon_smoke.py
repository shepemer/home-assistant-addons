#!/usr/bin/env python3
"""Run the complete add-on twice in an isolated, disposable Docker container.

Build the production image first, then run:
    python3 codex-terminal/tests/addon_smoke.py

The container has no network access or published ports. Only generated temporary
data/config directories and synthetic credentials are used; no model login is
required. This is separate from unittest discovery because it needs a full image.
"""

import argparse
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import time
import tomllib
import uuid


ENDPOINT = "http://127.0.0.1:8765/mcp"
PROCESS_PROBE = r'''
import json, os
from pathlib import Path

processes = {}
for directory in Path('/proc').iterdir():
    if not directory.name.isdigit():
        continue
    try:
        argv = directory.joinpath('cmdline').read_bytes().decode().split('\0')[:-1]
        status = directory.joinpath('stat').read_text().rsplit(')', 1)[1].split()
        processes[int(directory.name)] = {
            'argv': argv,
            'parent': int(status[1]),
            'executable': Path(os.readlink(directory / 'exe')).name,
        }
    except (OSError, ValueError):
        continue

ha = [pid for pid, p in processes.items()
      if '/usr/local/libexec/ha-mcp-server.py' in p['argv']
      and '--check' not in p['argv']]
uv = [pid for pid, p in processes.items()
      if p['executable'] in ('uv', 'uvx')]
cli = [pid for pid, p in processes.items()
       if p['executable'] == 'codex'
       and '--dangerously-bypass-approvals-and-sandbox' in p['argv']]
print(json.dumps({'ha_pids': ha, 'uv_pids': uv, 'cli_pids': cli,
                  'parents': {pid: p['parent'] for pid, p in processes.items()}}))
'''


def docker(*arguments, timeout=30, check=True):
    try:
        result = subprocess.run(
            ["docker", *arguments], text=True, capture_output=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"docker {arguments[0]} timed out") from None
    if check and result.returncode:
        # Neither commands nor arbitrary container output belong in diagnostics:
        # they can include credentials in other test environments.
        raise RuntimeError(f"docker {arguments[0]} failed with exit {result.returncode}")
    return result


def inside(container, *arguments, **kwargs):
    return docker("exec", container, *arguments, **kwargs)


def process_snapshot(container):
    return json.loads(inside(container, "/opt/ha-mcp/bin/python", "-c", PROCESS_PROBE).stdout)


def under_pane(pid, pane_pid, parents):
    visited = set()
    while pid and pid not in visited:
        if pid == pane_pid:
            return True
        visited.add(pid)
        pid = parents.get(str(pid), 0)
    return False


def ready(container, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        health = inside(
            container, "/opt/ha-mcp/bin/python", "/usr/local/libexec/ha-mcp-server.py",
            "--check", check=False,
        )
        pane = inside(
            container, "tmux", "display-message", "-p", "-t", "codex", "#{pane_pid}",
            check=False,
        )
        if health.returncode == 0 and pane.returncode == 0:
            snapshot = process_snapshot(container)
            pane_pid = int(pane.stdout.strip())
            if any(under_pane(pid, pane_pid, snapshot["parents"])
                   for pid in snapshot["cli_pids"]):
                return snapshot
        time.sleep(0.5)
    raise AssertionError("Shared MCP and a real Codex CLI under tmux did not become ready")


def verify(container, data):
    snapshot = ready(container)
    assert len(snapshot["ha_pids"]) == 1, "Expected one shared HA Python process"
    assert not snapshot["uv_pids"], "Unexpected uv/uvx runtime launcher"
    assert len(snapshot["cli_pids"]) == 1, "Expected one active autostarted Codex CLI"

    status = json.loads(docker("inspect", container).stdout)[0]
    assert status["HostConfig"]["NetworkMode"] == "none"
    assert not status["HostConfig"]["PortBindings"], "Unexpected published port"
    assert not any((status["NetworkSettings"].get("Ports") or {}).values())

    configuration = data / ".codex" / "config.toml"
    document = tomllib.loads(configuration.read_text())
    ha = document["mcp_servers"]["home_assistant"]
    assert ha["url"] == ENDPOINT
    assert not any(key in ha for key in ("command", "args", "env", "env_vars"))
    assert ha["tool_timeout_sec"] == 42
    assert document["mcp_servers"]["unrelated"] == {
        "command": "/bin/true", "enabled": False,
    }
    assert document["managed_dir"] == "/config"
    assert stat.S_IMODE(configuration.stat().st_mode) == 0o600

    connection = json.loads(inside(
        container, "env", "CODEX_HOME=/data/.codex", "/usr/local/bin/codex",
        "mcp", "get", "home_assistant", "--json",
    ).stdout)
    assert connection["transport"]["url"] == ENDPOINT
    assert connection["transport"]["type"] == "streamable_http"
    # The separate read-only CLI inspection must not spawn another HA process.
    after = process_snapshot(container)
    assert after["ha_pids"] == snapshot["ha_pids"]
    assert after["cli_pids"] == snapshot["cli_pids"]
    assert not after["uv_pids"]

    return {
        "ha_python_processes": len(snapshot["ha_pids"]),
        "uv_launchers": len(snapshot["uv_pids"]),
        "active_cli_processes_under_tmux": len(snapshot["cli_pids"]),
        "cli_mcp_transport": connection["transport"]["type"],
        "published_ports": 0,
        "unrelated_mcp_preserved": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="codex-terminal:shared-ha-mcp")
    parser.add_argument("--cli-version", default="0.162.1")
    args = parser.parse_args()
    container = f"codex-ha-addon-smoke-{uuid.uuid4().hex[:12]}"
    credential = f"synthetic-smoke-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="codex-ha-addon-smoke-") as temporary:
        root = Path(temporary)
        data, config = root / "data", root / "config"
        (data / ".codex").mkdir(parents=True)
        config.mkdir()
        options = json.dumps({
            "auto_launch": True, "enable_ha_mcp": True,
            "enable_ssh": False, "enable_remote_control": False,
        })
        (data / "options.json").write_text(options)
        # Current Bashio reads Supervisor's options API, rather than options.json.
        # Seed its documented cache so the real startup can run entirely offline.
        supervisor_cache = data / ".smoke-supervisor-cache"
        supervisor_cache.mkdir()
        (supervisor_cache / "addons.self.options.config.cache").write_text(options)
        (data / ".codex" / "config.toml").write_text(
            'managed_dir = "/config"\n'
            '[mcp_servers.unrelated]\ncommand = "/bin/true"\nenabled = false\n'
            '[mcp_servers.home_assistant]\ncommand = "uvx"\n'
            'args = ["--index-strategy", "unsafe-best-match", "--from", '
            '"ha-mcp==3.5.1", "python", "-m", "ha_mcp"]\n'
            'tool_timeout_sec = 42\n'
            '[mcp_servers.home_assistant.env]\n'
            'HOMEASSISTANT_URL = "http://supervisor/core"\n'
            f'HOMEASSISTANT_TOKEN = {json.dumps(credential)}\n'
            'FUZZY_THRESHOLD = "57"\n'
        )
        try:
            docker(
                "run", "--detach", "--name", container, "--network", "none",
                "--add-host", "supervisor:127.0.0.1",
                "--mount", f"type=bind,source={data},target=/data",
                "--mount", f"type=bind,source={config},target=/config",
                "--env", f"SUPERVISOR_TOKEN={credential}",
                "--env", "CACHE_DIR=/data/.smoke-supervisor-cache",
                "--env", f"CODEX_VERSION={args.cli_version}",
                # Offline npm installation falls back to the bundled real CLI.
                "--env", "NPM_INSTALL_TIMEOUT_SECONDS=2",
                args.image,
            )
            first = verify(container, data)
            environment_path = data / ".codex" / "ha-mcp-env.json"
            environment = json.loads(environment_path.read_text())
            assert environment["HOMEASSISTANT_TOKEN"] == credential
            assert environment["FUZZY_THRESHOLD"] == "57"
            assert stat.S_IMODE(environment_path.stat().st_mode) == 0o600
            migrated_config = (data / ".codex" / "config.toml").read_bytes()
            assert credential.encode() not in migrated_config
            docker("restart", "--time", "20", container, timeout=40)
            restarted = verify(container, data)
            assert (data / ".codex" / "config.toml").read_bytes() == migrated_config
            assert json.loads(environment_path.read_text()) == environment
            logs = docker("logs", container)
            assert credential not in logs.stdout + logs.stderr, "Credential appeared in container logs"
            print(json.dumps({
                "image": args.image, "first_start": first, "after_restart": restarted,
                "configuration_persisted": True, "credentials_private": True,
                "real_addon_startup": True,
            }, indent=2))
        finally:
            try:
                docker("stop", "--time", "20", container, timeout=40, check=False)
            finally:
                docker("rm", "--force", container, check=False)


if __name__ == "__main__":
    main()
