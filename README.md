# Home Assistant Add-ons

Custom Home Assistant add-ons for Codex Terminal and HomeScope.

## AI-Generated Code Disclaimer

The code and documentation in this repository were generated with AI assistance. Review the implementation, add-on configuration, and security settings before using them on a real Home Assistant system.

## Codex Version Mismatch? Restart The Add-On/Container

If Codex Desktop reports a Codex version mismatch when connecting to Codex Terminal over SSH, a manual add-on/container restart may be needed. Restart the **Codex Terminal** add-on from Home Assistant.

The add-on updates `@openai/codex` on startup, then makes the selected runtime available to both the web terminal and SSH sessions. A restart is the expected fix when Codex detects an older SSH-side CLI.

## Quick Install

Add this repository URL in Home Assistant under **Settings** -> **Add-ons** -> **Add-on Store** -> **Repositories**, then install the add-on you want.

## Add-Ons

- **Codex Terminal**: Codex CLI in a Home Assistant ingress terminal, with optional SSH, Home Assistant MCP, and `/config`, `/addons`, `/share` access.
- **HomeScope**: Interactive signal workbench for Home Assistant data stored in InfluxDB 1.x.

## Docs

- [Repository docs](docs.md)
- [Codex Terminal docs](codex-terminal/DOCS.md)
- [HomeScope docs](homescope/README.md)
