#!/usr/bin/env python3
"""Clean up SAG's decrypted-office-files cache.

The file-converter.py decrypt layer stores decrypted copies of .docx /
.xlsx files under %TEMP%/sag-decrypted/ (or wherever $TEMP points). Each
entry is keyed by `<name>-<mtime_ns>.docx|xlsx`. We cache to avoid
launching Office repeatedly on the same file.

This script is the cleanup companion. It:

  --max-age <days>     delete cache files older than N days  (default 7)
  --max-size <MB>      if total cache size > N MB, delete oldest first
  --dry-run            print what would be deleted, do not delete
  --quiet              suppress per-file output

Exit codes:
  0 = nothing to delete, or all deletions OK
  1 = partial failure (some files could not be deleted)
  2 = bad arguments

Examples:

  # delete everything in cache older than 7 days
  python3 scripts/clean_decrypted_cache.py

  # only files older than 1 day, dry run
  python3 scripts/clean_decrypted_cache.py --max-age 1 --dry-run

  # keep cache under 200 MB, delete oldest first
  python3 scripts/clean_decrypted_cache.py --max-size 200
"""
import argparse
import os
import sys
import time
from pathlib import Path


def cache_root() -> Path:
    """Mirror file-converter._cache_root() so we point at the same dir."""
    root = Path(os.environ.get("TEMP", r"C:\Windows\Temp")) / "sag-decrypted"
    return root


def file_age_days(p: Path) -> float:
    return (time.time() - p.stat().st_mtime) / 86400.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--max-age", type=float, default=7.0,
                    help="delete files older than N days (default 7)")
    ap.add_argument("--max-size", type=float, default=None,
                    help="if cache total > N MB, delete oldest first")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be deleted, do not delete")
    ap.add_argument("--quiet", action="store_true",
                    help="suppress per-file output")
    args = ap.parse_args()

    root = cache_root()
    if not root.exists():
        if not args.quiet:
            print(f"[clean] cache dir does not exist: {root}")
        return 0

    # Phase 1: by-age deletes
    candidates_by_age: list[Path] = []
    for p in root.iterdir():
        if not p.is_file():
            continue
        try:
            age = file_age_days(p)
        except OSError:
            continue
        if age >= args.max_age:
            candidates_by_age.append(p)

    # Phase 2: by-size deletes (oldest first)
    candidates_by_size: list[Path] = []
    if args.max_size is not None:
        max_bytes = int(args.max_size * 1024 * 1024)
        # All files sorted by mtime ascending (oldest first)
        all_files = [p for p in root.iterdir() if p.is_file()]
        all_files.sort(key=lambda p: p.stat().st_mtime)
        total = 0
        for p in all_files:
            try:
                total += p.stat().st_size
            except OSError:
                continue
        if total > max_bytes:
            # delete oldest first until under limit
            excess = total - max_bytes
            deleted = 0
            for p in all_files:
                if deleted >= excess:
                    break
                candidates_by_size.append(p)
                try:
                    deleted += p.stat().st_size
                except OSError:
                    continue

    # Union, dedupe
    to_delete = sorted(set(candidates_by_age) | set(candidates_by_size),
                       key=lambda p: p.stat().st_mtime)

    if not to_delete:
        if not args.quiet:
            print(f"[clean] {root}: nothing to delete "
                  f"(max-age={args.max_age}d, max-size={args.max_size}MB)")
        return 0

    if not args.quiet:
        verb = "would delete" if args.dry_run else "deleting"
        print(f"[clean] {root}: {verb} {len(to_delete)} files")

    failed = 0
    freed_bytes = 0
    for p in to_delete:
        try:
            sz = p.stat().st_size
        except OSError:
            sz = 0
        if args.dry_run:
            if not args.quiet:
                age = file_age_days(p)
                print(f"  - {p.name}  ({sz/1024:.1f} KB, age={age:.1f}d)")
            continue
        try:
            p.unlink()
            freed_bytes += sz
            if not args.quiet:
                print(f"  ✓ {p.name}")
        except OSError as e:
            failed += 1
            print(f"  ✗ {p.name}: {e}", file=sys.stderr)

    if not args.dry_run and not args.quiet:
        print(f"[clean] done. freed {freed_bytes/1024/1024:.1f} MB; "
              f"failed={failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
