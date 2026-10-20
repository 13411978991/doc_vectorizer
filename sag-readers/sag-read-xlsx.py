#!/usr/bin/env python3
"""sag-read-xlsx.py — default XLSX reader.

Uses openpyxl in read_only + data_only mode. Each sheet becomes a
`## Sheet N - <name>` section; rows are rendered as markdown tables.

Hard caps to bound memory on hostile workbooks:
  - MAX_SHEETS = 50
  - MAX_ROWS_PER_SHEET = 20,000
  - MAX_COLS_PER_SHEET = 100

If a sheet is truncated, a note is appended.

Implements the SAG reader protocol (see SPEC.md).
"""
from __future__ import annotations
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

EXTENSIONS = [".xlsx"]
EXIT_OK = 0
EXIT_UNSUPPORTED = 2

MAX_SHEETS = 50
MAX_ROWS_PER_SHEET = 20_000
MAX_COLS_PER_SHEET = 100


def _meta() -> None:
    json.dump({
        "name": "sag-read-xlsx",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["any"],
        "timeoutMs": 180000,
        "needs": ["python>=3.10", "openpyxl>=3.1"],
        "maxBytes": 524288000,
        "maxRowsPerSheet": MAX_ROWS_PER_SHEET,
        "maxColsPerSheet": MAX_COLS_PER_SHEET,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _probe(path: str) -> int:
    if not os.path.isfile(path):
        return 1
    _, ext = os.path.splitext(path)
    if ext.lower() not in EXTENSIONS:
        return 1
    try:
        with open(path, "rb") as f:
            return 0 if f.read(2) == b"PK" else 1
    except OSError:
        return 1


def _extract(path: str) -> int:
    basename = os.path.basename(path)
    try:
        import openpyxl  # type: ignore
    except ImportError:
        sys.stderr.write("openpyxl not installed\n")
        return EXIT_UNSUPPORTED
    try:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    except Exception as e:
        msg = str(e).lower()
        if "encrypt" in msg or "password" in msg or "not a zip" in msg:
            sys.stderr.write(f"encrypted or malformed: {e}\n")
            return EXIT_UNSUPPORTED
        sys.stderr.write(f"read failed: {e}\n")
        return 1

    sheets = wb.sheetnames
    if not sheets:
        sys.stderr.write("xlsx has no sheets\n")
        return EXIT_UNSUPPORTED

    parts: list[str] = []
    truncated_sheets = []
    for idx, name in enumerate(sheets):
        if idx >= MAX_SHEETS:
            truncated_sheets.append(name)
            continue
        ws = wb[name]
        rows: list[list[str]] = []
        try:
            for ri, row in enumerate(ws.iter_rows(values_only=True)):
                if ri >= MAX_ROWS_PER_SHEET:
                    truncated_sheets.append(name)
                    break
                cells = ["" if v is None else str(v) for v in row[:MAX_COLS_PER_SHEET]]
                # Trim trailing empties
                while cells and cells[-1] == "":
                    cells.pop()
                if not cells:
                    continue
                rows.append(cells)
        except Exception as e:
            sys.stderr.write(f"sheet '{name}' read failed: {e}\n")
            continue
        if not rows:
            continue
        # Normalize all rows to the widest row's length
        width = max(len(r) for r in rows)
        header = rows[0] if rows else []
        if not header or all(not c.strip() for c in header):
            # No usable header; synthesize col1, col2...
            header = [f"col{i+1}" for i in range(width)]
            body_rows = rows
        else:
            while len(header) < width:
                header.append(f"col{len(header)+1}")
            body_rows = rows[1:] if len(rows) > 1 else []
        parts.append(f"## Sheet {idx + 1} - {name}\n")
        parts.append("| " + " | ".join(_md_escape(c) for c in header) + " |")
        parts.append("| " + " | ".join(["---"] * len(header)) + " |")
        for row in body_rows:
            while len(row) < len(header):
                row.append("")
            parts.append("| " + " | ".join(_md_escape(c) for c in row) + " |")
        parts.append("")

    wb.close()

    if not parts:
        sys.stderr.write("xlsx has no extractable rows\n")
        return EXIT_UNSUPPORTED

    out = [f"# {basename}", ""] + parts
    sys.stdout.write("\n".join(out))
    if not out[-1].endswith("\n"):
        sys.stdout.write("\n")
    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": os.path.getsize(path),
        "sheets": len(sheets),
        "truncatedSheets": truncated_sheets,
        "extractedAt": _now_iso(),
    }, ensure_ascii=False) + "\n")
    return EXIT_OK


def _md_escape(s: str) -> str:
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
    sys.stderr.write("usage: sag-read-xlsx.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))