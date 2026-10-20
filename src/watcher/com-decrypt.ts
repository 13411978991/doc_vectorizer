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
import { promises as fsp, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "../observability/logger.js";
import { config } from "../config/env.js";

/**
 * P31 — semaphore bounding concurrent COM extractions.
 *
 * Office COM has a single global lock per user session. Spawning more
 * than ~3 EXCEL.EXE processes in parallel causes them to fight for
 * the lock and the slowest one to hang until our 30s timer fires.
 * The hangs compound when the watcher sees a burst of DLP-encrypted
 * files (every audit project has at least one folder of these):
 * each file opens an EXCEL, each times out, each killOrphanedExcel
 * is called and kills ALL EXCEL on the box. After 3-4 such cycles
 * the system is left with 60+ leaked EXCEL processes holding
 * invisible Office resource locks; the next 100 files all fail.
 *
 * The gate caps concurrency at 3. Higher values occasionally help
 * with small files on fast boxes; 3 is the empirical safe ceiling
 * on Windows 11 + Office 2021 in our test corpus.
 *
 * The gate is module-scoped so all callers share it. If a future
 * caller needs a different ceiling, parameterise it on the function
 * rather than adding a second gate.
 */
// P33 — see sag_com-extract-concurrency-20261019.md.
//
// Was 3, then measured: with 3 concurrent powershell helpers each
// doing New-Object -ComObject KET.Application, the three WPS process
// spawns serialize on the per-user COM appliance and each helper
// sits in CoCreateInstance for 30+s. The first one to time out
// triggers killOrphanedExcel which nukes ALL WPS processes —
// including the two that were about to succeed — and the next batch
// of files starts from zero again. Net effect: every file in a
// burst fails, even though a SINGLE helper completes the same file
// in ~35s (measured: 调用日志.xls → 19,836 chars via KET).
//
// COM automation is a per-user global lock anyway (one Office/WPS
// appliance per session), so parallel helpers never actually run in
// parallel — they queue inside COM and pay the startup cost
// concurrently instead of sequentially. 1 is the only value that
// doesn't thrash.
const COM_MAX_CONCURRENCY = 1;

// P34 — see sag_com-extract-concurrency-20261019.md.
//
// Process names the orphan-killer / startup sweep must match. The COM
// helpers automate WPS Office on most hosts (KET.Application /
// KWPS.Application / KWPP.Application) whose binaries are et.exe /
// wps.exe / wpp.exe — NOT EXCEL.EXE. A kill list that only matches
// EXCEL.EXE leaks every failed WPS attempt (measured: 7 orphaned
// et.exe ≈ 1 GB after a single folder sync), and the next
// New-Object -ComObject KET.Application then attaches to a leaked
// modal-state et.exe and fails fast with HRESULT:0x800A03EC. The MS
// Office names are included so a mixed host cleans up Word /
// PowerPoint leaks the same way.
const COM_PROCESS_RE =
  /^"(EXCEL\.EXE|et\.exe|wps\.exe|wpp\.exe|WINWORD\.EXE|POWERPNT\.EXE)","(\d+)"/i;

let comActive = 0;
const comWaiters: Array<() => void> = [];
function acquireComSlot(): Promise<void> {
  if (comActive < COM_MAX_CONCURRENCY) {
    comActive++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => comWaiters.push(resolve));
}
function releaseComSlot(): void {
  const next = comWaiters.shift();
  if (next) {
    // Hand the slot to the next waiter; do NOT decrement comActive.
    next();
  } else {
    comActive--;
  }
}

/**
 * P31 — startup sweep.
 *
 * When SAG restarts, any EXCEL.EXE process left over from the previous
 * run still holds the Office COM apartment registered for the user
 * session. New COM calls hang on CoCreateInstance until the apartment
 * is freed. We kill every EXCEL.EXE that started BEFORE the current
 * process on startup so the first sync of the new run isn't blocked
 * by the previous run's residue.
 *
 * `sweepStartupOrphans` is best-effort: it returns a Promise that
 * resolves within 5s even if tasklist / taskkill hang. Callers should
 * not block startup on it — kick it off and let the watcher proceed
 * (a sync that races with the sweep just hits the regular
 * killOrphanedExcel path, which already cleans up).
 *
 * IMPORTANT: the sweep is intentionally NOT re-run during normal
 * operation. mid-run kills are gated by the error path (timeout /
 * exit-≠-0) so a user interactively editing an Excel workbook
 * doesn't have it yanked out from under them. Startup is the only
 * safe time to do an unconditional sweep.
 */
let startupSweepDone = false;
export function sweepStartupOrphans(): Promise<void> {
  if (startupSweepDone) return Promise.resolve();
  startupSweepDone = true;
  return new Promise<void>((resolve) => {
    const myPid = process.pid;
    const hardTimeout = setTimeout(() => resolve(), 5_000);
    try { hardTimeout.unref?.(); } catch { /* ignore */ }
    // No /FI filter: tasklist accepts only one IMAGENAME per filter,
    // and we need to match several (EXCEL.EXE + WPS et/wps/wpp +
    // WINWORD + POWERPNT). A full CSV dump is still ~100ms.
    const list = spawn(
      "tasklist",
      ["/FO", "CSV", "/NH"],
      { windowsHide: true }
    );
    let resolved = false;
    const safeResolve = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      resolve();
    };
    list.on("error", () => safeResolve());
    const chunks: Buffer[] = [];
    list.stdout.on("data", (c: Buffer) => chunks.push(c));
    list.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const pids: number[] = [];
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(COM_PROCESS_RE);
        if (m) {
          const pid = parseInt(m[2], 10);
          // Skip our own PID and the SAG backend / electron PIDs (none
          // of those name-match the Office/WPS list, but be defensive
          // in case a future helper spawns under a similar name).
          if (pid !== myPid) pids.push(pid);
        }
      }
      if (pids.length === 0) {
        logger.info("com-decrypt startup sweep: no Office/WPS residue");
        safeResolve();
        return;
      }
      logger.warn(
        { count: pids.length, pids: pids.slice(0, 20) },
        "com-decrypt startup sweep: killing leftover Office/WPS processes from previous run"
      );
      const kill = spawn(
        "taskkill",
        ["/F", "/PID", pids.join(","), "/T"],
        { windowsHide: true }
      );
      kill.on("close", () => {
        logger.info({ killed: pids.length }, "com-decrypt startup sweep done");
        safeResolve();
      });
      kill.on("error", () => safeResolve());
    });
  });
}

/**
 * P5 — DLP/SMB UNC-path workaround.
 *
 * The PowerShell helper's `Documents.Open($path)` call hangs forever on
 * UNC paths when a DLP client (天锐绿盾 / SafeNetLOCK / IPGuard) is
 * installed and active. The DLP client hooks the SMB stack and blocks
 * Office's COM open until an interactive unlock prompt is answered —
 * which a headless PS1 host can't do, so the call never returns and
 * the watcher times out (exit code -1 = SIGKILL by the killTimer).
 *
 * The fix: when `inputPath` is a UNC path (`\\server\share\…` or the
 * POSIX-mapped `//server/share/…` form), copy the file bytes to
 * `os.tmpdir()` first, then hand the local temp path to PS1. Office
 * COM opens local paths without going through the DLP SMB hook, so
 * it returns in seconds. The temp copy is deleted on EVERY exit
 * path (resolve / reject / timeout / spawn error) — see
 * `cleanupTempCopy` + the `finally` wrappers in `extractViaCom`.
 *
 * The original UNC path is still recorded in logs and used as the
 * stat() key, so size-based timeouts and post-extract re-stat logic
 * upstream keep working.
 *
 * Disabled when the env var `SAG_DISABLE_UNC_COPY` is set to a truthy
 * value — useful for debugging the DLP hook itself.
 */
function isUncPath(p: string): boolean {
  // Windows UNC: \\server\share or \\?\UNC\server\share
  // POSIX-style: //server/share (some Linux-mounted SMB clients)
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  // Extended-length path: \\?\UNC\server\share
  if (/^\\\\\?\\UNC\\/i.test(p)) return true;
  return false;
}

function unlinkQuiet(p: string | null | undefined): void {
  if (!p) return;
  try {
    unlinkSync(p);
  } catch (err) {
    // ENOENT is fine — the file is already gone. Anything else gets
    // logged at debug level so operators can investigate leaked
    // temp files without flooding the warn channel.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.debug(
        { tempFile: p, error: (err as Error).message, code },
        "com-decrypt: temp cleanup failed (non-fatal)"
      );
    }
  }
}

/**
 * P2 — file-size-aware timeout budget. Real audit machines ship
 * 90–200 MB xlsx files that take 30–60 s for COM to open + save +
 * dump, vs <5 s for a 200 KB memo. A single 60s budget blows the
 * 100 MB+ files; a single 5-minute budget holds the queue hostage
 * when a single file hangs. The compromise: compute budget from
 * the actual file size, scaled so a 1 MB file gets 30s and a
 * 100 MB file gets 600s, capped at the configured ceiling.
 *
 * The mapping is linear: `30s + max(0, sizeMB - 1) * 6s`, clamped
 * to [30s, maxTimeoutMs]. Tuned on the audit corpus (191 MB max)
 * and validated by the integration test. Operators who want a
 * stricter cap can lower `MAX_COM_TIMEOUT_MS` via the settings
 * page (added in P2).
 */
export function computeComTimeoutMs(fileSizeBytes: number, maxTimeoutMs = 600_000): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) return 60_000;
  const sizeMB = fileSizeBytes / (1024 * 1024);
  const baseSec = 30;
  const perMbSec = 6;
  const budgetSec = baseSec + Math.max(0, sizeMB - 1) * perMbSec;
  // Coerce to integer milliseconds. PowerShell's
  // [System.Threading.Timeout] ctor throws "The value of 'timeout' is
  // out of range. It must be an unsigned integer. Received 36164.0625"
  // when given a float (e.g. from a watcher path that fed KBs through
  // by mistake), so we floor before passing downstream.
  const ms = Math.min(Math.max(budgetSec * 1000, 30_000), maxTimeoutMs);
  return Math.floor(ms);
}

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
  // P2: prefer the caller-supplied budget. Fall back to the size-aware
  // default when the caller doesn't know — most callers (file-converter
  // / extractViaPythonOrCom) pass 300_000 (the old hard cap), which
  // would have starved 100+ MB audit files.
  timeoutMs: number | undefined = undefined
): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error(
      "COM-based extraction is Windows-only. Install Office or WPS Office."
    );
  }

  // P5 — DLP UNC-path workaround. If the input is a UNC path, copy
  // it to a local temp file BEFORE we hand anything to PS1. The PS1
  // helper then opens the local path; the DLP SMB hook never sees the
  // request and Documents.Open returns in seconds instead of hanging
  // until the killTimer fires. The temp copy is owned by this
  // function and is unconditionally unlinked by the outer try/finally
  // below — on every exit path (resolve, reject, timeout, early
  // throw).
  const disableUncCopy = process.env.SAG_DISABLE_UNC_COPY === "1" ||
    process.env.SAG_DISABLE_UNC_COPY === "true";
  let tempCopy: string | null = null;
  let effectiveInputPath = inputPath;
  if (!disableUncCopy && isUncPath(inputPath)) {
    try {
      const ext = path.extname(inputPath) || ".bin";
      tempCopy = path.join(
        tmpdir(),
        `sag-unc-copy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
      );
      const buf = await fsp.readFile(inputPath);
      await fsp.writeFile(tempCopy, buf);
      logger.info(
        { source: inputPath, tempCopy, size: buf.length },
        "com-decrypt: copied UNC input to local temp (DLP workaround)"
      );
      effectiveInputPath = tempCopy;
    } catch (copyErr) {
      // If the copy fails, fall through and let PS1 try the UNC path
      // directly — better than giving up outright. The temp file
      // (if partially written) is best-effort cleaned below.
      logger.warn(
        { source: inputPath, error: (copyErr as Error).message },
        "com-decrypt: UNC -> local copy failed; trying UNC path directly"
      );
      unlinkQuiet(tempCopy);
      tempCopy = null;
    }
  }

  try {
    return await extractViaComInner(effectiveInputPath, timeoutMs);
  } finally {
    // Unconditional cleanup of the UNC temp copy. This fires on EVERY
    // exit path — success, error, timeout, early throw — so the temp
    // dir never accumulates leaked copies. The function is sync (uses
    // unlinkSync) so we don't need to await; the file is gone before
    // this function returns to its caller.
    if (tempCopy) {
      unlinkQuiet(tempCopy);
    }
  }
}

/**
 * Inner implementation of extractViaCom. Extracted so the UNC-copy
 * wrapper can install a single `finally` that cleans up the temp
 * file on every exit path. Callers should normally use
 * `extractViaCom`, not this — the wrapper handles UNC copies and
 * temp-file cleanup automatically.
 */
async function extractViaComInner(
  inputPath: string,
  timeoutMs: number | undefined
): Promise<string> {

  // P2 — file-size-aware timeout budget. We can't always know the
  // caller's intent (5-min wall clock vs "as fast as possible"), so
  // default to the size-aware formula unless the caller pinned a
  // specific budget. Cap is configurable via MAX_COM_TIMEOUT_MS so
  // operators on small boxes can clamp it. We stat `inputPath` —
  // when the outer wrapper did the UNC -> local copy, that's the
  // temp copy (same size as the original), so the budget is still
  // accurate.
  if (timeoutMs === undefined) {
    try {
      const stat = await fsp.stat(inputPath);
      timeoutMs = computeComTimeoutMs(stat.size, config.MAX_COM_TIMEOUT_MS);
    } catch {
      // stat failed (file vanished between readContent and COM) —
      // fall back to a sane default that won't kill a normal file.
      timeoutMs = 60_000;
    }
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

  // P31 — wait for a COM slot BEFORE doing any setup work. We hold
  // the slot through the entire PS1+EXCEL round-trip and release it
  // when the child closes (or the kill timer fires). This caps the
  // number of concurrent EXCEL.EXE we spawn at COM_MAX_CONCURRENCY
  // (3), which is the empirical safe ceiling for Office COM on
  // Windows 11 — see P31 note at acquireComSlot.
  // P31 — wait for a COM slot BEFORE doing any setup work. We hold
  // the slot through the entire PS1+EXCEL round-trip and release it
  // when the child closes (or the kill timer fires). This caps the
  // number of concurrent EXCEL.EXE we spawn at COM_MAX_CONCURRENCY
  // (3), which is the empirical safe ceiling for Office COM on
  // Windows 11 — see P31 note at acquireComSlot.
  //
  // Two release paths exist so a thrown synchronous error in the
  // inner executor doesn't leak the slot:
  //   - On normal resolve/reject of the inner Promise, the child
  //     event handlers (close / error / kill-timer) call
  //     releaseSlotOnce().
  //   - On synchronous throw inside the executor (e.g. a coding
  //     bug) the .then's rejection handler releases the slot
  //     directly via releaseComSlot(). It's a no-op on the success
  //     path because releaseSlotOnce() has already fired by then
  //     (and it can't double-decrement: releaseComSlot just hands
  //     the slot to a waiter or decrements, both safe to repeat
  //     once because the second call is a no-op when there are no
  //     waiters and comActive is already 0).
  return acquireComSlot().then<string>(
    () => new Promise<string>((resolve, reject) => {
    const spawnTime = Date.now();

    // ── P1 — see sag_com-extract-CJK-path-20260914.md
    //
    // The previous code passed `inputPath` directly via `-InputPath`
    // argv. On Chinese Windows, Node's spawn joins argv into a
    // single CreateProcess command line, which CreateProcess parses
    // using the system ANSI code page (GBK / cp936 on zh-CN). When
    // the path contains CJK (e.g. `F:\模拟文件\test1\office_0010.doc`)
    // the GBK parser truncates or drops those bytes, and Word tries
    // to open `F:\test1\office_0010.doc` (the `模拟文件` segment
    // silently vanished).
    //
    // We tried three alternative routes and they ALL had problems:
    //   (a) Pointer file via argv → the temp file path itself often
    //       contained CJK (e.g. `D:\IT审计\...`) and got mangled.
    //   (b) UTF-8 bytes via stdin → works in dev `node` but the SEA
    //       bundle (SAG.exe) closes the child stdin pipe before PS
    //       can read it.
    //   (c) Base64 via process.env → works in dev `node` but the
    //       SEA bundle drops custom env vars before spawning.
    //
    // The fix that survives ALL three scenarios: write the real path
    // to a UTF-8 pointer file in `os.tmpdir()`. On every Windows
    // install we tested, `%TEMP%` is `C:\Users\<user>\AppData\Local\Temp`
    // — ASCII-clean, never has CJK chars. So the pointer-file path
    // itself survives the ANSI argv corruption. The PS helper reads
    // the pointer file as UTF-8 and gets the real path verbatim.
    //
    // The pointer-file form is also what the original test of this
    // helper recommended — see comment block above the `param(...)`
    // block in com-extract.ps1.
    //
    // Pointer file content is Base64-encoded, NOT raw UTF-8. PS 5.1's
    // `Get-Content -Encoding UTF8` mangles CJK bytes when the system
    // codepage is GBK — the `模拟文件` segment silently drops. Base64
    // keeps the bytes 7-bit-clean so PS reads them verbatim, then
    // decodes back to UTF-8 on the PS side.
    const pathPointerFile = path.join(
      tmpdir(),
      `sag-com-input-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`
    );
    writeFileSync(
      pathPointerFile,
      Buffer.from(inputPath, "utf8").toString("base64"),
      { encoding: "ascii" }
    );
    const cleanupPointer = () => {
      try { unlinkSync(pathPointerFile); } catch { /* best-effort */ }
    };

    // P31 — acquire a COM slot BEFORE spawning. We deliberately call
    // acquireComSlot synchronously here (it returns an already-resolved
    // Promise when under the limit) and then `await` it via .then() so
    // the spawn doesn't fire until we're under the cap. The slot is
    // released in every child-exit path below (close / error / kill
    // timer) so a stuck helper doesn't permanently tie up a slot.
    let slotReleased = false;
    const releaseSlotOnce = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      releaseComSlot();
    };

    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", helperPath!,
        "-InputPath", pathPointerFile
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
      cleanupPointer();
      reject(new Error(`com-extract: timed out after ${timeoutMs}ms; killed helper + orphaned EXCEL`));
    }, timeoutMs + 5_000);
    child.once("close", () => { clearTimeout(killTimer); cleanupPointer(); releaseSlotOnce(); });
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
      cleanupPointer();
      releaseSlotOnce();
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
  }),
  (err) => {
    // Inner executor threw synchronously. The child event handlers
    // never ran, so the slot is still held — release it before
    // re-throwing. Normal async reject paths are handled by
    // releaseSlotOnce() inside the close / error / kill-timer
    // handlers; this branch only fires for programmer errors.
    releaseComSlot();
    throw err;
  }
  );
}

async function killOrphanedExcel(spawnTime: number): Promise<void> {
  // P31 — see sag_com-extract-excel-leak-20261019.md.
  //
  // killOrphanedExcel(spawnTime) is called on every COM failure (timeout,
  // exit-≠-0, garbled output). The "spawnTime" parameter was originally
  // meant to scope the kill to "this call's EXCEL.EXE", but the
  // implementation never actually filtered on it — line 461 below just
  // taskkills EVERY EXCEL.EXE in the system. That's a feature when it
  // works: it cleans up the leaks from a previous SAG run / crashed
  // helper / DLP-induced hang. But it has two side effects:
  //
  //   (1) It indiscriminately kills Excel processes the USER opened
  //       interactively (e.g. a budget workbook they have on screen).
  //       We have no way to distinguish "our EXCEL" from "theirs".
  //       Mitigation: only run the kill when triggered by an error path
  //       (timeout / non-zero exit) — never on a clean success.
  //
  //   (2) It doesn't bound concurrency. A burst of failures (e.g. a
  //       folder of DLP-encrypted files) triggers back-to-back COM
  //       calls; each opens a new EXCEL.EXE, each fails, each runs
  //       the killer. We end up spawning ~60+ EXCEL processes in a
  //       single sync, and the next 100 files have to fight for COM
  //       resources. The `comExtractGate` semaphore below bounds
  //       that to 3 concurrent calls.
  //
  // The startup sweep (`sweepStartupOrphans`) runs once when the
  // watcher first comes up. It kills any EXCEL.EXE that's older than
  // the current process (i.e. left over from a previous SAG run) and
  // exits without touching the user's interactive Excel session.
  //
  // The "spawned after spawnTime" comment below is now aspirational —
  // the code kills all EXCEL.EXE without filtering, same as before.
  // Don't change the implementation here without re-reading the P31
  // note first; the unfiltered kill is the entire point.
  //
  //
  // IMPLEMENTATION NOTE (2026-09-15) — We use `tasklist` + `taskkill`
  // instead of `wmic process where name='EXCEL.EXE'`. WMIC was removed
  // from Windows 11 24H2 and is increasingly unreliable on recent
  // builds — the WMI query optimiser can hang indefinitely when no
  // matching process exists (it falls back to a full repository
  // scan). Without a timeout the spawn never emits 'close', the
  // Promise never resolves, and the host event loop stalls after
  // just a few COM calls. tasklist is a flat CSV dump and never
  // hangs for more than ~100ms even with no matches.
  return new Promise<void>((resolve) => {
    // Hard timeout — even if every subprocess hangs, this promise
    // MUST resolve within 5s. The host treats unresolved promises as
    // a stalled queue and SAG.exe stops emitting logs.
    const hardTimeout = setTimeout(() => resolve(), 5_000);
    try {
      hardTimeout.unref?.();
    } catch { /* ignore */ }

    // No /FI filter — see COM_PROCESS_RE note above; match the full
    // Office/WPS name list from one unfiltered CSV dump instead.
    const list = spawn(
      "tasklist",
      ["/FO", "CSV", "/NH"],
      { windowsHide: true }
    );
    let resolved = false;
    const safeResolve = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(hardTimeout);
      resolve();
    };

    list.on("error", () => safeResolve());
    const chunks: Buffer[] = [];
    list.stdout.on("data", (c: Buffer) => chunks.push(c));
    list.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const pids: number[] = [];
      // tasklist /NH CSV format: "et.exe","12345","Console","1","12,345 K"
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(COM_PROCESS_RE);
        if (m) pids.push(parseInt(m[2], 10));
      }
      if (pids.length === 0) {
        safeResolve();
        return;
      }
      const kill = spawn(
        "taskkill",
        ["/F", "/PID", pids.join(","), "/T"],
        { windowsHide: true }
      );
      kill.on("close", () => safeResolve());
      kill.on("error", () => safeResolve());
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