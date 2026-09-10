# InfluxDB documentation

For an existing community InfluxDB installation, use [MIGRATION.md](MIGRATION.md) before connecting clients. The fresh-install steps below create new accounts and are not a migration procedure.

## Fresh installation

1. Add this repository to the Supervisor app store and install **InfluxDB**. Leave the Network host port for `8086/tcp` empty and `backup_rpc_network: false`.
2. Set `bootstrap_admin_username` to a dedicated administrator name using letters, digits, `_`, `.`, or `-`, starting with a letter/digit. Set `bootstrap_admin_password` to a unique password of at least 16 characters with no control characters. Save it in your password manager. Use the app Configuration UI, not a committed configuration file.
3. Start the app. On a truly empty database, the wrapper creates only the administrator through a temporary localhost-only engine before opening the normal HTTP service. It does not create `homeassistant` or change retention policies.
4. Wait for the database HTTP listener to start and verify an authenticated `SHOW USERS` query using the CLI below. Clear both bootstrap options after verifying access and save them. They are not a password-reset mechanism; the administrator remains in database metadata.
5. Connect with the bundled `influx` CLI or a trusted v1 administration client, authenticate, and create the database and separate client accounts below. No Chronograf or ingress interface is bundled.

The CLI examples use an administrative Docker shell on the HA OS host, or your disposable Docker workstation. A normal protected terminal app does not have access to sibling containers. This app itself does not receive Docker or Supervisor API access. Find the app's actual full slug using its information page or `ha addons list`, then substitute it below:

```sh
APP_SLUG='<actual-repository-prefix>_influxdb'
APP_CONTAINER="addon_${APP_SLUG}"
docker exec -it "$APP_CONTAINER" influx -host 127.0.0.1 \
  -username '<your-admin-username>' -password ''
```

The empty password argument requests a hidden prompt; never put a real password in a command-line argument. In the authenticated InfluxQL shell, use unique passwords in place of these placeholders. Do not record the terminal session or commit its contents. InfluxQL strings escape a backslash as `\\` and a single quote as `\'`.

```sql
CREATE DATABASE "homeassistant" WITH DURATION INF REPLICATION 1 NAME "autogen"
CREATE USER "homeassistant" WITH PASSWORD '<unique-writer-password>'
GRANT ALL ON "homeassistant" TO "homeassistant"
CREATE USER "homescope" WITH PASSWORD '<unique-reader-password>'
GRANT READ ON "homeassistant" TO "homescope"
SHOW RETENTION POLICIES ON "homeassistant"
SHOW GRANTS FOR "homeassistant"
SHOW GRANTS FOR "homescope"
```

Confirm `autogen` is default and its duration is `0s` (unlimited). `ALL` here grants database read/write privileges, not administrator privileges. HomeScope receives only `READ`. The [upstream CLI documentation](https://docs.influxdata.com/influxdb/v1/tools/influx-cli/use-influx-cli/) describes password prompting and interactive authentication.

## Options and existing data

| Option | Default | Behavior |
| --- | --- | --- |
| `bootstrap_admin_username` | empty | Administrator created only for an empty database. |
| `bootstrap_admin_password` | empty | At least 16 characters for initial setup; ignored when valid metadata already exists. |
| `backup_rpc_network` | `false` | Bind native backup RPC to `127.0.0.1:8088`; when true, bind `0.0.0.0:8088` inside the app network. |

Existing `/data/influxdb/meta/meta.db` takes precedence over bootstrap options: startup does not recreate users, reset passwords, create databases, or change retention policies. A directory containing shard/WAL data without metadata is an incomplete restore and startup fails. Restore the complete matching set instead of bootstrapping over it.

Only `/data/influxdb` and its database directories receive ownership repair for the upstream `influxdb` user. The daemon runs unprivileged. All persistent database state is explicitly configured here:

| State | Path |
| --- | --- |
| Accounts, databases, retention metadata | `/data/influxdb/meta` |
| Shards and indexes | `/data/influxdb/data` |
| Write-ahead log | `/data/influxdb/wal` |

The inherited `/var/lib/influxdb` image volume is unused. There are no writable shared-folder mounts. Startup and database messages go to stdout/stderr, while HTTP query logging is disabled to avoid exposing credentials in query text.

## Networking and lifecycle

The service starts in Supervisor's `system` phase, boots automatically, and allows 120 seconds for graceful shutdown. Its Docker health check uses `/ping`; Supervisor uses container health for its watchdog. This endpoint intentionally requires no password and checks availability; an authenticated query is still needed to verify client credentials and restored data. Enable Watchdog on the app page if it is not already enabled.

Use the hostname reported for the installed app by `ha addons info "$APP_SLUG"`; repository prefixes vary. A typical endpoint is `http://<actual-hostname>:8086`, not `localhost` inside Home Assistant or HomeScope. Keep Home Assistant's existing InfluxDB v1 config entry and HomeScope's database and credentials; see the migration runbook for changing their endpoints.

Optional LAN HTTP access can be enabled by assigning a host port to `8086/tcp` in the Network settings. HTTP is unencrypted, including authenticated traffic. Prefer the internal network; if LAN publishing is needed, restrict it to a trusted network/VPN and use a distinct host port while the old app is installed. There is no host networking, ingress, or LAN RPC port mapping.

RPC port 8088 is a separate administrative interface without HTTP authentication. Enabling `backup_rpc_network` gives other containers on the internal app network backup **and restore** access; HTTP passwords do not protect it. Keep it false until a trusted future backup companion needs it, then disable it again when no longer needed. Do not add a host port mapping for 8088.

## Supervisor backup and recovery

Select this app in a Supervisor backup. Its `backup: cold` setting stops the app before copying private data, including WAL, and restarts it afterward if it was running. Check that shutdown and backup completed successfully; a failed or forcibly interrupted backup is not a verified recovery point. Writes cannot be accepted during this outage, which may last longer for a large database or image export. Home Assistant does not provide durable replay of every missed event.

The manifest deliberately omits `image`. In the [Supervisor source reviewed on 2026-09-10](https://github.com/home-assistant/supervisor/blob/b44b4acbc21768765f70089c90d1a4d9daee5d48/supervisor/apps/app.py), `need_build` detects this omission; backup exports `image.tar` for a locally built app, and restore can import that image when it is absent. This helps recover without the original repository or upstream registry, but it is not a cross-architecture image: rehearse a downloaded backup on the same architecture. Keep the backup encryption key/emergency kit where it can be recovered independently.

Restore a complete Supervisor app backup through Supervisor. Restore overwrites the selected app's private state, so first preserve any newer data you might need. Test actual Supervisor export/import on disposable HA OS before relying on this behavior for disaster recovery. The container integration test alone cannot validate Supervisor backup packaging.

## Manual portable backup

`influxd backup`, `influxd restore`, and `influx_inspect` remain available. Portable commands talk to the running server over RPC; they are separate from copying a stopped database directory.

Run this from the administrative Docker shell after resolving `APP_CONTAINER` above:

```sh
docker exec "$APP_CONTAINER" sh -eu -c '
  umask 077
  mkdir -p /data/manual-backups
  destination="/data/manual-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  test ! -e "$destination"
  influxd backup -portable -host 127.0.0.1:8088 "$destination"
  printf "%s\n" "$destination"
'
```

With no `-db` argument this backs up all databases. Record the printed path, exit status, engine version, and backup start/end times. Output is in this app's **private** `/data/manual-backups/<timestamp>`, not `/share` and not an independent disk. After successful completion, copy that exact directory to a protected location on the Docker host, then transfer it off the HA computer:

```sh
docker cp "$APP_CONTAINER:/data/manual-backups/<timestamp>" \
  '<protected-host-backup-directory>'
```

There is no scheduling, cleanup, retention policy, remote upload, or notification job. These manual files also enlarge subsequent Supervisor backups until you remove copies you no longer need.

Native backup does not capture the WAL files or in-memory cache as such; recent points may be outside the recoverable snapshot. Do not infer a recovery timestamp from successful completion, assume a sleep guarantees flushing, or promise that every acknowledged write during the backup is covered. For a complete stopped-state recovery point including persisted WAL, use a successful cold Supervisor backup or the stopped-directory procedure in [MIGRATION.md](MIGRATION.md). See [upstream backup limitations](https://docs.influxdata.com/influxdb/v1/administration/backup_and_restore/).

Portable restore preserves database/retention/shard metadata, but it is **not an account restore**. In the pinned engine's [metadata import implementation](https://github.com/influxdata/influxdb/blob/v1.12.4/services/meta/data.go#L812), the restore path imports databases and retention policies without copying users/password hashes or grants. Use a complete cold metadata/data/WAL restore to preserve existing credentials.

## Isolated portable restore example

Use a disposable Docker workstation, the same engine version that created the portable backup, and an unused data directory. Do not target the production container. Build the checked-out app image; make a private options file containing a new temporary admin password. The following prompts locally instead of putting the secret in shell history:

```sh
set -eu
docker build -t local/influxdb-restore ./influxdb
RESTORE_CASE=$(mktemp -d)
export RESTORE_CASE
mkdir "$RESTORE_CASE/app-data"
python3 - <<'PY'
import getpass
import json
import os
from pathlib import Path

password = getpass.getpass("Temporary restore admin password (16+ characters): ")
if len(password) < 16:
    raise SystemExit("Password is too short")
path = Path(os.environ["RESTORE_CASE"]) / "app-data/options.json"
with path.open("x", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
    json.dump({"bootstrap_admin_username": "restore_admin",
               "bootstrap_admin_password": password,
               "backup_rpc_network": False}, stream)
PY
docker run -d --name influxdb-restore --network none \
  --mount "type=bind,src=$RESTORE_CASE/app-data,dst=/data" \
  local/influxdb-restore
docker logs influxdb-restore
docker exec influxdb-restore curl --fail --silent http://127.0.0.1:8086/ping
docker cp '<portable-backup-directory>' influxdb-restore:/tmp/portable
docker exec influxdb-restore influxd restore -portable \
  -host 127.0.0.1:8088 -db homeassistant -newdb homeassistant_rehearsal \
  /tmp/portable
docker exec -it influxdb-restore influx -username restore_admin -password ''
```

Wait for readiness before `/ping` and restore. `--network none` prevents traffic to or from production; `docker exec` still accesses localhost inside the container. The restored database is `homeassistant_rehearsal`; omit `-db/-newdb` only when intentionally restoring all databases into an otherwise unused server. A portable restore cannot overwrite an existing database. Never drop a live database just to make this command succeed.

In the prompted shell, verify retention policies and historical numeric/string points with the query examples in the migration runbook, substituting `homeassistant_rehearsal`. `SHOW USERS` will contain the temporary admin, not the source accounts. Create disposable read/write users if exercising clients. Preserve the restore logs and results, then stop/remove only the named disposable container:

```sh
docker stop --time 120 influxdb-restore
docker rm -v influxdb-restore
```

The bind-mounted results remain in `$RESTORE_CASE`; remove them manually when the rehearsal is no longer needed. A portable backup spanning engine versions needs its own rehearsal; upstream's published compatibility rules are narrower than “any 1.x into any later 1.x.”

## Maintenance and validation

See [initial validation results and remaining HA OS checks](VALIDATION.md) for the checks actually executed for app 1.0.0.

The focused [InfluxDB CI workflow](../.github/workflows/influxdb-ci.yml) builds amd64 and aarch64 using the repository's Home Assistant builder convention and runs container integration checks with HomeScope's actual query code. Local invocation after building the image:

```sh
docker build -t local/influxdb-test ./influxdb
npm ci --prefix homescope
python3 influxdb/tests/integration.py --image local/influxdb-test
```

The [update workflow](../.github/workflows/update-influxdb.yml) checks weekly and on manual dispatch for a stable official OSS 1.x tag and digest supporting both architectures. It opens or refreshes a PR on `codex/update-influxdb-image`, updating the pin, app patch version, README, and changelog. It does not merge, publish, or deploy. Enable the repository Actions setting permitting pull-request creation. PRs made with `GITHUB_TOKEN` may need workflow approval before their CI runs; require passing CI before merging. See [GitHub's event-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

At implementation validation on 2026-09-10, this repository's **Allow GitHub Actions to create and approve pull requests** setting was disabled. The repository owner must enable it before scheduled update-PR creation can work. The setting was not changed, and scheduled PR creation was not tested.

Run the updater read-only with `python3 .github/scripts/update-influxdb.py --check`. Review engine release notes and the digest, then rehearse an upgrade of a fresh copy of the current database before accepting an update. The initial migration guide records the original 1.8.10 to 1.12.4 transition; it does not certify later upgrades.

Container checks cannot establish that your production data, HA config entry, actual Supervisor DNS, watchdog, host permissions, or downloaded Supervisor backup will restore correctly. Record locally executed results separately from CI and production rehearsals; never treat an unrun check as a pass.
