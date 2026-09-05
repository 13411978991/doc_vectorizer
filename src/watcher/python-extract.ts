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
import { existsSync } from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "../observability/logger.js";

const PYTHON_CANDIDATES = ["python", "python3", "py"];

async function findPython(): Promise<string | null> {
  for (const bin of PYTHON_CANDIDATES) {
    const found = await new Promise<boolean>((resolve) => {
      const child = spawn(bin, ["-c", "print('ok')"], { windowsHide: true });
      let ok = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().trim() === "ok") ok = true;
      });
      child.on("close", (code) => resolve(code === 0 && ok));
    });
    if (found) return bin;
  }
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

  return new Promise<string>((resolve, reject) => {
    const start = Date.now();
    logger.info({ file: inputPath, python, helper }, "python-extract: spawning");
    const child = spawn(
      python,
      [helper, "--input", inputPath, "--output", outputFile],
      { windowsHide: true }
    );
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
