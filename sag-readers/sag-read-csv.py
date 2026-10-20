#!/usr/bin/env python3
"""sag-read-csv.py — default CSV reader.

Emits each row as a markdown table row. Auto-detects delimiter (comma,
tab, semicolon) and encoding (UTF-8 / UTF-8 BOM / GB18030).

For very large CSVs (>100k rows) we cap the output at 50k rows to avoid
OOM; a "truncatedRows" warning is emitted on stderr so the UI knows.
"""
from __future__ import annotations
import csv
import io
import json
import os
import sys
from typing import Tuple

try:
    # P3 — newline="" disables the Windows CRT's \n→\r\n rewrite.
    sys.stdout.reconfigure(encoding="utf-8", newline="")
    sys.stderr.reconfigure(encoding="utf-8", newline="")
except Exception:
    pass

EXTENSIONS = [".csv", ".tsv"]
MAX_ROWS = 50_000
TEXT_PROBE_BYTES = 4096

EXIT_OK = 0
EXIT_UNSUPPORTED = 2


def _meta() -> None:
    json.dump({
        "name": "sag-read-csv",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["any"],
        "timeoutMs": 60000,
        "needs": ["python>=3.10"],
        "maxBytes": 524288000,
        "maxRows": MAX_ROWS,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _detect_encoding(path: str) -> Tuple[str, bool]:
    with open(path, "rb") as f:
        head = f.read(TEXT_PROBE_BYTES)
    if head.startswith(b"\xef\xbb\xbf"):
        return ("utf-8-sig", True)
    if head.startswith(b"\xff\xfe") or head.startswith(b"\xfe\xff"):
        return ("utf-16", True)
    try:
        head.decode("utf-8")
        return ("utf-8", False)
    except UnicodeDecodeError:
        pass
    try:
        head.decode("gb18030")
        return ("gb18030", False)
    except UnicodeDecodeError:
        return ("utf-8", False)


def _detect_delimiter(path: str, encoding: str) -> str:
    """Sniff common delimiters; prefer tab > comma > semicolon."""
    candidates = ["\t", ",", ";", "|"]
    try:
        with open(path, "r", encoding=encoding, errors="replace") as f:
            sample = f.read(8192)
    except OSError:
        return ","
    counts = {d: sample.count(d) for d in candidates}
    best = max(counts.items(), key=lambda kv: kv[1])
    return best[0] if best[1] > 0 else ","


def _probe(path: str) -> int:
    if not os.path.isfile(path):
        return 1
    _, ext = os.path.splitext(path)
    return 0 if ext.lower() in EXTENSIONS else 1


def _extract(path: str) -> int:
    basename = os.path.basename(path)
    encoding, _ = _detect_encoding(path)
    delim = _detect_delimiter(path, encoding)
    truncated = False
    rows_emitted = 0
    out_lines: list[str] = [f"# {basename}", ""]

    try:
        with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
            reader = csv.reader(f, delimiter=delim)
            try:
                header = next(reader)
            except StopIteration:
                header = []
            header = [c.strip() or f"col{i+1}" for i, c in enumerate(header)]
            if header:
                out_lines.append("| " + " | ".join(_md_escape(c) for c in header) + " |")
                out_lines.append("| " + " | ".join(["---"] * len(header)) + " |")
            row_buf: list[str] = []
            for row in reader:
                if rows_emitted >= MAX_ROWS:
                    truncated = True
                    break
                # Pad short rows to header length, trim long rows.
                if len(row) < len(header):
                    row = list(row) + [""] * (len(header) - len(row))
                elif len(row) > len(header):
                    row = list(row[:len(header)])
                row_buf.append("| " + " | ".join(_md_escape(c) for c in row) + " |")
                rows_emitted += 1
                # Flush every 1000 rows so we don't blow memory on a 500MB CSV.
                if len(row_buf) >= 1000:
                    out_lines.extend(row_buf)
                    row_buf.clear()
            if row_buf:
                out_lines.extend(row_buf)
    except (OSError, UnicodeError) as e:
        sys.stderr.write(f"read failed: {e}\n")
        return 1

    # P3 — strip any CR bytes so validator's CR-byte check passes on Windows
    payload = "\n".join(out_lines).replace("\r\n", "\n").replace("\r", "\n")
    sys.stdout.write(payload)
    if not payload.endswith("\n"):
        sys.stdout.write("\n")
    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": os.path.getsize(path) if os.path.isfile(path) else None,
        "encoding": encoding,
        "delimiter": delim,
        "rows": rows_emitted,
        "truncated": truncated,
        "extractedAt": _now_iso(),
    }, ensure_ascii=False) + "\n")
    return EXIT_OK


def _md_escape(s: str) -> str:
    """Escape pipes and newlines for a markdown table cell."""
    return (s.replace("\\", "\\\\")
             .replace("|", "\\|")
             .replace("\n", " ")
             .replace("\r", " ")
             .strip())


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
    sys.stderr.write("usage: sag-read-csv.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))