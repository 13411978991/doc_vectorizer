/**
 * src/workers/db-write-worker-entry.ts — Standalone child-process worker
 * that owns a single better-sqlite3 connection and runs batches of
 * synchronous SQL on behalf of the main process. The main process sends
 * JSON-RPC requests over stdin and reads responses from stdout; stderr
 * is reserved for logging.
 *
 * This is the DEV-MODE transport: the parent runs under tsx, which only
 * transpiles .ts files, so the worker source has to be another .ts file
 * spawned as a child process. In the packaged build the pool uses the
 * worker_thread flavour instead (db-write-worker-thread-entry.ts) —
 * the SEA host has no separate node.exe, so a child-process spawn
 * would boot a second backend instead of the worker (2026-10-29).
 *
 * The SQL execution itself lives in db-write-worker-core.ts so both
 * transports behave identically.
 *
 * Protocol (one JSON message per line on stdin / stdout):
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
 */

import { openWorkerDb, createDbWriteWorkerCore, type WorkerStatement } from "./db-write-worker-core.js";

// --- Args / env ---
const dbPath = process.argv[2] ?? process.env.SAG_DBWRITE_WORKER_DB ?? "";
if (!dbPath) {
  process.stderr.write("[db-write-worker] FATAL: no DB path provided (argv[2] or SAG_DBWRITE_WORKER_DB)\n");
  process.exit(1);
}
const verbose = process.env.SAG_VERBOSE === "1" || process.env.SAG_DBWRITE_WORKER_VERBOSE === "1";

const db = openWorkerDb(dbPath);
const core = createDbWriteWorkerCore(db);

function send(msg: unknown): void {
  // Single-line JSON to keep the parser on the main side trivial.
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function log(...args: unknown[]): void {
  if (verbose) {
    process.stderr.write(`[db-write-worker ${process.pid}] ${args.map(String).join(" ")}\n`);
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
  process.on("SIGUSR1", () => core.setAborted());
} catch {
  // Some Node builds (Windows) refuse to register SIGUSR1 listeners.
  // That's fine — the in-band cancel op covers us.
}

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
    let req: { id?: string; op?: string; stmts?: WorkerStatement[]; sql?: string; params?: unknown[] };
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
  core.close();
  process.exit(0);
});

function handle(req: { id?: string; op?: string; stmts?: WorkerStatement[]; sql?: string; params?: unknown[] }): void {
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
        const results = core.runBatchTx(req.stmts);
        const ms = Date.now() - t0;
        log(`batch id=${id} stmts=${req.stmts.length} ms=${ms}`);
        send({ id, ok: true, results, ms });
        break;
      }
      case "exec": {
        // Single-statement shortcut used by health checks and such.
        // Not wrapped in a transaction.
        if (!req.sql) throw new Error("exec: missing sql");
        const { rows, rowCount } = core.execOne(req.sql, req.params ?? []);
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
        core.setAborted();
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
