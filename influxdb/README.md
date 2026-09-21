# InfluxDB

InfluxDB OSS 1.x for Home Assistant Supervisor, using the official upstream Docker image and a small wrapper. The database stays on your Home Assistant computer and retains the v1 HTTP API and InfluxQL used by Home Assistant and HomeScope.

- Engine: InfluxDB OSS **1.13.1**.
- App version: **1.0.1**.
- Architectures: `amd64` and `aarch64`.
- Base image: exact official `influxdb` version and multi-platform digest pinned in [Dockerfile](Dockerfile).

Supervisor builds the image locally; there is no prebuilt app `image` field. Current Supervisor includes locally built images in app backups, which improves recovery when an app repository disappears. Keep a downloaded backup and rehearse recovery on the same architecture.

HTTP authentication is always enabled. Database metadata, shard data, and WAL live under private `/data/influxdb`. HTTP port 8086 is available to other apps; LAN publishing is disabled by default. Native backup RPC stays on localhost unless explicitly enabled for the internal app network.

Supervisor backups stop the database briefly to capture consistent files. Native backup/restore tools remain available. This app includes backup hooks only; it does not schedule backups, copy them remotely, or send notifications.

For a fresh installation, follow [setup and operation](DOCS.md). To replace community app `a0d7b954_influxdb` running engine 1.8.10, follow the [migration runbook](MIGRATION.md), including a disposable rehearsal and explicit cutover gap. Do not uninstall the old app or submit its removal repair while you still need its data.

See [maintenance and validation](DOCS.md#maintenance-and-validation) for CI, reviewable upstream update PRs, and the checks required before upgrading a real database.
