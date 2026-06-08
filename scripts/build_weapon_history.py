#!/usr/bin/env python3
"""
Download all historical weapon.json files from coh3stats and build a minified
base + chained patch dataset for versioned weapon data.

Data source:
  https://data.coh3stats.com/cohstats/coh3-data/{tag}/data/weapon.json

Output layout:
  data/backups/{tag}/weapon.json          Raw downloads (local backup)
  data/weapon-history/base.json.gz        Oldest version, minified JSON
  data/weapon-history/latest.json.gz      Latest version snapshot (fast load)
  data/weapon-history/patches/{tag}.patch.json.gz
  data/weapon-history/manifest.json       Version index and patch metadata
"""

from __future__ import annotations

import argparse
import copy
import gzip
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "data" / "backups"
HISTORY_DIR = ROOT / "data" / "weapon-history"
PATCH_DIR = HISTORY_DIR / "patches"
MANIFEST_PATH = HISTORY_DIR / "manifest.json"
BASE_PATH = HISTORY_DIR / "base.json.gz"
LATEST_SNAPSHOT_PATH = HISTORY_DIR / "latest.json.gz"

DATA_URL_TEMPLATE = "https://data.coh3stats.com/cohstats/coh3-data/{tag}/data/weapon.json"
GITHUB_TAGS_API = "https://api.github.com/repos/cohstats/coh3-data/tags?per_page=100&page={page}"
USER_AGENT = "coh3-weapon-stat-sheet/1.0"
TAG_PATTERN = re.compile(r"^v(\d+)\.(\d+)\.(\d+)-(\d+)$")


def parse_tag(tag: str) -> tuple[int, int, int, int]:
    match = TAG_PATTERN.match(tag)
    if not match:
        raise ValueError(f"Invalid tag format: {tag}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def fetch_tags() -> list[str]:
    tags: list[str] = []
    page = 1
    while True:
        url = GITHUB_TAGS_API.format(page=page)
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            batch = json.loads(response.read())
        if not batch:
            break
        tags.extend(item["name"] for item in batch)
        page += 1
    return sorted(set(tags), key=parse_tag)


def minify_json(data: Any) -> str:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False, sort_keys=True)


def gzip_bytes(payload: bytes, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(dest, "wb", compresslevel=9) as handle:
        handle.write(payload)
    return dest.stat().st_size


def download_weapon_json(tag: str, dest: Path, retries: int = 3) -> None:
    if dest.is_file() and dest.stat().st_size > 0:
        return

    url = DATA_URL_TEMPLATE.format(tag=tag)
    dest.parent.mkdir(parents=True, exist_ok=True)
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=120) as response:
                payload = response.read()
            data = json.loads(payload)
            dest.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
            return
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(2 * attempt)

    raise RuntimeError(f"Failed to download {tag} after {retries} attempts: {last_error}")


def iter_leaf_paths(obj: Any, prefix: str = "") -> list[tuple[str, Any]]:
    leaves: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        for key in sorted(obj):
            path = f"{prefix}/{key}" if prefix else f"/{key}"
            leaves.extend(iter_leaf_paths(obj[key], path))
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            path = f"{prefix}/{index}"
            leaves.extend(iter_leaf_paths(value, path))
    else:
        leaves.append((prefix, obj))
    return leaves


def flatten_leaves(obj: Any) -> dict[str, Any]:
    return dict(iter_leaf_paths(obj))


def build_patch(old: Any, new: Any, path: str = "") -> list[dict[str, Any]]:
    patch: list[dict[str, Any]] = []

    if type(old) is not type(new):
        if path:
            patch.append({"op": "replace", "p": path, "v": new})
        return patch

    if isinstance(old, dict):
        for key in sorted(set(old) | set(new)):
            child_path = f"{path}/{key}" if path else f"/{key}"
            if key not in old:
                patch.append({"op": "add", "p": child_path, "v": new[key]})
            elif key not in new:
                patch.append({"op": "remove", "p": child_path})
            else:
                patch.extend(build_patch(old[key], new[key], child_path))
        return patch

    if isinstance(old, list):
        if old != new and path:
            patch.append({"op": "replace", "p": path, "v": new})
        return patch

    if old != new and path:
        patch.append({"op": "replace", "p": path, "v": new})
    return patch


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def path_key(path: str, *, reverse_index: bool = False) -> tuple[Any, ...]:
    parts: list[Any] = []
    for segment in path.split("/")[1:]:
        if segment.isdigit():
            index = int(segment)
            parts.append(-index if reverse_index else index)
        else:
            parts.append(segment)
    return tuple(parts)


def apply_patch(data: Any, patch: list[dict[str, Any]]) -> Any:
    result = copy.deepcopy(data)
    removes = sorted((op for op in patch if op["op"] == "remove"), key=lambda op: path_key(op["p"], reverse_index=True))
    replaces = [op for op in patch if op["op"] == "replace"]
    adds = sorted((op for op in patch if op["op"] == "add"), key=lambda op: path_key(op["p"]))

    for operation in removes:
        parent, key = resolve_parent(result, pointer_segments(operation["p"]))
        if isinstance(parent, dict):
            del parent[key]
        else:
            del parent[int(key)]

    for operation in replaces:
        parent, key = resolve_parent(result, pointer_segments(operation["p"]))
        value = operation["v"]
        if isinstance(parent, dict):
            parent[key] = value
        else:
            parent[int(key)] = value

    for operation in adds:
        parent, key = resolve_parent(result, pointer_segments(operation["p"]), create_missing=True)
        value = operation["v"]
        if isinstance(parent, dict):
            parent[key] = value
        else:
            index = int(key)
            if index == len(parent):
                parent.append(value)
            else:
                parent.insert(index, value)

    return result


def pointer_segments(pointer: str) -> list[str]:
    return [segment for segment in pointer.split("/") if segment]


def resolve_parent(root: Any, segments: list[str], create_missing: bool = False) -> tuple[Any, str]:
    current = root
    for segment in segments[:-1]:
        if isinstance(current, dict):
            if segment not in current:
                if not create_missing:
                    raise KeyError(segment)
                current[segment] = {}
            current = current[segment]
        else:
            current = current[int(segment)]

    return current, segments[-1]


def verify_patch_chain(tags: list[str], backup_dir: Path, history_dir: Path) -> None:
    base = load_json_from_gz(history_dir / "base.json.gz")
    current = base
    previous_tag = tags[0]

    for tag in tags[1:]:
        patch_path = history_dir / "patches" / f"{tag}.patch.json.gz"
        patch = load_json_from_gz(patch_path)
        current = apply_patch(current, patch)
        expected = load_json(backup_dir / tag / "weapon.json")
        if flatten_leaves(current) != flatten_leaves(expected):
            raise RuntimeError(f"Patch verification failed for {tag} (from {previous_tag})")
        previous_tag = tag


def load_json_from_gz(path: Path) -> Any:
    with gzip.open(path, "rb") as handle:
        return json.loads(handle.read())


def build_history(tags: list[str], backup_dir: Path, history_dir: Path, skip_verify: bool = False) -> dict[str, Any]:
    history_dir.mkdir(parents=True, exist_ok=True)
    patch_dir = history_dir / "patches"
    patch_dir.mkdir(parents=True, exist_ok=True)

    versions: list[dict[str, Any]] = []
    previous_data: Any | None = None
    previous_tag: str | None = None
    total_patch_bytes = 0
    total_changes = 0

    for index, tag in enumerate(tags):
        backup_path = backup_dir / tag / "weapon.json"
        data = load_json(backup_path)
        minified = minify_json(data)

        if index == 0:
            base_bytes = gzip_bytes(minified.encode("utf-8"), BASE_PATH)
            versions.append(
                {
                    "tag": tag,
                    "role": "base",
                    "file": "base.json.gz",
                    "from": None,
                    "rawBytes": backup_path.stat().st_size,
                    "minifiedBytes": len(minified.encode("utf-8")),
                    "artifactBytes": base_bytes,
                    "changeCount": 0,
                    "addedCount": 0,
                    "removedCount": 0,
                    "replacedCount": 0,
                }
            )
            previous_data = data
            previous_tag = tag
            continue

        patch = build_patch(previous_data, data)
        patch_json = json.dumps(patch, separators=(",", ":"), ensure_ascii=False)
        patch_path = patch_dir / f"{tag}.patch.json.gz"
        patch_bytes = gzip_bytes(patch_json.encode("utf-8"), patch_path)
        total_patch_bytes += patch_bytes
        total_changes += len(patch)

        added = sum(1 for op in patch if op["op"] == "add")
        removed = sum(1 for op in patch if op["op"] == "remove")
        replaced = sum(1 for op in patch if op["op"] == "replace")

        versions.append(
            {
                "tag": tag,
                "role": "patch",
                "file": f"patches/{tag}.patch.json.gz",
                "from": previous_tag,
                "rawBytes": backup_path.stat().st_size,
                "minifiedBytes": len(minified.encode("utf-8")),
                "artifactBytes": patch_bytes,
                "changeCount": len(patch),
                "addedCount": added,
                "removedCount": removed,
                "replacedCount": replaced,
            }
        )
        previous_data = data
        previous_tag = tag

    latest_tag = tags[-1]
    latest_minified = minify_json(previous_data)
    latest_snapshot_bytes = gzip_bytes(latest_minified.encode("utf-8"), LATEST_SNAPSHOT_PATH)

    manifest = {
        "schemaVersion": 1,
        "dataFile": "weapon.json",
        "sourceUrlTemplate": DATA_URL_TEMPLATE,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "versionCount": len(tags),
        "baseTag": tags[0],
        "latestTag": latest_tag,
        "latestSnapshotFile": "latest.json.gz",
        "latestSnapshotBytes": latest_snapshot_bytes,
        "baseArtifactBytes": BASE_PATH.stat().st_size,
        "totalPatchArtifactBytes": total_patch_bytes,
        "totalArtifactBytes": BASE_PATH.stat().st_size + total_patch_bytes + latest_snapshot_bytes,
        "totalChanges": total_changes,
        "versions": versions,
    }

    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if not skip_verify:
        print("Verifying patch chain...")
        verify_patch_chain(tags, backup_dir, history_dir)
        snapshot_data = load_json_from_gz(LATEST_SNAPSHOT_PATH)
        expected_latest = load_json(backup_dir / latest_tag / "weapon.json")
        if flatten_leaves(snapshot_data) != flatten_leaves(expected_latest):
            raise RuntimeError(f"Latest snapshot verification failed for {latest_tag}")

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Download and build weapon.json version history.")
    parser.add_argument("--skip-download", action="store_true", help="Skip downloading backups.")
    parser.add_argument("--skip-build", action="store_true", help="Skip building patch artifacts.")
    parser.add_argument("--skip-verify", action="store_true", help="Skip patch chain verification.")
    args = parser.parse_args()

    tags = fetch_tags()
    print(f"Found {len(tags)} tags ({tags[0]} .. {tags[-1]})")

    if not args.skip_download:
        for index, tag in enumerate(tags, start=1):
            dest = BACKUP_DIR / tag / "weapon.json"
            print(f"[{index}/{len(tags)}] Downloading {tag}...")
            download_weapon_json(tag, dest)
            print(f"  saved {dest} ({dest.stat().st_size / 1024 / 1024:.2f} MB)")

    if not args.skip_build:
        print("Building minified base + patch chain...")
        manifest = build_history(tags, BACKUP_DIR, HISTORY_DIR, skip_verify=args.skip_verify)
        print(f"Wrote {MANIFEST_PATH}")
        print(f"Base artifact: {manifest['baseArtifactBytes'] / 1024:.1f} KB")
        print(f"Patch artifacts total: {manifest['totalPatchArtifactBytes'] / 1024:.1f} KB")
        print(f"Latest snapshot: {manifest['latestSnapshotBytes'] / 1024:.1f} KB")
        print(f"All artifacts total: {manifest['totalArtifactBytes'] / 1024 / 1024:.2f} MB")
        print(f"Total leaf changes across history: {manifest['totalChanges']:,}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
