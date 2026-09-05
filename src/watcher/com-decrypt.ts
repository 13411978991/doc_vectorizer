/**
 * COM-based text extraction for encrypted Office documents.
 *
 * Office documents that are password-protected or DLP-encrypted
 * (e.g. 亿赛通 / 文档安全系统 / IPGuard) cannot be read by the
 * Node-side parsers (xlsx/mammoth/pdfjs). We delegate to a PowerShell
 * helper that drives the host's Office/WPS via COM automation, opens the
 * encrypted file, extracts text content directly into memory, and
 * returns markdown on stdout. No temp files, no SaveAs — the content
 * never touches disk.
 *
 * Only attempted on Windows; on other platforms a clear error is thrown.
 */
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { logger } from "../observability/logger.js";

/**
 * Extract text content from an encrypted Office file via COM automation.
 * Returns markdown directly. Throws on failure (no Office/WPS, COM error).
 *
 * Round-trip notes (Chinese Windows + PowerShell 5.1):
 *   The PowerShell helper writes the extracted text to a temp file in
 *   real UTF-8 (via `Out-File -Encoding UTF8`) and prints the file path
 *   on stdout. Writing directly to stdout corrupts every Chinese
 *   character because the PS host transcodes [Console]::Write through
 *   the system ANSI code page (GBK). We read the file bytes and decode
 *   as UTF-8 to round-trip the Unicode content safely. The temp file
 *   is deleted before returning.
 */
export async function extractViaCom(
  inputPath: string,
  // 60s instead of the old 5-minute default. Most xlsx COM extracts
  // finish in 25-50s (CA-19 benchmarks). Anything past 60s is almost
  // certainly stuck (VBA macro, external link, file lock from a
  // stale EXCEL.EXE) — see sag_xlsx-问题汇总1-COM卡死-20260818.md
  // §七. We kill earlier so the user gets fast feedback and the
  // queue isn't blocked by one zombie file.
  timeoutMs = 60_000
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error(
      "COM-based extraction is Windows-only. Install Office or WPS Office."
    );
  }

// SAG_SCRIPTS_DIR is set by the SEA entry to the native-cache directory
  // where the bundled decryption helper was unpacked. The SEA host
  // writes the path to <exeDir>/sd-scripts-dir.txt at startup. Reading
  // from this file is more robust than globalThis / process.env because
  // esbuild's SEA bundle runs in an isolated vm context from the SEA
  // host's entry, and globalThis / process.env are not shared between
  // the two realms. The file lives next to the exe (NOT in
  // native-cache, which is per-content-hash and would lose the path
  // on next launch with a different content).
  const scriptsDir = readScriptsDirFromFile();
  const helperCandidates = [
    scriptsDir
      ? path.join(scriptsDir, "com-extract.ps1")
      : null,
    // Dev / explicit install fallbacks.
    path.join(process.cwd(), "scripts", "com-extract.ps1"),
    path.join(path.dirname(process.execPath), "scripts", "com-extract.ps1")
  ].filter((p): p is string => Boolean(p));
  let helperPath: string | null = null;
  for (const candidate of helperCandidates) {
    try {
      await fsp.access(candidate);
      helperPath = candidate;
      break;
    } catch {
      // try next
    }
  }
  if (!helperPath) {
    throw new Error(
      `com-extract.ps1 not found. Looked in: ${helperCandidates.join(", ")}.`
    );
  }

  return new Promise<string>((resolve, reject) => {
    const spawnTime = Date.now();
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", helperPath!,
        "-InputPath", inputPath
      ],
      { windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL' }
    );
    // Belt-and-braces timer in case Node's own `timeout:` option misses
    // (PowerShell's stdout backpressure on huge spreadsheets can stall
    // the event loop). When it fires we SIGKILL the helper AND any
    // child EXCEL.EXE it spawned, so the COM process doesn't linger
    // and slow down subsequent calls.
    const killTimer = setTimeout(() => {
      // Order matters: kill the Excel child FIRST so the PowerShell
      // host can finish unwinding, then the helper itself. Killing PS
      // first leaves EXCEL.EXE running orphaned (we saw 4+ lingering
      // EXCEL.EXE in sag_xlsx-问题汇总1-COM卡死-20260818.md §二).
      // Both calls fire-and-forget — the parent process doesn't wait
      // for taskkill because that could itself stall.
      killOrphanedExcel(spawnTime).catch(() => undefined);
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(new Error(`com-extract: timed out after ${timeoutMs}ms; killed helper + orphaned EXCEL`));
    }, timeoutMs + 5_000);
    child.once("close", () => clearTimeout(killTimer));
    logger.info(
      { file: inputPath, pid: child.pid, spawnTime, timeoutMs },
      "com-decrypt: spawning powershell"
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      logger.error(
        { file: inputPath, pid: child.pid, elapsed: Date.now() - spawnTime, error: err.message },
        "com-decrypt: powershell spawn error"
      );
      reject(err);
    });
    child.on("close", async (code) => {
      const elapsed = Date.now() - spawnTime;
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (stderr) {
        logger.warn(
          { file: inputPath, pid: child.pid, stderr: stderr.slice(0, 500), elapsed },
          "com-decrypt: powershell stderr"
        );
      }
      if (code !== 0) {
        logger.error(
          { file: inputPath, pid: child.pid, code, signal: null, elapsed, stderr: stderr.slice(0, 500) },
          "com-extract: powershell exited with error; killing any orphaned EXCEL"
        );
        // Even when the helper exits with an error (stack overflow,
        // malformed file, …) the EXCEL.EXE process can survive. Sweep
        // it before the next file picks up the same lock and stalls
        // for 5 minutes — see sag_xlsx-问题汇总1-COM卡死-20260818.md §七.3.
        killOrphanedExcel(spawnTime).catch(() => undefined);
        reject(new Error(friendlyError(code ?? -1, stderr)));
        return;
      }
      logger.info(
        { file: inputPath, pid: child.pid, code, elapsed, hasOutput: !!stdout },
        "com-decrypt: powershell exited"
      );
      // The PS helper prints a single line: the temp file path.
      // Read that path's contents as raw UTF-8 bytes (with BOM
      // stripped) so the Unicode text survives the round-trip.
      const filePath = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      if (!filePath) {
        reject(new Error("com-extract: helper did not print a file path"));
        return;
      }
      try {
        const bytes = await fsp.readFile(filePath);
        // Strip UTF-8 BOM if Out-File emitted one. Replace CRLF with
        // LF for downstream consistency.
        const cleaned = bytes
          .toString("utf8")
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n")
          .trimEnd() + "\n";
        // Even on success the PS helper sometimes leaves an EXCEL.EXE
        // alive (PowerShell can return before Quit() fully releases the
        // COM reference). Force-kill any EXCEL.EXE that this helper
        // spawned so the next call starts from a clean slate. We only
        // target EXCEL.EXE, and only those spawned at or after our
        // helper's spawnTime — never the user's interactive Excel.
        killOrphanedExcel(spawnTime).catch(() => undefined);
        resolve(cleaned);
      } catch (err) {
        reject(new Error(`com-extract: failed to read temp file ${filePath}: ${(err as Error).message}`));
      } finally {
        // Best-effort cleanup. Ignore errors — the OS will sweep the
        // temp dir on reboot.
        void fsp.unlink(filePath).catch(() => {});
      }
    });
  });
}

async function killOrphanedExcel(spawnTime: number): Promise<void> {
  // Find EXCEL.EXE processes spawned AFTER spawnTime and kill them.
  // Uses WMIC to get the ProcessId and CreationDate of each EXCEL.EXE,
  // then taskkill /F /PID for any whose creation time >= spawnTime.
  // We deliberately avoid the user's own interactive Excel: by
  // comparing creation timestamps we only target the orphaned
  // children spawned by this PowerShell helper.
  return new Promise<void>((resolve) => {
    const list = spawn(
      "wmic",
      ["process", "where", "name='EXCEL.EXE'", "get", "ProcessId,CreationDate", "/format:csv"],
      { windowsHide: true }
    );
    const chunks: Buffer[] = [];
    list.stdout.on("data", (c: Buffer) => chunks.push(c));
    list.on("error", () => resolve());
    list.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text.split(/\r?\n/).slice(1); // skip header
      const pids: number[] = [];
      for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 2) continue;
        const pid = parseInt(parts[parts.length - 1] || "", 10);
        const creation = parts[parts.length - 2] || "";
        if (!pid || !creation) continue;
        // CreationDate format: yyyymmddHHMMSS.mmmmmmsUUU
        const iso = `${creation.slice(0, 4)}-${creation.slice(4, 6)}-${creation.slice(6, 8)}T${creation.slice(8, 10)}:${creation.slice(10, 12)}:${creation.slice(12, 14)}${creation.slice(15, 21)}Z`;
        const createdAt = Date.parse(iso);
        if (!isNaN(createdAt) && createdAt >= spawnTime) {
          pids.push(pid);
        }
      }
      if (pids.length === 0) {
        resolve();
        return;
      }
      const kill = spawn("taskkill", ["/F", "/PID", pids.join(",")], { windowsHide: true });
      kill.on("close", () => resolve());
      kill.on("error", () => resolve());
    });
  });
}

/**
 * Read the SEA host-written scripts directory hint from
 * <exeDir>/sd-scripts-dir.txt. The SEA entry writes this file at startup
 * (see scripts/build-sea-bundle.mjs). Reading from a file beats both
 * globalThis and process.env here because the esbuild bundle and the
 * SEA host entry run in different vm contexts in Node SEA — neither
 * globalThis.X nor process.env.X propagates from one to the other.
 *
 * The file is plain text, the absolute path, with a trailing newline.
 * Cached after first successful read so the cost is one fs.access per
 * process per file, not per call.
 */
let cachedScriptsDir: string | undefined | null = null;
function readScriptsDirFromFile(): string | undefined {
  if (cachedScriptsDir !== null) return cachedScriptsDir || undefined;
  try {
    const hintPath = path.join(path.dirname(process.execPath), "sd-scripts-dir.txt");
    const raw = require("fs").readFileSync(hintPath, "utf8");
    const trimmed = raw.replace(/^\uFEFF/, "").trim();
    if (trimmed.length > 0) {
      cachedScriptsDir = trimmed;
      return trimmed;
    }
  } catch {
    // file not present or unreadable — fall through to undefined
  }
  cachedScriptsDir = "";
  return undefined;
}

function friendlyError(code: number, stderrTail: string): string {
  // P3 — see sag_xlsx-问题汇总1-开发交付-20260818.md §五.
  // The previous version hard-coded "may be DLP-encrypted" on every
  // PS1 exit 1, which is misleading — exit 1 covers DLP-encrypted,
  // COM exception, SafeNetLOCK interception, corrupted OOXML, etc.
  // We now let the actual stderr speak: the PowerShell helper writes
  // a typed message ("OpenXML failed: ...", "OpenXML timed out ...",
  // "Open returned null document. Possible causes: ...") and the
  // Node side just relays it. The regex strips non-ASCII because the
  // helper's stderr comes back in the system ANSI code page (GBK on
  // Chinese Windows), which PowerShell's writer encoded as UTF-16 —
  // we get garbage unless we filter, but losing the CJK chars is
  // better than getting "Open() failed: ??" in the UI.
  const safe = stderrTail.replace(/[^\x20-\x7E\n]/g, "").trim();
  switch (code) {
    case 1:
      // Surface whatever ps1 actually said. If ps1 left no stderr
      // (which shouldn't happen now, but defence in depth), keep the
      // generic hint.
      return `com-extract: PS1 exit 1 — ${safe || "no stderr output from helper"}`.trim();
    case 10:
      return "com-extract: input file not found (PS1 exit 10).";
    case 11:
      return "com-extract: PDF extraction via COM is not supported (PS1 exit 11).";
    case 12:
      return "com-extract: unsupported extension for COM extraction (PS1 exit 12).";
    case 13:
      return "com-extract: no Office or WPS Office installed (PS1 exit 13). " +
        "Install Office/WPS to unlock encrypted Office documents.";
    case 14:
      return "com-extract: Office temp lock file skipped (PS1 exit 14).";
    default:
      return `com-extract: helper exited with code ${code}. ${safe}`.trim();
  }
}