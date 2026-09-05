// src/ai/embedding-worker.ts — Runs in a Worker thread, isolated from
// the main Node process. Loads the BGE pipeline + tokenizer once, then
// processes embedding requests sent via `parentPort.postMessage`.
// Crashes here (including ONNX native aborts) are caught by the
// `worker.on("error", ...)` handler in embedding-worker-client.ts and
// do NOT take down the main Node process / HTTP server / watcher.

import { parentPort } from "node:worker_threads";
import path from "node:path";
import * as transformers from "@xenova/transformers";
import { toLocalISO } from "../db/row-helpers.js";

if (!parentPort) {
  throw new Error("embedding-worker must be spawned via worker_threads");
}

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
  const absoluteModelPath = path.resolve(modelPath);
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
  pipeline = (await createPipeline("feature-extraction", basename, {
    quantized: false,
    model_file_name: "model_int8",
    local_files_only: true
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
  // Batched forward: pass the whole pre-truncated array to the
  // pipeline. ONNX feature-extraction accepts `string[]` and runs
  // one forward pass over the entire batch — roughly 4x faster than
  // one-text-at-a-time on CPU. The previous looped implementation
  // was single-text forward (17ms × N). With batching, throughput
  // is bounded by the longest input's compute, not the sum.
  try {
    const tensor = await pipeline(safeTexts, { pooling: "cls", normalize: true });
    // `tensor.data` for batched input is a single flat array;
    // reshape into `number[][]` of length `texts.length`.
    const lastDim = tensor.dims[tensor.dims.length - 1] ?? 0;
    if (lastDim !== dimensions) {
      throw new Error(`local-bge output dim ${lastDim} != configured ${dimensions}`);
    }
    const flat = Array.from(tensor.data);
    for (let i = 0; i < safeTexts.length; i++) {
      const start = i * dimensions;
      results.push(flat.slice(start, start + dimensions));
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

parentPort.on("message", async (msg: WorkerInbound) => {
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
});

log("info", "worker booted, awaiting first 'load' command");
parentPort.postMessage({ op: "ready" });