#!/usr/bin/env python3
"""Compress weapon.json to weapon.json.gz for Cloudflare Pages deployment."""

from __future__ import annotations

import gzip
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / "weapon.json"
DEFAULT_DEST = ROOT / "weapon.json.gz"


def compress(source: pathlib.Path = SOURCE, dest: pathlib.Path = DEFAULT_DEST) -> None:
    if not source.is_file():
        print(f"Missing source file: {source}", file=sys.stderr)
        sys.exit(1)

    dest.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, gzip.open(dest, "wb", compresslevel=9) as out:
        shutil.copyfileobj(src, out)

    raw_mb = source.stat().st_size / (1024 * 1024)
    gz_mb = dest.stat().st_size / (1024 * 1024)
    print(f"Wrote {dest.name}: {gz_mb:.2f} MB (from {raw_mb:.2f} MB, {100 * gz_mb / raw_mb:.1f}% of original)")


if __name__ == "__main__":
    output = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_DEST
    compress(dest=output)
