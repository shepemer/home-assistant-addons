# Home Assistant Add-ons

Custom Home Assistant add-ons.

## Installation

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the menu in the top right and choose **Repositories**.
3. Add this repository URL.
4. Refresh the add-on store.
5. Select the add-on you want to install.

## Add-ons

### Codex Terminal

Terminal interface for the OpenAI Codex CLI with Home Assistant MCP integration.

- Opens as a Home Assistant ingress panel.
- Persists Codex authentication and configuration in the add-on data directory.
- Mounts `/config`, `/addons`, and `/share` so Codex can work with Home Assistant files.
- Optionally configures the Home Assistant MCP server using the Supervisor token.

See [Codex Terminal documentation](codex-terminal/DOCS.md) for configuration and troubleshooting.

### HomeScope

Interactive signal workbench for Home Assistant data stored in InfluxDB 1.x.

- Opens as a Home Assistant ingress panel.
- Connects to an InfluxDB 1.x database with server-side credentials.
- Provides a dense signal catalog, chart panes, dual axes, zoom/pan, keyboard shortcuts, A/B measurements, markers, event overlays, saved workspaces, and local display styling.
- Keeps InfluxDB credentials in add-on options. Password values are never returned to the browser.

See [HomeScope documentation](homescope/README.md) for installation and configuration.
