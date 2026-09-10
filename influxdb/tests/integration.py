#!/usr/bin/env python3
"""Disposable Docker integration checks; never mount an existing database.

Prerequisites: Docker, Python >=3.10, Node >=22, npm ci --prefix homescope.
Usage: python3 influxdb/tests/integration.py --image home-assistant-influxdb:test
"""

from __future__ import annotations

import argparse
import base64
import json
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


OLD_IMAGE = (
    "influxdb:1.8.10@sha256:"
    "299ebda2c7e308dbef42e26ac9b8fd1d9b3bcb8a0aee80c6509aa0219c1d0290"
)
ROOT = Path(__file__).resolve().parents[2]
HISTORICAL_NS = 1704153600123456789


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run(*args, stdin=None, timeout=180, check_status=True):
    result = subprocess.run(
        args, input=stdin, text=True, capture_output=True, timeout=timeout, check=False
    )
    if check_status and result.returncode:
        # Commands never include credentials. HTTP setup and Node receive those
        # through in-memory request bodies/stdin; options are copied from a temp file.
        raise RuntimeError(f"Command failed: {' '.join(args)}\n{result.stderr}")
    return result


def sql_string(value):
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


class Harness:
    def __init__(self, image, platform):
        self.image = image
        self.platform = ["--platform", platform] if platform else []
        self.prefix = "influxdb-test-" + secrets.token_hex(5)
        self.containers = []
        self.volumes = []
        self.admin = ("bootstrap_admin", secrets.token_urlsafe(24) + "'\\\"$`")
        self.writer = ("homeassistant", secrets.token_urlsafe(24))
        self.reader = ("homescope", secrets.token_urlsafe(24))
        self.other_admin = ("ignored_admin", secrets.token_urlsafe(24))
        self.recent_ns = time.time_ns()
        self.urls = {}

    def docker(self, *args, **kwargs):
        return run("docker", *args, **kwargs)

    def volume(self, suffix):
        name = f"{self.prefix}-{suffix}"
        self.docker("volume", "create", name)
        self.volumes.append(name)
        return name

    def helper(self, volume, script, *extra_mounts):
        return self.docker(
            "run", "--rm", *self.platform, "--entrypoint", "/bin/sh",
            "-v", f"{volume}:/data", *extra_mounts, self.image, "-ec", script
        ).stdout.strip()

    def create(self, suffix, volume, *, old=False, rpc=False, options=None):
        name = f"{self.prefix}-{suffix}"
        image = OLD_IMAGE if old else self.image
        args = [
            "create", "--name", name, *self.platform,
            "--network", self.prefix, "-p", "127.0.0.1::8086",
            "-v", f"{volume}:/data"
        ]
        if old:
            args += [
                "--entrypoint", "influxd",
                "-e", "INFLUXDB_HTTP_AUTH_ENABLED=true",
                "-e", "INFLUXDB_HTTP_LOG_ENABLED=false",
                "-e", "INFLUXDB_META_DIR=/data/influxdb/meta",
                "-e", "INFLUXDB_DATA_DIR=/data/influxdb/data",
                "-e", "INFLUXDB_DATA_WAL_DIR=/data/influxdb/wal",
                "-e", "INFLUXDB_DATA_CACHE_SNAPSHOT_WRITE_COLD_DURATION=4h",
                "-e", "INFLUXDB_BIND_ADDRESS=127.0.0.1:8088"
            ]
        self.docker(*args, image)
        self.containers.append(name)
        if not old:
            settings = options if options is not None else {
                "bootstrap_admin_username": self.admin[0],
                "bootstrap_admin_password": self.admin[1],
                "backup_rpc_network": rpc
            }
            with tempfile.TemporaryDirectory(prefix=self.prefix) as tmp:
                path = Path(tmp) / "options.json"
                path.write_text(json.dumps(settings))
                path.chmod(0o600)
                self.docker("cp", str(path), f"{name}:/data/options.json")
        self.docker("start", name)
        return name

    def request(self, name, path, *, auth=None, data=None, params=None):
        url = self.urls[name] + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {}
        if auth:
            encoded = base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
            headers["Authorization"] = "Basic " + encoded
        body = data.encode() if isinstance(data, str) else data
        req = urllib.request.Request(url, body, headers)
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def query(self, name, query, *, auth=None, database="homeassistant"):
        body = urllib.parse.urlencode({"q": query, "db": database})
        status, text = self.request(name, "/query", data=body, auth=auth or self.admin)
        check(status == 200, f"Query failed with HTTP {status}")
        payload = json.loads(text)
        check(not payload.get("error"), "Query returned an error")
        check(not any(r.get("error") for r in payload["results"]), "InfluxQL query failed")
        return payload["results"][0].get("series", [])

    def wait(self, name, *, old=False):
        # Docker may allocate a different ephemeral host port after a restart.
        port = self.docker("port", name, "8086/tcp").stdout.strip().split(":")[-1]
        self.urls[name] = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            state = json.loads(self.docker("inspect", "-f", "{{json .State}}", name).stdout)
            check(state["Running"], "Container exited during startup")
            try:
                status, _ = self.request(name, "/ping")
                if status == 204:
                    if old or state.get("Health", {}).get("Status") == "healthy":
                        return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.5)
        raise AssertionError("Container failed its startup/health check")

    def write(self, name, lines, *, rp=None):
        params = {"db": "homeassistant", "precision": "ns"}
        if rp:
            params["rp"] = rp
        status, _ = self.request(name, "/write", auth=self.writer, params=params, data=lines)
        check(status == 204, f"HA-style line protocol write failed with HTTP {status}")

    def setup(self, name, *, old=False):
        if old:
            self.query(name, f'CREATE USER "{self.admin[0]}" WITH PASSWORD {sql_string(self.admin[1])} WITH ALL PRIVILEGES')
        self.query(name, 'CREATE DATABASE "homeassistant"')
        self.query(name, 'CREATE RETENTION POLICY "keep_30d" ON "homeassistant" DURATION 30d REPLICATION 1')
        for user, password in [self.writer, self.reader]:
            self.query(name, f'CREATE USER "{user}" WITH PASSWORD {sql_string(password)}')
        self.query(name, 'GRANT WRITE ON "homeassistant" TO "homeassistant"')
        self.query(name, 'GRANT READ ON "homeassistant" TO "homescope"')
        t = HISTORICAL_NS
        lines = [
            f"°C,domain=sensor,entity_id=living_room_temp,location=Living\\ room value=21.5 {t}",
            f"°C,domain=sensor,entity_id=living_room_temp,location=Living\\ room value=22.5 {t + 5_000_000_000}",
            f"W,domain=sensor,entity_id=total_power value=100 {t}",
            f"W,domain=sensor,entity_id=total_power value=200 {t + 5_000_000_000}",
            f"%,domain=sensor,entity_id=humidity value=40 {t}",
            f"custom\\ unit,domain=sensor,entity_id=custom_value value=2.5 {t}",
            f'state,domain=binary_sensor,entity_id=door state="off" {t - 5_000_000_000}',
            f'state,domain=binary_sensor,entity_id=door state="on" {t + 10_000_000_000}',
            f'state,domain=sensor,entity_id=door state="Open, after \\"rain\\"" {t}',
            f'state,domain=automation,entity_id=evening state="on" {t}',
            f'automation.evening,domain=automation,entity_id=evening value=1 {t}'
        ]
        self.write(name, "\n".join(lines))
        self.write(name, f"°C,domain=sensor,entity_id=living_room_temp,location=Living\\ room value=23.75 {self.recent_ns}")
        self.write(name, f"W,domain=sensor,entity_id=retained_power value=19 {self.recent_ns}", rp="keep_30d")

    def auth_checks(self, name):
        status, _ = self.request(name, "/query", params={"q": "SHOW DATABASES"})
        check(status == 401, "Unauthenticated query was accepted")
        status, _ = self.request(name, "/write", params={"db": "homeassistant"}, data="W value=9")
        check(status == 401, "Unauthenticated write was accepted")
        status, _ = self.request(name, "/query", params={"q": "SHOW DATABASES"}, auth=(self.admin[0], "wrong"))
        check(status == 401, "Incorrect password was accepted")
        status, _ = self.request(name, "/write", params={"db": "homeassistant"}, auth=self.reader, data="W value=9")
        check(status in (401, 403), "Read-only HomeScope account could write")

    def verify(self, name, *, homescope=True):
        self.auth_checks(name)
        users = self.query(name, "SHOW USERS")[0]["values"]
        check(sorted(users) == sorted([[self.admin[0], True], ["homeassistant", False], ["homescope", False]]), "User metadata changed")
        policies = self.query(name, 'SHOW RETENTION POLICIES ON "homeassistant"')[0]
        policy_rows = [dict(zip(policies["columns"], row)) for row in policies["values"]]
        check(any(p["name"] == "autogen" and p["duration"] == "0s" and p["default"] for p in policy_rows), "Default unlimited autogen retention changed")
        check(any(p["name"] == "keep_30d" and p["duration"] == "720h0m0s" and not p["default"] for p in policy_rows), "Secondary retention policy changed")
        result = self.query(name, 'SELECT "value", "domain", "entity_id", "location" FROM "°C" ORDER BY time ASC', auth=self.reader)[0]
        expected_times = [HISTORICAL_NS, HISTORICAL_NS + 5_000_000_000, self.recent_ns]
        status, text = self.request(name, "/query", auth=self.reader, params={
            "db": "homeassistant", "epoch": "ns",
            "q": 'SELECT "value", "domain", "entity_id", "location" FROM "°C" ORDER BY time ASC'
        })
        check(status == 200, "Timestamp read failed")
        exact = json.loads(text)["results"][0]["series"][0]
        check([row[0] for row in exact["values"]] == expected_times, "Nanosecond timestamps or recent WAL sample changed")
        check([row[1] for row in result["values"]] == [21.5, 22.5, 23.75], "Numeric values changed")
        check(all(row[2:] == ["sensor", "living_room_temp", "Living room"] for row in result["values"]), "Entity tags changed")
        check(self.query(name, 'SELECT "value" FROM "keep_30d"."W"', auth=self.reader)[0]["values"][0][1] == 19, "Secondary RP data lost")
        if homescope:
            result = run(
                "node", str(ROOT / "homescope/node_modules/tsx/dist/cli.mjs"),
                str(Path(__file__).with_name("homescope.mts")),
                stdin=json.dumps({
                    "url": self.urls[name], "username": self.reader[0],
                    "password": self.reader[1], "recent_ms": self.recent_ns // 1_000_000
                })
            )
            print(result.stdout.strip(), flush=True)

    def log_check(self, name):
        logs = self.docker("logs", name)
        for _, password in [self.admin, self.writer, self.reader, self.other_admin]:
            check(password not in logs.stdout + logs.stderr, "A credential appeared in container logs")

    def stop(self, name):
        self.docker("stop", "--time", "60", name, timeout=75)
        code = self.docker("inspect", "-f", "{{.State.ExitCode}}", name).stdout.strip()
        check(code == "0", f"InfluxDB did not shut down gracefully (exit {code})")
        self.log_check(name)

    def run_tests(self):
        self.docker("network", "create", self.prefix)
        self.rejected_startups()
        fresh_volume = self.volume("fresh")
        self.helper(fresh_volume, "touch /data/unrelated; chown 12345:23456 /data/unrelated")
        fresh = self.create("fresh", fresh_volume)
        self.wait(fresh)
        self.setup(fresh)
        self.verify(fresh)
        uid = self.docker("exec", fresh, "id", "-u", "influxdb").stdout.strip()
        pid_status = self.docker("exec", fresh, "cat", "/proc/1/status").stdout
        check(f"Uid:\t{uid}\t{uid}\t{uid}\t{uid}" in pid_status and uid != "0", "Database PID 1 is not the upstream unprivileged user")
        check(self.helper(fresh_volume, "stat -c '%u:%g' /data/unrelated") == "12345:23456", "Wrapper changed unrelated private-file ownership")
        unused = self.docker("exec", fresh, "find", "/var/lib/influxdb", "-type", "f").stdout.strip()
        check(not unused, "Database state leaked into the upstream volume")
        print("PASS fresh bootstrap, authenticated writes/reads, Docker health, unprivileged PID 1 and scoped ownership", flush=True)
        self.check_rpc(fresh, exposed=False)
        self.stop(fresh)
        self.docker("start", fresh)
        self.wait(fresh)
        self.verify(fresh, homescope=False)
        self.stop(fresh)
        self.docker("rm", "-v", fresh)
        self.containers.remove(fresh)
        replacement = self.create("replacement", fresh_volume, options={
            "bootstrap_admin_username": self.other_admin[0],
            "bootstrap_admin_password": self.other_admin[1],
            "backup_rpc_network": True
        })
        self.wait(replacement)
        self.verify(replacement, homescope=False)
        self.check_rpc(replacement, exposed=True)
        print("PASS restart/container replacement, existing accounts override bootstrap, internal RPC opt-in", flush=True)
        self.portable_backup(replacement)
        self.stop(replacement)
        self.cold_migration()

    def rejected_startups(self):
        for suffix, options, script in [
            ("empty-bootstrap", {}, ":"),
            ("weak-bootstrap", {"bootstrap_admin_username": "admin", "bootstrap_admin_password": "short"}, ":"),
            ("partial-restore", {}, "mkdir -p /data/influxdb/wal; touch /data/influxdb/wal/orphan"),
            ("symlink-restore", {}, "mkdir -p /data/influxdb /data/outside; chown 12345:23456 /data/outside; ln -s /data/outside /data/influxdb/meta"),
            ("hardlink-restore", {}, "mkdir -p /data/influxdb/meta; touch /data/outside; chown 12345:23456 /data/outside; ln /data/outside /data/influxdb/meta/linked")
        ]:
            volume = self.volume(suffix)
            self.helper(volume, script)
            container = self.create(suffix, volume, options=options)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                state = json.loads(self.docker("inspect", "-f", "{{json .State}}", container).stdout)
                if not state["Running"]:
                    break
                time.sleep(0.2)
            check(not state["Running"] and state["ExitCode"] != 0, f"Unsafe {suffix} startup did not fail closed")
            if suffix in ("symlink-restore", "hardlink-restore"):
                check(self.helper(volume, "stat -c '%u:%g' /data/outside") == "12345:23456", "Rejected restore changed an outside target's ownership")
            self.log_check(container)
        print("PASS fail-closed missing/weak bootstrap, incomplete restore, symlink and hardlink ownership protection", flush=True)

    def check_rpc(self, name, *, exposed):
        # Probe from a separate container: localhost connectivity alone cannot
        # distinguish the required default from an accidentally exposed RPC port.
        result = self.docker(
            "run", "--rm", *self.platform, "--network", self.prefix,
            "--entrypoint", "bash", self.image, "-c",
            f"timeout 3 bash -c 'echo >/dev/tcp/{name}/8088'",
            check_status=False
        )
        check((result.returncode == 0) == exposed, "Backup RPC network exposure did not match the option")

    def cold_migration(self):
        self.docker("pull", *self.platform, OLD_IMAGE, timeout=300)
        source_volume = self.volume("source-1810")
        source = self.create("source-1810", source_volume, old=True)
        self.wait(source, old=True)
        self.setup(source, old=True)
        self.verify(source)
        wal_script = "find /data/influxdb/wal -type f -name '*.wal' -size +0c | wc -l"
        check(int(self.helper(source_volume, wal_script)) > 0, "Migration fixture had no recent WAL data")
        self.stop(source)
        check(int(self.helper(source_volume, wal_script)) > 0, "Cold source fixture did not retain WAL files")
        destination_volume = self.volume("migrated")
        self.helper(source_volume,
            "cp -a /data/influxdb /destination/influxdb; "
            "chown -R 12345:23456 /destination/influxdb; "
            "touch /destination/unrelated; chown 12345:23456 /destination/unrelated",
            "-v", f"{destination_volume}:/destination")
        migrated = self.create("migrated", destination_volume, options={
            "bootstrap_admin_username": self.other_admin[0],
            "bootstrap_admin_password": self.other_admin[1],
            "backup_rpc_network": False
        })
        self.wait(migrated)
        self.verify(migrated)
        check(self.helper(destination_volume, "stat -c '%u:%g' /data/unrelated") == "12345:23456", "Restore changed unrelated ownership")
        self.write(migrated, f"migration_check,domain=sensor,entity_id=after_upgrade value=1 {time.time_ns()}")
        self.stop(migrated)
        print("PASS disposable 1.8.10 cold complete-directory migration, recent WAL, exact timestamps/tags, users, grants, RPs and restored ownership", flush=True)

    def portable_backup(self, source):
        self.docker("exec", source, "influxd", "backup", "-portable", "/tmp/portable-backup")
        restored_volume = self.volume("portable-restore")
        restored = self.create("portable-restore", restored_volume, options={
            "bootstrap_admin_username": self.other_admin[0],
            "bootstrap_admin_password": self.other_admin[1],
            "backup_rpc_network": False
        })
        self.wait(restored)
        with tempfile.TemporaryDirectory(prefix=self.prefix) as tmp:
            self.docker("cp", f"{source}:/tmp/portable-backup", tmp)
            self.docker("cp", str(Path(tmp) / "portable-backup"), f"{restored}:/tmp/portable-backup")
        # Native portable restore is an online import into a clean, isolated
        # server. It imports database/RP metadata; account behavior is checked
        # explicitly below rather than assumed equivalent to a cold backup.
        self.docker("exec", restored, "influxd", "restore", "-portable", "/tmp/portable-backup")
        users = self.query(restored, "SHOW USERS", auth=self.other_admin)[0]["values"]
        check(users == [[self.other_admin[0], True]], "Portable restore unexpectedly changed target users")
        policies = self.query(restored, 'SHOW RETENTION POLICIES ON "homeassistant"', auth=self.other_admin)[0]["values"]
        check({row[0] for row in policies} == {"autogen", "keep_30d"}, "Portable restore lost retention policy metadata")
        values = self.query(restored, 'SELECT "value" FROM "°C" ORDER BY time ASC', auth=self.other_admin)[0]["values"]
        check([row[1] for row in values] == [21.5, 22.5, 23.75], "Portable fixture data was not restored")
        self.stop(restored)
        print("PASS native portable backup/isolated restore and RP data; source users/grants are NOT imported (fixture samples observed, no completion-time guarantee)", flush=True)

    def cleanup(self):
        for name in reversed(self.containers):
            self.docker("rm", "-f", "-v", name, check_status=False)
        for volume in reversed(self.volumes):
            self.docker("volume", "rm", volume, check_status=False)
        self.docker("network", "rm", self.prefix, check_status=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="home-assistant-influxdb:test")
    parser.add_argument("--platform", choices=["linux/amd64", "linux/arm64"])
    args = parser.parse_args()
    check((ROOT / "homescope/node_modules/tsx/dist/cli.mjs").exists(), "Run npm ci --prefix homescope first")
    harness = Harness(args.image, args.platform)
    try:
        harness.run_tests()
    finally:
        harness.cleanup()
    print("PASS all disposable InfluxDB integration checks", flush=True)


if __name__ == "__main__":
    main()
