# Codex Terminal

Terminal interface for the OpenAI Codex CLI, packaged as a Home Assistant add-on.

## AI-Generated Code Disclaimer

The code and documentation for this add-on were generated with AI assistance. Review the implementation, add-on configuration, and security settings before using it on a real Home Assistant system.

## Version Mismatch? Restart The Add-On/Container

If Codex Desktop reports a Codex version mismatch when connecting over SSH, a manual add-on/container restart may be needed. Restart the **Codex Terminal** add-on from Home Assistant.

The add-on updates `@openai/codex` on startup and applies the selected runtime to both web terminal and SSH sessions. A restart is the expected fix when Codex detects an older SSH-side CLI.

## Features

- Home Assistant ingress panel backed by `ttyd` and `tmux`.
- Codex CLI installed in the image and updated on startup when a newer `latest` release is available for web and SSH sessions.
- Persistent Codex auth and configuration in `/data/.codex`.
- Writable access to `/config`, `/addons`, and `/share`.
- Home Assistant `ha` CLI available inside the container using the Supervisor token.
- Optional Home Assistant MCP server configuration using the Supervisor token.
- Optional SSH access for Codex remote SSH workflows from another machine.
- Optional experimental Codex remote-control daemon support.
- Optional `/data/startup-packages.sh` hook for user-managed startup customization.

For full setup, options, and troubleshooting, see [DOCS.md](DOCS.md).

## Security note

Codex is launched with `--dangerously-bypass-approvals-and-sandbox` by default. This is intentional for this terminal-style add-on because Home Assistant add-on containers already define the filesystem and API boundary. Only install and use this add-on on Home Assistant systems where you trust the users who can access the add-on.
