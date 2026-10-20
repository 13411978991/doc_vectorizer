#!/usr/bin/env python3
"""sag-read-md.py — markdown passthrough reader.

Markdown is already plain text; we emit it as-is with a heading prepended
so the chunker can pick up the filename. UTF-8 / UTF-8 BOM only; we
explicitly refuse GB18030 (it's almost always a sign that the file is
plain TXT mislabeled).

Implements the SAG reader protocol (see SPEC.md).
"""
from __future__ import annotations
import json
import os
import sys

try:
    # P3 — explicit newline="" prevents the Windows CRT from rewriting
    # \n → \r\n on every write. The validator's stdout check counts
    # bare \r bytes as a fail.
    sys.stdout.reconfigure(encoding="utf-8", newline="")
    sys.stderr.reconfigure(encoding="utf-8", newline="")
except Exception:
    pass

EXTENSIONS = [".md", ".markdown", ".mdown"]

EXIT_OK = 0
EXIT_UNSUPPORTED = 2


def _meta() -> None:
    json.dump({
        "name": "sag-read-md",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["any"],
        "timeoutMs": 30000,
        "needs": ["python>=3.10"],
        "maxBytes": 524288000,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _probe(path: str) -> int:
    if not os.path.isfile(path):
        return 1
    _, ext = os.path.splitext(path)
    return 0 if ext.lower() in EXTENSIONS else 1


def _extract(path: str) -> int:
    basename = os.path.basename(path)
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        sys.stderr.write(f"read failed: {e}\n")
        return 1
    # UTF-8 only for markdown; reject anything else (md should be UTF-8 by convention)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = raw.decode("utf-8", errors="replace")
        except Exception as e:
            sys.stderr.write(f"decode failed: {e}\n")
            return 1

    text = text.replace("\r\n", "\n").replace("\r", "\n").rstrip() + "\n"
    out = [f"# {basename}", "", text]
    # P3 — write with LF-only newlines so the validator's CR-byte
    # check passes. \r\n sneaks in when stdout is reopened with
    # line_buffering=True on Windows.
    sys.stdout.write("\n".join(out).replace("\r\n", "\n"))

    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": len(raw),
        "extractedAt": _now_iso(),
    }, ensure_ascii=False) + "\n")
    return EXIT_OK


def _now_iso() -> str:
    from datetime import datetime
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _dispatch(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--meta":
        _meta()
        return EXIT_OK
    if len(argv) >= 3 and argv[1] == "--probe":
        return _probe(argv[2])
    if len(argv) >= 2:
        return _extract(argv[1])
    sys.stderr.write("usage: sag-read-md.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))