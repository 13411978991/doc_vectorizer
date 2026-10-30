/**
 * Python-based fallback text extractor for Office documents.
 *
 * When the pure-Node parser fails on an encrypted/DLP-wrapped file and
 * the COM helper hangs (e.g. SafeNetLOCK intercept, external links), we
 * can fall back to `scripts/extract-office.py`. It uses openpyxl / xlrd /
 * python-docx / python-pptx to read the file directly without loading
 * Office COM, which avoids the 30-second OpenXML timeout.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../observability/logger.js";
import { performanceSettingsService } from "../services/performance-settings-service.js";

const PYTHON_CANDIDATES = ["python", "python3", "py"];

/**
 * Cached result of the Python probe.
 *
 * `undefined` = not probed yet, `null` = no usable interpreter.
 *
 * Why this cache exists (2026-10-30)
 * -----------------------------------
 * `findPython()` used to run on EVERY extraction, spawning
 * `python -c "print('ok')"` as a liveness probe and then spawning
 * python AGAIN to do the actual work. Measured on a loaded machine:
 *
 *   python -c "pass"          (interpreter startup only)   617 ms
 *   python -c "print('ok')"   (the probe)                  671 ms
 *   import openpyxl           (inside the real extraction) 3,975 ms
 *
 * So every single .xlsx/.doc/.ppt file paid an extra ~0.7 s of pure
 * Python interpreter startup before any work began — for a 20 KB
 * spreadsheet that is ~14% of the total extraction time, and over a
 * 6,900-file drive it adds up to well over an hour of pure waste.
 *
 * The interpreter does not change while the process is alive, so the
 * probe is done once. This mirrors the existing `cachedScriptsDir`
 * pattern a few lines below.
 */
let cachedPython: string | null | undefined;

async function findPython(): Promise<string | null> {
  if (cachedPython !== undefined) {
    return cachedPython;
  }
  for (const bin of PYTHON_CANDIDATES) {
    const found = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["-c", "print('ok')"], { windowsHide: true });
      let ok = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().trim() === "ok") ok = true;
      });
      child.on("close", (code) => resolve(code === 0 && ok));
    });
    if (found) {
      cachedPython = bin;
      return bin;
    }
  }
  cachedPython = null;
  return null;
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
 * Cached after first successful read.
 */
let cachedScriptsDir: string | undefined | null = null;
function readScriptsDirFromFile(): string | undefined {
  if (cachedScriptsDir !== null) return cachedScriptsDir || undefined;
  try {
    const hintPath = path.join(path.dirname(process.execPath), "sd-scripts-dir.txt");
    const raw = readFileSync(hintPath, "utf8");
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

function findHelper(): string {
  // Read SAG_SCRIPTS_DIR via the SEA host-written <exe>/sd-scripts-dir.txt
  // file rather than globalThis or process.env — esbuild's bundle runs
  // in a separate vm context from the SEA host entry, so neither
  // globalThis nor process.env mutations made by the entry reach the
  // bundle. The file is the only cross-realm carrier we can rely on.
  // See com-decrypt.ts for the same fix.
  const scriptsDir = readScriptsDirFromFile();
  const candidates = [
    // Highest priority: SAG_SCRIPTS_DIR set by the SEA entry — points
    // at the native-cache directory where the bundled Python helper
    // was unpacked. End users should never see the helper on their
    // filesystem.
    scriptsDir
      ? path.join(scriptsDir, "extract-office.py")
      : null,
    // Dev / explicit install fallbacks (used when running from
    // source tree or when an integrator copies it next to the exe).
    path.join(process.cwd(), "scripts", "extract-office.py"),
    path.join(path.dirname(process.execPath), "scripts", "extract-office.py")
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`extract-office.py not found. Looked in: ${candidates.join(", ")}`);
}

export async function extractViaPython(inputPath: string): Promise<string> {
  const python = await findPython();
  if (!python) {
    throw new Error("python-based extraction: no python executable found");
  }
  const helper = findHelper();
  const outputFile = path.join(os.tmpdir(), `sag-python-extract-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);

  // Read the latest performance settings async so we always pass the
  // freshest sheet caps to the Python helper. The sync
  // `getRuntimePerformanceSettings()` reads from the in-process
  // cache which can return env defaults right after a PUT invalidated
  // it (CACHE_TTL_MS window) — making the user's "单表最多行数"
  // slider edits silently no-op for the first 5s after save.
  const performance = await performanceSettingsService.getEffective();

  return new Promise<string>((resolve, reject) => {
    const start = Date.now();
    logger.info({ file: inputPath, python, helper, maxRows: performance.maxSheetRows, maxCols: performance.maxSheetCols }, "python-extract: spawning");
    // P1 — see sag_com-extract-CJK-path-20260914.md. Same root
    // cause as the com-extract.ps1 fix: argv on Chinese Windows
    // passes through ANSI codepage (GBK), dropping CJK bytes from
    // the path. We tried stdin / env-var / Base64 routes but the
    // SEA bundle (SAG.exe) intercepts all three. Pointer file
    // placed in `os.tmpdir()` survives because that path is always
    // ASCII (`C:\Users\<user>\AppData\Local\Temp`) — the pointer-
    // file path itself goes through argv intact.
    const pointerFile = path.join(os.tmpdir(), `sag-py-input-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    writeFileSync(pointerFile, inputPath, { encoding: "utf8" });
    const cleanupPointer = () => {
      try { unlinkSync(pointerFile); } catch { /* best-effort */ }
    };

    const child = spawn(
      python,
      [
        helper,
        "--input",
        pointerFile,
        "--output",
        outputFile,
        // Forward the runtime sheet caps so the user-facing
        // Settings → 性能设置 → 单表最多行/列数 sliders actually
        // take effect. Without these, the Python helper falls back
        // to its hard-coded defaults and ignores user edits.
        "--max-rows",
        String(performance.maxSheetRows),
        "--max-cols",
        String(performance.maxSheetCols)
      ],
      { windowsHide: true }
    );
    child.once("close", cleanupPointer);
    child.once("error", cleanupPointer);
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => reject(err));
    child.on("close", async (code) => {
      const elapsed = Date.now() - start;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (code !== 0) {
        logger.warn({ file: inputPath, code, elapsed, stderr }, "python-extract: failed");
        reject(new Error(`python-extract failed (exit ${code}): ${stderr || "unknown error"}`));
        return;
      }
      logger.info({ file: inputPath, elapsed, stdout }, "python-extract: succeeded");
      try {
        const bytes = await fsp.readFile(outputFile);
        const text = bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trimEnd() + "\n";
        resolve(text);
      } catch (err) {
        reject(new Error(`python-extract: failed to read output file ${outputFile}: ${(err as Error).message}`));
      } finally {
        void fsp.unlink(outputFile).catch(() => {});
      }
    });
  });
}
