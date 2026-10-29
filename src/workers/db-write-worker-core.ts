/**
 * src/workers/db-write-worker-core.ts — the transport-independent core of
 * the DB-write worker.
 *
 * The worker owns one better-sqlite3 connection and runs batches of
 * synchronous SQL for the main process. The SQL execution itself is
 * identical whether the worker runs as
 *
 *   - a child PROCESS (dev mode: `node --import tsx src/workers/…`,
 *     IPC over stdin/stdout), or
 *   - a worker THREAD (packaged mode: `new Worker(<staged .cjs>)`,
 *     IPC over the MessagePort).
 *
 * Why the thread transport exists (2026-10-29): in the packaged SEA
 * build `process.execPath` is `SAG-backend.exe` itself, so the old
 * child-process spawn ran the SEA host with the worker path as an
 * argument — the child booted a whole second backend instead of the
 * worker, never spoke the IPC protocol, and every document write died
 * with "db-write-worker: op=batch timed out after 60000ms". A worker
 * thread has the same problem-free property as the embedding worker
 * (which already runs that way) and needs no node.exe.
 *
 * This module deliberately imports nothing from src/index.ts or
 * src/api/* — those pull in Fastify and the whole embedding stack.
 * Only better-sqlite3, sqlite-vec, the shared SQL translator and Node
 * built-ins.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { DB_WRITE_ABORT_CHECK_EVERY, SQLITE_BUSY_TIMEOUT_MS } from "../config/tuning-constants.js";
import { translateSqlFull, safeBindParams as translatorSafeBind } from "../db/sqlite-translator.js";

export interface WorkerStatement {
  sql: string;
  params?: unknown[];
}

export interface WorkerExecResult {
  rows: unknown[];
  rowCount: number;
}

export interface DbWriteWorkerCore {
  db: Database.Database;
  /** Run one statement outside a transaction. */
  execOne(sql: string, params: unknown[]): WorkerExecResult;
  /** Run a batch inside ONE transaction (single WAL fsync). */
  runBatchTx(stmts: WorkerStatement[]): WorkerExecResult[];
  /** Flip the abort flag and poke the native interrupt channel. */
  setAborted(): void;
  /** True once an abort has been requested. */
  isAborted(): boolean;
  close(): void;
}

/**
 * Open the worker's own connection to the SQLite file.
 *
 * Mirrors sqlite-driver.ts's getOrOpen, but process-local: WAL mode,
 * foreign keys ON, and a busy timeout so a reader never starves the
 * writer (the main process's pool defaults to busy_timeout=0).
 */
export function openWorkerDb(filePath: string): Database.Database {
  const resolved = resolve(filePath);
  if (!existsSync(dirname(resolved))) {
    mkdirSync(dirname(resolved), { recursive: true });
  }
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  try {
    sqliteVec.load(db);
  } catch (e) {
    process.stderr.write(`[db-write-worker] sqlite-vec load failed: ${(e as Error).message}\n`);
  }
  return db;
}

/**
 * Create the core around an already-open connection.
 */
export function createDbWriteWorkerCore(db: Database.Database): DbWriteWorkerCore {
  const aborted = { flag: false };

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
  // the first value, so the helper has nothing to add. We therefore
  // skip the call entirely.
  const execOne = (sql: string, params: unknown[]): WorkerExecResult => {
    const { sql: translated, paramOrder } = translateSqlFull(sql);
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
  };

  // Pre-build a single transaction runner that takes an array of
  // statement objects. better-sqlite3 wraps the function in BEGIN/COMMIT
  // and rolls back on any thrown error. This is the critical win — a
  // single COMMIT = single WAL fsync instead of N fsyncs.
  //
  // The loop also checks the abort flag every ABORT_CHECK_EVERY
  // statements; throwing here triggers a ROLLBACK.
  const runBatchTx = db.transaction((stmts: WorkerStatement[]): WorkerExecResult[] => {
    const results: WorkerExecResult[] = [];
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

  // We can't interrupt a running better-sqlite3 statement mid-execution
  // — the native call is synchronous and not signal-safe — but we CAN
  // check a flag between statements inside `db.transaction`. Throwing
  // out of the transaction body makes better-sqlite3 ROLLBACK
  // automatically, so no half-written rows reach disk.
  const setAborted = (): void => {
    if (aborted.flag) return;
    aborted.flag = true;
    // Also poke better-sqlite3's interrupt channel so an in-flight
    // long-running statement can bail early. `db.interrupt()` is a
    // no-op if no statement is running and the next `.run()` will
    // throw SQLITE_INTERRUPT — which the outer transaction wrapper
    // turns into a rollback.
    try {
      (db as unknown as { interrupt: () => void }).interrupt();
    } catch {
      // interrupt can throw when called from inside a statement on
      // some builds; the post-statement flag check still catches it.
    }
  };

  return {
    db,
    execOne,
    runBatchTx,
    setAborted,
    isAborted: () => aborted.flag,
    close: () => {
      try { db.close(); } catch { /* ignore */ }
    }
  };
}
