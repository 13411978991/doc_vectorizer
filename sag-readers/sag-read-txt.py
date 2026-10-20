#!/usr/bin/env python3
"""sag-read-txt.py — default plain-text reader.

Reads any text file, auto-detects UTF-8 / UTF-8 BOM / UTF-16 / GB18030
(Chinese Windows TXT files saved as GBK decode fine via GB18030 which is a
superset). Falls back to UTF-8 with replacement characters.

Implements the SAG reader protocol (see SPEC.md):
  --meta      → JSON metadata on stdout, exit 0
  --probe F   → exit 0 if file looks like plain text, 1 otherwise
  <file>      → extracted text on stdout, JSON meta on stderr
"""
from __future__ import annotations
import json
import os
import sys
from typing import Tuple

# SAG readers always emit UTF-8 on stdout. On Windows the default
# Python encoding is CP1252, which mangles CJK characters when the
# parent process (PowerShell, cmd, or our Node spawn) reads them
# back. Reconfigure both streams to UTF-8 with line-buffering so the
# chunker downstream gets clean UTF-8 bytes.
try:
    # P3 — newline="" disables the Windows CRT's \n→\r\n rewrite.
    # The validator counts bare \r bytes in stdout and rejects on > 0.
    sys.stdout.reconfigure(encoding="utf-8", newline="")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8", newline="")  # type: ignore[attr-defined]
except Exception:
    pass

EXTENSIONS = [".txt", ".log", ".text"]
TEXT_PROBE_BYTES = 4096  # how many bytes to inspect for encoding detection

# Exit codes (per SPEC §2.1)
EXIT_OK = 0
EXIT_UNSUPPORTED = 2
EXIT_TRANSIENT = 3


def _meta() -> None:
    """Print JSON metadata for the Settings UI."""
    json.dump({
        "name": "sag-read-txt",
        "version": "1.0.0",
        "extensions": EXTENSIONS,
        "languages": ["zh", "en", "ja", "ko", "any"],
        "timeoutMs": 30000,
        "needs": ["python>=3.10"],
        "maxBytes": 524288000,  # 500 MB
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def _detect_encoding(path: str) -> Tuple[str, bool]:
    """Return (encoding, had_bom). Tries common encodings in order."""
    with open(path, "rb") as f:
        head = f.read(TEXT_PROBE_BYTES)
    if not head:
        return ("utf-8", False)
    # BOM sniffing
    if head.startswith(b"\xef\xbb\xbf"):
        return ("utf-8-sig", True)
    if head.startswith(b"\xff\xfe") or head.startswith(b"\xfe\xff"):
        return ("utf-16", True)
    # Try UTF-8 strict
    try:
        head.decode("utf-8")
        return ("utf-8", False)
    except UnicodeDecodeError:
        pass
    # Try GB18030 (covers GBK / GB2312 / Big5; common on Chinese Windows)
    try:
        head.decode("gb18030")
        return ("gb18030", False)
    except UnicodeDecodeError:
        pass
    # Try latin1 as a final non-lossy fallback
    return ("utf-8", False)  # we'll fall back to replacement mode


def _probe(path: str) -> int:
    """Exit 0 if this looks like text, 1 if binary."""
    if not os.path.isfile(path):
        return 1
    _, ext = os.path.splitext(path)
    if ext.lower() not in EXTENSIONS:
        return 1
    try:
        with open(path, "rb") as f:
            head = f.read(TEXT_PROBE_BYTES)
    except OSError:
        return 1
    if not head:
        return 0  # empty file → trivially text
    # Quick binary heuristic: NUL bytes are a strong signal of binary.
    if b"\x00" in head:
        return 1
    return 0


def _extract(path: str) -> int:
    """Read the whole file and emit UTF-8 markdown text."""
    try:
        size = os.path.getsize(path)
    except OSError as e:
        sys.stderr.write(f"stat failed: {e}\n")
        return 1
    encoding, had_bom = _detect_encoding(path)
    try:
        # errors='replace' for the final fallback path; the encoding
        # detector picked something we trust, but very large mixed-encoding
        # files can still surprise us.
        with open(path, "r", encoding=encoding, errors="replace", newline="") as f:
            text = f.read()
    except (OSError, UnicodeError) as e:
        sys.stderr.write(f"read failed: {e}\n")
        return 1

    # Normalize line endings (CRLF → LF), strip BOM if present (UTF-8 codec
    # would have consumed it but be defensive), trim trailing whitespace.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if had_bom and text.startswith("\ufeff"):
        text = text[1:]
    text = text.rstrip() + "\n"

    # Emit markdown header so the chunker knows the basename.
    basename = os.path.basename(path)
    out = [f"# {basename}", "", text]
    # P3 — strip any CR bytes that survived so the validator's
    # CR-byte check passes on Windows.
    sys.stdout.write("\n".join(out).replace("\r\n", "\n").replace("\r", "\n"))

    sys.stderr.write(json.dumps({
        "title": basename,
        "bytes": size,
        "encoding": encoding,
        "extractedAt": _now_iso(),
    }, ensure_ascii=False) + "\n")
    return EXIT_OK


def _now_iso() -> str:
    """ISO-8601 timestamp in local TZ without external deps."""
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
    sys.stderr.write("usage: sag-read-txt.py [--meta|--probe F] <file>\n")
    return 1


if __name__ == "__main__":
    sys.exit(_dispatch(sys.argv))