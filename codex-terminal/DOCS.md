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

### `enable_ssh`

Default: `false`

When enabled, the add-on starts an SSH server inside the Codex Terminal container on container port `2222`. SSH can use authorized keys, a configured username/password, or both. Logins use the root-backed Codex runtime so mount permissions match the web terminal. The Home Assistant network setting defaults the host port to `2222`, but you can change it if that port is already in use.

SSH access can operate on writable `/config`, `/addons`, and `/share`. Password SSH should only be exposed on a trusted LAN, VPN, or Tailscale path. Do not forward SSH directly to the public internet.

SSH starts when at least one login method is configured: `ssh_password` or `ssh_authorized_keys`.

### `ssh_username`

Default: `root`

Username accepted for SSH password access. Custom usernames are mapped into the same root-backed Codex runtime so mounted paths, Codex configuration, and Home Assistant permissions match the web terminal.

### `ssh_password`

Default: empty

Password allowed for SSH login when `enable_ssh` is enabled. Leave this empty to keep password authentication disabled and use key-only SSH.

Password-only example:

```yaml
enable_ssh: true
ssh_username: codex
ssh_password: "use-a-long-unique-password"
ssh_authorized_keys: []
```

### `ssh_authorized_keys`

Default: `[]`

Public SSH keys allowed to log in when `enable_ssh` is enabled. Keys can be used by themselves or together with `ssh_password`.

Example:

```yaml
enable_ssh: true
ssh_authorized_keys:
  - "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... codex@workstation"
```

Key plus password example:

```yaml
enable_ssh: true
ssh_username: codex
ssh_password: "use-a-long-unique-password"
ssh_authorized_keys:
  - "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... shep@mac-mini"
```

Generate a dedicated key on your Mac mini:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ha_codex_terminal_ed25519 -C "codex-terminal"
```

Example SSH config on the Mac mini:

```sshconfig
Host ha-codex-terminal
  HostName homeassistant.local
  Port 2222
  User root
  IdentityFile ~/.ssh/ha_codex_terminal_ed25519
```

Verify the remote environment:

```bash
ssh ha-codex-terminal 'codex --version && codex mcp list'
```

### `enable_remote_control`

Default: `false`

When enabled, the add-on starts the experimental Codex remote-control daemon after Codex auth and MCP setup. The normal npm-installed Codex CLI is still used for the terminal and MCP setup, but remote-control requires the standalone Codex install managed by the Codex installer.

If `/data/.codex/packages/standalone/current/codex` is missing, startup downloads and runs the official installer:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

The standalone install is stored under `/data/.codex` and persists across add-on restarts. The add-on uses `codex app-server daemon bootstrap --remote-control` when the installed Codex version supports it, with a fallback to `codex remote-control start --json` for older versions. Both startup paths pass `managed_dir="/config"` so the remote session opens against the Home Assistant config workspace. If Codex is not authenticated yet, remote-control is skipped with a warning; run `codex login` from the web terminal, then restart the add-on.

Remote-control is started from `/config`, and startup sets `managed_dir = "/config"` and marks `/config`, `/addons`, and `/share` as trusted Codex projects in `/data/.codex/config.toml`. This gives remote sessions the same Home Assistant filesystem context as the web terminal.

## Mounted Paths

- `/config`: Home Assistant configuration, writable.
- `/addons`: local add-on sources, writable when Home Assistant provides a writable mount.
- `/share`: Home Assistant share directory, writable.
- `/data`: persistent add-on data.

## Codex CLI Version

The image includes `@openai/codex`. On startup, the add-on checks the npm `latest` dist-tag and installs that version into `/data/.npm-global` when needed. Network lookup and install failures are bounded and non-fatal; the add-on falls back to the best available installed CLI.

## Home Assistant CLI

The image includes the official Home Assistant `ha` CLI. The add-on wrapper configures the Supervisor endpoint and token automatically, so agents and terminal users can inspect or manage Home Assistant from inside the container.

Examples:

```bash
ha core info
ha core check
ha supervisor info
```

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

### SSH does not start

Confirm `enable_ssh` is enabled, at least one `ssh_authorized_keys` entry is configured, and `2222/tcp` is mapped to a host port in the add-on network settings.

### Codex remote-control does not start

Confirm Codex auth is configured with `codex login status` in the web terminal. If the standalone install fails, check the add-on logs for `codex install` output.

### Home Assistant MCP is unavailable

Check that `enable_ha_mcp` is enabled and the add-on logs show a successful Home Assistant API probe. MCP setup is optional and fails open so the terminal remains usable.

### Local add-on sources are missing

The add-on logs whether `/addons` is mounted and writable. Home Assistant controls this mount based on the add-on configuration and installation context.
