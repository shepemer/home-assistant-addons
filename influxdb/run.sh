#!/bin/bash
set -euo pipefail
umask 027

fail() {
    echo "InfluxDB: $*" >&2
    exit 1
}

# Never recurse through restored links or touch options.json/shared directories.
[[ ! -L /data/influxdb ]] || fail "Database directory must not be a symlink."
mkdir -p /data/influxdb
[[ -z "$(find /data/influxdb -xdev -type l -print -quit)" ]] ||
    fail "Database contains symlinks; restore regular files and directories only."
[[ -z "$(find /data/influxdb -xdev -type f -links +1 -print -quit)" ]] ||
    fail "Database contains hard links; restore independent files."
mkdir -p /data/influxdb/{meta,data,wal}
chown influxdb:influxdb /data/influxdb
chmod 0750 /data/influxdb
for directory in /data/influxdb/{meta,data,wal}; do
    find "$directory" -xdev ! -user influxdb -exec chown -h influxdb:influxdb {} +
    find "$directory" -xdev ! -group influxdb -exec chgrp -h influxdb {} +
    chmod 0750 "$directory"
done

# These settings also apply to native CLI commands launched via docker exec,
# through /etc/influxdb/influxdb.conf. Only this process overrides the RPC bind.
rpc_network=$(jq -er '.backup_rpc_network // false | tostring' /data/options.json)
case "$rpc_network" in
    true) export INFLUXDB_BIND_ADDRESS=0.0.0.0:8088 ;;
    false) export INFLUXDB_BIND_ADDRESS=127.0.0.1:8088 ;;
    *) fail "backup_rpc_network must be a boolean." ;;
esac

as_influxdb() {
    exec setpriv --reuid=influxdb --regid=influxdb --init-groups --no-new-privs "$@"
}

if [[ ! -f /data/influxdb/meta/meta.db ]]; then
    [[ -z "$(find /data/influxdb/{meta,data,wal} -mindepth 1 -print -quit)" ]] ||
        fail "Database files exist without meta/meta.db; restore all three directories before starting."
    # Validate without echoing option values. Existing metadata skips this entirely.
    jq -e '
      (.bootstrap_admin_username | type == "string") and
      (.bootstrap_admin_username | test("^[A-Za-z0-9][A-Za-z0-9_.-]*$")) and
      (.bootstrap_admin_password | type == "string") and
      (.bootstrap_admin_password | length >= 16) and
      (.bootstrap_admin_password | test("[\u0000-\u001f\u007f]") | not)
    ' /data/options.json > /dev/null 2>&1 ||
        fail "Fresh install requires a simple admin username and a password of at least 16 characters (no control characters)."

    # Bootstrap in disposable storage. A crash cannot leave public metadata with
    # no administrator; only a successfully initialized meta.db is installed.
    bootstrap_dir=$(mktemp -d /tmp/influxdb-bootstrap.XXXXXX)
    chown influxdb:influxdb "$bootstrap_dir"
    bootstrap_pid=""
    cleanup() {
        if [[ -n "$bootstrap_pid" ]]; then
            kill -TERM "$bootstrap_pid" 2>/dev/null || true
            wait "$bootstrap_pid" || true
        fi
        rm -rf "$bootstrap_dir"
    }
    trap cleanup EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    INFLUXDB_META_DIR="$bootstrap_dir/meta" \
    INFLUXDB_DATA_DIR="$bootstrap_dir/data" \
    INFLUXDB_DATA_WAL_DIR="$bootstrap_dir/wal" \
    INFLUXDB_HTTP_BIND_ADDRESS=127.0.0.1:8086 \
    INFLUXDB_BIND_ADDRESS=127.0.0.1:8088 \
        as_influxdb influxd -config /etc/influxdb/influxdb.conf &
    bootstrap_pid=$!
    ready=false
    for ((attempt = 0; attempt < 60; attempt++)); do
        kill -0 "$bootstrap_pid" 2>/dev/null || fail "Bootstrap engine stopped."
        if curl --fail --silent --max-time 1 http://127.0.0.1:8086/ping > /dev/null; then
            ready=true
            break
        fi
        sleep 1
    done
    [[ "$ready" == true ]] || fail "Bootstrap engine did not become ready."

    username=$(jq -r '.bootstrap_admin_username' /data/options.json)
    password=$(jq -r '.bootstrap_admin_password' /data/options.json)
    password=${password//\\/\\\\}
    password=${password//\'/\\\'}
    # A pipe keeps the password out of argv, URLs, logs and temporary files.
    response=$(printf 'CREATE USER "%s" WITH PASSWORD '\''%s'\'' WITH ALL PRIVILEGES' "$username" "$password" |
        curl --fail --silent --max-time 30 --request POST \
            --data-urlencode q@- http://127.0.0.1:8086/query) ||
        fail "Administrator bootstrap failed."
    unset username password
    jq -e '.error == null and (.results | length > 0) and all(.results[]; .error == null)' \
        <<< "$response" > /dev/null || fail "Administrator bootstrap failed."
    unset response
    kill -TERM "$bootstrap_pid"
    wait "$bootstrap_pid"
    bootstrap_pid=""
    # Copy then rename within the destination filesystem for atomic publication.
    install -o influxdb -g influxdb -m 0600 "$bootstrap_dir/meta/meta.db" /data/influxdb/meta/.bootstrap-meta
    mv /data/influxdb/meta/.bootstrap-meta /data/influxdb/meta/meta.db
    cleanup
    trap - EXIT INT TERM
    echo "InfluxDB: Administrator initialized; clear the bootstrap options after verifying access."
fi

echo "InfluxDB: Starting with existing metadata and authenticated HTTP on port 8086."
exec setpriv --reuid=influxdb --regid=influxdb --init-groups --no-new-privs \
    influxd -config /etc/influxdb/influxdb.conf
