/**
 * Plan B (2026-09-19): NER pipeline factory.
 *
 * Wraps `@xenova/transformers`'s `pipeline("token-classification", ...)`
 * with the same caching, path-resolution and SEA-friendly patterns
 * that `embedding-client.ts:608 getLocalBgePipeline` uses for the
 * BGE embedding model. See that function's header comment for the
 * full rationale on `env.localModelPath`, the parent-dir trick and
 * the onnx-file scan.
 *
 * The model files live under `<exeDir>/resources/models/<name>/` in
 * packaged builds (e.g. `models/bert-base-chinese-ner/`) and are
 * downloaded through `/api/settings/ner/download` from the HuggingFace
 * Hub. The factory deliberately never reaches the network — it
 * insists on `local_files_only: true` so a missing model produces a
 * clear "model not found" error instead of silently fetching.
 *
 * Public surface:
 *   - `getLocalNerPipeline({ modelPath, maxTokens, aggregationStrategy })`
 *   - `disposeNerPipeline()` — drops the cached pipeline so the next
 *     call re-loads from disk (used after the operator switches models).
 *   - `getLoadedNerInfo()` — `{ modelPath, maxTokens }` of the live
 *     pipeline or `null`.
 */
// Plan B + dev/QA bypass: this module used to `import * as` the
// transformers package at module-init time, which meant importing
// ANY symbol from ner-pipeline-factory (even just `getLoadedNerInfo`
// for the Web UI's status pill) would trigger the entire
// @xenova/transformers → sharp → color → simple-swizzle → is-arrayish
// → @napi-rs/canvas → @napi-rs/canvas-win32-x64-msvc load chain.
// If any of those transitive deps is missing from the SEA bundle's
// native-cache, the entire backend refuses to start — even though
// the user might just want to disable NER (SAG_SKIP_NER_CHECK=1) and
// keep using regex extraction for the session.
//
// Fix: load transformers lazily via `createRequire(import.meta.url)`
// inside `getLocalNerPipeline()`. The static `import *` is replaced
// with a getter; the package is only required when something
// actually wants to run inference. We keep `createRequire` (which
// already exists in this file) so we don't introduce a new way to
// load ESM that's incompatible with the SEA bundle's vm-context.
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  resolveLocalModelPath,
  pickBestOnnxFile
} from "./model-path-resolver.js";

// @xenova/transformers' full type surface is heavy and the bundle
// re-exports it through `pipeline(...)`. We narrow to the shape we
// actually use so the compiler can validate call sites.
interface TransformersShape {
  pipeline: (...args: unknown[]) => Promise<unknown>;
  env: Record<string, unknown>;
}

let _transformersCache: TransformersShape | null = null;
function loadTransformers(): TransformersShape {
  if (!_transformersCache) {
    const req = createRequire(import.meta.url);
    _transformersCache = req("@xenova/transformers") as TransformersShape;
  }
  return _transformersCache;
}

/** A single token-classification result returned by the pipeline. */
export interface NerTokenResult {
  entity: string;        // BIO tag, e.g. "B-PER", "I-LOC", "O"
  word: string;          // the matched subword/word (may include leading "##")
  start: number;         // character offset of the match
  end: number;           // character offset of the match (exclusive)
  score: number;         // 0..1 model confidence
}

/** Aggregation strategies supported by @xenova/transformers' token-classification pipeline. */
export type NerAggregationStrategy = "none" | "simple" | "first" | "average" | "max";

export interface NerConfig {
  /**
   * Relative path ("models/bert-base-chinese-ner") or absolute path
   * to the model directory. Resolved by `resolveLocalModelPath()` so
   * it must contain `tokenizer.json` + `onnx/*.onnx`.
   */
  modelPath: string;
  /**
   * Maximum number of tokens to feed the model. The factory forwards
   * this as `max_length`/`truncation` so a chunk longer than this is
   * cut off rather than throwing. Default 512 to align with the
   * chunking pipeline's default token budget.
   */
  maxTokens?: number;
  /**
   * Aggregation strategy for subword merging. "simple" (the default)
   * merges B-/I- tagged subwords into a single span; "none" returns
   * every subword as its own entry.
   */
  aggregationStrategy?: NerAggregationStrategy;
}

/** The pipeline shape we actually call. */
export type NerPipeline = (
  text: string,
  options?: {
    ignore_labels?: string[];
    max_length?: number;
    truncation?: boolean;
    /**
     * Override the cached aggregation strategy for this call only.
     * Default comes from `NerConfig.aggregationStrategy` baked at
     * pipeline creation. The /api/settings/ner/test route passes
     * `"none"` to get raw BMES tags; ingest passes nothing and gets
     * the cached `"simple"` (smoothed spans).
     */
    aggregation_strategy?: NerAggregationStrategy;
  }
) => Promise<NerTokenResult[]>;

/** Returned by `getLoadedNerInfo()` — reflects what is *currently loaded*. */
export interface LoadedNerInfo {
  modelPath: string;
  maxTokens: number;
  aggregationStrategy: NerAggregationStrategy;
}

let nerPipelinePromise: Promise<NerPipeline> | null = null;
let nerPipelineModelPath: string | null = null;
let nerPipelineConfig: { maxTokens: number; aggregationStrategy: NerAggregationStrategy } | null = null;

/**
 * Lazy-singleton getter. The first call loads the ONNX weights into
 * the process; subsequent calls with the same `modelPath` reuse the
 * in-memory pipeline. To switch models, call `disposeNerPipeline()`
 * (the `update*` settings routes do this automatically).
 */
export async function getLocalNerPipeline(config: NerConfig): Promise<NerPipeline> {
  const maxTokens = config.maxTokens ?? 512;
  const aggregationStrategy = config.aggregationStrategy ?? "simple";

  if (
    nerPipelinePromise &&
    nerPipelineModelPath === config.modelPath &&
    nerPipelineConfig &&
    nerPipelineConfig.maxTokens === maxTokens &&
    nerPipelineConfig.aggregationStrategy === aggregationStrategy
  ) {
    return nerPipelinePromise;
  }

  // Tear down any previously cached pipeline so a model switch actually
  // frees the old ONNX runtime state instead of leaking it.
  nerPipelinePromise = null;
  nerPipelineModelPath = null;
  nerPipelineConfig = null;

  nerPipelinePromise = (async () => {
    // The transformers package is loaded lazily here (see the header
    // comment on the lazy-loader) so this whole module can be imported
    // — even from code paths that never intend to run NER — without
    // dragging sharp / color / @napi-rs/canvas into the process at
    // boot. Without this guard the SEA bundle crashes whenever a
    // transitive dep is missing.
    const transformers = loadTransformers();
    const createPipeline = transformers.pipeline.bind(transformers);
    const env = transformers.env as unknown as {
      allowRemoteModels: boolean;
      allowLocalModels: boolean;
      localModelPath: string;
      version?: string;
      wasm?: { wasmPaths?: string; proxy?: boolean };
    };
    env.allowRemoteModels = false;
    env.allowLocalModels = true;

    // See embedding-client.ts:617-643 for the rationale on parentDir +
    // basename: @xenova/transformers' pathJoin breaks on Windows when
    // given an absolute modelPath because it concatenates "<envDir>/"
    // + "D:\..." literally.
    const absoluteModelPath = resolveLocalModelPath(config.modelPath);
    const basename = path.basename(absoluteModelPath);
    const parentDir = path.dirname(absoluteModelPath);
    env.localModelPath = parentDir.replace(/\\/g, "/");

    // P29 fix (real root cause): the SEA bundle marks
    // `onnxruntime-node` as an esbuild external/ignored, so at
    // runtime transformers falls back to `onnxruntime-web` (WASM),
    // not the native binding. WASM files (`ort-wasm*.wasm`) live next
    // to `transformers.min.js` under `dist/`, but
    // `transformers.min.js`'s baked `__dirname` points at the
    // webpack build environment
    // (`/home/runner/work/transformers.js/transformers.js/`). The
    // default `env.backends.onnx.wasm.wasmPaths` is therefore
    // "https://cdn.jsdelivr.net/.../dist/" (browser fallback) — which
    // means the runtime tries to fetch WASM from the CDN, fails
    // silently, and the tokenizer produces degenerate "?" tokens for
    // every input (model loads but every decode returns "?").
    //
    // Fix: locate the real `dist/` directory next to
    // `transformers.min.js` in the unpacked native-cache tree, then
    // point `wasm.wasmPaths` at it. We do this by resolving
    // `@xenova/transformers/package.json` through the same module
    // resolution the rest of the bundle uses, then walking
    // "<package>/dist/" — which is exactly where the four
    // `ort-wasm*.wasm` files were staged by build-sea-bundle.mjs.
    // pickBestOnnxFile() is also called for parity with the
    // embedding-client helper, even though the factory ultimately
    // hands `model_file_name: "model"` to the loader (HF naming
    // convention: `model_quantized.onnx` is what gets loaded).
    pickBestOnnxFile(absoluteModelPath);

    // Resolve the on-disk path to @xenova/transformers via
    // require.resolve — this works inside the SEA bundle because
    // require() falls through to the staged native-cache tree
    // (Module._resolveFilename is patched by sag.entry.cjs).
    const tfPkgJsonPath = createRequire(import.meta.url).resolve(
      "@xenova/transformers/package.json"
    );
    const tfPkgDir = path.dirname(tfPkgJsonPath);
    const tfDistDir = path.join(tfPkgDir, "dist");

    if ((env as any).backends?.onnx?.wasm) {
      // Set wasmPaths to a directory containing the WASM files
      // (the loader appends "ort-wasm-simd-threaded.wasm" etc.).
      // Trailing slash matters: ORT treats wasmPaths as a URL prefix.
      (env as any).backends.onnx.wasm.wasmPaths = tfDistDir.replace(/\\/g, "/") + "/";
      (env as any).backends.onnx.wasm.proxy = false;
    }

    // HuggingFace file naming convention: the quantized .onnx is
    // named `model_quantized.onnx`. With `quantized: true` the loader
    // appends `_quantized` to the fileName, so passing just `"model"`
    // resolves to `onnx/model_quantized.onnx`.
    const onnxFileName = "model";

    const pipeline = await createPipeline("token-classification", basename, {
      quantized: true,
      model_file_name: onnxFileName,
      local_files_only: true
    });

    // Bake aggregation strategy into a closure so every call site gets
    // the same behaviour without remembering to pass `aggregation_strategy`
    // each time. The wrapper only applies the cached `aggregationStrategy`
    // when the caller doesn't explicitly override it — that way the
    // /api/settings/ner/test route can request "none" (raw BMES tags)
    // while the ingest path keeps "simple" (smoothed spans).
    const configSnapshot = { maxTokens, aggregationStrategy };
    const typed = pipeline as unknown as (
      text: string,
      options?: Record<string, unknown>
    ) => Promise<NerTokenResult[]>;
    const wrapper: NerPipeline = async (text, options) => {
      const merged = {
        aggregation_strategy:
          options?.aggregation_strategy ?? configSnapshot.aggregationStrategy,
        max_length: options?.max_length ?? configSnapshot.maxTokens,
        truncation: options?.truncation ?? true,
        ignore_labels: options?.ignore_labels ?? ["O"]
      };
      return await typed(text, merged);
    };

    return wrapper;
  })();

  nerPipelineModelPath = config.modelPath;
  nerPipelineConfig = { maxTokens, aggregationStrategy };
  try {
    return await nerPipelinePromise;
  } catch (err) {
    // Reset the cache so the next call retries instead of handing out
    // a rejected promise. (Same pattern as embedding-client.ts:680.)
    nerPipelinePromise = null;
    nerPipelineModelPath = null;
    nerPipelineConfig = null;
    throw err;
  }
}

/**
 * Drop the cached pipeline. Called by settings update routes after
 * the operator switches to a different model — without this, the
 * old model would stay loaded and the new one would never be
 * instantiated.
 */
export async function disposeNerPipeline(): Promise<void> {
  nerPipelinePromise = null;
  nerPipelineModelPath = null;
  nerPipelineConfig = null;
}

/**
 * Returns `{ modelPath, maxTokens, aggregationStrategy }` for the
 * currently loaded pipeline, or `null` when nothing is loaded yet.
 * Mirrors `getLoadedLocalLlmInfo()` in local-llm-client.ts so the
 * settings UI can show "preheat" vs "reload" vs the success tick.
 */
export function getLoadedNerInfo(): LoadedNerInfo | null {
  if (!nerPipelineModelPath || !nerPipelineConfig) return null;
  return {
    modelPath: nerPipelineModelPath,
    maxTokens: nerPipelineConfig.maxTokens,
    aggregationStrategy: nerPipelineConfig.aggregationStrategy
  };
}
