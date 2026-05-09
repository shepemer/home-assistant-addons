# Codex Terminal Documentation

## First Start

Open the Codex Terminal add-on from the Home Assistant sidebar. The terminal starts a persistent `tmux` session in `/config` and auto-launches Codex by default.

Codex stores its data in `/data/.codex`, and `/root/.codex` is linked there so authentication persists across add-on restarts and upgrades.

## Options

### `auto_launch`

Default: `true`

When enabled, the add-on starts Codex automatically inside the terminal session. When disabled, the terminal opens to a shell and provides a `codex` alias when the Codex CLI is available.

The Codex command uses `--dangerously-bypass-approvals-and-sandbox`. This is intentional for this add-on because the Home Assistant add-on container is the operational boundary.

### `enable_ha_mcp`

Default: `true`

When enabled, startup attempts to configure a Codex MCP server named `home_assistant` using the Supervisor token and `ha-mcp`. If the token, Home Assistant API, `uvx`, or Codex CLI is unavailable, startup logs a warning and continues without MCP.

## Mounted Paths

- `/config`: Home Assistant configuration, writable.
- `/addons`: local add-on sources, writable when Home Assistant provides a writable mount.
- `/share`: Home Assistant share directory, writable.
- `/data`: persistent add-on data.

## Codex CLI Version

The image includes `@openai/codex`. On startup, the add-on checks the npm `latest` dist-tag and installs that version into `/data/.npm-global` when needed. Network lookup and install failures are bounded and non-fatal; the add-on falls back to the best available installed CLI.

## Authentication

If `/data/.codex/auth.json` is missing, Codex will prompt for authentication in the terminal. After authentication, the file persists in add-on data and will be reused on later starts.

## Startup Package Hook

If `/data/startup-packages.sh` exists, the add-on runs it during startup. A failing startup hook logs the last output lines and does not prevent the terminal from starting.

Example:

```bash
#!/usr/bin/env bash
set -e

apk add --no-cache jq
```

## Troubleshooting

### Codex does not auto-launch

Check the add-on logs for npm lookup or install failures. If the Codex CLI is unavailable, the add-on still starts the web terminal so you can inspect the environment.

### Home Assistant MCP is unavailable

Check that `enable_ha_mcp` is enabled and the add-on logs show a successful Home Assistant API probe. MCP setup is optional and fails open so the terminal remains usable.

### Local add-on sources are missing

The add-on logs whether `/addons` is mounted and writable. Home Assistant controls this mount based on the add-on configuration and installation context.
