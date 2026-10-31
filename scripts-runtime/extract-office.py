#!/usr/bin/env python3
"""Fallback office file extractor for SAG.

Usage:
    python scripts/extract-office.py --input <file> --output <file>
        [--max-rows N] [--max-cols N]

Reads .xlsx/.xls/.docx/.pptx using pure Python libraries (no COM/Office).
Writes the extracted text as markdown to the output file. The output file
path is also printed on stdout so the Node caller can read it back.

Sheet caps (max-rows / max-cols) come from the Node caller; the Node
caller sources them from `performance-settings-service` so the user can
tune them live in Settings → 性能设置. Defaults below mirror the Node
defaults in src/config/env.ts so behaviour stays consistent if Node
forgets to pass them.
"""
import argparse
import os
import sys

DEFAULT_MAX_DETAIL_ROWS = 200
DEFAULT_MAX_DETAIL_COLS = 26
DETAIL_KEYWORDS = [
    "明细", "台账", "报表", "记录", "流水", "汇总",
    "details", "ledger", "log", "register", "明细表", "台账表", "汇总表"
]


def _matches_detail_keyword(name: str) -> str | None:
    lower = name.lower()
    for keyword in DETAIL_KEYWORDS:
        if keyword in lower:
            return f"detail-report keyword '{keyword}' matched in '{name}'"
    return None


def read_xlsx(path: str, max_rows: int, max_cols: int) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    file_name = path.lower()
    out: list[str] = []
    for ws in wb.worksheets:
        out.append(f"## {ws.title}\n")
        # Skip detail-report sheets: large tables should not be vectorized.
        # Caps come from the Node caller (Settings → 性能设置).
        keyword_match = _matches_detail_keyword(ws.title) or _matches_detail_keyword(file_name)
        # In read_only mode openpyxl returns None for max_row/max_column
        # when the sheet XML lacks a <dimension> declaration (common for
        # system-exported workbooks, e.g. WeCom / hive query exports).
        # Treat unknown dimensions as "small enough to keep" — the body
        # cap below still bounds how many rows are emitted.
        sheet_rows = ws.max_row if ws.max_row is not None else 0
        sheet_cols = ws.max_column if ws.max_column is not None else 0
        if sheet_rows > max_rows or sheet_cols > max_cols or keyword_match:
            reason = keyword_match if keyword_match else f"{sheet_rows} rows × {sheet_cols} cols"
            out.append(f"*(sheet skipped: {reason} — treated as detail data, not vectorized)*\n")
            continue
        rows: list[list[str]] = []
        for row in ws.iter_rows(values_only=True):
            rows.append([str(cell) if cell is not None else "" for cell in row])
        if not rows:
            out.append("*(empty sheet)*\n")
            continue
        max_cols_in_rows = max(len(r) for r in rows)
        for r in rows:
            while len(r) < max_cols_in_rows:
                r.append("")
        # Pad header to the same width as the body so the markdown
        # table is rectangular — otherwise the header has fewer
        # columns than the body and downstream parsers (e.g. the
        # chunker) misalign cells.
        header = rows[0]
        while len(header) < max_cols_in_rows:
            header.append("")
        out.append("| " + " | ".join(header) + " |")
        out.append("| " + " | ".join(["---"] * max_cols_in_rows) + " |")
        # Cap body rows so an audit workbook doesn't produce hundreds of
        # near-identical chunks. Always keep the header.
        body_rows = rows[1 : 1 + max_rows]
        for r in body_rows:
            out.append("| " + " | ".join(r) + " |")
        if len(rows) > 1 + max_rows:
            omitted = len(rows) - 1 - max_rows
            out.append(
                f"| _… {omitted} more rows omitted (capped at {max_rows} per sheet to bound embedding cost) …_ |\n"
            )
        else:
            out.append("")
    wb.close()
    return "\n".join(out)


def read_xls(path: str, max_rows: int, max_cols: int) -> str:
    """Read a legacy .xls workbook.

    The row / column caps and the detail-sheet skip are the SAME ones
    read_xlsx() applies. They used to be missing here, and that was a
    serious problem (found 2026-10-31 on a live drive):

      * read_xls() emitted EVERY row of EVERY sheet with no cap at all
      * a 55 MB legacy .xls produced ~50 MB of markdown
      * which the chunker turned into 246,499 chunks
      * the embedding worker then had to vectorise all of them at
        ~0.1 texts/s on this box -- i.e. WEEKS of CPU for one file
      * and it held an ingest slot the whole time, so the rest of the
        queue (6,400+ files) never moved

    The .xlsx path was capped all along; .xls was simply forgotten.
    """
    import xlrd

    bk = xlrd.open_workbook(path)
    file_name = path.lower()
    out: list[str] = []
    for si in range(bk.nsheets):
        sh = bk.sheet_by_index(si)
        out.append(f"## {sh.name}\n")
        if sh.nrows == 0:
            out.append("*(empty sheet)*\n")
            continue

        # Same detail-sheet skip as read_xlsx: big tables are detail
        # data, not knowledge-base content.
        keyword_match = _matches_detail_keyword(sh.name) or _matches_detail_keyword(file_name)
        if sh.nrows > max_rows or sh.ncols > max_cols or keyword_match:
            reason = keyword_match if keyword_match else f"{sh.nrows} rows x {sh.ncols} cols"
            out.append(f"*(sheet skipped: {reason} - treated as detail data, not vectorized)*\n")
            continue

        n_cols = min(sh.ncols, max_cols)
        header = [str(sh.cell_value(0, ci)) for ci in range(n_cols)]
        out.append("| " + " | ".join(header) + " |")
        out.append("| " + " | ".join(["---"] * n_cols) + " |")
        body_rows = sh.nrows - 1
        for ri in range(1, min(sh.nrows, 1 + max_rows)):
            row = [str(sh.cell_value(ri, ci)) for ci in range(n_cols)]
            out.append("| " + " | ".join(row) + " |")
        if body_rows > max_rows:
            omitted = body_rows - max_rows
            out.append(
                f"| _... {omitted} more rows omitted (capped at {max_rows} per sheet "
                f"to bound embedding cost) ..._ |\n"
            )
        out.append("")
    return "\n".join(out)


def read_docx(path: str) -> str:
    from docx import Document

    doc = Document(path)
    return "\n".join(p.text for p in doc.paragraphs if p.text)


def read_pptx(path: str) -> str:
    from pptx import Presentation

    prs = Presentation(path)
    texts: list[str] = []
    for slide in prs.slides:
        for shape in slide.shapes:
            if hasattr(shape, "text") and shape.text.strip():
                texts.append(shape.text.strip())
    return "\n".join(texts)


def extract(path: str, max_rows: int, max_cols: int) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".xlsx":
        return read_xlsx(path, max_rows, max_cols)
    if ext == ".xls":
        return read_xls(path, max_rows, max_cols)
    if ext == ".docx":
        return read_docx(path)
    if ext == ".pptx":
        return read_pptx(path)
    raise ValueError(f"unsupported extension: {ext}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Fallback office extractor for SAG")
    parser.add_argument("--input", required=True, help="input file path (may be a pointer file containing the real path)")
    parser.add_argument("--output", required=True, help="output markdown file path")
    parser.add_argument(
        "--max-rows",
        type=int,
        default=DEFAULT_MAX_DETAIL_ROWS,
        help=f"max rows per xlsx sheet (default {DEFAULT_MAX_DETAIL_ROWS})",
    )
    parser.add_argument(
        "--max-cols",
        type=int,
        default=DEFAULT_MAX_DETAIL_COLS,
        help=f"max columns per xlsx sheet (default {DEFAULT_MAX_DETAIL_COLS})",
    )
    args = parser.parse_args()

    # P1 — see sag_com-extract-CJK-path-20260914.md. The Node caller
    # writes the real input path to a UTF-8 file in os.tmpdir() (which
    # is always ASCII-clean on Windows, e.g. C:\Users\...\Temp) and
    # passes THAT file's path via --input argv. Pointer file form is
    # the only route that survives both (a) Chinese Windows ANSI
    # codepage munging of argv and (b) the SEA bundle (SAG.exe)
    # closing stdin / dropping env vars on its children. The pointer
    # file path itself goes through argv untouched because tmpdir is
    # always ASCII. Reading the pointer file as UTF-8 inside this
    # helper gives us the real CJK path verbatim.
    if args.input.endswith(".txt") and os.path.isfile(args.input):
        try:
            with open(args.input, "r", encoding="utf-8") as f:
                content = f.read().strip()
            # The Node caller writes the real Windows path into a
            # short UTF-8 pointer file in os.tmpdir() so the CJK path
            # bytes survive argv on Chinese Windows ANSI codepage.
            # If the pointer file's content looks like a real path
            # (has a drive letter C:/D:/... or starts with a UNC
            # \\share prefix), use it; otherwise leave args.input
            # alone and let os.path.isfile() decide.
            if (
                content
                and len(content) > 4
                and (
                    (len(content) >= 3 and content[1] == ":" and content[2] in ("\\", "/"))
                    or content.startswith("\\\\")
                )
                and os.path.isfile(content)
            ):
                args.input = content
                print(f"DBG: resolved input path from pointer file: {args.input}", file=sys.stderr)
        except Exception as e:
            print(f"DBG: pointer file read failed: {e}", file=sys.stderr)

    if not os.path.isfile(args.input):
        print(f"input not found: {args.input}", file=sys.stderr)
        sys.exit(10)

    try:
        text = extract(args.input, args.max_rows, args.max_cols)
    except Exception as exc:
        print(f"extraction failed: {exc}", file=sys.stderr)
        sys.exit(1)

    with open(args.output, "w", encoding="utf-8") as f:
        f.write(text)

    print(args.output)


if __name__ == "__main__":
    main()
