/**
 * src/workers/db-write-worker-entry.ts — Standalone child-process worker
 * that owns a single better-sqlite3 connection and runs batches of
 * synchronous SQL on behalf of the main process. The main process sends
 * JSON-RPC requests over stdin and reads responses from stdout; stderr
 * is reserved for logging.
 *
 * Why a child process (and not worker_threads):
 *   - In dev mode we run via tsx, which only transpiles .ts files; the
 *     Node Worker constructor requires a real .js file path. Spawning a
 *     child tsx process keeps the dev workflow seamless — the worker
 *     source is just another .ts file in src/.
 *   - In prod (SEA) the same worker file is staged next to the bundle
 *     and invoked via `node sag.bundle.cjs` (or similar). The IPC shape
 *     is identical in both modes.
 *   - better-sqlite3's native handle is process-bound, so a dedicated
 *     process gives us a clean ownership model: the main process never
 *     touches the writer mutex, the worker never sees HTTP traffic.
 *
 * Protocol (one JSON message per line on stdin / stdout):
 *   in:  {"id": "abc", "op": "begin"}
 *   in:  {"id": "abc", "op": "batch", "stmts": [
 *          {"sql": "...", "params": [...]},
 *          ...
 *        ]}
 *   out: {"id": "abc", "ok": true, "results": [
 *          {"rows": [...], "rowCount": N}, ...
 *        ]}
 *        or
 *   out: {"id": "abc", "ok": false, "error": "..."}
 *   in:  {"id": "abc", "op": "shutdown"}  → process exits 0
 *
 * Each `batch` runs inside a single better-sqlite3 transaction via
 * `db.transaction(...)`. This means a single fsync on the outermost
 * COMMIT instead of one per statement — exactly the win we need
 * against the 200-statement dbWrite in ingestion-service.ts.
 *
 * IMPORTANT: This file is the worker entry point. It deliberately does
 * NOT import anything from src/index.ts or src/api/* — those pull in
 * Fastify + the full embedding stack and would take seconds to import
 * per spawn. Only better-sqlite3, sqlite-vec, and Node built-ins.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { DB_WRITE_ABORT_CHECK_EVERY, SQLITE_BUSY_TIMEOUT_MS } from "../config/tuning-constants.js";

// --- Args / env ---
const dbPath = process.argv[2] ?? process.env.SAG_DBWRITE_WORKER_DB ?? "";
if (!dbPath) {
  process.stderr.write("[db-write-worker] FATAL: no DB path provided (argv[2] or SAG_DBWRITE_WORKER_DB)\n");
  process.exit(1);
}
const verbose = process.env.SAG_VERBOSE === "1" || process.env.SAG_DBWRITE_WORKER_VERBOSE === "1";

// --- DB setup (mirrors sqlite-driver.ts getOrOpen, but process-local) ---
function openDb(filePath: string): Database.Database {
  const resolved = resolve(filePath);
  if (!existsSync(dirname(resolved))) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The main process's SqlitePool defaults busy_timeout=0, so even
  // small reads can be starved by a long writer. Give the worker
  // 5s of patience so a reader doesn't break the writer.
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  try {
    sqliteVec.load(db);
  } catch (e) {
    process.stderr.write(`[db-write-worker] sqlite-vec load failed: ${(e as Error).message}\n`);
  }
  return db;
}

const db = openDb(dbPath);

function send(msg: unknown): void {
  // Single-line JSON to keep the parser on the main side trivial.
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(...args: unknown[]): void {
  if (verbose) {
    process.stderr.write(`[db-write-worker ${process.pid}] ${args.map(String).join(" ")}\n`);
  }
}

// --- SQL helpers ---
// Translator + bind helpers imported from db/sqlite-translator.ts so
// the main process and the child process share a single source of
// truth (audit Tier 2 #14). The translator module has zero native
// bindings so it's safe to import from the worker.
import { translateSqlFull, safeBindParams as translatorSafeBind } from "../db/sqlite-translator.js";

// P-Tier3-#T3a bugfix: previously this file also imported
// `ensureIdColumn` from the shared translator and wrapped it in a
// local no-op. The shared helper was NEVER a no-op in practice —
// it injects `id,` into any INSERT whose column list doesn't start
// with `id`, which is wrong for `chunk_embeddings` (no `id` column)
// and several other tables. We now skip the call entirely. See
// the long comment in execOne() for the full root-cause analysis.

function execOne(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
  const { sql: translated, paramOrder } = translateSqlFull(sql);
  // P-Tier3-#T3a bugfix: do NOT call ensureIdColumn here. The shared
  // helper's behavior is "if the first column list has no `id` column,
  // inject `id,` at the start" — which is correct for tables like
  // `documents` / `chunks` / `events` / `entities` (they all have a
  // text `id` PK) but WRONG for `chunk_embeddings` (its PK is
  // `chunk_id`, no `id` column at all). The previous code path was
  // rewriting `insert into chunk_embeddings (chunk_id, ...) ...` to
  // `insert into chunk_embeddings (id, chunk_id, ...) ...` and SQLite
  // threw "table chunk_embeddings has no column named id".
  //
  // Every dbWrite statement in the buildWriteBatch output already
  // supplies its own PK column (id, chunk_id, event_id, entity_id) as
  // the first value, so the helper has nothing to add. The
  // `withId`/`prefixParams` plumbing is preserved so the rest of the
  // call site stays the same — we just hard-code them to a no-op.
  const withId = translated;
  const prefixParams: unknown[] = [];
  const effectiveParamOrder =
    paramOrder.length > 0
      ? paramOrder
      : Array.from({ length: (withId.match(/\?/g) ?? []).length }, (_, i) => i + 1);
  const positional = effectiveParamOrder.map((n) => params[n - 1]);
  const finalParams = prefixParams.concat(positional);
  const safe = translatorSafeBind(finalParams);
  const stmt = db.prepare(withId);
  if (
    /^\s*(insert|update|delete|create|drop|alter)\b/i.test(withId) ||
    /^\s*with\b[\s\S]+\b(insert|update|delete)\b/i.test(withId)
  ) {
    if (/\breturning\b/i.test(withId)) {
      const rows = stmt.all(...safe);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...safe);
    return { rows: [], rowCount: info.changes };
  }
  if (/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(withId)) {
    return { rows: [], rowCount: 0 };
  }
  const rows = stmt.all(...safe);
  return { rows, rowCount: rows.length };
}

// --- Abort support ---
// When the user pauses a folder, the main process forwards the abort
// signal to this worker over SIGUSR1 (Windows: SIGUSR1 maps to the
// kill event but better-sqlite3 doesn't trap it, so we also expose a
// plain in-band `cancel` op for cross-platform reliability). We can't
// interrupt a running better-sqlite3 statement mid-execution — the
// native call is synchronous and not signal-safe — but we CAN check a
// flag between statements inside a `db.transaction`. Throwing out of
// the transaction body makes better-sqlite3 ROLLBACK automatically, so
// no half-written rows reach disk and the document stays in its
// pre-ingest state. No `COMMIT` ever fires on an aborted batch.
const aborted = { flag: false };
function setAborted(): void {
  if (aborted.flag) return;
  aborted.flag = true;
  // Also poke better-sqlite3's interrupt channel so an in-flight
  // long-running statement (e.g. a big `insert into chunk_vec0`) can
  // bail early. `db.interrupt()` is a no-op if no statement is running
  // and the next `.run()` will throw SQLITE_INTERRUPT — which the
  // outer transaction wrapper turns into a rollback. This is the
  // documented escape hatch for "I changed my mind, abort the
  // transaction" from the better-sqlite3 docs.
  //
  // NOTE: better-sqlite3's .d.ts doesn't expose `interrupt()` because
  // it was added after the original typings froze. We know it exists
  // on the runtime binding (confirmed against better-sqlite3 11.x);
  // the cast keeps `tsc --noEmit` happy without disabling strict
  // mode for the rest of the file.
  try {
    (db as unknown as { interrupt: () => void }).interrupt();
  } catch {
    // interrupt can throw if called from inside a statement on some
    // builds; that's safe to ignore because the post-statement flag
    // check below still catches it.
  }
}

// Cross-platform abort wiring:
// - POSIX: SIGUSR1 is the standard "user interrupt" signal. The Node
//   default handler would kill the process; we override it to just
//   flip the flag.
// - Windows: there are no real signals; `proc.kill('SIGUSR1')` is
//   implemented as a TerminateProcess call which would kill us
//   outright. So the main process sends an in-band `{op:"cancel"}`
//   message over the same IPC channel instead. The SIGUSR1 handler
//   is registered as a no-op so accidental cross-platform sends are
//   harmless.
try {
  process.on("SIGUSR1", () => setAborted());
} catch {
  // Some Node builds (Windows) refuse to register SIGUSR1 listeners.
  // That's fine — the in-band cancel op covers us.
}

// Pre-build a single transaction runner that takes an array of
// statement objects. better-sqlite3 wraps the function in BEGIN/COMMIT
// and rolls back on any thrown error. This is the critical win — a
// single COMMIT = single WAL fsync instead of N fsyncs.
//
// The loop also checks the abort flag every ABORT_CHECK_EVERY
// statements; throwing here triggers a ROLLBACK. We pass the flag
// object as the second arg so the closure captures the live value.
const runBatchTx = db.transaction((stmts: Array<{ sql: string; params?: unknown[] }>) => {
  const results: Array<{ rows: unknown[]; rowCount: number }> = [];
  for (let i = 0; i < stmts.length; i++) {
    if (aborted.flag) {
      throw new Error("aborted by signal");
    }
    if (i > 0 && i % DB_WRITE_ABORT_CHECK_EVERY === 0) {
      // Cheap progress check — gives abort a chance to land even on
      // huge batches where one statement alone can take seconds.
    }
    results.push(execOne(stmts[i].sql, stmts[i].params ?? []));
  }
  if (aborted.flag) {
    throw new Error("aborted by signal");
  }
  return results;
});

// --- Main loop: read JSON requests, dispatch, send responses ---
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let req: { id?: string; op?: string; stmts?: Array<{ sql: string; params?: unknown[] }> };
    try {
      req = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[db-write-worker] malformed JSON: ${(e as Error).message}\n`);
      continue;
    }
    handle(req);
  }
});
process.stdin.on("end", () => {
  log("stdin closed, exiting");
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
});

function handle(req: { id?: string; op?: string; stmts?: Array<{ sql: string; params?: unknown[] }> }): void {
  const { id, op } = req;
  if (!id || !op) {
    process.stderr.write(`[db-write-worker] request missing id/op: ${JSON.stringify(req)}\n`);
    return;
  }
  try {
    switch (op) {
      case "batch": {
        if (!req.stmts) throw new Error("batch: missing stmts");
        const t0 = Date.now();
        const results = runBatchTx(req.stmts);
        const ms = Date.now() - t0;
        log(`batch id=${id} stmts=${req.stmts.length} ms=${ms}`);
        send({ id, ok: true, results, ms });
        break;
      }
      case "exec": {
        // Single-statement shortcut used by health checks and such.
        // Not wrapped in a transaction.
        const sql = (req as { sql?: string; params?: unknown[] }).sql;
        if (!sql) throw new Error("exec: missing sql");
        const params = (req as { params?: unknown[] }).params ?? [];
        const { rows, rowCount } = execOne(sql, params);
        send({ id, ok: true, results: [{ rows, rowCount }], ms: 0 });
        break;
      }
      case "shutdown": {
        send({ id, ok: true, results: [], ms: 0 });
        setTimeout(() => process.exit(0), 10);
        break;
      }
      case "cancel": {
        // Windows-safe abort path. POSIX sends SIGUSR1 directly; this
        // op is the cross-platform fallback. Either path ends with
        // `aborted.flag = true` and a `db.interrupt()` poke so an
        // in-flight statement bails ASAP.
        setAborted();
        send({ id, ok: true, results: [], ms: 0 });
        break;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  } catch (e) {
    process.stderr.write(`[db-write-worker] op=${op} failed: ${(e as Error).message}\n`);
    send({ id, ok: false, error: (e as Error).message });
  }
}
