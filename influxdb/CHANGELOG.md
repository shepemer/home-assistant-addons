# Changelog

## 1.0.0

- Added a Supervisor app built locally from the digest-pinned official InfluxDB OSS 1.12.4 image for amd64 and aarch64.
- Added authenticated first-start setup, unprivileged database execution, private persistent paths, graceful shutdown, and health checks.
- Added cold Supervisor backups and native backup/restore hooks with localhost RPC by default.
- Documented fresh setup, isolated restore, and migration from community app 5.0.2 / engine 1.8.10, including cutover and rollback data handling.
- Added focused integration CI and reviewable upstream image update PRs; production migration and backup jobs remain outside this app.
