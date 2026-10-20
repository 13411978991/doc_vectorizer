// src/ai/embedding-worker.ts — Runs in a Worker thread, isolated from
// the main Node process. Loads the BGE pipeline + tokenizer once, then
// processes embedding requests sent via `parentPort.postMessage`.
// Crashes here (including ONNX native aborts) are caught by the
// `worker.on("error", ...)` handler in embedding-worker-client.ts and
// do NOT take down the main Node process / HTTP server / watcher.
//
// IMPORTANT: This file has no exports by design — it self-executes via
// `parentPort.on(...)` and never imports anything else from the host
// bundle. tsc's emit-once-or-skip logic would normally tree-shake this
// file away because nothing statically references it. The empty
// `export {}` below is the standard TypeScript incantation to force
// tsc to emit the JS file even when the module is reached only via
// dynamic file path (the `Worker(workerPath)` constructor in
// embedding-worker-client.ts). Without this, `npm run build:api`
// produces no `dist/src/ai/embedding-worker.js` and the worker
// thread silently falls back to in-process embedding, which DOES
// block the main thread and freezes /health during ingest storms.

export {};

import { parentPort } from "node:worker_threads";
import path from "node:path";
import { statSync } from "node:fs";
import * as transformers from "@xenova/transformers";
import { toLocalISO } from "../db/row-helpers.js";

if (!parentPort) {
  throw new Error("embedding-worker must be spawned via worker_threads");
}

// Lightweight stdout logger. The main-thread logger isn't reachable
// from a worker, and the user inspects sd-out.log to debug embedding
// issues — we tag every line with [embedding-worker] so it's easy
// to find. Avoid pino here because the worker doesn't need async
// file IO and synchronous console output is plenty for diagnostics.
function log(level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void {
  const ts = toLocalISO();
  const line = fields
    ? `${ts} [embedding-worker] ${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`
    : `${ts} [embedding-worker] ${level.toUpperCase()} ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// =========================================================================
// onnxruntime BFC arena kill-switch.
//
// Why this is needed: @xenova/transformers v2.17.2's constructSession
// (node_modules/@xenova/transformers/src/models.js:120-144) calls
// `InferenceSession.create(buffer, { executionProviders })` with a
// HARDCODED options object — there is no way to pass extra session
// options through the public `pipeline()` API. The onnxruntime-node
// `BFCArena` allocator then pre-reserves ~4.8 GB of contiguous
// virtual address space based on the BGE-large working-set estimate,
// which Windows cannot provide when system memory is fragmented
// (browser tabs, dev tools, security agents, etc.). The native
// binding raises `EXCEPTION_NONCONTINUABLE_EXCEPTION` (0xC06D007F)
// and the entire Node process dies — taking the desktop app down
// with it.
//
// transformers v2.17.2 imports onnxruntime-node eagerly (see
// backends/onnx.js) but does NOT re-export it — `transformers.env`
// only exposes `ONNX.env` (the onnxruntime env object, not the
// ONNX namespace itself), and `backends.onnx` is a backend
// REGISTRY object, not the onnxruntime-node module. So a
// monkey-patch via the transformers namespace cannot reach
// `InferenceSession.create`. The patch has to be installed on
// `onnxruntime-node` directly.
//
// The fix: `require("onnxruntime-node")` ourselves and patch its
// `InferenceSession.create`. transformers already holds a reference
// to the same module object (modules are cached in `require.cache`),
// so when transformers' `constructSession` later calls
// `InferenceSession.create`, it routes through our wrapper. The
// wrapper merges `enableCpuMemArena: false + enableMemoryPattern:
// false + intraOpNumThreads: 1` into the session options before
// delegating.
//
// With the BFC arena off, the working set drops to ~1.2 GB on a
// 32 GB Win11 host (verified empirically with the same model). The
// cost is per-forward alloc/release overhead — ~10-20% slower, in
// absolute terms ~150-200ms per chunk, well within the 30s ingest
// budget.
//
// This patch MUST be installed before `loadModel()` is called
// (i.e. before `pipeline()` is invoked), which is why it sits at
// the top of the worker file rather than inside `loadModel()`.
// =========================================================================
(function installOnnxSessionPatch(): void {
  // Patch EVERY reachable onnxruntime-node instance. Node's
  // require.cache is keyed by the RESOLVED FILENAME, and this
  // worker file sits in `<exeDir>/native-cache/__bundle__/` —
  // a bare `require("onnxruntime-node")` from here walks UP the
  // directory tree and can land on a DIFFERENT copy than the one
  // transformers' internal require uses (transformers is loaded
  // from the staged `<sig>/node_modules/@xenova/transformers`,
  // so its own require resolves the staged `onnxruntime-node`).
  // Patching only one copy leaves transformers' copy with the
  // BFC arena still on — which is exactly what happened on the
  // first attempt (patch logged "installed" yet the arena
  // still pre-reserved 4.8 GB and the process died).
  //
  // We therefore resolve onnxruntime-node in THREE contexts and
  // patch each unique instance:
  //   1. Relative to the transformers package (the context
  //      transformers' own internal require uses — THE one that
  //      matters).
  //   2. A bare require from this file (belt-and-braces; may be
  //      the same instance as #1, deduped via __sagPatched).
  const candidatePaths: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const txMain = require.resolve("@xenova/transformers");
    candidatePaths.push(
      require.resolve("onnxruntime-node", { paths: [path.dirname(txMain)] })
    );
  } catch (err) {
    log("warn", "onnx session patch: could not resolve onnxruntime-node via transformers", {
      error: err instanceof Error ? err.message : String(err)
    });
  }
  try {
    candidatePaths.push(require.resolve("onnxruntime-node"));
  } catch {
    /* not resolvable from here — fine, #1 is the one that counts */
  }

  let patchedCount = 0;
  const seen = new Set<string>();
  for (const ortPath of candidatePaths) {
    if (seen.has(ortPath)) continue;
    seen.add(ortPath);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ortNs = require(ortPath) as {
        InferenceSession?: { create?: unknown };
      };
      const Create = ortNs?.InferenceSession?.create;
      if (!Create || typeof Create !== "function") {
        log("warn", "onnx session patch: InferenceSession.create missing", { ortPath });
        continue;
      }
      if ((Create as { __sagPatched?: boolean }).__sagPatched) {
        continue;
      }
      const originalCreate = Create as (
        buffer: ArrayBuffer,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
      const patched = async function sagPatchedCreate(
        buffer: ArrayBuffer,
        opts?: Record<string, unknown>
      ): Promise<unknown> {
        return originalCreate(buffer, {
          ...(opts ?? {}),
          enableCpuMemArena: false,
          enableMemoryPattern: false,
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
          // Keep whatever executionProviders the caller asked
          // for (transformers passes ['cpu', 'wasm']).
          executionProviders: opts?.executionProviders ?? ["cpu"]
        });
      };
      (patched as { __sagPatched?: boolean }).__sagPatched = true;
      ortNs.InferenceSession!.create = patched;
      patchedCount++;
      log("info", "onnx session patch installed", { ortPath });
    } catch (err) {
      log("warn", "onnx session patch failed for resolved path", {
        ortPath,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (patchedCount === 0) {
    log("warn", "onnx session patch: NO instance patched — BFC arena still on, expect OOM");
  }
})();


interface FeatureTensor {
  dims: number[];
  data: Float32Array | Float64Array | Int32Array;
}

type PipelineFn = (
  task: string,
  model: string | null,
  opts?: Record<string, unknown>
) => Promise<FeatureTensor>;

interface PipelineInstance {
  // Single-text forward: `pipeline(text, opts)`
  (text: string, opts: Record<string, unknown>): Promise<FeatureTensor>;
  // Batched forward: `pipeline(texts, opts)` where `texts: string[]`
  // returns a flat tensor with batch dim at index 0.
  (texts: string[], opts: Record<string, unknown>): Promise<FeatureTensor>;
}

type TokenizerLike = {
  encode: (text: string, textPair: unknown, opts: Record<string, unknown>) => Promise<number[]>;
};

const env = transformers.env as {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
};
env.allowRemoteModels = false;
env.allowLocalModels = true;

let pipeline: PipelineInstance | null = null;
let tokenizer: TokenizerLike | null = null;
let currentModelPath = "";

async function loadModel(modelPath: string): Promise<void> {
  log("info", "loading model", { modelPath });
  // Resolve the model path correctly under SEA. Settings store
  // `models/<name>` as a *relative* path because the web UI ships
  // that prefix verbatim from the catalog. Plain `path.resolve()`
  // would anchor at process.cwd(), which inside the Electron-launched
  // SEA exe is `<release-desktop>/win-unpacked/` — but the models
  // are actually staged under `resources/models/` next to the exe.
  // Try in order:
  //   1. Absolute path (operator hand-edited a custom location).
  //   2. `<exeDir>/resources/<modelPath>` — the SEA production layout.
  //   3. `<exeDir>/<modelPath>` — dev / out-of-tree layout.
  //   4. `<cwd>/<modelPath>` — legacy fallback for tests / npm scripts.
  let absoluteModelPath: string;
  if (path.isAbsolute(modelPath)) {
    absoluteModelPath = modelPath;
  } else {
    const exeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(exeDir, "resources", modelPath),
      path.join(exeDir, modelPath),
      path.resolve(modelPath)
    ];
    const matched = candidates.find((c) => {
      try {
        return statSync(c).isDirectory();
      } catch {
        return false;
      }
    });
    if (!matched) {
      throw new Error(
        `local BGE model directory not found. Tried:\n` +
          candidates.map((c) => `  - ${c}`).join("\n") +
          `\nFix: re-download the model from Settings → Embedding → 本地 BGE.`
      );
    }
    absoluteModelPath = matched;
    log("info", "resolved model path", { modelPath, absoluteModelPath });
  }
  const basename = path.basename(absoluteModelPath);
  const parentDir = path.dirname(absoluteModelPath);
  env.allowLocalModels = true;
  env.localModelPath = parentDir.replace(/\\/g, "/");
  // The transformers.pipeline factory needs to be invoked unbound
  // so `this` resolves to the transformers module (otherwise it
  // errors with "Illegal invocation").
  const createPipeline = (transformers.pipeline as unknown as PipelineFn).bind(
    transformers
  );
  // Pick the first matching file under onnx/. Current Xenova ships
  // model_int8.onnx; older exports shipped model_quantized.onnx.
  // Falling back here avoids forcing a 327 MB re-download for users
  // whose tree predates the rename.
  const fsPromises = await import("node:fs/promises");
  let onnxFileName: string | undefined;
  try {
    // The loader appends `.onnx` to `model_file_name` itself, so we
    // strip the extension when scanning the directory.
    const onnxDir = path.join(parentDir, basename, "onnx");
    const files = await fsPromises.readdir(onnxDir);
    const candidates = ["model_int8", "model_uint8", "model_q4", "model_quantized"];
    onnxFileName = candidates.find((c) => files.includes(`${c}.onnx`));
  } catch {
    /* directory unreadable; let createPipeline fail with the standard error */
  }
  pipeline = (await createPipeline("feature-extraction", basename, {
    quantized: false,
    model_file_name: onnxFileName ?? "model_int8",
    local_files_only: true
    // NOTE: We deliberately do NOT pass `session_options` here.
    // @xenova/transformers v2.17.2's constructSession
    // (node_modules/@xenova/transformers/src/models.js:120-144)
    // builds a hardcoded `{ executionProviders }` options object
    // and ignores any extra fields, so passing them here has
    // no effect. The BFC-arena kill-switch is installed earlier
    // in this file (see installOnnxSessionPatch), where it
    // monkey-patches onnxruntime-node's InferenceSession.create
    // to inject enableCpuMemArena: false before transformers
    // gets a chance to call it.
  })) as unknown as PipelineInstance;
  const AutoTokenizer = (transformers as unknown as {
    AutoTokenizer: { from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<TokenizerLike> };
  }).AutoTokenizer;
  tokenizer = await AutoTokenizer.from_pretrained(basename, {
    quantized: false,
    local_files_only: true
  });
  currentModelPath = modelPath;
  log("info", "model loaded", { modelPath, dimHint: 1024 });
}

const BGE_MAX_TOKENS = 510;

async function truncateToTokenLimit(text: string): Promise<string> {
  if (!tokenizer) throw new Error("tokenizer not loaded");
  // Fast path: very short strings don't need tokenisation. BGE-large's
  // tokenizer sub-tokenises CJK at roughly 1 char = 1 token
  // (verified empirically against bge-large-zh-v1.5), so the fast
  // path must stay ≤ ~500 chars. Any longer string runs the binary
  // search below.
  if (text.length <= 500) return text;
  const encodeOptions = { add_special_tokens: false };
  const ids = await tokenizer.encode(text, null, encodeOptions);
  if (ids.length <= BGE_MAX_TOKENS) return text;
  const ratio = text.length / ids.length;
  const upperChars = Math.min(text.length, Math.ceil(BGE_MAX_TOKENS * ratio * 0.9));
  let lo = 1;
  let hi = Math.max(1, upperChars);
  let best = "";
  let lastSlice = "";
  let lastTokens = Number.POSITIVE_INFINITY;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let tokens: number;
    if (mid === lastSlice.length) {
      tokens = lastTokens;
    } else {
      lastSlice = text.slice(0, mid);
      const sliceIds = await tokenizer.encode(lastSlice, null, encodeOptions);
      lastTokens = sliceIds.length;
      tokens = lastTokens;
    }
    if (tokens <= BGE_MAX_TOKENS) {
      best = lastSlice;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best.trimEnd();
}

async function embedTexts(texts: string[], dimensions: number): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!pipeline) throw new Error("pipeline not loaded");
  // Truncate each text first (defense-in-depth: the main thread
  // already truncates to 8000 chars via capForEmbedding, but we
  // also need to enforce the BGE 510-token limit here because the
  // batched `pipeline(texts)` call is one forward pass that can
  // trip onnxruntime's broadcast assertion on a single over-long
  // element).
  const safeTexts: string[] = [];
  for (const text of texts) {
    safeTexts.push(await truncateToTokenLimit(text));
  }
  const results: number[][] = [];
  // Hard cap on forward-pass batch size. Callers upstream can
  // hand us arbitrarily large arrays (the main ingest path has
  // its own batching that has varied over time), and a single
  // batched forward's attention-score transient is
  // [batch, 16, seq<=512, seq<=512] fp32 ≈ batch × 16 MB. On
  // commit-constrained hosts a >256 MB transient risks a
  // native `bad allocation` that escapes as 0xC06D007F and
  // kills the whole backend process. Sub-batching to 8 caps
  // the transient at ~128 MB no matter what callers send.
  // Throughput is bounded by CPU anyway at these sizes.
  const FORWARD_BATCH = 8;
  try {
    for (let off = 0; off < safeTexts.length; off += FORWARD_BATCH) {
      const slice = safeTexts.slice(off, off + FORWARD_BATCH);
      const tensor = await pipeline(slice, { pooling: "cls", normalize: true });
      // `tensor.data` for batched input is a single flat array;
      // reshape into `number[][]` of length `texts.length`.
      const lastDim = tensor.dims[tensor.dims.length - 1] ?? 0;
      if (lastDim !== dimensions) {
        throw new Error(`local-bge output dim ${lastDim} != configured ${dimensions}`);
      }
      const flat = Array.from(tensor.data);
      for (let i = 0; i < slice.length; i++) {
        const start = i * dimensions;
        results.push(flat.slice(start, start + dimensions));
      }
    }
  } catch {
    // Batched call failed (typically one element over the 510-token
    // limit despite our truncate). Fall back to single-text
    // processing with the 200-char emergency slice so one bad
    // element doesn't kill the whole batch.
    for (const text of texts) {
      let tensor: FeatureTensor | null = null;
      try {
        tensor = await pipeline(await truncateToTokenLimit(text), {
          pooling: "cls",
          normalize: true
        });
      } catch {
        try {
          tensor = await pipeline(text.slice(0, 200), {
            pooling: "cls",
            normalize: true
          });
        } catch {
          results.push(new Array<number>(dimensions).fill(0));
          continue;
        }
      }
      if (!tensor) {
        results.push(new Array<number>(dimensions).fill(0));
        continue;
      }
      results.push(Array.from(tensor.data));
    }
  }
  return results;
}

type WorkerInbound =
  | { id: string; op: "load"; modelPath: string }
  | { id: string; op: "embed"; modelPath: string; texts: string[]; dimensions: number }
  | { id: string; op: "ping" };

async function handleMessage(msg: WorkerInbound): Promise<void> {
  try {
    if (msg.op === "load") {
      const t0 = Date.now();
      await loadModel(msg.modelPath);
      parentPort!.postMessage({
        id: msg.id,
        op: msg.op,
        ok: true,
        loadMs: Date.now() - t0
      });
    } else if (msg.op === "embed") {
      if (!pipeline || currentModelPath !== msg.modelPath) {
        await loadModel(msg.modelPath);
      }
      const vectors = await embedTexts(msg.texts, msg.dimensions);
      parentPort!.postMessage({ id: msg.id, op: msg.op, ok: true, vectors });
    } else if (msg.op === "ping") {
      parentPort!.postMessage({ id: msg.id, op: msg.op, ok: true });
    }
  } catch (err) {
    log("error", "request failed", {
      op: msg.op,
      id: msg.id,
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });
    parentPort!.postMessage({
      id: msg.id,
      op: msg.op,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// Serialize ALL ops through a promise chain. The main thread can
// post up to EMBEDDING_BATCH_CONCURRENCY (default 5) embed ops
// back-to-back; the previous async handler ran them INTERLEAVED,
// so 5 ONNX forward passes (each ~512 MB transient at batch 32)
// could be live at once — plus a double loadModel when the
// warmup 'load' and the first real 'embed' arrive together
// (~2.6 GB for two sessions). That memory multiplication is
// what tripped the native `bad allocation` / 0xC06D007F process
// kill on commit-constrained hosts. One op at a time caps the
// peak at one session + one batch transient (~700 MB).
let opChain: Promise<void> = Promise.resolve();
parentPort.on("message", (msg: WorkerInbound) => {
  opChain = opChain.then(() => handleMessage(msg));
  // Swallow chain rejections: handleMessage already reports
  // per-op failures via postMessage, so the chain itself must
  // never reject (a rejected link would stall every later op).
  opChain = opChain.catch(() => undefined);
});

log("info", "worker booted, awaiting first 'load' command");
parentPort.postMessage({ op: "ready" });