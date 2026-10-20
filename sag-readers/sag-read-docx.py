#!/usr/bin/env python3
"""sag-read-docx.py — default DOCX reader.

Uses python-docx for paragraph + table extraction. If python-docx isn't
installed OR the file is encrypted (msoffcrypto-tool is required), we
return exit 2 so the exe can try the next reader (typically the COM-based
ps1 reader which decrypts first).

Implements the SAG reader protocol (see SPEC.md).
"""
from __future__ import annotations
import json
import os
import sys

try:
    # newline="" prevents Python from translating \n to \r\n on Windows
    # stdout, which would violate SAG reader spec §3 (LF only). The previous
    # version used the default text-mode \r\n translation and was caught by
    # sag-reader-validator's "no CR in stdout" check.
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True, newline="")
    sys.stderr.reconfigure(encoding="utf-8", line_buffering=True, newline="")
except Exception:
    pass

EXTENSIONS = [".docx"]
EXIT_OK = 0
EXIT_UNSUPPORTED = 2

# Cap to avoid blowing memory on pathological docs with 50k+ paragraphs.
MAX_PARAGRAPHS = 100_000


def _meta() -> None:
    json.dump({
        "name": "sag-read-docx",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["zh", "en", "ja", "ko", "any"],
        "timeoutMs": 120000,
        "needs": ["python>=3.10", "python-docx>=1.0"],
        "maxBytes": 524288000,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _probe(path: str) -> int:
    if not os.path.isfile(path):
        return 1
    _, ext = os.path.splitext(path)
    if ext.lower() not in EXTENSIONS:
        return 1
    # OOXML container is a zip — first 2 bytes should be "PK".
    try:
        with open(path, "rb") as f:
            return 0 if f.read(2) == b"PK" else 1
    except OSError:
        return 1


def _extract(path: str) -> int:
    basename = os.path.basename(path)
    try:
        from docx import Document  # python-docx
    except ImportError:
        sys.stderr.write("python-docx not installed\n")
        return EXIT_UNSUPPORTED

    try:
        doc = Document(path)
    except Exception as e:
        msg = str(e).lower()
        if "encrypt" in msg or "password" in msg or "not a zip" in msg:
            sys.stderr.write(f"encrypted or malformed: {e}\n")
            return EXIT_UNSUPPORTED
        sys.stderr.write(f"read failed: {e}\n")
        return 1

    parts: list[str] = []
    para_count = 0
    # Walk body in document order via doc.element.body iter
    for child in doc.element.body.iter():
        tag = child.tag.split("}", 1)[-1]
        if tag == "p":
            text = "".join(t.text or "" for t in child.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"))
            if text.strip():
                parts.append(text.strip())
                para_count += 1
                if para_count >= MAX_PARAGRAPHS:
                    parts.append(f"\n*(truncated: more than {MAX_PARAGRAPHS} paragraphs)*")
                    break
        elif tag == "tbl":
            # Render each row as a markdown table row. python-docx exposes
            # tables separately too; we just walk XML for ordering.
            row_texts: list[str] = []
            for row in child.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tr"):
                cell_texts = []
                for cell in row.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tc"):
                    cell_text = "".join(
                        t.text or ""
                        for t in cell.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
                    ).strip()
                    cell_texts.append(cell_text)
                row_texts.append("| " + " | ".join(cell_texts) + " |")
            if row_texts:
                parts.append("\n".join(row_texts))

    if not parts:
        sys.stderr.write("docx has no extractable text\n")
        return EXIT_UNSUPPORTED

    body = "\n\n".join(parts)
    out = [f"# {basename}", "", body]
    sys.stdout.write("\n".join(out))
    if not body.endswith("\n"):
        sys.stdout.write("\n")
    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": os.path.getsize(path),
        "paragraphs": para_count,
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
    sys.stderr.write("usage: sag-read-docx.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))