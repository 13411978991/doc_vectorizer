#!/usr/bin/env python3
"""sag-read-pdf.py — default PDF reader.

Tries pypdf first (pure-Python, no system deps), then pdfplumber if
pypdf returns empty (better at extracting table-like layouts and
right-to-left text).

If neither lib is installed the script emits a one-line hint on stderr
and exits with code 2 so the exe can fall back to the next reader.

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

EXTENSIONS = [".pdf"]
EXIT_OK = 0
EXIT_UNSUPPORTED = 2


def _meta() -> None:
    json.dump({
        "name": "sag-read-pdf",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["zh", "en", "ja", "ko", "any"],
        "timeoutMs": 120000,
        "needs": ["python>=3.10", "pypdf>=4.0"],
        "optionalNeeds": ["pdfplumber>=0.10"],
        "maxBytes": 524288000,
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
            head = f.read(8)
        return 0 if head.startswith(b"%PDF-") else 1
    except OSError:
        return 1


def _try_pypdf(path: str) -> str | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return None
    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            return None  # let the COM-based reader handle encrypted PDFs
        parts: list[str] = []
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if not text.strip():
                continue
            parts.append(f"## 第 {i + 1} 页\n\n{text.strip()}")
        return "\n\n".join(parts) if parts else None
    except Exception as e:
        # PDF structural errors (e.g. "invalid pdf structure", "EOF marker not found")
        # signal encryption or corruption — return None so the next reader
        # can try, OR the exe can fall back to its internal TS parser.
        msg = str(e).lower()
        if "encrypt" in msg or "password" in msg:
            return None
        raise


def _try_pdfplumber(path: str) -> str | None:
    try:
        import pdfplumber  # type: ignore
    except ImportError:
        return None
    try:
        parts: list[str] = []
        with pdfplumber.open(path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                if not text.strip():
                    continue
                parts.append(f"## 第 {i + 1} 页\n\n{text.strip()}")
        return "\n\n".join(parts) if parts else None
    except Exception:
        return None


def _extract(path: str) -> int:
    basename = os.path.basename(path)
    extracted = _try_pypdf(path)
    engine = "pypdf"
    if not extracted:
        extracted = _try_pdfplumber(path)
        engine = "pdfplumber" if extracted else None
    if not extracted:
        sys.stderr.write("pdf read failed (encrypted or no parser available)\n")
        return EXIT_UNSUPPORTED
    out = [f"# {basename}", "", extracted]
    sys.stdout.write("\n".join(out))
    if not extracted.endswith("\n"):
        sys.stdout.write("\n")
    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": os.path.getsize(path),
        "engine": engine,
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
    sys.stderr.write("usage: sag-read-pdf.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))