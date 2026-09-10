#!/usr/bin/env python3
"""Propose official stable InfluxDB 1.x pins; --check only reports the candidate."""

import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


REGISTRY = "https://registry-1.docker.io/v2/library/influxdb"
ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
    ]
)
PIN = re.compile(r"^FROM influxdb:(1\.\d+\.\d+)@(sha256:[a-f0-9]{64})$", re.M)


def request(url, headers=None):
    with urlopen(Request(url, headers=headers or {}), timeout=30) as response:
        return response.read(), response.headers


def version_key(version):
    return tuple(map(int, version.split(".")))


def upstream_pin():
    query = urlencode(
        {"service": "registry.docker.io", "scope": "repository:library/influxdb:pull"}
    )
    body, _ = request(f"https://auth.docker.io/token?{query}")
    headers = {"Authorization": f"Bearer {json.loads(body)['token']}"}
    versions = []
    last = ""
    # Bound pagination so a registry anomaly fails rather than looping indefinitely.
    for _ in range(50):
        query = urlencode({"n": 100, "last": last})
        body, page_headers = request(f"{REGISTRY}/tags/list?{query}", headers)
        tags = json.loads(body)["tags"] or []
        versions.extend(tag for tag in tags if re.fullmatch(r"1\.\d+\.\d+", tag))
        if not page_headers.get("Link"):
            break
        if not tags or tags[-1] == last:
            raise RuntimeError("Registry tag pagination did not advance")
        last = tags[-1]
    else:
        raise RuntimeError("Registry tag pagination exceeded 50 pages")
    if not versions:
        raise RuntimeError("No official stable InfluxDB 1.x tags found")
    version = max(versions, key=version_key)
    body, manifest_headers = request(
        f"{REGISTRY}/manifests/{version}", {**headers, "Accept": ACCEPT}
    )
    digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
    if manifest_headers.get("Docker-Content-Digest") != digest:
        raise RuntimeError("Registry manifest digest does not match its content")
    platforms = {
        (item.get("platform", {}).get("os"), item.get("platform", {}).get("architecture"))
        for item in json.loads(body).get("manifests", [])
    }
    if not {("linux", "amd64"), ("linux", "arm64")} <= platforms:
        raise RuntimeError("Newest stable image does not support both amd64 and arm64")
    return version, digest


def replace_once(pattern, replacement, text):
    updated, count = re.subn(pattern, replacement, text, flags=re.M)
    if count != 1:
        raise RuntimeError(f"Expected one match for {pattern!r}, found {count}")
    return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Do not modify any files")
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[2] / "influxdb"
    dockerfile = (app / "Dockerfile").read_text()
    matches = list(PIN.finditer(dockerfile))
    if len(matches) != 1:
        raise RuntimeError("Expected one exact official InfluxDB 1.x FROM pin")
    current_version, current_digest = matches[0].groups()
    version, digest = upstream_pin()
    if version_key(version) < version_key(current_version):
        raise RuntimeError("Refusing to downgrade the engine")
    print(f"Current: influxdb:{current_version}@{current_digest}")
    print(f"Candidate: influxdb:{version}@{digest}")
    if (version, digest) == (current_version, current_digest):
        print("The upstream image pin is current.")
        return
    if args.check:
        print("An update is available; no files changed.")
        return

    config = (app / "config.yaml").read_text()
    app_version = re.search(r'^version: "(\d+\.\d+\.\d+)"$', config, re.M)
    if not app_version:
        raise RuntimeError("Expected a quoted semantic app version in config.yaml")
    major, minor, patch = version_key(app_version[1])
    next_app = f"{major}.{minor}.{patch + 1}"
    readme = (app / "README.md").read_text()
    readme = replace_once(
        r"^- Engine: InfluxDB OSS \*\*1\.\d+\.\d+\*\*\.$",
        f"- Engine: InfluxDB OSS **{version}**.",
        readme,
    )
    readme = replace_once(
        r"^- App version: \*\*\d+\.\d+\.\d+\*\*\.$",
        f"- App version: **{next_app}**.",
        readme,
    )
    changelog = (app / "CHANGELOG.md").read_text()
    changelog = replace_once(
        r"^# Changelog$",
        f"# Changelog\n\n## {next_app}\n\n"
        f"- Update the official InfluxDB OSS image to `{version}@{digest}` "
        "(Linux amd64 and arm64).\n"
        "- Review upstream changes and rehearse the upgrade before installation.",
        changelog,
    )
    # Validate every expected field before writing any file.
    updates = {
        "Dockerfile": PIN.sub(f"FROM influxdb:{version}@{digest}", dockerfile),
        "config.yaml": replace_once(
            r'^version: "\d+\.\d+\.\d+"$', f'version: "{next_app}"', config
        ),
        "README.md": readme,
        "CHANGELOG.md": changelog,
    }
    for name, content in updates.items():
        (app / name).write_text(content)
    print(f"Prepared app {next_app}; review all changes before merging or installing.")


if __name__ == "__main__":
    main()
