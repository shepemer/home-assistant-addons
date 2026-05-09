# Codex Terminal

Terminal interface for the OpenAI Codex CLI, packaged as a Home Assistant add-on.

## Features

- Home Assistant ingress panel backed by `ttyd` and `tmux`.
- Codex CLI installed in the image and updated on startup when a newer `latest` release is available.
- Persistent Codex auth and configuration in `/data/.codex`.
- Writable access to `/config`, `/addons`, and `/share`.
- Optional Home Assistant MCP server configuration using the Supervisor token.
- Optional `/data/startup-packages.sh` hook for user-managed startup customization.

## Security note

Codex is launched with `--dangerously-bypass-approvals-and-sandbox` by default. This is intentional for this terminal-style add-on because Home Assistant add-on containers already define the filesystem and API boundary. Only install and use this add-on on Home Assistant systems where you trust the users who can access the add-on.

See [DOCS.md](DOCS.md) for setup, options, and troubleshooting.
