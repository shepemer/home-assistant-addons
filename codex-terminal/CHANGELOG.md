# Changelog

## 1.0.0

- Initial v1.0 release of Codex Terminal.
- Added Home Assistant ingress terminal with Codex auto-launch.
- Added persistent Codex configuration and authentication storage.
- Added Home Assistant MCP setup using the Supervisor token.
- Added writable mounts for `/config`, `/addons`, and `/share`.
- Added startup hardening so optional Codex updates, MCP setup, and startup hooks fail open.
