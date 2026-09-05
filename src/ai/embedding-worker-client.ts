// src/ai/embedding-worker-client.ts — Main-thread proxy that spawns
// a Worker thread running src/ai/embedding-worker.ts. All BGE
// embeddings happen in the worker, isolating the slow ONNX forward
// pass from the main thread so the HTTP server stays responsive
// even while a watcher is ingesting hundreds of files.
//
// The worker source is read from a sibling file on disk so the
// `Worker` constructor has a real path to spawn. We extract the
// worker source from the SEA bundle at runtime: the bundle is
// staged to `%TEMP%/sag-sea-native-<sig>/__bundle__/sag.bundle.cjs`
// by unpackOnce(), and the worker file is staged next to it as
// `__bundle__/sag.embedding-worker.cjs` by the SEA build pipeline.
//
// The proxy is a thin request/response router: every main-thread
// call gets a unique id, sent to the worker, and the matching
// response resolves the waiting promise. If the worker crashes,
// the client transparently respawns once and the next call retries.

import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../observability/logger.js";

type Pending = {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
};

type WorkerRequest =
  | { id: string; op: "load"; modelPath: string }
  | { id: string; op: "embed"; modelPath: string; texts: string[]; dimensions: number }
  | { id: string; op: "ping" };

type WorkerResponse =
  | { id: string; op: "load"; ok: true }
  | { id: string; op: "embed"; ok: true; vectors: number[][] }
  | { id: string; op: "ping"; ok: true }
  | { id: string; op: WorkerRequest["op"]; ok: false; error: string };

let workerInstance: Worker | null = null;
let workerInitPromise: Promise<void> | null = null;
const pending = new Map<string, Pending>();

function workerSourcePath(): string {
  // Look up the worker source in this order:
  //   1. <process.execPath-dir>/sag.embedding-worker.cjs  (dev / out-of-tree)
  //   2. %TEMP%/sag-sea-native-<sig>/__bundle__/sag.embedding-worker.cjs
  //      (SEA staging — the SEA build writes the worker bundle to
  //      this location at runtime via unpackOnce())
  //   3. <dirname>/embedding-worker.js                    (dev fallback)
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "sag.embedding-worker.cjs"),
    // Walk the SEA staging dir — the basename may vary across
    // versions, so glob for any sag-sea-native-* dir under tmpdir.
    ...(function findSeaStaging(): string[] {
      try {
        const os = require("node:os") as typeof import("node:os");
        const fs = require("node:fs") as typeof import("node:fs");
        const tmp = os.tmpdir();
        const entries = fs.readdirSync(tmp, { withFileTypes: true });
        const matches: string[] = [];
        for (const e of entries) {
          if (e.isDirectory() && e.name.startsWith("sag-sea-native-")) {
            const p = path.join(tmp, e.name, "__bundle__", "sag.embedding-worker.cjs");
            if (fs.existsSync(p)) matches.push(p);
          }
        }
        return matches;
      } catch {
        return [];
      }
    })(),
    path.join(path.dirname(new URL(import.meta.url).pathname), "embedding-worker.js")
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error(
    `embedding-worker source not found. Looked in: ${candidates.join(", ")}. ` +
      "The SEA build must stage sag.embedding-worker.cjs next to sag.bundle.cjs."
  );
}

function teardownWorker(reason: string): void {
  if (!workerInstance) return;
  const w = workerInstance;
  workerInstance = null;
  // Reject any pending requests — the caller can retry, which will
  // trigger a fresh worker spawn.
  for (const [, p] of pending) {
    p.reject(new Error(`embedding worker terminated: ${reason}`));
  }
  pending.clear();
  workerInitPromise = null;
  try {
    w.removeAllListeners();
    w.terminate().catch(() => {
      /* ignore */
    });
  } catch {
    /* ignore */
  }
}

function ensureWorker(): Promise<void> {
  if (workerInitPromise) return workerInitPromise;
  workerInitPromise = new Promise<void>((resolve, reject) => {
    let workerPath: string;
    try {
      workerPath = workerSourcePath();
    } catch (err) {
      workerInitPromise = null;
      reject(err as Error);
      return;
    }
    const w = new Worker(workerPath);
    workerInstance = w;

    let bootError: Error | null = null;

    w.on("message", (msg: WorkerResponse | { op: "ready" }) => {
      // The boot "ready" signal isn't request-scoped; ignore.
      if ("op" in msg && msg.op === "ready") return;
      const resp = msg as WorkerResponse;
      const p = pending.get(resp.id);
      if (!p) return;
      pending.delete(resp.id);
      if (resp.ok) p.resolve(resp);
      else p.reject(new Error(resp.error || "embedding worker error"));
    });

    w.on("error", (err) => {
      // The worker thread crashed (often ONNX native abort). Keep
      // the main process alive — only the worker is torn down.
      logger.error({ err: err.message }, "embedding worker crashed; will respawn on next request");
      bootError = err;
      teardownWorker(err.message);
    });

    w.on("exit", (code) => {
      if (!bootError && code !== 0) {
        logger.warn({ code }, "embedding worker exited non-zero");
      }
      teardownWorker(`exit code ${code}`);
    });

    // Send a ping to confirm the worker thread is alive and the
    // RPC channel is wired up. Resolves the init promise.
    const initId = randomUUID();
    pending.set(initId, {
      resolve: () => {
        resolve();
      },
      reject: (err) => reject(err)
    });
    const ping: WorkerRequest = { id: initId, op: "ping" };
    w.postMessage(ping);
    // Reject if the worker never responds within a sane window —
    // typically <100ms but allow 5s for slow CI / disk.
    const watchdog = setTimeout(() => {
      if (workerInitPromise) {
        workerInitPromise = null;
        reject(new Error("embedding worker boot timed out after 5s"));
        teardownWorker("boot timeout");
      }
    }, 5000);
    // Once the ping resolves, clear the watchdog.
    const origResolve = pending.get(initId)!.resolve;
    pending.get(initId)!.resolve = (v) => {
      clearTimeout(watchdog);
      origResolve(v);
    };
    // Suppress unused-variable warning — `ping` is kept around for
    // debugging if we ever wire a structured postMessage signature.
    void ping;
    void initId;
  });
  // Don't propagate rejection forever — clear so the next call retries.
  workerInitPromise.catch(() => {
    workerInitPromise = null;
  });
  return workerInitPromise;
}

async function sendRequest<T extends WorkerResponse>(
  op: WorkerRequest["op"],
  fields: Record<string, unknown>
): Promise<T> {
  await ensureWorker();
  if (!workerInstance) throw new Error("embedding worker not running");
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject
    });
    workerInstance!.postMessage({ ...fields, op, id });
    // Per-request timeout (10 minutes). ONNX forward pass on CPU is
    // ~10-50ms per chunk; a 10-min ceiling catches true hangs.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`embedding worker request ${id} timed out after 10min`));
      }
    }, 600_000).unref();
  });
}

/**
 * Embed a batch of texts via the worker. The main thread blocks
 * only on `postMessage`/`structuredClone`, never on ONNX forward.
 */
export async function localBgeEmbeddingViaWorker(
  modelPath: string,
  texts: string[],
  dimensions: number
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const resp = await sendRequest<{
    id: string;
    op: "embed";
    ok: true;
    vectors: number[][];
  }>("embed", {
    modelPath,
    texts,
    dimensions
  });
  return resp.vectors;
}

/**
 * Pre-warm the worker so the first embedding request doesn't pay
 * the ~5-15s ONNX pipeline load. Called during `localBgeEmbedding`
 * lazy-init in the main thread.
 */
export async function preloadLocalBgeWorker(modelPath: string): Promise<void> {
  await ensureWorker();
  await sendRequest<{ id: string; op: "load"; ok: true }>("load", {
    modelPath
  });
}

/**
 * Stop the worker thread cleanly. Used on shutdown / settings
 * change so we don't leak a thread between sessions.
 */
export async function stopLocalBgeWorker(): Promise<void> {
  teardownWorker("stop requested");
}