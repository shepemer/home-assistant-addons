# Initial validation — 2026-09-10

App **1.0.0**, engine **1.12.4**. All work used disposable Docker resources on a macOS ARM64 workstation with Docker Engine 29.5.3. No production database, HA configuration, or installed app was accessed or changed.

## Completed locally

- Docker Hub registry inspection confirmed the official OSS `influxdb:1.12.4` index digest `sha256:b86ceeb9b6b0f56061d9a8071e13cef02229db513377952e5e8eb8080a369138`, with Linux amd64 and arm64 manifests. Both built images report engine `1.12.4` (commit `f9befe3459b689dc6dd1dd11e1e58e2943434ab1`).
- App images built for both architectures. The full [integration suite](tests/README.md) passed on native ARM64 and on amd64 through Docker Desktop emulation, with exit status 0:

  ```sh
  python3 influxdb/tests/integration.py --image home-assistant-influxdb:test --platform linux/arm64
  python3 influxdb/tests/integration.py --image home-assistant-influxdb:test-amd64 --platform linux/amd64
  ```

- Checks covered isolated fresh-admin bootstrap (including quote/backslash passwords), rejected invalid bootstrap/incomplete restore/linked files, authentication and reader restrictions, Docker health, unprivileged daemon, graceful stop, scoped ownership, and an unused upstream `/var/lib/influxdb` volume.
- HA-style writes and HomeScope's actual TypeScript client passed against the real engines: measurement/series discovery, historical and recent numeric data, mean aggregation, string states and preceding-state queries, escaped/custom measurements, and entity/domain tags. HomeScope required no changes.
- Data survived restart and container replacement. Existing metadata overrode different bootstrap credentials. RPC was unreachable from another container by default and reachable with explicit opt-in.
- A digest-pinned **1.8.10** fixture was populated, stopped, and copied with its entire metadata/data/WAL tree. Nonempty source WAL files were verified before and after stop. The upgraded copy preserved historical and recent points, exact nanosecond timestamps, tags, users/passwords/grants, unlimited default `autogen`, and a second retention policy. Deliberately incorrect restored ownership was repaired; the migrated writer accepted another point.
- Native portable backup and isolated online restore passed. Database data and retention policies restored, the destination's distinct administrator/password remained valid, and source users/grants were **not imported**. These observed fixture points do not establish a backup-completion recovery timestamp.
- Repository ShellCheck, yamllint, actionlint, the current `frenck/action-addon-linter@v2` implementation, and whitespace checks passed. The update resolver's read-only registry lookup passed; disposable updater fixtures checked version/digest changes, idempotence, downgrade rejection, and validation before file writes.
- Independent reviews covered the wrapper, test/CI behavior, and migration commands.

## Source verification and remaining checks

The reviewed [Supervisor revision](https://github.com/home-assistant/supervisor/blob/b44b4acbc21768765f70089c90d1a4d9daee5d48/supervisor/apps/app.py) identifies a local build when `image` is absent, exports `image.tar` for that app during backup, and imports the saved image during restore when needed. This verifies implementation behavior, not an executed Supervisor restore.

Still required on a disposable HA OS installation before production migration:

- Supervisor local installation/build, AppArmor and host permissions, boot ordering, native health/watchdog behavior, actual internal hostname/connectivity, and cold backup export/import including the saved image.
- Restore of the actual downloaded **old community app** backup and image, followed by rehearsal of the actual source database copy. The automated source fixture uses the official 1.8.10 engine, not the discontinued community wrapper or the user's data.
- Existing HA config-entry reconfiguration, end-to-end HA state-event writes, HomeScope UI verification, and operator acceptance/accounting of outage gaps and any post-cutover rollback reconciliation.

GitHub CI is configured to run on native amd64/aarch64 runners; its hosted results are recorded on the PR separately from these local results. Scheduled update-PR creation has not been executed. At validation time, the repository's **Allow GitHub Actions to create and approve pull requests** setting was disabled; the owner must enable it before the updater can open PRs. No repository permission setting was changed.

No scheduled database backups, companion, remote copy, notifications, app installation, production migration, release publication, or merge was performed.
