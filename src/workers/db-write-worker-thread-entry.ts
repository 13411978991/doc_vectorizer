/**
 * src/workers/db-write-worker-thread-entry.ts — worker_threads flavour of
 * the DB-write worker.
 *
 * Same job as db-write-worker-entry.ts (run batches of synchronous SQL
 * on a private better-sqlite3 connection so the main thread stays
 * free), but the transport is a MessagePort instead of stdin/stdout.
 *
 * Why this exists (2026-10-29): the packaged SEA build has no separate
 * node.exe — `process.execPath` IS `SAG-backend.exe`. Spawning it with
 * a worker script as an argument boots a second copy of the whole
 * backend instead of the worker, so every batch timed out after 60 s
 * ("db-write-worker: op=batch timed out after 60000ms") and document
 * ingestion failed with HTTP 500. A worker thread sidesteps that
 * entirely (it is exactly how the embedding worker already runs) and
 * needs no external interpreter.
 *
 * Protocol (identical shapes to the child-process flavour):
 *   in:  { id, op: "batch", stmts: [{ sql, params }] }
 *        { id, op: "exec",  sql, params }
 *        { id, op: "cancel" }
 *        { id, op: "shutdown" }
 *   out: { id, ok: true, results: [{ rows, rowCount }], ms }
 *        { id, ok: false, error }
 */

import { parentPort, workerData } from "node:worker_threads";
import { openWorkerDb, createDbWriteWorkerCore, type WorkerStatement } from "./db-write-worker-core.js";

if (!parentPort) {
  throw new Error("db-write-worker-thread-entry must run inside a worker_thread");
}

const port = parentPort;
const data = (workerData ?? {}) as { dbPath?: string; verbose?: boolean };
const dbPath = data.dbPath ?? process.env.SAG_DBWRITE_WORKER_DB ?? "";
if (!dbPath) {
  port.postMessage({ id: "init", ok: false, error: "no DB path provided (workerData.dbPath or SAG_DBWRITE_WORKER_DB)" });
  throw new Error("db-write-worker: no DB path provided");
}

const verbose = data.verbose ?? (process.env.SAG_VERBOSE === "1" || process.env.SAG_DBWRITE_WORKER_VERBOSE === "1");
const db = openWorkerDb(dbPath);
const core = createDbWriteWorkerCore(db);

function log(...args: unknown[]): void {
  if (verbose) {
    process.stderr.write(`[db-write-worker-thread] ${args.map(String).join(" ")}\n`);
  }
}

port.on("message", (req: { id?: string; op?: string; stmts?: WorkerStatement[]; sql?: string; params?: unknown[] }) => {
  const { id, op } = req ?? {};
  if (!id || !op) {
    port.postMessage({ id: id ?? "unknown", ok: false, error: "request missing id/op" });
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
        port.postMessage({ id, ok: true, results, ms });
        break;
      }
      case "exec": {
        if (!req.sql) throw new Error("exec: missing sql");
        const { rows, rowCount } = core.execOne(req.sql, req.params ?? []);
        port.postMessage({ id, ok: true, results: [{ rows, rowCount }], ms: 0 });
        break;
      }
      case "cancel": {
        core.setAborted();
        port.postMessage({ id, ok: true, results: [], ms: 0 });
        break;
      }
      case "shutdown": {
        port.postMessage({ id, ok: true, results: [], ms: 0 });
        core.close();
        setTimeout(() => process.exit(0), 10);
        break;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  } catch (e) {
    port.postMessage({ id, ok: false, error: (e as Error).message });
  }
});

// Tell the parent we are alive so it can flip its status to "worker".
port.postMessage({ id: "__ready__", ok: true, results: [], ms: 0 });
