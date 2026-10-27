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
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../observability/logger.js";
import { waitForNativeCacheReady } from "./native-cache-ready.js";
import * as esbuild from "esbuild";

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
  //   0. $SAG_NATIVE_CACHE_DIR/__bundle__/sag.embedding-worker.cjs
  //      (the SEA entry points straight at the per-machine staged dir —
  //      the most precise source available; set for the backend).
  //   1. <exeDir>/native-cache/<12-hex-hash>/__bundle__/sag.embedding-worker.cjs
  //      (the per-machine hash layout — unpackOnce() stages the worker
  //      AND its node_modules siblings under the same hash dir, so the
  //      worker's require("@xenova/transformers") resolves via Node's
  //      normal parent-walk even without NODE_PATH. Hash dirs whose
  //      node_modules actually contain transformers are preferred over
  //      an older build's leftover dir that may only hold the eager
  //      subset. Needs no env var, so it also works in the
  //      ingest-worker sidecar, whose entry does not set
  //      SAG_NATIVE_CACHE_DIR.)
  //   2. %TEMP%/sag-sea-native-<sig>/__bundle__/sag.embedding-worker.cjs
  //      (older staging shape — kept for back-compat with pre-iter17 installs)
  //   3. <dirname>/embedding-worker.js                    (compiled dev fallback)
  //
  // NOTE: <exeDir>/native-cache/__bundle__/sag.embedding-worker.cjs is
  // deliberately NOT a candidate any more. That file is the SHIPPED
  // source-cache copy staged by the build, and its sibling
  // `node_modules/` does NOT exist at that level (the source cache
  // lays packages out at native-cache/<pkg>/, not
  // native-cache/node_modules/<pkg>/). Picking it made the worker
  // crash at require("@xenova/transformers") with MODULE_NOT_FOUND and
  // pushed every embedding call onto the in-process main-thread
  // fallback — the "UI stops loading" freeze (observed 2026-10-27 on
  // the v2 install, preflight probe failed every 60 s).
  const exeDir = path.dirname(process.execPath);
  const candidates: string[] = [];
  if (process.env.SAG_NATIVE_CACHE_DIR) {
    candidates.push(
      path.join(process.env.SAG_NATIVE_CACHE_DIR, "__bundle__", "sag.embedding-worker.cjs")
    );
  }
  try {
    const ncRoot = path.join(exeDir, "native-cache");
    const withDeps: string[] = [];
    const withoutDeps: string[] = [];
    for (const e of readdirSync(ncRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[0-9a-f]{12}$/.test(e.name)) continue;
      const hashDir = path.join(ncRoot, e.name);
      const w = path.join(hashDir, "__bundle__", "sag.embedding-worker.cjs");
      if (!existsSync(w)) continue;
      if (existsSync(path.join(hashDir, "node_modules", "@xenova", "transformers", "package.json"))) {
        withDeps.push(w);
      } else {
        withoutDeps.push(w);
      }
    }
    candidates.push(...withDeps, ...withoutDeps);
  } catch {
    /* native-cache unreadable — fall through to the other candidates */
  }
  candidates.push(
    // Walk the SEA staging dir — the basename may vary across
    // versions, so glob for any sag-sea-native-* dir under tmpdir.
    ...(function findSeaStaging(): string[] {
      try {
        const tmp = os.tmpdir();
        const entries = readdirSync(tmp, { withFileTypes: true });
        const matches: string[] = [];
        for (const e of entries) {
          if (e.isDirectory() && e.name.startsWith("sag-sea-native-")) {
            const p = path.join(tmp, e.name, "__bundle__", "sag.embedding-worker.cjs");
            if (existsSync(p)) matches.push(p);
          }
        }
        return matches;
      } catch {
        return [];
      }
    })(),
    path.join(path.dirname(fileURLToPath(import.meta.url)), "embedding-worker.js")
  );
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // P-Audit-#1 — dev-mode fallback. When this module is loaded via
  // `npx tsx src/index.ts`, none of the .cjs/.js files above exist
  // (no SEA bundle, no compiled dist). The previous behaviour was to
  // throw and force every embedding call onto the in-process ONNX
  // path, freezing /health for 10-30s/file during ingest.
  //
  // The fix is to write a one-shot transpiled .cjs alongside the
  // source file using esbuild (already a devDep — `node` doesn't have
  // to spawn a new tsx process). The .cjs is cached by content hash
  // so we only re-transpile when the source changes; subsequent boots
  // skip esbuild and load the cached file directly via the candidate
  // loop above.
  //
  // In production (SEA), the SEA build pipeline already stages the
  // worker .cjs alongside the bundle, so this fallback never runs.
  return ensureDevWorkerBundle();
}

/**
 * P-Audit-#1 — dev-mode worker source provisioner. transpiles
 * `embedding-worker.ts` to a sibling `.cjs` using esbuild so the
 * `Worker(workerPath)` constructor can spawn it. The filename is
 * keyed on the SHA-256 of the source — if the source hasn't changed
 * since the last boot, we skip esbuild entirely and just return the
 * cached path.
 *
 * Returns the .cjs file path. Throws on transpile error so the
 * upstream `localBgeEmbedding` catch falls through to the in-process
 * fallback (no behaviour change for users who can't reach this path).
 *
 * Why esbuild (not tsx): tsx is a runtime hook that intercepts module
 * resolution; `Worker(path)` constructs a child thread with its own
 * require/loader and tsx doesn't propagate into it. esbuild gives us
 * a plain .cjs file that the child thread loads with Node's native
 * loader — same shape as the SEA bundle the production code path
 * already uses.
 */
function ensureDevWorkerBundle(): string {
  // Locate the .ts source. The Worker constructor (and esbuild)
  // resolve relative paths against the file URL of the calling
  // module, so we anchor the lookup at __dirname/embedding-worker.ts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(here, "embedding-worker.ts");
  if (!existsSync(sourcePath)) {
    // Should never happen — embedding-worker.ts lives next to this
    // file in every checkout. Surface a clear error so the SEA
    // operator doesn't chase a phantom "dev fallback" issue.
    throw new Error(
      `embedding-worker.ts not found at ${sourcePath}. The dev fallback ` +
        "requires the .ts source next to embedding-worker-client.ts."
    );
  }
  const source = readFileSync(sourcePath, "utf8");
  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const outPath = path.join(here, `.embedding-worker.${hash}.cjs`);
  if (existsSync(outPath)) {
    // Cache hit — fast path for repeat dev sessions.
    return outPath;
  }
  // Cache miss — transpile. esbuild is bundled, no Node ESM/CJS
  // gymnastics needed; format=cjs gives us the same shape as the
  // production .cjs the SEA build emits.
  let transpiled: string;
  try {
    transpiled = esbuild.transformSync(source, {
      loader: "ts",
      format: "cjs",
      target: "node20",
      // worker_threads still requires CJS module.exports to attach
      // parentPort correctly; preserve the original module shape
      // rather than letting esbuild guess.
      banner: "// Auto-generated dev worker bundle — do not edit by hand.",
      sourcemap: false,
      minify: false
    }).code;
    // P-Tear2 — esbuild inlines all imports as bare relative paths
    // (`require("../db/row-helpers.js")`). The .cjs file lives next
    // to embedding-worker.ts but is loaded by a brand-new
    // `Worker(workerPath)` thread that does NOT inherit tsx's module
    // resolution. Without explicit tsx bootstrapping the require
    // fails with "Cannot find module '../db/row-helpers.js'" and the
    // worker thread crashes immediately — every embedding call then
    // falls back to in-process ONNX, freezing the main thread for
    // 5-15s per chunk.
    //
    // Two fixes tried in this dev fallback:
    //   1. Write the transpiled .cjs into a directory whose
    //      `node_modules/esbuild-loader/register.mjs` shim can resolve
    //      via the parent's tsx loader. We can't make a Worker thread
    //      inherit the parent's loader — Node's worker_threads does
    //      not propagate ESM loader hooks.
    //   2. (this code) inject a CJS `require` shim into the bundle
    //      that resolves `.js` -> `.ts` -> `.tsx` paths so the
    //      relative `../db/row-helpers.js` import finds the source.
    //
    // We accomplish (2) by prefixing the bundle with a tiny
    // `Module._extensions` patch that intercepts `.js` resolution and
    // tries `.ts`/`.tsx` siblings when the original target doesn't
    // exist. This is the same approach the `ts-node` CJS hook uses,
    // minus the full type-stripping machinery.
    transpiled = `// dev-mode .ts resolution shim for the worker thread
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function patched(request, parent, ...rest) {
  try {
    return origResolveFilename.call(this, request, parent, ...rest);
  } catch (err) {
    if (request.startsWith(".") || request.startsWith("/")) {
      // Try .ts / .tsx / .mts / .cts siblings before propagating.
      const exts = [".ts", ".tsx", ".mts", ".cts"];
      for (const e of exts) {
        const tryPath = request.endsWith(".js") ? request.replace(/\\.js$/, e) : request + e;
        try {
          return origResolveFilename.call(this, tryPath, parent, ...rest);
        } catch { /* keep going */ }
      }
    }
    throw err;
  }
};
${transpiled}`;
    // Drop the cached .cjs file from the first attempt that lacked
    // the shim so we force a rebuild on the very next call.
  } catch (err) {
    throw new Error(
      `dev worker transpile failed: ${(err as Error).message}. ` +
        "The main process will fall back to in-process embedding."
    );
  }
  // Write the cached file and prune any stale hashes from previous
  // source revisions (otherwise editing embedding-worker.ts would leave
  // orphaned .cjs files under the same dir).
  try {
    writeFileSync(outPath, transpiled, "utf8");
    const dir = here;
    for (const entry of readdirSync(dir)) {
      if (
        entry.startsWith(".embedding-worker.") &&
        entry.endsWith(".cjs") &&
        entry !== `.embedding-worker.${hash}.cjs`
      ) {
        try {
          // best-effort prune
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require("node:fs").unlinkSync(path.join(dir, entry));
        } catch {
          // ignore — another process holds the file open, or it's
          // already gone. Next boot will retry the prune.
        }
      }
    }
  } catch (err) {
    throw new Error(
      `dev worker write failed: ${(err as Error).message}. ` +
        "The main process will fall back to in-process embedding."
    );
  }
  logger.info(
    { sourcePath, outPath },
    "embedding-worker: dev transpile cache miss — built .cjs from .ts"
  );
  return outPath;
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
  // Gate on the SEA background native-cache unpack: the worker FILE is
  // staged eagerly, but its require("@xenova/transformers") resolves
  // against node_modules that the background pass may still be copying.
  // Spawning before the stamp lands crashes the worker at require time
  // and pushes every embedding call onto the in-process main-thread
  // path — the "UI stops loading after a restart" freeze. Bounded and
  // memoized; a no-op once the stamp exists.
  workerInitPromise = waitForNativeCacheReady().then(
    () =>
      new Promise<void>((resolve, reject) => {
    let workerPath: string;
    try {
      workerPath = workerSourcePath();
    } catch (err) {
      workerInitPromise = null;
      reject(err as Error);
      return;
    }
    // The worker file lives in <base>/__bundle__/sag.embedding-worker.cjs
    // but its externals (@xenova/transformers, onnxruntime-node, ...)
    // live in <base>/node_modules/. A Worker thread resolves `require()`
    // relative to ITS OWN file, so from __bundle__/ it would look in
    // <base>/__bundle__/node_modules and fail with
    //   "Cannot find module '@xenova/transformers'"
    // — the worker then dies at boot and every embedding call silently
    // falls back to in-process ONNX on the main thread (the "UI stops
    // loading" freeze).
    //
    // The SEA entry solves the same problem for the MAIN bundle by
    // setting `bundleModule.paths = [NATIVE_DIR/node_modules]`. A Worker
    // thread gets its own module registry, so we point it at the same
    // directory.
    //
    // We use NODE_PATH (via the worker's `env`) rather than patching
    // Module.globalPaths inside the worker: NODE_PATH is applied by
    // Node's own bootstrap before ANY module in the worker is loaded,
    // so it works regardless of how the bundler orders the imports.
    // Patching globalPaths from inside the worker body is unreliable
    // because esbuild hoists `import` statements above the module body.
    const nodeModulesDir = (() => {
      try {
        // Most precise: the SEA entry points at the per-machine dir.
        if (process.env.SAG_NATIVE_CACHE_DIR) {
          const fromEnv = path.join(process.env.SAG_NATIVE_CACHE_DIR, "node_modules");
          if (existsSync(fromEnv)) return fromEnv;
        }
        // <exe>/native-cache/<hash>/__bundle__/sag.embedding-worker.cjs
        //   -> <exe>/native-cache/<hash>/node_modules
        const bundleDir = path.dirname(workerPath);
        const baseDir = path.dirname(bundleDir);
        const candidate = path.join(baseDir, "node_modules");
        return existsSync(candidate) ? candidate : undefined;
      } catch {
        return undefined;
      }
    })();

    const workerEnv = { ...process.env };
    if (nodeModulesDir) {
      const existing = workerEnv.NODE_PATH;
      workerEnv.NODE_PATH = existing
        ? `${nodeModulesDir}${path.delimiter}${existing}`
        : nodeModulesDir;
    }

    const w = new Worker(workerPath, {
      // `execArgv: []` keeps the worker from inheriting --inspect,
      // which would try to bind the debug port twice.
      execArgv: [],
      env: workerEnv,
    });
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
      })
  );
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