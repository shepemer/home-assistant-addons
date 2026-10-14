#!/opt/ha-mcp/bin/python
"""Migrate only the add-on's HA transport; keep credentials private and persistent."""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

import tomlkit

ENDPOINT = "http://127.0.0.1:8765/mcp"
SUPERVISOR_URL = "http://supervisor/core"


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def server_environment(saved, inherited):
    environment = dict(saved)
    environment.setdefault("HOMEASSISTANT_URL", SUPERVISOR_URL)
    # Supervisor tokens rotate on restart. Custom HA endpoints/tokens remain intact.
    if environment["HOMEASSISTANT_URL"].rstrip("/") == SUPERVISOR_URL:
        token = inherited.get("SUPERVISOR_TOKEN")
        if token:
            environment["HOMEASSISTANT_TOKEN"] = token
    if not environment.get("HOMEASSISTANT_TOKEN"):
        raise ValueError("Home Assistant credentials unavailable")
    return environment


def migrate(config_path, environment_path):
    document = tomlkit.parse(config_path.read_text() if config_path.exists() else "")
    servers = document.setdefault("mcp_servers", tomlkit.table())
    server = servers.setdefault("home_assistant", tomlkit.table())
    saved = json.loads(environment_path.read_text()) if environment_path.exists() else {}
    for name in server.get("env_vars", []):
        if isinstance(name, str) and name in os.environ:
            saved[name] = os.environ[name]
    saved.update(server.get("env", {}))
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in saved.items()):
        raise ValueError("Invalid Home Assistant environment")
    saved = server_environment(saved, os.environ)
    for name in ("command", "args", "env", "env_vars", "cwd", "experimental_environment"):
        server.pop(name, None)
    server["url"] = ENDPOINT
    # Save the old stdio environment before removing it from config. Both writes
    # are atomic and private; interrupted migration is safe to run again.
    atomic_write(environment_path, json.dumps(saved) + "\n")
    atomic_write(config_path, tomlkit.dumps(document))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("/data/.codex/config.toml"))
    parser.add_argument("--environment", type=Path, default=Path("/data/.codex/ha-mcp-env.json"))
    parser.add_argument("--exec", action="store_true", dest="execute")
    args = parser.parse_args()
    try:
        if args.execute:
            saved = server_environment(json.loads(args.environment.read_text()), os.environ)
            environment = dict(os.environ)
            environment.update(saved)
            os.execve("/opt/ha-mcp/bin/python", ["/opt/ha-mcp/bin/python",
                      "/usr/local/libexec/ha-mcp-server.py"], environment)
        else:
            migrate(args.config, args.environment)
    except Exception:
        # Parse/OS exceptions can contain config values. Never log their text.
        print("Home Assistant MCP configuration failed; check private config and credentials", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
