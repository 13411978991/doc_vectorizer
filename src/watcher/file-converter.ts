/**
 * Pure-Node file converter for the watcher pipeline.
 *
 * Replaces the previous design that spawned `python3 scripts/file-converter.py`
 * per ingest. The exe is now self-contained — no Python interpreter, no
 * third-party CLI tools — and runs anywhere Node 20+ runs.
 *
 * Conversion matrix (extension → strategy):
 *   .txt  .md  → passthrough (UTF-8 read; BOM stripped, CRLF normalised)
 *   .pdf       → pdf-parse (text layer only; scanned PDFs yield no text)
 *   .docx      → mammoth (DOCX → markdown; tables/headings preserved)
 *   .pptx      → in-house XML walker over ppt/slides/slide*.xml (see below)
 *   .xlsx .xls → xlsx (SheetJS) — every sheet → markdown table
 *   .csv       → Node fs + simple CSV parser
 *
 * Every converter returns a markdown string. The watcher writes that into a
 * sibling `.md` file under `.tmp/watcher/` and reads it back so the calling
 * code shape stays identical to the old Python flow.
 */
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";
// mammoth's TypeScript types live in @types/mammoth (transitive). The
// library itself is CommonJS, so import the namespace.
import * as mammothNs from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
// pdfjs-dist ships as ESM. Use the legacy build which works in Node and
// doesn't require DOM globals.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// pdfjs-dist's default worker setup tries to load pdf.worker.mjs via a
// dynamic import() — which fails inside the SEA bundle (no relative-path
// filesystem resolution). The legacy build supports a "main thread"
// worker via globalThis.pdfjsWorker, which keeps everything in the same
// process. We import the worker module here and expose its handler so
// pdfjsLib.getDocument() picks it up. No DOM/Canvas worker is needed:
// we only ever call getTextContent, never render.
// Minimal type stub — pdfjs-dist ships the worker without .d.ts but
// the runtime export shape (WorkerMessageHandler) is stable.
type PdfjsWorkerModule = { WorkerMessageHandler: unknown };
// @ts-expect-error - no .d.ts shipped for the worker entrypoint
import * as pdfjsWorkerRaw from "pdfjs-dist/legacy/build/pdf.worker.mjs";
const pdfjsWorker = pdfjsWorkerRaw as unknown as PdfjsWorkerModule;
(globalThis as { pdfjsWorker?: PdfjsWorkerModule }).pdfjsWorker = pdfjsWorker;
pdfjsLib.GlobalWorkerOptions.workerSrc = "(main-thread)";
import { extractViaCom } from "./com-decrypt.js";
import { extractViaPython } from "./python-extract.js";

type Mammoth = {
  convertToMarkdown: (input: { path: string }) => Promise<{
    value: string;
    messages: Array<{ type: string; message: string }>;
  }>;
};
const mammoth = mammothNs as unknown as Mammoth;

/**
 * Convert an arbitrary supported file into Markdown. Returns the markdown
 * string directly — the previous Python flow wrote to `outputPath` and we
 * read it back, but in-process is simpler. We still keep `outputPath` in the
 * signature because the watcher writes a sibling copy for debugging.
 */
export async function convertFile(
  inputPath: string,
  outputPath: string
): Promise<string> {
  const ext = getExtension(inputPath);
  let markdown: string;
  try {
    markdown = await dispatchConvert(ext, inputPath);
  } catch (error) {
    logger.error({ inputPath, ext, error: (error as Error).message }, "watcher: converter failed");
    throw error;
  }

  // Persist a sibling copy under .tmp/watcher/ for debugging parity with
  // the old Python flow. Errors writing the debug copy are non-fatal.
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, markdown, "utf8");
  } catch (error) {
    logger.warn({ outputPath, error: (error as Error).message }, "watcher: converter debug write failed (non-fatal)");
  }
  return markdown;
}

async function dispatchConvert(ext: string, inputPath: string): Promise<string> {
  // Try the parser once. If the error smells like encryption (encrypted
  // OOXML/PDF), fall back to COM-based decryption via the host's Office
  // or WPS, then re-parse the decrypted copy. Otherwise surface the
  // original error so the caller can persist it to last_error.
  let firstError: Error | null = null;
  try {
    return await convertOne(ext, inputPath);
  } catch (error) {
    firstError = error as Error;
    const isEnc = isEncryptionError(ext, firstError.message);
    // Write to a temp file so we can see what's happening even if stderr is lost.
    try {
      writeFileSync(path.join(tmpdir(), "sag-convert-diag.log"),
        `${toLocalISO()} ext=${ext} isEnc=${isEnc} file=${path.basename(inputPath)} msg=${firstError.message.slice(0, 120)}\n`,
        { flag: "a" });
    } catch { /* ignore */ }
    if (!isEnc) {
      throw firstError;
    }
    logger.warn(
      { inputPath, ext, error: firstError.message },
      "watcher: parser rejected file — attempting Python decryption"
    );
  }

  // Try Python extraction first, then COM if that fails.
  const result = await extractViaPythonOrCom(inputPath);
  logger.info({ inputPath }, "watcher: COM extraction succeeded");
  return result;
}

/**
 * Single conversion attempt — no retry, no fallback. Splitting this out
 * from `dispatchConvert` lets the wrapper do "try → maybe-decrypt → try".
 */
async function convertOne(ext: string, inputPath: string): Promise<string> {
  switch (ext) {
    case ".txt":
    case ".md":
      return readTextFile(inputPath);
    case ".pdf":
      return convertPdf(inputPath);
    case ".docx":
      return convertDocx(inputPath);
    case ".doc":
      // Legacy binary Word format. mammoth cannot parse it; try Python first,
      // then route to COM automation (Office/WPS will open the .doc and emit text).
      return extractViaPythonOrCom(inputPath);
    case ".pptx":
      return convertPptx(inputPath);
    case ".ppt":
      // Legacy binary PowerPoint format. The XML walker only handles the
      // modern OOXML container; try Python first, then route legacy .ppt to COM.
      return extractViaPythonOrCom(inputPath);
    case ".xlsx":
      // Use Python first: npm xlsx can hang for minutes on large / externally-
      // linked workbooks, while openpyxl read_only is reliably fast.
      return extractViaPythonOrCom(inputPath);
    case ".xls":
      // Legacy binary Excel format. npm xlsx cannot reliably parse encrypted
      // .xls files (SafeNetLOCK etc.), so try Python first, then COM with a
      // longer timeout (300s = 5 minutes) to handle slow DLP decryption.
      return extractViaPythonOrCom(inputPath, 300_000);
    case ".csv":
      return withGarbledFallback(inputPath, ext, () => convertCsv(inputPath));
    case ".png":
    case ".jpg":
    case ".jpeg":
      throw new Error(
        `OCR is intentionally not supported in the Node-only converter. ` +
          `Skipping ${ext} files. (Re-enable by integrating tesseract.js + a language pack.)`
      );
    default:
      throw new Error(`unsupported extension for conversion: ${ext || "(none)"}`);
  }
}

/**
 * Heuristic: does the parser's error message look like the file is
 * encrypted (or DLP-wrapped)? We can't tell for sure without parsing the
 * file twice, so we pattern-match on a few known signals:
 *
 *   - jszip: "Can't find end of central directory : is this a zip file"
 *     (OOXML encrypted files are not valid zips)
 *   - pdfjs: "Invalid PDF structure" / "Password required" / "Encrypted"
 *   - generic: "password", "encrypted"
 *
 * False positives (e.g. a truncated zip) just hit the COM retry and
 * surface a clear "COM not available" error back to the caller.
 */
function isEncryptionError(ext: string, message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes("end of central directory")) return true;   // OOXML zip
  if (m.includes("password")) return true;
  if (m.includes("encrypt")) return true;
  if (ext === ".pdf" && (m.includes("invalid pdf structure") || m.includes("encrypted"))) {
    return true;
  }
  return false;
}

/**
 * Detect garbled/corrupted text that indicates encryption or encoding issues.
 * SafeNetLOCK and similar DLP systems produce bytes that decode to:
 *   - High ratio of replacement characters (U+FFFD)
 *   - Control characters (0x00-0x1F) in text content
 *   - Very low ratio of printable ASCII/Chinese characters
 *
 * Returns true if the text looks garbled and should trigger COM fallback.
 */
function isGarbledText(text: string): boolean {
  if (text.length === 0) return false;
  
  // Check for SafeNetLOCK encryption signatures
  // These DLP systems embed their identifiers in encrypted content
  if (/E-SafeNet|SafeNet|FFZMX/i.test(text)) return true;
  if (/LOCK/i.test(text) && /[\x00-\x1f]/.test(text)) return true;
  
  // Check for binary encryption patterns (e.g., b\x14#e\x0c)
  if (/b[\x00-\x1f]#e[\x00-\x1f]/.test(text)) return true;
  
  let replacementCount = 0;
  let controlCount = 0;
  let printableCount = 0;
  
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xFFFD) {
      replacementCount++;
    } else if (code < 0x20 && code !== 0x0A && code !== 0x0D && code !== 0x09) {
      // Control chars except newline, carriage return, tab
      controlCount++;
    } else if (code >= 0x20 && code <= 0x7E) {
      // Printable ASCII
      printableCount++;
    } else if (code >= 0x4E00 && code <= 0x9FFF) {
      // CJK Unified Ideographs (Chinese)
      printableCount++;
    } else if (code >= 0x3000 && code <= 0x303F) {
      // CJK Symbols and Punctuation
      printableCount++;
    } else if (code >= 0xFF00 && code <= 0xFFEF) {
      // Halfwidth and Fullwidth Forms
      printableCount++;
    }
  }
  
  const total = text.length;
  const replacementRatio = replacementCount / total;
  const controlRatio = controlCount / total;
  const printableRatio = printableCount / total;
  
  // Heuristics:
  // 1. High replacement char ratio (>5%) indicates encoding corruption
  // 2. High control char ratio (>10%) indicates binary/encrypted data
  // 3. Very low printable ratio (<20%) indicates non-text content
  return replacementRatio > 0.05 || controlRatio > 0.10 || printableRatio < 0.20;
}

/**
 * Try Python-based extraction first. If it fails (or Python isn't
 * installed), fall back to COM automation. This avoids the 30-300s hangs
 * that happen when Excel tries to open SafeNetLOCK-protected or
 * external-link workbooks.
 */
async function extractViaPythonOrCom(inputPath: string, timeoutMs?: number): Promise<string> {
  try {
    return await extractViaPython(inputPath);
  } catch (error) {
    logger.warn(
      { inputPath, error: (error as Error).message },
      "watcher: Python extraction failed — falling back to COM"
    );
    return extractViaCom(inputPath, timeoutMs);
  }
}

/**
 * Try the fast Node.js parser first. If the output looks garbled (encrypted
 * file decoded as text), fall back to COM extraction. This gives us the best
 * of both worlds: fast processing for normal files, automatic COM fallback
 * for encrypted ones.
 */
async function withGarbledFallback(
  inputPath: string,
  ext: string,
  convert: (path: string) => Promise<string>
): Promise<string> {
  try {
    const result = await convert(inputPath);
    // Check if the output looks garbled (encrypted file decoded as text)
    if (isGarbledText(result)) {
      logger.warn(
        { inputPath, ext, sampleLength: Math.min(100, result.length) },
        "watcher: parser output looks garbled — attempting Python/COM extraction"
      );
      return await extractViaPythonOrCom(inputPath, 300_000);
    }
    return result;
  } catch (error) {
    const msg = (error as Error).message;
    if (!isEncryptionError(ext, msg)) {
      throw error;
    }
    logger.warn(
      { inputPath, ext, error: msg },
      "watcher: parser rejected file — attempting Python/COM extraction"
    );
    return await extractViaPythonOrCom(inputPath, 300_000);
  }
}

function getExtension(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot).toLowerCase();
}

async function readTextFile(inputPath: string): Promise<string> {
  const buffer = await fs.readFile(inputPath);
  // Try UTF-8 first (with BOM stripping). If the file contains invalid
  // UTF-8 sequences (common for Chinese Windows TXT files saved as GBK),
  // fall back to GB18030 which is a superset of GBK/GB2312.
  let raw: string;
  try {
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    raw = utf8Decoder.decode(buffer);
  } catch {
    // Not valid UTF-8 — try GB18030 (covers GBK/GB2312/Big5).
    try {
      const gbkDecoder = new TextDecoder("gb18030", { fatal: true });
      raw = gbkDecoder.decode(buffer);
    } catch {
      // Last resort: UTF-8 with replacement characters.
      const fallback = new TextDecoder("utf-8", { fatal: false });
      raw = fallback.decode(buffer);
    }
  }
  // Strip BOM, normalise line endings, trim trailing whitespace.
  const result = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd() + "\n";
  
  // Check if the content looks garbled (encrypted file decoded as text).
  // TXT files cannot use COM fallback, so if it's garbled, throw an error
  // to mark it as unreadable.
  if (isGarbledText(result)) {
    throw new Error(
      `TXT file appears to be encrypted or corrupted: ${inputPath}. ` +
      `Cannot decrypt TXT files — skipping.`
    );
  }
  
  return result;
}

async function convertPdf(inputPath: string): Promise<string> {
  const buffer = await fs.readFile(inputPath);
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({
    data,
    // Node has no DOM; disable features that depend on it.
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0
  }).promise;
  const out: string[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const textContent = await page.getTextContent();
    // Reconstruct each line from the textContent items: pdfjs gives us
    // { str, transform, ... } per text run; items sharing the same y
    // coordinate (rounded) belong to the same line.
    const lines = groupTextContentIntoLines(textContent.items as Array<{
      str: string;
      transform: number[];
    }>);
    out.push(lines.join("\n"));
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * pdfjs' `getTextContent` returns runs in arbitrary order; group runs that
 * share a rounded y-coordinate into the same line, then sort by x.
 */
function groupTextContentIntoLines(items: Array<{ str: string; transform: number[] }>): string[] {
  if (items.length === 0) return [];
  // PDF coordinates have origin at bottom-left and y grows upward; the
  // transform[5] is the y-translation. Round to one decimal to merge runs
  // on the same baseline.
  const lines = new Map<number, Array<{ x: number; str: string }>>();
  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    const key = Math.round(y * 10) / 10;
    const list = lines.get(key) ?? [];
    list.push({ x, str: item.str });
    lines.set(key, list);
  }
  // Sort lines top-to-bottom. Because y grows up, larger y comes first.
  const sortedKeys = Array.from(lines.keys()).sort((a, b) => b - a);
  return sortedKeys.map((k) => {
    const runs = (lines.get(k) ?? []).sort((a, b) => a.x - b.x);
    return runs.map((r) => r.str).join("").replace(/[ \t]+/g, " ").trim();
  }).filter((line) => line.length > 0);
}

async function convertDocx(inputPath: string): Promise<string> {
  const result = await mammoth.convertToMarkdown({ path: inputPath });
  // mammoth emits a `messages` array for warnings (unused styles, etc.) —
  // log at debug level but don't fail the ingest.
  if (result.messages.length > 0) {
    logger.debug(
      { inputPath, messages: result.messages.map((m) => `${m.type}: ${m.message}`) },
      "watcher: mammoth warnings"
    );
  }
  return (result.value ?? "").trimEnd() + "\n";
}

/**
 * PPTX is a zip with XML files under ppt/slides/slide*.xml. Walk them in
 * order, extract text from <a:t> elements, and emit a heading + bullets per
 * slide. Pure JS — no native deps.
 */
async function convertPptx(inputPath: string): Promise<string> {
  return withComFallback(inputPath, ".pptx", convertPptxImpl);
}

async function convertPptxImpl(inputPath: string): Promise<string> {
  const buffer = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml$/.exec(a)?.[1] ?? 0);
      const nb = Number(/slide(\d+)\.xml$/.exec(b)?.[1] ?? 0);
      return na - nb;
    });

  const out: string[] = [];
  for (const fileName of slideFiles) {
    const xml = await zip.file(fileName)?.async("string");
    if (!xml) continue;
    const slideNumber = Number(/slide(\d+)\.xml$/.exec(fileName)?.[1] ?? 0);
    const { title, bullets } = extractSlideContent(xml);
    out.push(`## ${title || `Slide ${slideNumber}`}`);
    for (const bullet of bullets) {
      out.push(`- ${bullet}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/**
 * Pull text runs from a slide XML. The first non-empty text in a
 * title placeholder becomes the heading; everything else becomes bullets.
 */
function extractSlideContent(xml: string): { title: string; bullets: string[] } {
  const title = "";
  const bullets: string[] = [];
  // Collect all <a:t>...</a:t> runs in document order. Each run is one
  // contiguous piece of text; a paragraph is built from consecutive runs.
  const runs: string[] = [];
  const runRegex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
  let m: RegExpExecArray | null;
  while ((m = runRegex.exec(xml)) !== null) {
    const text = decodeXmlEntities(m[1] ?? "").trim();
    if (text) runs.push(text);
  }
  // PPTX slide structure: paragraphs <a:p>. We don't easily know paragraph
  // boundaries from a flat run list, so treat the first run as the title
  // and the rest as bullets. For more granular output we'd need to walk
  // <a:p> elements and split runs by paragraph — kept simple here.
  const [first, ...rest] = runs;
  return {
    title: first ?? "",
    bullets: rest
  };
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

/**
 * Wrap a converter function with COM-based fallback. If the converter
 * throws an encryption-shaped error, call `decryptViaCom` to get a
 * decrypted copy and retry. This is duplicated inside each converter
 * (convertPptx/convertDocx/convertXlsx) in addition to the top-level
 * `dispatchConvert` wrapper, so the retry is guaranteed even if the
 * outer wrapper is bypassed.
 */
async function withComFallback(
  inputPath: string,
  ext: string,
  convert: (path: string) => Promise<string>
): Promise<string> {
  // Office temp lock file (~$*.docx etc.). Skip without trying to
  // parse — opening via COM would hang on the conflict dialog.
  const basename = path.basename(inputPath);
  if (basename.startsWith("~$")) {
    return `*(skipped: Office temp lock file)*\n`;
  }
  try {
    return await convert(inputPath);
  } catch (error) {
    const msg = (error as Error).message;
    if (!isEncryptionError(ext, msg)) {
      throw error;
    }
    logger.warn(
      { inputPath, ext, error: msg },
      "watcher: parser rejected file — attempting Python/COM extraction"
    );
  }
  // Try Python-based extraction first (avoids hanging COM/Office on
  // SafeNetLOCK / external-link workbooks), then COM if that fails.
  const result = await extractViaPythonOrCom(inputPath);
  logger.info({ inputPath }, "watcher: fallback extraction succeeded");
  return result;
}

/**
 * XLSX → markdown: every sheet becomes an H2 section, every row a markdown
 * table row. Limit columns to 20 and rows to 5000 to keep markdown tractable.
 */
async function convertXlsx(inputPath: string): Promise<string> {
  return convertXlsxImpl(inputPath);
}

async function convertXlsxImpl(inputPath: string): Promise<string> {
  const buffer = await fs.readFile(inputPath);
  const wb = XLSX.read(buffer, { type: "buffer" });
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const range = getSheetRange(sheet);
    const fileName = path.basename(inputPath).toLowerCase();
    let skipReason: string | null = null;
    if (range && range.rows > MAX_SHEET_ROWS) {
      skipReason = `${range.rows} rows > ${MAX_SHEET_ROWS}`;
    } else if (range && range.cols > MAX_SHEET_COLS) {
      skipReason = `${range.cols} cols > ${MAX_SHEET_COLS}`;
    } else if (isDetailReportName(sheetName) || isDetailReportName(fileName)) {
      skipReason = `detail-report keyword matched in "${isDetailReportName(sheetName) ? sheetName : path.basename(inputPath)}"`;
    }
    if (skipReason) {
      out.push(`## ${sheetName}`);
      out.push("");
      out.push(`*(sheet skipped: ${skipReason} — treated as detail data, not vectorized)*`);
      out.push("");
      continue;
    }
    out.push(`## ${sheetName}`);
    out.push("");
    const rows = sheetToRows(sheet);
    if (rows.length === 0) {
      out.push("*(empty sheet)*");
      out.push("");
      continue;
    }
    // Normalise column count to the maximum row width.
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const padded = rows.map((r) => [...r, ...Array(maxCols - r.length).fill("")]);
    const header = padded[0] ?? [];
    out.push("| " + header.map(escapeCell).join(" | ") + " |");
    out.push("| " + header.map(() => "---").join(" | ") + " |");
    // Cap body rows to bound embedding work on huge spreadsheets. A
    // 50k-row spreadsheet would otherwise produce ~50k/512 ≈ 100 chunks
    // even with only header content. 200 rows covers the relevant
    // data in 99% of audit spreadsheets; for the rest, the user can
    // pre-filter the source. We always keep the header.
    const MAX_BODY_ROWS = 200;
    const bodyRows = padded.slice(1, 1 + MAX_BODY_ROWS);
    for (const row of bodyRows) {
      out.push("| " + row.map(escapeCell).join(" | ") + " |");
    }
    if (padded.length > 1 + MAX_BODY_ROWS) {
      const omitted = padded.length - 1 - MAX_BODY_ROWS;
      out.push(`| _… ${omitted} more rows omitted (capped at ${MAX_BODY_ROWS} per sheet to bound embedding cost) …_ |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

const MAX_SHEET_ROWS = 200;
const MAX_SHEET_COLS = 26;

// Sheet/file names containing these keywords are treated as detail reports
// and skipped from vectorization, regardless of size.
const DETAIL_KEYWORDS = [
  "明细", "台账", "报表", "记录", "流水", "汇总",
  "details", "ledger", "log", "register", "明细表", "台账表", "汇总表"
];

function isDetailReportName(name: string): boolean {
  const lower = name.toLowerCase();
  return DETAIL_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function getSheetRange(sheet: Record<string, unknown>): { rows: number; cols: number } | null {
  const ref = (sheet as { "!ref"?: string })["!ref"];
  if (!ref) return null;
  const decoded = XLSX.utils.decode_range(ref);
  return {
    rows: decoded.e.r - decoded.s.r + 1,
    cols: decoded.e.c - decoded.s.c + 1,
  };
}

function sheetToRows(sheet: Record<string, unknown>): string[][] {
  // xlsx's `!ref` is the only reliable "is the sheet empty?" check — an
  // empty sheet has no ref at all.
  const ref = (sheet as { "!ref"?: string })["!ref"];
  if (!ref) return [];
  const json: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  return json.map((row) => row.map((cell) => {
    // SheetJS may return Date objects, numbers, or raw cell objects.
    // Normalize everything to string safely.
    if (cell instanceof Date) {
      return cell.toISOString().split("T")[0]; // YYYY-MM-DD
    }
    if (typeof cell === "object" && cell !== null && "v" in cell) {
      // Raw cell object: { t: 's', v: 'text', w: 'formatted' }
      const raw = (cell as { w?: string; v?: unknown }).w ?? (cell as { v?: unknown }).v;
      return String(raw ?? "");
    }
    return String(cell ?? "");
  }));
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}

/**
 * Minimal RFC 4180-ish CSV parser. Supports quoted fields with embedded
 * commas and escaped double-quotes. Sufficient for the kinds of CSVs a
 * watcher would ingest; we don't try to be a full RFC implementation.
 */
async function convertCsv(inputPath: string): Promise<string> {
  const raw = (await fs.readFile(inputPath, "utf8")).replace(/^\uFEFF/, "");
  const rows = parseCsv(raw);
  if (rows.length === 0) return "";
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = rows.map((r) => [...r, ...Array(maxCols - r.length).fill("")]);
  const header = padded[0] ?? [];
  const out: string[] = [];
  out.push("| " + header.map(escapeCell).join(" | ") + " |");
  out.push("| " + header.map(() => "---").join(" | ") + " |");
  for (const row of padded.slice(1)) {
    out.push("| " + row.map(escapeCell).join(" | ") + " |");
  }
  return out.join("\n").trimEnd() + "\n";
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          cell += "\"";
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(cell);
      cell = "";
      // Skip \r\n pair.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  // Flush the final cell / row if the file didn't end with a newline.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}



/**
 * Passthrough extensions — for these the converter reads the file directly
 * and normalises encoding/line endings.
 */
export const PASSTHROUGH_EXTENSIONS = new Set([".txt", ".md"]);

/**
 * Extensions handled by the in-process Node converter.
 */
export const CONVERTER_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".pptx",
  ".ppt",
  ".xlsx",
  ".xls",
  ".csv"
]);

/**
 * Source-code extensions — these wrap raw text in a fenced markdown block.
 * Kept here for parity with the old Python converter's CODE_LANG_HINTS table,
 * but the current ingestion flow reads text files directly so this set is
 * mostly informational.
 */
const CODE_LANG_HINTS: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".jsx": "jsx",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".java": "java",
  ".kt": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".sql": "sql"
};

export function getCodeLanguage(ext: string): string {
  return CODE_LANG_HINTS[ext] ?? "";
}

// Silence the unused-declaration warning when nothing imports the helper.
void logger;