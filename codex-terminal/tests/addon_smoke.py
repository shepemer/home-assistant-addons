#!/usr/bin/env python3
"""Run the complete add-on twice in an isolated, disposable Docker container.

Build the production image first, then run:
    python3 codex-terminal/tests/addon_smoke.py

The container has no network access or published ports. Only disposable Docker
data/config volumes and synthetic credentials are used; no model login is
required. This is separate from unittest discovery because it needs a full image.
"""

import argparse
import json
import subprocess
import time
import tomllib
import uuid


ENDPOINT = "http://127.0.0.1:8765/mcp"
SEED_DATA = r'''
import json, sys
from pathlib import Path

for relative_path, content in json.load(sys.stdin).items():
    path = Path('/data') / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
'''
PRIVATE_FILES = r'''
import hashlib, json, stat
from pathlib import Path

configuration = Path('/data/.codex/config.toml')
environment = Path('/data/.codex/ha-mcp-env.json')
print(json.dumps({
    'configuration': configuration.read_text(),
    'config_sha256': hashlib.sha256(configuration.read_bytes()).hexdigest(),
    'config_mode': stat.S_IMODE(configuration.stat().st_mode),
    'environment': json.loads(environment.read_text()),
    'environment_mode': stat.S_IMODE(environment.stat().st_mode),
}))
'''
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


def docker(*arguments, timeout=30, check=True, input_text=None):
    try:
        result = subprocess.run(
            ["docker", *arguments], text=True, capture_output=True, timeout=timeout,
            input=input_text,
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


def private_files(container):
    # Runtime files belong to container root and must remain mode 0600. Read them
    # inside the container; their captured contents are never printed to CI logs.
    return json.loads(inside(container, "/opt/ha-mcp/bin/python", "-c", PRIVATE_FILES).stdout)


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


def verify(container):
    snapshot = ready(container)
    assert len(snapshot["ha_pids"]) == 1, "Expected one shared HA Python process"
    assert not snapshot["uv_pids"], "Unexpected uv/uvx runtime launcher"
    assert len(snapshot["cli_pids"]) == 1, "Expected one active autostarted Codex CLI"

    status = json.loads(docker("inspect", container).stdout)[0]
    assert status["HostConfig"]["NetworkMode"] == "none"
    assert not status["HostConfig"]["PortBindings"], "Unexpected published port"
    assert not any((status["NetworkSettings"].get("Ports") or {}).values())

    private = private_files(container)
    document = tomllib.loads(private["configuration"])
    ha = document["mcp_servers"]["home_assistant"]
    assert ha["url"] == ENDPOINT
    assert not any(key in ha for key in ("command", "args", "env", "env_vars"))
    assert ha["tool_timeout_sec"] == 42
    assert document["mcp_servers"]["unrelated"] == {
        "command": "/bin/true", "enabled": False,
    }
    assert document["managed_dir"] == "/config"
    assert private["config_mode"] == 0o600

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
    data_volume, config_volume = f"{container}-data", f"{container}-config"
    mounts = ["--mount", f"type=volume,source={data_volume},target=/data",
              "--mount", f"type=volume,source={config_volume},target=/config"]
    options = json.dumps({
        "auto_launch": True, "enable_ha_mcp": True,
        "enable_ssh": False, "enable_remote_control": False,
    })
    legacy_config = (
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
    created_volumes = []
    try:
        for volume in (data_volume, config_volume):
            docker("volume", "create", volume)
            created_volumes.append(volume)
        # Named volumes prevent Linux root-owned private files from escaping into
        # a host temporary directory. Seeding and inspection also run as container
        # root, without weakening the add-on's runtime file permissions.
        docker(
            "run", "--rm", "--interactive", "--network", "none", *mounts,
            "--entrypoint", "/opt/ha-mcp/bin/python", args.image, "-c", SEED_DATA,
            input_text=json.dumps({
                "options.json": options,
                # Current Bashio reads Supervisor's options API. Seed its cache
                # so the real startup can run with synthetic options offline.
                ".smoke-supervisor-cache/addons.self.options.config.cache": options,
                ".codex/config.toml": legacy_config,
            }),
        )
        docker(
            "run", "--detach", "--name", container, "--network", "none",
            "--add-host", "supervisor:127.0.0.1", *mounts,
            "--env", f"SUPERVISOR_TOKEN={credential}",
            "--env", "CACHE_DIR=/data/.smoke-supervisor-cache",
            "--env", f"CODEX_VERSION={args.cli_version}",
            # Offline npm installation falls back to the bundled real CLI.
            "--env", "NPM_INSTALL_TIMEOUT_SECONDS=2",
            args.image,
        )
        first = verify(container)
        private = private_files(container)
        assert private["environment"]["HOMEASSISTANT_TOKEN"] == credential
        assert private["environment"]["FUZZY_THRESHOLD"] == "57"
        assert private["environment_mode"] == 0o600
        assert credential not in private["configuration"]
        docker("restart", "--time", "20", container, timeout=40)
        restarted = verify(container)
        after_restart = private_files(container)
        assert after_restart["config_sha256"] == private["config_sha256"]
        assert after_restart["environment"] == private["environment"]
        assert after_restart["environment_mode"] == 0o600
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
            try:
                docker("rm", "--force", container, check=False)
            finally:
                for volume in reversed(created_volumes):
                    docker("volume", "rm", "--force", volume, check=False)



if __name__ == "__main__":
    main()
