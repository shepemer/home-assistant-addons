# Disposable integration checks

These checks create temporary Docker volumes, a temporary network and containers.
They never mount an existing database and clean up their own resources even on
failure. Generated credentials stay in memory and temporary options files; they
are not command arguments or committed fixtures. Only temporary HTTP ports bound
to the runner's loopback interface are published.

From the repository root, with Docker, Python 3.10+ and Node 22+ available:

```sh
npm ci --prefix homescope
docker build --build-arg BUILD_ARCH=amd64 --build-arg BUILD_VERSION=1.0.0 \
  --platform linux/amd64 -t home-assistant-influxdb:test influxdb
python3 influxdb/tests/integration.py \
  --image home-assistant-influxdb:test --platform linux/amd64
```

For an ARM64 runner, use `BUILD_ARCH=aarch64` and `--platform linux/arm64` in both
commands. The optional `--platform` also supports Docker's configured emulation.
The app image must already be built. The test pulls an exact pinned official
InfluxDB **1.8.10** image as its migration fixture.

The harness checks:

- Failed startup for missing/weak bootstrap options, an incomplete restore and
  linked restore files, without changing ownership outside the database tree.
- Real HTTP authentication and a restricted HA writer/HomeScope reader, Docker
  health, unprivileged PID 1, graceful shutdown and private persistent paths.
- HA-style line protocol with numeric and string fields, unit/custom measurement
  names, domain/entity/location tags and exact nanosecond timestamps.
- HomeScope's actual `testConnection`, `discoverSignals` and `querySignals`
  functions from `homescope/backend/src/influx.ts`: measurement and series
  discovery, raw values, mean aggregation, state boundary queries and entities
  sharing an ID across domains. No copied query implementation or mock server.
- Restart, container replacement and ignored bootstrap settings after metadata
  exists, plus backup RPC visibility from a separate container before/after opt-in.
- A cold **complete-directory** 1.8.10-to-current migration: source WAL files must
  actually exist, copied ownership is deliberately wrong, and historical/recent
  data, nanosecond timestamps, users/passwords/grants and retention policies must
  survive the upgrade. The migrated writer must also accept a new point.
- Native portable backup and online restore to a separate empty server, including
  restored data and retention policies. Source users/grants are deliberately
  checked as **not imported**; the target's bootstrap administrator remains.

Portable-backup fixture samples observed in a test are not a promise that every
write through backup completion is recoverable. These are disposable Docker
tests, not a test of production data or HA OS/Supervisor backup, restore,
networking or integration reconfiguration. See the app documentation for those
remaining deployment checks and the migration procedure.
