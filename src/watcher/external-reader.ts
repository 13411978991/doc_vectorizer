/**
 * External reader dispatcher.
 *
 * Looks up a reader script in `<exe-dir>/sag-readers/` (or the override
 * path in SAG_READERS_DIR), spawns it with the file path, and returns
 * the extracted text. If no external reader accepts the file, returns
 * null so the caller can fall back to the in-process TS parser.
 *
 * The protocol is documented in sag-readers/SPEC.md. To summarise:
 *   <reader> --meta                 → JSON manifest on stdout, exit 0
 *   <reader> --probe <path>         → exit 0 if it can handle the file
 *   <reader> <path>                 → extracted text on stdout
 *
 * Reader filenames follow the pattern `sag-read-<ext>[.<variant>].<lang>`.
 * The dispatcher matches `<ext>` first, then iterates candidates in
 * alpha order so operators can override by adding a more specific script
 * (e.g. `sag-read-pdf-corp.ps1` beats `sag-read-pdf.py` alphabetically).
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { logger } from "../observability/logger.js";

// ── Reader cert verification ─────────────────────────────────────────
//
// Readers are user-contributed scripts that run with our privileges. We
// only dispatch to a reader if it has a valid `.sag-validator-cert.json`
// certificate written next to it by `sag-reader-validator.exe`.
//
// The cert contains:
//   - readerSha256 + readerSizeBytes + metaDeclaredExtensions (snapshotted)
//   - per-check SHA-256 hashes (snapshot of the validation result)
//   - validatorSelfSha256 (the validator binary's own hash)
//   - HMAC signature computed with a key derived from the validator binary
//
// To trust a cert, we recompute the HMAC with the same key derivation
// and compare. The key seed is `SHA-256(<validator binary bytes>)`, which
// the validator binary publishes in its own `validator-sha256.txt`.
// We hardcode that expected hash below.
//
// SECURITY MODEL (do not weaken this without a code review):
//
//   - This SHA is the trust anchor. Anyone who can change both this file
//     AND `external-reader.ts` can substitute their own validator binary,
//     but they can also replace 黑洞.exe itself at that point — we're
//     not defending against a tampered exe.
//   - In dev mode, the validator runs from source and writes
//     `validatorSelfSha256: "dev-mode-no-self-hash"`. Those certs fail
//     trust check UNLESS `EXPECTED_VALIDATOR_SHA256` is also the dev-mode
//     marker. Set `SAG_ALLOW_DEV_VALIDATOR_CERTS=1` in your env to
//     accept them locally; never ship that env to production.
//   - Updating the validator source requires updating this SHA. The
//     source content fingerprint lives at
//     tools/sag-reader-validator/SHA256.txt — review it in lockstep
//     with this constant.
const EXPECTED_VALIDATOR_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000"; // updated at validator build time
const SAG_ALLOW_DEV = process.env.SAG_ALLOW_DEV_VALIDATOR_CERTS === "1";

type CertBody = {
  schemaVersion: number;
  readerPath: string;
  readerFilename: string;
  readerExtension: string;
  validatorSelfSha256: string;
  validatorSchemaVersion: number;
  issuedAt: string;
  readerSha256: string;
  readerSizeBytes: number;
  metaDeclaredExtensions: string[];
  metaDeclaredLanguages: string[];
  checks: Record<string, string>;
  signature: { algorithm: string; value: string };
};

function deriveSigningKeyFromSha(validatorSha256: string): Buffer {
  // The packaged validator computes the HMAC key as
  //   HMAC-SHA-256(key=SHA-256(validator_binary), data="sag-reader-validator-v1")
  // We rebuild the key from its published SHA-256 — same result, no
  // need to ship the binary with us.
  //
  // Dev-mode certs use a stable string key (see
  // tools/sag-reader-validator/src/main.mjs deriveSigningKey). They
  // are tagged with validatorSelfSha256 = "dev-mode-no-self-hash"
  // so we can branch here.
  if (validatorSha256 === "dev-mode-no-self-hash") {
    return Buffer.from("sag-reader-validator-dev-mode-key-do-not-ship", "utf8");
  }
  return createHmac("sha256", Buffer.from(validatorSha256, "hex"))
    .update("sag-reader-validator-v1")
    .digest();
}

function verifyCert(cert: CertBody): { ok: boolean; reason?: string } {
  if (cert.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported cert schemaVersion ${cert.schemaVersion}` };
  }
  if (cert.signature.algorithm !== "HMAC-SHA256") {
    return { ok: false, reason: `unsupported signature algorithm ${cert.signature.algorithm}` };
  }
  if (cert.validatorSelfSha256 === "dev-mode-no-self-hash") {
    if (!SAG_ALLOW_DEV) {
      return { ok: false, reason: "cert is from dev-mode validator; SAG_ALLOW_DEV_VALIDATOR_CERTS not set" };
    }
    // Dev mode: trust the cert anyway, but warn so devs notice in logs.
  } else if (cert.validatorSelfSha256 !== EXPECTED_VALIDATOR_SHA256) {
    return { ok: false, reason: `validator self-hash mismatch (cert: ${cert.validatorSelfSha256.slice(0, 12)}…, expected: ${EXPECTED_VALIDATOR_SHA256.slice(0, 12)}…)` };
  }

  // Recompute the HMAC over the cert body (excluding signature itself).
  const { signature: _sig, ...body } = cert;
  // IMPORTANT: the validator signs with JSON.stringify of the body in
  // sorted-key order. Mirror that here.
  const sorted = JSON.stringify(body, Object.keys(body).sort());
  const key = deriveSigningKeyFromSha(cert.validatorSelfSha256);
  const expected = createHmac("sha256", key).update(sorted).digest("hex");
  if (expected !== cert.signature.value) {
    return { ok: false, reason: "signature mismatch (cert tampered or validator changed)" };
  }
  return { ok: true };
}

function loadAndVerifyCert(certPath: string): { ok: boolean; reason?: string } {
  let cert: CertBody;
  try {
    cert = JSON.parse(readFileSync(certPath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `cert not parseable as JSON: ${(e as Error).message}` };
  }
  return verifyCert(cert);
}

export type ReaderResult = {
  /** Markdown text (the script's stdout). */
  text: string;
  /** Last-line stderr (typically the JSON metadata blob the script emits). */
  stderrTail: string;
  /** Which reader script produced this (path + interpreter info). */
  reader: string;
  /** Wall-clock cost in ms. */
  tookMs: number;
};

/**
 * Locate reader scripts for a given extension. Returns the candidate
 * paths in priority order (most-specific first, then alphabetical).
 * Skips hidden files and dotfiles.
 */
export function findReaderCandidates(
  ext: string,
  readersDir: string
): string[] {
  const normalized = ext.startsWith(".") ? ext.slice(1).toLowerCase() : ext.toLowerCase();
  if (!normalized) return [];
  if (!existsSync(readersDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(readersDir);
  } catch {
    return [];
  }
  const prefix = `sag-read-${normalized}`;
  const candidates = entries.filter((name) => {
    if (name.startsWith(".")) return false;
    if (!name.startsWith(prefix)) return false;
    // Must end in a known interpreter suffix.
    return /\.(py|ps1|cmd|bat|exe|sh|node\.js)$/i.test(name);
  });
  // Sort: more-specific first (more dots in name), then alphabetical.
  candidates.sort((a, b) => {
    const dotsA = (a.match(/\./g) || []).length;
    const dotsB = (b.match(/\./g) || []).length;
    if (dotsA !== dotsB) return dotsB - dotsA;
    return a.localeCompare(b);
  });
  return candidates.map((name) => path.join(readersDir, name));
}

/**
 * Build the interpreter + argv that should be used to invoke a reader.
 * PowerShell scripts go through `powershell` with `-ExecutionPolicy Bypass`
 * because the user's shell policy may block `.ps1` by default.
 */
function interpreterFor(scriptPath: string): { cmd: string; baseArgs: string[] } {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return {
      cmd: "powershell",
      baseArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
    };
  }
  if (lower.endsWith(".py")) {
    // `python` first (Windows default), `python3` (Linux/macOS default) as fallback.
    // We pick the one that's likely on PATH; the spawn error message will surface
    // if neither is available and the caller decides whether to retry.
    return { cmd: "python", baseArgs: [scriptPath] };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { cmd: "cmd.exe", baseArgs: ["/c", scriptPath] };
  }
  // `.exe`, `.sh`, `.node.js` — invoke directly with the script as argv0.
  return { cmd: scriptPath, baseArgs: [] };
}

type SpawnOpts = {
  timeoutMs: number;
};

function spawnReader(
  cmd: string,
  args: string[],
  inputPath: string,
  opts: SpawnOpts
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, opts.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      // Hard ceiling: refuse to accumulate > 500 MB of stdout so a
      // pathological reader can't OOM the watcher.
      if (stdout.length > 500 * 1024 * 1024) {
        killed = true;
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      // Keep stderr bounded — we only show the tail anyway.
      if (stderr.length > 64 * 1024) {
        stderr = stderr.slice(-64 * 1024);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`reader killed after ${opts.timeoutMs}ms (${cmd} ${args.join(" ")})`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    void inputPath; // referenced implicitly via args; keep param for API clarity
  });
}

/**
 * Run `--probe` on a candidate script. Returns true if it claims to
 * handle the file. We allow up to 30s for a probe — the script should
 * only be doing cheap magic-byte inspection.
 */
async function probeReader(scriptPath: string, inputPath: string): Promise<boolean> {
  const { cmd, baseArgs } = interpreterFor(scriptPath);
  try {
    const { code } = await spawnReader(
      cmd,
      [...baseArgs, "--probe", inputPath],
      inputPath,
      { timeoutMs: 30_000 }
    );
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Spawn a reader script with the file and capture its stdout/stderr.
 * Resolves with the result, or rejects on:
 *  - non-zero exit code
 *  - spawn error (e.g. python not installed → caller falls back)
 *  - timeout
 */
async function runReader(
  scriptPath: string,
  inputPath: string,
  timeoutMs: number
): Promise<ReaderResult> {
  const { cmd, baseArgs } = interpreterFor(scriptPath);
  const started = Date.now();
  const { code, stdout, stderr } = await spawnReader(
    cmd,
    [...baseArgs, inputPath],
    inputPath,
    { timeoutMs }
  );
  const tookMs = Date.now() - started;
  if (code !== 0) {
    throw new Error(
      `reader ${path.basename(scriptPath)} exited ${code}: ${stderr.slice(-300).trim() || "(no stderr)"}`
    );
  }
  return {
    text: stdout,
    stderrTail: stderr.trim(),
    reader: scriptPath,
    tookMs
  };
}

/**
 * Public entry point: dispatch a file to the best external reader, or
 * return null if no reader accepts it.
 *
 * Logs each dispatch decision so operators can see which reader won.
 */
export async function tryExternalReaders(
  inputPath: string,
  ext: string,
  opts: { readersDir: string; timeoutMs?: number }
): Promise<ReaderResult | null> {
  const candidates = findReaderCandidates(ext, opts.readersDir);
  if (candidates.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    // ── Cert gate: refuse to dispatch to readers without a valid
    //    .sag-validator-cert.json certificate. The cert is signed by
    //    sag-reader-validator.exe (see POLICY.md for the trust model).
    const certPath = `${candidate}.sag-validator-cert.json`;
    if (!existsSync(certPath)) {
      logger.warn(
        { reader: path.basename(candidate), certPath },
        "external-reader: skipping — no validator certificate (run sag-reader-validator.exe)"
      );
      continue;
    }
    const certCheck = loadAndVerifyCert(certPath);
    if (!certCheck.ok) {
      logger.warn(
        { reader: path.basename(candidate), certPath, reason: certCheck.reason },
        "external-reader: skipping — invalid validator certificate"
      );
      continue;
    }

    const accepts = await probeReader(candidate, inputPath);
    if (!accepts) {
      logger.debug(
        { reader: path.basename(candidate), inputPath },
        "external-reader: candidate rejected --probe"
      );
      continue;
    }
    try {
      const result = await runReader(candidate, inputPath, timeoutMs);
      logger.info(
        {
          reader: path.basename(candidate),
          ext,
          inputPath,
          tookMs: result.tookMs,
          stdoutBytes: result.text.length
        },
        "external-reader: dispatched"
      );
      return result;
    } catch (err) {
      logger.warn(
        { reader: path.basename(candidate), inputPath, error: (err as Error).message },
        "external-reader: dispatch failed — trying next candidate"
      );
      // Continue to next candidate; one failing reader shouldn't
      // block the rest of the chain.
    }
  }
  return null;
}

/**
 * Resolve the readers directory at runtime. Reads SAG_READERS_DIR
 * first (dev override), then defaults to `<exe-dir>/sag-readers/`.
 *
 * We resolve relative to process.execPath (the exe's location) rather
 * than cwd because the SAG launcher can spawn the exe from any shell.
 */
export function resolveReadersDir(exeDir: string): string {
  const envOverride = process.env.SAG_READERS_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;
  return path.join(exeDir, "sag-readers");
}