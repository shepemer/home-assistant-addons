# Migration from the community InfluxDB app

This is a runbook to execute later, after reviewing and rehearsing it. Implementing this app does not migrate the live database.

The source is community app `a0d7b954_influxdb` version **5.0.2**, engine **InfluxDB OSS 1.8.10**, at `http://a0d7b954-influxdb:8086`. The initial target is this app version **1.0.0**, engine **InfluxDB OSS 1.12.4**, on the same amd64 HA OS computer. `homeassistant` uses default retention policy `autogen` with unlimited retention; the `homeassistant` account writes and `homescope` reads.

The chosen path is a complete **stopped-directory copy** of `meta`, `data`, and `wal`, followed by upgrade on the copy. This retains password hashes, grants, database/retention metadata, shard indexes, original points, and persisted WAL. Never attach the upgraded engine to the only source copy. Portable backup/restore alone does not preserve users, and its recent-write coverage is not a substitute for this cold copy; see [backup limitations](DOCS.md#manual-portable-backup).

**Do not submit the current repair warning for the old app. That action uninstalls it and deletes its private data.** Keep the old installation, source backup, and source image until rollback is no longer needed.

## 1. Inventory and choose the outage window

Record the installed HA OS/Supervisor/Core versions, source app and engine versions, old URL, database, default retention policy, app network options, and the existing HA InfluxDB config entry. Keep credentials in your password manager and current app/config-entry settings, not in this repository or command logs. Do not export all app options into a public troubleshooting log.

Using the source administrator account, record the following without changing anything:

```sql
SHOW DATABASES
SHOW USERS
SHOW GRANTS FOR "homeassistant"
SHOW GRANTS FOR "homescope"
SHOW RETENTION POLICIES ON "homeassistant"
SHOW CONTINUOUS QUERIES
SHOW SUBSCRIPTIONS
```

Record any customized source environment settings, index type, and non-default directories. The [community app's versioned configuration](https://github.com/hassio-addons/addon-influxdb/blob/v5.0.2/influxdb/rootfs/etc/influxdb/influxdb.conf) uses `/data/influxdb/meta`, `/data/influxdb/data`, and `/data/influxdb/wal`. Confirm the running source uses those paths; if it has overrides, collect their matching complete directories instead. Do not delete/rebuild indexes or change retention during this migration.

Choose several real numeric and string-state entities already visible in HomeScope. Record their actual measurement names, tag sets, field names/types, old timestamps, and recent values. Include a fixed historical interval and the latest few points. Save query results for comparison; a count alone cannot prove values and timestamps survived.

This procedure intentionally pauses HA's only native InfluxDB writer twice: once to capture the rehearsal source, then for final cutover. Record UTC start/end times for each pause. Events that occur while the integration is disabled are not automatically replayed from Recorder. Existing retries are not a durable spool and do not make the pause lossless. There is an expected InfluxDB gap for those events, including events lost from any failed or undrained write before shutdown.

If that gap is unacceptable, stop before the outage and separately implement and validate a durable capture/replay path that retains the exact line protocol, nanosecond timestamps, field types, tags, and destination retention policy for every write during the window. That is additional work, not a feature of this app. Do not configure a second native InfluxDB integration for dual writing, and do not assume polling current states reconstructs missed transitions.

## 2. Capture a recoverable source before changing it

Use **Settings → Devices & services → InfluxDB** to disable the existing config entry. Keep it; do not delete/recreate it. Wait for queued writes to settle, inspect HA for write errors, and record the latest visible source points. Disable automatic updates of the old app during this work, and record its boot/watchdog settings for rollback.

The following commands require an HA OS host console or an already-authorized administrative Docker shell. They are not run inside this app, and do not require granting this app extra permissions. Use a dedicated shell with `set -eu` as shown so a failed safety check stops execution; do not continue past an error. Resolve the running source container's actual `/data` mount before stopping it:

```sh
set -eu
OLD_SLUG=a0d7b954_influxdb
OLD_CONTAINER="addon_${OLD_SLUG}"
OLD_DATA=$(docker inspect "$OLD_CONTAINER" --format \
  '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
OLD_IMAGE=$(docker inspect "$OLD_CONTAINER" --format '{{.Config.Image}}')
test -n "$OLD_DATA"
test -s "$OLD_DATA/influxdb/meta/meta.db"
test -d "$OLD_DATA/influxdb/data"
test -d "$OLD_DATA/influxdb/wal"
test ! -L "$OLD_DATA/influxdb"
test -z "$(find "$OLD_DATA/influxdb" -xdev -type l -print -quit)"
test -z "$(find "$OLD_DATA/influxdb" -xdev -type f -links +1 -print -quit)"
```

The wrapper rejects symlinks and hard-linked database files. If these checks fail, investigate without modifying the source. Materialize any legitimate hard-linked files as independent regular files in a disposable copy before archiving/rehearsing; do not dereference arbitrary symlinks into other host directories. Resolve that layout before scheduling the final copy.

Choose a new absolute directory on the host with enough free disk space, outside either app's private directory. Preserve these variable values in a private operator note for later steps; the paths contain no passwords.

```sh
MIGRATION_DIR='<absolute-protected-host-directory>'
mkdir -m 700 "$MIGRATION_DIR"
docker image save -o "$MIGRATION_DIR/old-app-image.tar" "$OLD_IMAGE"
```

Stop the old app through Supervisor and confirm it remains stopped. Its [5.0.2 manifest](https://github.com/hassio-addons/addon-influxdb/blob/v5.0.2/influxdb/config.yaml) does not request cold backups, so do not assume a running-source Supervisor backup is consistent. While it is stopped:

1. In **Settings → System → Backups**, create a backup that includes the old app and Home Assistant configuration. Confirm success, download it to independent storage, and preserve the backup encryption key/emergency kit. The old app uses a prebuilt image; do not assume that backup includes its discontinued image. Retain the image export above alongside it.
2. Create the cold database archive below. Do not copy while `influxd` is running. This archive is for transfer/rehearsal, not a replacement for the complete Supervisor backup.

```sh
test ! -e "$MIGRATION_DIR/source-cold.tar"
tar -C "$OLD_DATA" -cpf "$MIGRATION_DIR/source-cold.tar" influxdb
tar -tf "$MIGRATION_DIR/source-cold.tar"
(cd "$MIGRATION_DIR" && sha256sum source-cold.tar old-app-image.tar) \
  > "$MIGRATION_DIR/SHA256SUMS"
```

Confirm the archive contains `influxdb/meta/meta.db` and both the data and WAL trees, including any `_series` and shard index files. Protect it as sensitive data: it contains password hashes and home history. Copy it, the image export, and checksums to the rehearsal workstation and independent storage; verify checksums after transfer.

Restart the old app, confirm authenticated access, and re-enable the existing HA writer at its unchanged old URL. Confirm fresh points resume and record the first pause's end. Keep the source serving normally while rehearsing. These later writes will be included in a **new final cold copy**, not silently discarded by reusing this rehearsal archive.

## 3. Rehearse restoration and the engine upgrade

First test restoring the downloaded Supervisor source backup on a **disposable amd64 HA OS installation** isolated from production devices and clients. Load the saved old image with `docker image load -i old-app-image.tar` on that test host if it is no longer available from its registry. Confirm that the source app, options, credentials, retention policy, and recent data recover. Do not restore the source backup over your working production system just to test it.

For a smaller engine rehearsal, use a Docker workstation and a separate copy of `source-cold.tar`. This tests the copy/upgrade path, not Supervisor archive packaging:

```sh
set -eu
docker build -t local/influxdb-migration ./influxdb
MIGRATION_CASE=$(mktemp -d)
mkdir "$MIGRATION_CASE/app-data"
tar -xpf '<downloaded-source-cold.tar>' -C "$MIGRATION_CASE/app-data"
test -s "$MIGRATION_CASE/app-data/influxdb/meta/meta.db"
test -z "$(find "$MIGRATION_CASE/app-data/influxdb" -type l -print -quit)"
test -z "$(find "$MIGRATION_CASE/app-data/influxdb" -type f -links +1 -print -quit)"
printf '%s\n' '{"bootstrap_admin_username":"","bootstrap_admin_password":"","backup_rpc_network":false}' \
  > "$MIGRATION_CASE/app-data/options.json"
docker run -d --name influxdb-migration --network none \
  --mount "type=bind,src=$MIGRATION_CASE/app-data,dst=/data" \
  local/influxdb-migration
docker logs influxdb-migration
docker exec influxdb-migration curl --fail --silent http://127.0.0.1:8086/ping
docker exec -it influxdb-migration influx \
  -username '<existing-admin-username>' -password ''
```

Extract only your trusted archive into the new disposable directory. Run the target as amd64 (`--platform linux/amd64` on build/run if using an ARM workstation) to mirror this HA computer. Wait for readiness before the health/query commands. Use the existing source passwords at the hidden prompts. `--network none` prevents subscriptions or test clients from contacting production.

Compare all recorded users, grants, retention policies, fixed historical results, field types, tags, and last pre-backup points. Confirm the latest recorded source values survived, including writes made shortly before the source was stopped. Verify `autogen` remains default with duration `0s`, and authenticate separately as `homeassistant` and `homescope`. Do not change their passwords to make a failing test pass.

Exercise new writes only on the disposable database; confirm the writer succeeds and the reader can query but cannot write. Restart the container and replace it with another container mounting the same disposable directory; compare results again. Keep the original archive read-only and unchanged. The repository's integration fixture additionally exercises recent 1.8.10 writes and ownership repair, but a synthetic fixture does not establish that this real source copy upgrades successfully.

The [upstream upgrade guide](https://docs.influxdata.com/influxdb/v1/administration/upgrading/) describes configuration/index considerations and is still labeled 1.11; it is not a guarantee covering every direct 1.8.10-to-1.12.4 installation. Make successful rehearsal of this exact source copy a prerequisite to cutover. Stop here if any account, point, index, or retention comparison fails.

Stop the test container when finished (`docker stop --time 120 influxdb-migration`). Retain its results until the migration is accepted; never move an upgraded test directory back into the old app.

## 4. Install alongside the old app and identify the destination

Install the new **InfluxDB** app from this repository on the HA computer. Leave `8086/tcp` unpublished and `backup_rpc_network: false`. Distinct app containers can both listen internally on 8086 without conflict; the old host-port mapping can remain as it is. If external access is necessary, give the new app a different host port.

To establish that the new app builds and starts before the outage, follow the [fresh bootstrap steps](DOCS.md#fresh-installation) with a temporary unique administrator password, then clear its bootstrap options. Do not create client databases or point HA/HomeScope at it yet. This temporary empty instance will be replaced wholesale with the source tree, including the original accounts.

Find the new full slug and reported hostname from the app information page or:

```sh
ha addons list
ha addons info '<actual-new-full-slug>'
```

Record the actual hostname and verify it resolves from the internal app network. Do not guess a repository prefix or reuse `a0d7b954-influxdb`. The new URL is `http://<actual-new-hostname>:8086`.

From the host Docker shell, capture the destination's actual data mount while it runs, then stop the new app through Supervisor:

```sh
NEW_SLUG='<actual-new-full-slug>'
NEW_CONTAINER="addon_${NEW_SLUG}"
NEW_DATA=$(docker inspect "$NEW_CONTAINER" --format \
  '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
test -n "$NEW_DATA"
test "$NEW_DATA" != "$OLD_DATA"
```

## 5. Make the final cold copy and cut over

Disable the **existing** HA InfluxDB config entry again, leave it disabled, and record the UTC pause start. Wait for queued writes to settle and capture the latest source points. Stop HomeScope to avoid misleading old/new reads. Stop the old app through Supervisor, turn off its Start on boot during the migration, and confirm both database apps stay stopped.

Create and download another complete source Supervisor backup while the old app is stopped. Keep the first backup too. Repeat the cold archive capture using a **new filename**:

```sh
test ! -e "$MIGRATION_DIR/final-cold.tar"
tar -C "$OLD_DATA" -cpf "$MIGRATION_DIR/final-cold.tar" influxdb
(cd "$MIGRATION_DIR" && sha256sum final-cold.tar) \
  > "$MIGRATION_DIR/final-cold.sha256"
```

This final snapshot incorporates writes accepted by the old database after the rehearsal snapshot. Do not restart the old writer after this point. Copy the final archive and checksum to independent storage.

With both apps stopped, extract into a staging directory inside the **new app's** private data mount. Verify the complete tree, preserve the temporary fresh tree, then move the staged database into place. Never copy the old `options.json`, never overlay shards onto an existing database, and never alter the source tree:

```sh
set -eu
test -n "$NEW_DATA"
test -n "$OLD_DATA"
test "$NEW_DATA" != "$OLD_DATA"
test -d "$NEW_DATA/influxdb"
test ! -e "$NEW_DATA/migration-staging"
test ! -e "$NEW_DATA/influxdb-before-migration"
mkdir "$NEW_DATA/migration-staging"
tar -xpf "$MIGRATION_DIR/final-cold.tar" -C "$NEW_DATA/migration-staging"
test -s "$NEW_DATA/migration-staging/influxdb/meta/meta.db"
test -d "$NEW_DATA/migration-staging/influxdb/data"
test -d "$NEW_DATA/migration-staging/influxdb/wal"
test -z "$(find "$NEW_DATA/migration-staging/influxdb" -type l -print -quit)"
test -z "$(find "$NEW_DATA/migration-staging/influxdb" -type f -links +1 -print -quit)"
mv "$NEW_DATA/influxdb" "$NEW_DATA/influxdb-before-migration"
mv "$NEW_DATA/migration-staging/influxdb" "$NEW_DATA/influxdb"
rmdir "$NEW_DATA/migration-staging"
```

Start only the new app. The wrapper repairs ownership inside its database tree and starts with restored metadata. If it requests fresh bootstrap credentials, stop: the copied metadata is missing or misplaced. Do not initialize a replacement database. Check logs for recovery errors, then repeat account, retention, historical, and latest-source-point checks before enabling HA writes. Retain the temporary `influxdb-before-migration` directory until the transfer is verified; it can then be removed manually to avoid enlarging later backups.

In **Settings → Devices & services → InfluxDB**, use the existing entry's **Reconfigure** action. Change only the URL to `http://<actual-new-hostname>:8086`; keep API v1, `homeassistant`, the existing `homeassistant` credentials, and existing measurement/tag/filter/precision settings. Do not add YAML connection configuration or create a second integration. Preserve the disabled state until ready, then enable/reload that entry. The [current HA config flow](https://github.com/home-assistant/core/blob/dev/homeassistant/components/influxdb/config_flow.py) supports updating and reloading the existing entry. If your installed Core lacks Reconfigure, stop and resolve that version-specific UI path before editing live storage files.

In HomeScope's Configuration, change **only** `influx_url` to the same new URL. Keep `influx_database: homeassistant`, `influx_username: homescope`, and its existing password. Save and restart HomeScope.

## 6. Verify writes and reads, then keep rollback available

Check `/ping` and engine version, then authenticate separately with both existing client accounts. Record the UTC time when HA writes resume and a real new state change is visible; that closes the cutover gap. Confirm HA has no authentication, connection, missing-database, or write errors.

Use HomeScope's real catalog and plot flows: entity search, historical numeric chart, recent numeric chart, a wide aggregated view, and a string-state interval whose previous state began before the visible interval. This exercises the query builders in [HomeScope's backend](../homescope/backend/src/influx.ts), including these shapes. Substitute actual source measurements/tags/fields and fixed UTC boundaries:

```sql
SHOW MEASUREMENTS
SHOW SERIES FROM "°C" LIMIT 1000 OFFSET 0
SELECT "value" AS value FROM "°C" WHERE "entity_id" = 'example_temperature' AND time >= '2026-01-01T00:00:00Z' AND time <= '2026-01-02T00:00:00Z' LIMIT 1000
SELECT mean("value") AS value FROM "°C" WHERE "entity_id" = 'example_temperature' AND time >= '2026-01-01T00:00:00Z' AND time <= '2026-01-02T00:00:00Z' GROUP BY time(5m) fill(none)
SELECT "state" AS state FROM "example_state_measurement" WHERE "entity_id" = 'example_state' AND time >= '2026-01-01T00:00:00Z' AND time <= '2026-01-02T00:00:00Z' LIMIT 1000
SELECT "state" AS state FROM "example_state_measurement" WHERE "entity_id" = 'example_state' AND time < '2026-01-01T00:00:00Z' ORDER BY time DESC LIMIT 1
```

Include all tags used by your real series; these names are examples, not renaming instructions. Confirm both old and post-cutover points retain their original schema and timestamps. Compare the final snapshot's latest known source points, not only the older rehearsal copy. Keep an explicit record of each unavailable interval; successfully receiving a current state does not fill its earlier transitions.

Create and download a cold Supervisor backup of the **new** app after verification, accounting for that backup's additional writer outage. Preserve the original old app stopped, its source backup/image, and the final cold archive for the agreed rollback period. This runbook does not uninstall either app or schedule future backups.

## Rollback

Before the first new write, rollback is straightforward: stop the new app, start the unchanged old app, reconfigure the existing HA entry back to `http://a0d7b954-influxdb:8086`, restore HomeScope's old `influx_url`, and enable/reload the writer. Verify both clients. Record another outage interval and restore the old app's boot/watchdog settings as appropriate.

After the new database has accepted writes, the old database is stale. Disable the writer, stop the new database, and preserve a complete cold new-app backup plus its image and exact engine version **before** switching back. Keep that recovery set even if service must resume immediately on the old database. Rollback alone does not copy post-cutover points; the reverted history will lack them until they are deliberately reconciled.

If preserving those new points in the old database is required, rehearse a separate export/import on disposable copies: export the relevant time interval from the stopped new copy with the matching `influx_inspect export` tool, explicitly passing `-datadir /data/influxdb/data -waldir /data/influxdb/wal` for that copy's mounted layout. The inspection tool does not infer these paths from the daemon configuration. Import the original line protocol into an isolated old-engine copy using the original database/retention policy and nanosecond precision, and compare numeric/string values, tags, timestamps, and boundary points. Review tombstones/deletions, duplicate-point field merges, and conflicting writes; the upstream export tool warns that WAL deletions are not applied, so exported data can resurrect deleted points. Preserve source metadata; do not import new users or retention changes blindly. This reconciliation is additional operator work and must be verified before claiming lossless rollback.

Never downgrade by mounting the upgraded 1.12.4 directory under 1.8.10. Recover the untouched old directory or its tested source backup. Keep the new post-cutover recovery set until reconciliation is complete or its omission has been explicitly accepted.
