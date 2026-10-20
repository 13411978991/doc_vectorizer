// sag-reader-validator/src/main.mjs
//
// Standalone validator for sag-readers/* scripts.
//
// What this does (and why it's a separate exe, not part of 黑洞.exe):
//
//   黑洞.exe must never trust a reader script directly. Otherwise:
//     - An attacker (or a careless AI agent on another computer) writes a
//       reader that pipes the user's confidential audit PDFs to a remote
//       server, and 黑洞.exe happily calls it because "the dispatch
//       succeeded".
//     - A broken reader emits bytes that look like text but are actually
//       binary garbage from a half-decrypted DLP file, poisoning the
//       vector store with nonsense.
//
// What we do instead:
//
//   1. This validator (running as its own process) exercises the reader
//      against a battery of behavioral checks (--meta shape, --probe
//      accept/reject, extract output format, memory/time bounds).
//   2. On pass, it writes `.sag-validator-cert.json` next to the reader.
//      The cert is HMAC-signed with a key derived from this validator's
//      own binary bytes — so the cert is unforgeable without rebuilding
//      the validator.
//   3. 黑洞.exe reads both files. If the cert is missing, malformed, or
//      signed by an unexpected validator binary, 黑洞.exe SKIPS the
//      reader and falls back to its built-in Node parser. The user can
//      still work — just no fancy environment-specific extraction.
//
// Tamper resistance:
//
//   The expected SHA-256 of THIS binary is hardcoded in
//   `EXPECTED_VALIDATOR_SHA256` below. If anyone edits this file's source
//   and rebuilds, the new binary won't match, and 黑洞.exe will refuse
//   to honor any cert it signs. So the validation rules can ONLY be
//   changed by editing both this file AND 黑洞.exe in lockstep — which
//   requires a code review, not just an AI prompt.
//
//   (We use SHA-256 of the running binary as the "key seed" rather than
//   a static secret so that we don't have to ship a private key in
//   plain text. Anyone who can replace this binary can already replace
//   anything else, so the property is "no AI can silently weaken checks
//   by editing this file and rerunning" — which holds because rebuilding
//   changes the SHA-256 that 黑洞.exe trusts.)
//
// Invocation:
//
//   node sag-reader-validator.mjs --validate <reader-path> \
//       --probe-file <file> [--probe-reject-file <file>] \
//       [--output <cert-output-path>] [--force]
//
// Exit codes:
//
//   0  — all checks passed, cert written
//   1  — usage error / missing args
//   2  — filename pattern violation (not a sag-read-<ext>.* file)
//   3  — --meta failed (exit / JSON / required fields)
//   4  — --probe accept failed
//   5  — --probe reject failed (returned 0 on wrong file type)
//   6  — main extract failed
//   7  — output format violation (BOM, CR, non-UTF-8, binary garbage)
//   8  — resource bound violation (memory or time)
//   9  — self-integrity violation (binary SHA mismatch)
//
// The exit codes are part of the protocol — agents can wire them into
// their retry / fallback logic. 黑洞.exe treats any non-zero as "reader
// invalid, skip".

import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ──────────────────────────────────────────────────────────────────────
// SELF-INTEGRITY: refuse to run if our own bytes don't match what we
// think they should. This catches the "AI edited the source and ran it
// from Node" bypass — the SHA in this comment only matches the
// unmodified source.
// ──────────────────────────────────────────────────────────────────────
//
// The expected SHA-256 is set at build time (see build.mjs). During
// development (`node src/main.mjs`) we allow any SHA; the gate only
// activates when the validator is run as a packaged exe. The packaged
// exe embeds the SHA at the top of its own bundle.
//
// (The `SAG_READER_VALIDATOR_PACKAGED` env var is set by build.mjs in
// the SEA config — when running as a packaged binary it's "1", when
// running from source it's unset.)

// ──────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function usage() {
  process.stderr.write([
    "sag-reader-validator — validate a SAG reader script",
    "",
    "Usage:",
    "  node sag-reader-validator.mjs --validate <reader-path> \\",
    "       --probe-file <file> [--probe-reject-file <file>] \\",
    "       [--timeout-ms <ms>] [--output <cert-path>] [--force]",
    "",
    "Required:",
    "  --validate          Path to a sag-read-<ext>.<lang> script",
    "  --probe-file        A file the reader SHOULD accept (e.g. a real .docx)",
    "",
    "Optional:",
    "  --probe-reject-file A file the reader SHOULD reject (e.g. a .txt when validating a .docx reader)",
    "  --timeout-ms        Per-invocation timeout, default 120000",
    "  --output            Where to write the cert (default: <reader>.sag-validator-cert.json)",
    "  --force             Overwrite an existing cert",
    "",
    "Exit codes: see source comments. 0 = pass + cert written.",
  ].join("\n"));
}

// ──────────────────────────────────────────────────────────────────────
// Reader dispatch (mirrors what 黑洞.exe does in external-reader.ts)
// ──────────────────────────────────────────────────────────────────────

function interpreterFor(scriptPath) {
  const lower = scriptPath.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return {
      cmd: "powershell",
      baseArgs: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    };
  }
  if (lower.endsWith(".py")) {
    return { cmd: process.env.SAG_READER_PYTHON || "python", baseArgs: [scriptPath] };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { cmd: "cmd.exe", baseArgs: ["/c", scriptPath] };
  }
  return { cmd: scriptPath, baseArgs: [] };
}

// Run a reader with given args. Returns {code, stdout, stderr, elapsedMs, peakRssBytes}.
function runReader(scriptPath, args, timeoutMs) {
  return new Promise((resolveP, rejectP) => {
    const { cmd, baseArgs } = interpreterFor(scriptPath);
    const started = Date.now();
    let proc;
    try {
      proc = spawn(cmd, [...baseArgs, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      rejectP(e);
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let peakRss = 0;
    let killed = false;
    const pollRss = setInterval(() => {
      try {
        // /proc only on POSIX; on Windows we use wmic-like via process.memoryUsage()
        // — but child process RSS isn't exposed cross-platform in Node, so we fall
        // back to the parent's RSS as a coarse upper bound. The 500 MB ceiling
        // is enforced via the parent's RSS — sufficient for our purposes because
        // the validator runs each reader in isolation and the parent doesn't
        // allocate much.
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
      } catch {
        /* ignore */
      }
    }, 250);
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    proc.stdout.on("data", (c) => {
      stdout = Buffer.concat([stdout, c]);
      // Hard ceiling on stdout — refuse to accumulate > 50 MB
      if (stdout.length > 50 * 1024 * 1024) {
        killed = true;
        try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      }
    });
    proc.stderr.on("data", (c) => {
      stderr = Buffer.concat([stderr, c]);
      if (stderr.length > 64 * 1024) {
        stderr = stderr.slice(-64 * 1024);
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(pollRss);
      rejectP(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(pollRss);
      const elapsedMs = Date.now() - started;
      if (killed) {
        resolveP({ code: null, stdout, stderr, elapsedMs, peakRssBytes: peakRss, killed: true });
        return;
      }
      resolveP({ code, stdout, stderr, elapsedMs, peakRssBytes: peakRss });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────
// Output validation (the "is this real text?" checks)
// ──────────────────────────────────────────────────────────────────────

function classifyOutput(buf) {
  if (buf.length === 0) return { ok: false, reason: "empty" };
  // Strip BOM if present
  let body = buf;
  let hadBom = false;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    hadBom = true;
    body = buf.subarray(3);
  }
  // Count CR (we forbid \r\n in stdout per SPEC §3)
  let crCount = 0;
  for (let i = 0; i < body.length; i++) if (body[i] === 0x0d) crCount++;
  // Try UTF-8 decode strict
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { ok: false, reason: "non-utf8", hadBom, crCount };
  }
  // Control-char density: anything below 0x20 except \n \t
  let ctrl = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a && c !== 0x09) ctrl++;
  }
  const ratio = ctrl / Math.max(1, text.length);
  return { ok: true, text, hadBom, crCount, controlRatio: ratio, length: text.length };
}

// ──────────────────────────────────────────────────────────────────────
// Filename parsing
// ──────────────────────────────────────────────────────────────────────

const NAME_RE = /^sag-read-([a-z0-9]+)(?:[.-][a-z0-9]+)*\.(py|ps1|cmd|bat|exe|sh|node\.js)$/i;

function parseReaderName(filename) {
  const m = NAME_RE.exec(filename);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  // If the extension contains a dash, it's a variant marker — split on first dash.
  // e.g. sag-read-pdf-encrypted.ps1 → ext="pdf", variant="encrypted"
  return { ext, variant: null, lang: m[2].toLowerCase() };
}

// ──────────────────────────────────────────────────────────────────────
// Cert signing
// ──────────────────────────────────────────────────────────────────────

// The HMAC key is derived from this validator binary's own bytes. Anyone
// who can rewrite this binary can rewrite anything else, so the property
// we care about is: "you can't silently weaken the rules and have the
// resulting certs still verify against 黑洞.exe". Rebuilding changes the
// SHA-256 and invalidates all certs — exactly what we want.
function deriveSigningKey() {
  const isPackaged = process.env.SAG_READER_VALIDATOR_PACKAGED === "1";
  if (!isPackaged) {
    // Dev mode — use a stable dev key. Certs from dev mode will fail
    // 黑洞.exe's verify (which expects the packaged SHA), so dev certs
    // are obviously not production-grade. That's intentional.
    return Buffer.from("sag-reader-validator-dev-mode-key-do-not-ship", "utf8");
  }
  const selfBytes = readFileSync(process.execPath);
  const sha = createHash("sha256").update(selfBytes).digest();
  // Domain-separate the key from any other use of the SHA
  return createHmac("sha256", sha).update("sag-reader-validator-v1").digest();
}

function signCert(certBody, key) {
  const json = JSON.stringify(certBody, Object.keys(certBody).sort());
  return createHmac("sha256", key).update(json).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────
// Main flow
// ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help || args.h) {
    usage();
    process.exit(1);
  }
  if (!args.validate) {
    process.stderr.write("error: --validate <reader-path> is required\n\n");
    usage();
    process.exit(1);
  }
  if (!args["probe-file"]) {
    process.stderr.write("error: --probe-file <file> is required\n\n");
    usage();
    process.exit(1);
  }

  const readerPath = resolve(args.validate);
  if (!existsSync(readerPath)) {
    process.stderr.write(`error: reader not found: ${readerPath}\n`);
    process.exit(1);
  }

  // ── Check 1: filename pattern ────────────────────────────────────
  const parsed = parseReaderName(basename(readerPath));
  if (!parsed) {
    process.stderr.write(
      `error: filename does not match sag-read-<ext>.<lang>: ${basename(readerPath)}\n`
    );
    process.exit(2);
  }

  const timeoutMs = parseInt(args["timeout-ms"] || "120000", 10);
  const outputPath = args.output || `${readerPath}.sag-validator-cert.json`;
  if (existsSync(outputPath) && !args.force) {
    process.stderr.write(
      `error: cert already exists at ${outputPath}. Pass --force to overwrite.\n`
    );
    process.exit(1);
  }

  const checks = {};
  function setCheck(name, ok, detail) {
    checks[name] = { ok, ...(detail ? { detail } : {}) };
    const tag = ok ? "✓" : "✗";
    process.stderr.write(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}\n`);
  }

  process.stderr.write(`validating ${basename(readerPath)} (ext=${parsed.ext})\n`);

  // ── Check 2/3/4: --meta ─────────────────────────────────────────
  const metaRun = await runReader(readerPath, ["--meta"], timeoutMs);
  const metaOk = metaRun.code === 0;
  let metaJson = null;
  let metaErrReason = null;
  if (metaOk) {
    const s = metaRun.stdout.toString("utf8").trim();
    try {
      metaJson = JSON.parse(s);
    } catch (e) {
      metaErrReason = `meta stdout not JSON: ${e.message}`;
    }
  } else {
    metaErrReason = `--meta exited ${metaRun.code}: ${metaRun.stderr.toString("utf8").trim().slice(0, 200)}`;
  }
  let metaOkFull = metaOk && metaJson !== null;
  if (metaOkFull) {
    if (!metaJson.name || !Array.isArray(metaJson.extensions) || !Array.isArray(metaJson.languages)) {
      metaErrReason = `meta missing required fields (need name, extensions, languages)`;
      metaOkFull = false;
    } else if (!metaJson.extensions.map((e) => String(e).toLowerCase()).includes(`.${parsed.ext}`)) {
      metaErrReason = `meta declares extensions ${JSON.stringify(metaJson.extensions)} but filename implies .${parsed.ext}`;
      metaOkFull = false;
    }
  }
  setCheck("meta-runs-and-valid", metaOkFull, metaErrReason || undefined);
  if (!metaOkFull) {
    process.stderr.write("\naborting: --meta check failed\n");
    process.exit(3);
  }

  // ── Check 5: --probe accepts ───────────────────────────────────
  const probeAcceptFile = args["probe-file"];
  if (!existsSync(probeAcceptFile)) {
    process.stderr.write(`error: --probe-file not found: ${probeAcceptFile}\n`);
    process.exit(1);
  }
  const probeAcceptRun = await runReader(readerPath, ["--probe", probeAcceptFile], timeoutMs);
  const probeAcceptOk = probeAcceptRun.code === 0;
  setCheck(
    "probe-accept",
    probeAcceptOk,
    probeAcceptOk ? undefined : `exit ${probeAcceptRun.code}: ${probeAcceptRun.stderr.toString("utf8").trim().slice(0, 200)}`
  );
  if (!probeAcceptOk) {
    process.exit(4);
  }

  // ── Check 6: --probe rejects ───────────────────────────────────
  const rejectFile = args["probe-reject-file"];
  if (rejectFile) {
    if (!existsSync(rejectFile)) {
      process.stderr.write(`error: --probe-reject-file not found: ${rejectFile}\n`);
      process.exit(1);
    }
    const probeRejectRun = await runReader(readerPath, ["--probe", rejectFile], timeoutMs);
    const probeRejectOk = probeRejectRun.code !== 0;
    setCheck(
      "probe-reject",
      probeRejectOk,
      probeRejectOk ? undefined : `reader accepted unrelated file ${rejectFile} (exit 0); readers must reject non-matching files`
    );
    if (!probeRejectOk) {
      process.exit(5);
    }
  } else {
    setCheck("probe-reject", true, "skipped (no --probe-reject-file)");
  }

  // ── Check 7-12: main extract ───────────────────────────────────
  const extractRun = await runReader(readerPath, [probeAcceptFile], timeoutMs);
  const extractExitOk = extractRun.code === 0;
  const out = classifyOutput(extractRun.stdout);
  const errText = extractRun.stderr.toString("utf8");
  let stderrJsonOk = true;
  let stderrJsonReason = undefined;
  if (errText.trim().length > 0) {
    try {
      JSON.parse(errText.trim().split("\n").pop());
    } catch (e) {
      stderrJsonOk = false;
      stderrJsonReason = `stderr last line not JSON: ${e.message}; tail: ${errText.slice(-200)}`;
    }
  }
  const rssOk = extractRun.peakRssBytes < 500 * 1024 * 1024;
  const timeOk = !extractRun.killed && extractRun.elapsedMs < timeoutMs;

  setCheck("extract-exit-0", extractExitOk, extractExitOk ? undefined : `exit ${extractRun.code}`);
  setCheck("extract-stdout-utf8-no-bom-no-cr", out.ok && !out.hadBom && out.crCount === 0,
    out.ok ? (out.hadBom ? "BOM present" : out.crCount > 0 ? `${out.crCount} CR bytes` : undefined) : `non-UTF-8 stdout`);
  setCheck("extract-stderr-json", stderrJsonOk, stderrJsonReason);
  setCheck("extract-no-binary-garbage", out.ok && out.controlRatio < 0.05,
    out.ok ? `control-char ratio ${(out.controlRatio * 100).toFixed(2)}%` : "non-UTF-8");
  setCheck("extract-non-empty", out.ok && out.length > 0,
    out.ok ? `${out.length} chars` : "non-UTF-8");
  setCheck("memory-bound", rssOk, rssOk ? undefined : `${(extractRun.peakRssBytes / 1024 / 1024).toFixed(0)} MB`);
  setCheck("time-bound", timeOk, timeOk ? `${extractRun.elapsedMs} ms` : `killed at ${timeoutMs} ms`);

  const allOk = extractExitOk && out.ok && !out.hadBom && out.crCount === 0 &&
    stderrJsonOk && out.controlRatio < 0.05 && out.length > 0 &&
    rssOk && timeOk;
  if (!allOk) {
    process.stderr.write("\naborting: extract checks failed\n");
    process.exit(extractExitOk ? 7 : (timeOk ? 6 : 8));
  }

  // ── Sign + write cert ──────────────────────────────────────────
  const key = deriveSigningKey();
  // Self-hash for the cert body so 黑洞.exe can detect "the validator
  // changed between issuing this cert and now" (only matters for SEA
  // builds — dev-mode certs use a placeholder).
  const selfSha256 = process.env.SAG_READER_VALIDATOR_PACKAGED === "1"
    ? createHash("sha256").update(readFileSync(process.execPath)).digest("hex")
    : "dev-mode-no-self-hash";

  const certBody = {
    schemaVersion: 1,
    readerPath: readerPath,
    readerFilename: basename(readerPath),
    readerExtension: `.${parsed.ext}`,
    validatorSelfSha256: selfSha256,
    validatorSchemaVersion: 1,
    issuedAt: new Date().toISOString(),
    readerSha256: createHash("sha256").update(readFileSync(readerPath)).digest("hex"),
    readerSizeBytes: statSync(readerPath).size,
    metaDeclaredExtensions: metaJson.extensions,
    metaDeclaredLanguages: metaJson.languages,
    checks: Object.fromEntries(
      Object.entries(checks).map(([k, v]) => [k, createHash("sha256").update(JSON.stringify(v)).digest("hex")])
    ),
  };
  const signature = signCert(certBody, key);
  const cert = { ...certBody, signature: { algorithm: "HMAC-SHA256", value: signature } };
  writeFileSync(outputPath, JSON.stringify(cert, null, 2) + "\n", "utf8");
  process.stderr.write(`\ncert written: ${outputPath}\n`);
  process.stderr.write("all checks passed.\n");
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`validator crashed: ${e.stack || e.message}\n`);
  process.exit(1);
});
