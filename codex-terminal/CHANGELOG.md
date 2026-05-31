# Changelog

## 1.1.0

- Added optional key-only SSH access to the Codex Terminal container for remote Codex workflows.
- Added optional experimental Codex remote-control daemon startup.
- Added standalone Codex installer support for remote-control while keeping npm Codex for terminal and MCP workflows.
- Added process tooling and daemon bootstrap support for Codex app-server remote-control startup.
- Start remote-control from `/config` and mark mounted Home Assistant paths as trusted Codex projects.
- Set Codex `managed_dir` to `/config` so remote-control app sessions open against Home Assistant files.

## 1.0.0

- Initial v1.0 release of Codex Terminal.
- Added Home Assistant ingress terminal with Codex auto-launch.
- Added persistent Codex configuration and authentication storage.
- Added Home Assistant MCP setup using the Supervisor token.
- Added writable mounts for `/config`, `/addons`, and `/share`.
- Added startup hardening so optional Codex updates, MCP setup, and startup hooks fail open.
