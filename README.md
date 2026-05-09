# Shep's Home Assistant Add-ons

Custom Home Assistant add-ons.

## Installation

1. In Home Assistant, go to **Settings** -> **Add-ons** -> **Add-on Store**.
2. Open the menu in the top right and choose **Repositories**.
3. Add this repository URL:

   ```text
   https://github.com/shepemer/home-assistant-addons
   ```

4. Refresh the add-on store and install the add-on you want.

## Add-ons

### Codex Terminal

Terminal interface for the OpenAI Codex CLI with Home Assistant MCP integration.

- Opens as a Home Assistant ingress panel.
- Persists Codex auth/configuration in the add-on data directory.
- Mounts `/config`, `/addons`, and `/share` so Codex can work with Home Assistant files.
- Optionally configures the Home Assistant MCP server using the Supervisor token.

See [Codex Terminal documentation](codex-terminal/DOCS.md) for configuration and troubleshooting.
