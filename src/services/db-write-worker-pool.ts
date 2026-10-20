/**
 * src/services/db-write-worker-pool.ts — Owns the db-write-worker child
 * process and exposes a `runWriteBatch()` API that the main process
 * uses to offload long synchronous-SQL transactions.
 *
 * Why a pool / single worker?
 *   - The main process never touches the writer mutex. Fastify HTTP
 *     handlers can read concurrently via the existing SqlitePool (WAL
 *     reader/writer split) without being blocked by the long dbWrite
 *     transaction. The worker holds its own connection and runs the
 *     200+ statement dbWrite without ever yielding the main thread.
 *   - Single worker is enough because (a) the main process only has
 *     one ingestion in flight per folder by default, and (b) multiple
 *     workers would still serialize on the SQLite writer mutex anyway.
 *     A future "ingest-queue parallel" change can scale this up.
 *
 * IPC shape (see db-write-worker-entry.ts):
 *   in:  {"id": "abc", "op": "begin"}
 *   in:  {"id": "abc", "op": "exec", "sql": "...", "params": [...]}
 *   in:  {"id": "abc", "op": "commit"}
 *   out: {"id": "abc", "ok": true, "rows": [...], "rowCount": N}
 *
 * The pool implements at-most-one in-flight batch at a time (a
 * "transaction slot") so a second call awaits the first. This is
 * intentional — the dbWrite pipeline is itself serial per ingest, and
 * we don't want two writers contending for the same logical operation.
 *
 * Fallback: if spawning the worker fails, runWriteBatch() falls back
 * to the in-process SqlitePool so the system still works. This keeps
 * dev mode robust when the user hasn't run `npm install` after pulling
 * the new file, or when running under SEA where spawn() paths differ.
 */

import { spawn, ChildProcessByStdio } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger } from "../observability/logger.js";
import { pool } from "../db/pool.js";
import { IngestAbortError } from "./ingestion-service.js";
import { DB_WRITE_OP_TIMEOUT_MS } from "../config/tuning-constants.js";

export interface ExecResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface WorkerStatus {
  mode: "worker" | "in-process";
  pid: number | null;
  spawnAttempts: number;
  lastError: string | null;
  batchesProcessed: number;
  statementsExecuted: number;
  fallbackReason: string | null;
}

type Pending = {
  resolve: (r: ExecResult) => void;
  reject: (e: Error) => void;
};

class DbWriteWorkerPool {
  private proc: ChildProcessByStdio<null, null, null> | null = null;
  private readonly pending = new Map<string, Pending>();
  private stdoutBuf = "";
  private stderrBuf = "";
  private slotChain: Promise<void> = Promise.resolve();
  private initPromise: Promise<void> | null = null;
  private readonly status: WorkerStatus = {
    mode: "in-process",
    pid: null,
    spawnAttempts: 0,
    lastError: null,
    batchesProcessed: 0,
    statementsExecuted: 0,
    fallbackReason: null
  };
  private shuttingDown = false;

  /**
   * Run a batch of statements inside one transaction. Returns when the
   * worker has either committed or rolled back. The callback is
   * invoked on the main thread between every statement for live
   * progress reporting (e.g. UI progress bar). The callback runs
   * synchronously; do not block in it.
   *
   * If `signal` is provided and the user pauses the folder mid-write,
   * the in-flight batch is aborted: the worker flips an in-memory
   * `aborted` flag, throws out of the db.transaction, and better-sqlite3
   * ROLLBACKs the whole batch — no half-written rows reach disk, and
   * the document stays in its pre-ingest state. The returned promise
   * rejects with an `IngestAbortError` so the caller can distinguish
   * "user paused" from "real DB error" without message matching.
   */
  async runWriteBatch(
    statements: Array<{ sql: string; params?: unknown[] }>,
    onProgress?: (done: number, total: number, lastResult: ExecResult) => void,
    signal?: AbortSignal
  ): Promise<{ results: ExecResult[]; mode: "worker" | "in-process"; durationMs: number }> {
    // Serialize so two concurrent ingests don't interleave transactions.
    const prev = this.slotChain;
    let release: () => void = () => undefined;
    this.slotChain = new Promise<void>((r) => { release = r; });
    try {
      await prev;
    } catch {
      // previous batch errored; allow this one through anyway
    }
    const t0 = performance.now();
    // If the signal already fired before we even started, short-circuit
    // so the worker isn't poked with a doomed batch.
    if (signal?.aborted) {
      throw new IngestAbortError("aborted before dbWrite");
    }
    let abortHandler: (() => void) | null = null;
    try {
      // Always try worker first; fall back to in-process on failure.
      try {
        await this.ensureWorker();
      } catch (e) {
        logger.warn(
          { error: (e as Error).message },
          "db-write-worker: worker unavailable, running in-process"
        );
        this.status.mode = "in-process";
        this.status.fallbackReason = (e as Error).message;
        if (this.proc) {
          try { this.proc.kill(); } catch { /* ignore */ }
          this.proc = null;
        }
      }

      if (this.proc && this.status.mode === "worker") {
        // Single round-trip: send the whole batch, get all results back
        // in one response. The worker runs them in one transaction.
        const id = randomUUID();

        // Wire up the abort forwarding. On POSIX we send SIGUSR1; on
        // Windows we use the in-band `cancel` op. The handler is
        // idempotent so a second abort (e.g. user pauses, then
        // resumes and pauses again) just re-sends the signal.
        if (signal) {
          abortHandler = () => {
            this.sendAbortToWorker(signal);
          };
          if (signal.aborted) {
            abortHandler();
          } else {
            signal.addEventListener("abort", abortHandler, { once: true });
          }
        }

        try {
          const res = (await this.sendReceive({ id, op: "batch", stmts: this.encodeStatements(statements) } as unknown as { id: string; op: string; sql?: string; params?: unknown[] })) as { results: ExecResult[]; ms: number };
          const results = res.results ?? [];
          for (let i = 0; i < results.length; i++) {
            this.status.statementsExecuted++;
            onProgress?.(i + 1, statements.length, results[i]);
          }
          this.status.batchesProcessed++;
          return {
            results,
            mode: "worker",
            durationMs: performance.now() - t0
          };
        } catch (e) {
          // If the worker reports it aborted (either via the in-band
          // error message or via the SIGUSR1 path), surface a typed
          // error so the caller can route it to the "paused" UI
          // branch instead of "ingestion failed". The message
          // contains "aborted by signal" because that's the literal
          // string the worker throws out of `runBatchTx`.
          const msg = (e as Error).message ?? "";
          if (msg.includes("aborted by signal") || signal?.aborted) {
            throw new IngestAbortError("dbWrite aborted by signal");
          }
          throw e;
        } finally {
          if (signal && abortHandler) {
            signal.removeEventListener("abort", abortHandler);
          }
        }
      }

      // In-process fallback: use the existing SqlitePool with begin/exec/commit.
      const client = await pool.connect();
      // For the in-process path there's no IPC to interrupt; we have
      // to let the existing transaction finish. Aborts are best-effort
      // — the flag is checked between statements so a 200-statement
      // batch can still bail in <16 statements worth of latency.
      let inProcessAborted = false;
      if (signal) {
        abortHandler = () => { inProcessAborted = true; };
        if (signal.aborted) inProcessAborted = true;
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
      try {
        await client.query("begin");
        const results: ExecResult[] = [];
        for (let i = 0; i < statements.length; i++) {
          if (inProcessAborted) {
            throw new Error("aborted by signal") as Error & { name: string; __aborted?: true };
          }
          const { sql, params } = statements[i];
          const res = await client.query<unknown>(sql, params ?? []);
          const r: ExecResult = { rows: res.rows, rowCount: res.rowCount };
          results.push(r);
          this.status.statementsExecuted++;
          onProgress?.(i + 1, statements.length, r);
        }
        await client.query("commit");
        this.status.batchesProcessed++;
        return {
          results,
          mode: "in-process",
          durationMs: performance.now() - t0
        };
      } catch (e) {
        try { await client.query("rollback"); } catch { /* ignore */ }
        const isAbort = inProcessAborted || signal?.aborted || (e as Error).message === "aborted by signal";
        if (isAbort) {
          throw new IngestAbortError("dbWrite aborted by signal");
        }
        throw e;
      } finally {
        try { await client.release(); } catch { /* ignore */ }
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    } finally {
      release();
    }
  }

  /**
   * Forward an abort signal to the running worker. Uses SIGUSR1 on
   * POSIX (where the worker has a handler installed that flips an
   * in-memory flag and calls `db.interrupt()`), and the in-band
   * `cancel` op on Windows. The IPC `cancel` message is best-effort —
   * if the worker has already died or the pipe is full, we fall
   * through silently. The next batch will simply restart the worker.
   */
  private sendAbortToWorker(signal: AbortSignal): void {
    if (!this.proc) return;
    // In-band cancel op works on every platform, so always send it.
    // The flag check on the worker side is idempotent so duplicates
    // are harmless.
    try {
      const id = randomUUID();
      // Use a no-await fire-and-forget; we don't wait for the
      // response because the batch op that's in flight is the one
      // that will return (with an error). Sending a second message
      // and not reading it just sits in the worker's stdin buffer.
      const stdin = this.proc.stdin as unknown as NodeJS.WritableStream;
      stdin.write(JSON.stringify({ id, op: "cancel" }) + "\n", () => { /* ignore */ });
    } catch {
      // Pipe may be closed; the SIGUSR1 path below is the backup.
    }
    if (process.platform !== "win32") {
      try {
        this.proc.kill("SIGUSR1");
      } catch {
        // ignore
      }
    }
    // The actual signal so callers awaiting on a separate signal can
    // observe it. We don't expose this — the runWriteBatch caller
    // already has the signal object and listens on it themselves.
    void signal;
  }

  getStatus(): WorkerStatus {
    return {
      ...this.status,
      pid: this.proc?.pid ?? null,
      mode: this.proc ? this.status.mode : "in-process"
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.proc) {
      try {
        const id = randomUUID();
        await this.sendReceive({ id, op: "shutdown" });
      } catch { /* ignore */ }
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  // ---- internals ----

  /**
   * Serialize a param value for the wire. Float32Array and other
   * TypedArray instances don't survive JSON.stringify (Node turns them
   * into plain `{0: ..., 1: ..., length: N}` objects on the other side,
   * which corrupts the vector bytes sqlite-vec expects). Encode them
   * as base64 strings on the way out, decode on the way in — preserves
   * the raw bytes exactly.
   */
  private encodeParam(p: unknown): unknown {
    if (p === null || p === undefined) return p;
    if (typeof p !== "object" && typeof p !== "function") return p;
    if (Buffer.isBuffer(p)) return { __sag_b64: p.toString("base64") };
    if (ArrayBuffer.isView(p) && !(p instanceof DataView)) {
      // Works for Float32Array, Uint8Array, Int32Array, etc.
      return { __sag_b64: Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString("base64") };
    }
    return p;
  }

  private encodeStatements(stmts: Array<{ sql: string; params?: unknown[] }>) {
    return stmts.map((s) => ({
      sql: s.sql,
      params: (s.params ?? []).map((p) => this.encodeParam(p))
    }));
  }

  private async ensureWorker(): Promise<void> {
    if (this.proc && this.status.mode === "worker") return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.spawn().finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private async spawn(): Promise<void> {
    this.status.spawnAttempts++;
    // Locate the worker entry source. In dev (tsx) the file is .ts; in
    // SEA the file is staged next to the bundle as .cjs. Try the
    // candidates in order and pick the first that exists.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolvePath(here, "..", "workers", "db-write-worker-entry.ts"),
      resolvePath(here, "..", "..", "src", "workers", "db-write-worker-entry.ts"),
      resolvePath(process.cwd(), "src", "workers", "db-write-worker-entry.ts")
    ];
    const entry = candidates.find((p) => existsSync(p));
    if (!entry) {
      throw new Error(
        `db-write-worker entry not found. Looked in: ${candidates.join(", ")}`
      );
    }

    // Pick the runner: dev → reuse the parent's tsx loader, prod →
    // node (the entry is .cjs in the SEA bundle; in the source-tree
    // dev mode the same path serves the .ts via tsx).
    //
    // We deliberately do NOT spawn `npx tsx ...` here. On Windows
    // npx.cmd can't be invoked directly as a child process without
    // shell:true (and shell:true breaks the stdio pipes we use for
    // IPC), and `--yes` is slow + requires network. Instead we
    // re-exec Node with the same tsx loader the parent process used.
    // process.argv[1] for the parent is the .ts entry (under tsx);
    // for the worker we substitute the worker entry. This is the
    // same approach the embedding-worker-client uses.
    const isDev = entry.endsWith(".ts");
    let cmd: string;
    let args: string[];
    if (isDev) {
      cmd = process.execPath;
      // Parent was started as `node --import tsx-loader src/index.ts`
      // (or the equivalent tsx wrapper). Replicate the loader so
      // the worker can import .ts files the same way. --import must
      // appear before the entry file in argv.
      const parentArgs = process.execArgv ?? [];
      args = [...parentArgs, entry];
    } else {
      cmd = process.execPath;
      args = [entry];
    }

    // Find the DB path. SqlitePool owns it; we read it back via the
    // marker on _pool. For dev it's `./data/sag.db`; the env var
    // DATABASE_FILE overrides.
    const dbPath = process.env.DATABASE_FILE ?? resolvePath(process.cwd(), "data", "sag.db");

    const proc = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        SAG_DBWRITE_WORKER_DB: dbPath
      },
      windowsHide: true
    });
    this.proc = proc as unknown as ChildProcessByStdio<null, null, null>;
    this.status.pid = proc.pid ?? null;
    this.status.mode = "worker";
    this.status.fallbackReason = null;
    this.status.lastError = null;
    this.stdoutBuf = "";
    this.stderrBuf = "";

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    proc.on("exit", (code, signal) => {
      this.status.mode = "in-process";
      this.status.pid = null;
      const reason = `worker exited code=${code} signal=${signal}`;
      this.status.lastError = reason;
      this.proc = null;
      // Reject any in-flight requests so the awaiting batch fails over.
      for (const [id, p] of this.pending) {
        p.reject(new Error(`db-write-worker: ${reason}`));
        this.pending.delete(id);
      }
    });
    proc.on("error", (err) => {
      this.status.lastError = err.message;
      this.status.mode = "in-process";
      this.proc = null;
    });

    if (this.shuttingDown) {
      try { proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg: {
        id?: string;
        ok?: boolean;
        rows?: unknown[];
        rowCount?: number;
        results?: ExecResult[];
        ms?: number;
        error?: string;
      };
      try {
        msg = JSON.parse(line);
      } catch (e) {
        logger.warn({ line: line.slice(0, 200) }, "db-write-worker: malformed response");
        continue;
      }
      if (!msg.id) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) {
        // Surface the entire message object. The shape varies per op
        // (`batch` returns `results: ExecResult[]`, `exec` returns
        // `results: [ExecResult]`, `shutdown` returns `results: []`).
        // Callers read whichever field they need; we don't try to
        // normalise here because the variant types don't share enough
        // structure to make one shape a superset of the other.
        p.resolve(msg as unknown as ExecResult);
      } else {
        p.reject(new Error(msg.error ?? "db-write-worker: unknown error"));
      }
    }
  }

  private onStderr(chunk: string): void {
    // The worker uses stderr for diagnostic logging. Pass it through
    // to the main process logger so operators can see what's happening.
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    for (const l of lines) {
      logger.warn({ source: "db-write-worker" }, l);
    }
  }

  private sendReceive(req: { id: string; op: string; sql?: string; params?: unknown[]; stmts?: Array<{ sql: string; params?: unknown[] }> }): Promise<unknown> {
    if (!this.proc) throw new Error("db-write-worker: not running");
    const proc = this.proc;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(req.id, {
        resolve: (r) => resolve(r),
        reject
      });
      // proc.stdin is non-null when stdio is "pipe" (we set it that
      // way in spawn). The cast is safe and avoids a per-call null
      // check that would force TS to narrow stdin to `never` after a
      // return inside the executor.
      const stdin = proc.stdin as unknown as NodeJS.WritableStream;
      stdin.write(JSON.stringify(req) + "\n", (err: Error | null | undefined) => {
        if (err) {
          this.pending.delete(req.id);
          reject(err);
        }
      });
      // Safety timeout: 60s per op. dbWrite never runs a single op that
      // long, so this catches a wedged worker without false positives.
      // .unref() so the timer doesn't keep Node alive past shutdown — the
      // sibling embedding-worker-client.ts already does this (line 213);
      // without it, an in-flight watchdog can hold the event loop open
      // for 60s after the rest of the process is ready to exit.
      const watchdog = setTimeout(() => {
        if (this.pending.has(req.id)) {
          this.pending.delete(req.id);
          reject(new Error(`db-write-worker: op=${req.op} timed out after ${DB_WRITE_OP_TIMEOUT_MS}ms`));
        }
      }, DB_WRITE_OP_TIMEOUT_MS);
      watchdog.unref();
    });
  }
}

export const dbWriteWorkerPool = new DbWriteWorkerPool();
