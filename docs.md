# Home Assistant Add-ons Docs

This file holds repository-level setup notes. Add-on-specific reference material lives in each add-on directory.

## Installation

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the menu in the top right and choose **Repositories**.
3. Add this repository URL.
4. Refresh the add-on store.
5. Select the add-on you want to install.

## Codex Terminal

Terminal interface for the OpenAI Codex CLI with Home Assistant MCP integration.

Important behavior:

- Opens as a Home Assistant ingress panel.
- Updates the Codex CLI during add-on startup when a newer `latest` release is available.
- Persists Codex authentication and configuration in the add-on data directory.
- Mounts `/config`, `/addons`, and `/share` so Codex can work with Home Assistant files.
- Optionally starts SSH access for Codex Remote SSH workflows.
- Optionally configures the Home Assistant MCP server using the Supervisor token.

If Codex Desktop reports a version mismatch over SSH, a manual add-on/container restart may be needed. Restart the Codex Terminal add-on from Home Assistant. Startup updates `@openai/codex` and writes the selected runtime environment for SSH and web terminal sessions.

See [Codex Terminal docs](codex-terminal/DOCS.md) for options, SSH setup, mounted paths, authentication, and troubleshooting.

## HomeScope

Interactive signal workbench for Home Assistant data stored in InfluxDB 1.x.

Important behavior:

- Opens as a Home Assistant ingress panel.
- Connects to an InfluxDB 1.x database with server-side credentials.
- Provides a dense signal catalog, chart panes, dual axes, zoom/pan, markers, saved workspaces, and local display styling.
- Keeps InfluxDB credentials in add-on options. Password values are never returned to the browser.

See [HomeScope docs](homescope/README.md) for installation and configuration.
