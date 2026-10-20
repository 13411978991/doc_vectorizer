
import path from "node:path";
import { statSync } from "node:fs";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { normalizeVector } from "../db/vector.js";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getRuntimePerformanceSettings } from "../services/performance-settings-service.js";
import { createModelCallLogger } from "../observability/model-call-log.js";

// Helper: build an AbortSignal that fires after the live embedding timeout
// (read from performance-settings-service, with env fallback) with a
// tagged reason so downstream errors say "embedding request aborted:
// timed out after Xms" instead of the generic "This operation was
// aborted". TypeScript's bundled lib.dom declares
// AbortSignal.timeout(ms, reason) as 1-arg, but Node 18+ accepts the
// reason and we want the runtime behaviour even if our types don't
// match. Wrap manually so the call type-checks.
function createEmbeddingTimeoutSignal(): AbortSignal {
  const controller = new AbortController();
  const timeoutMs = getRuntimePerformanceSettings().embeddingTimeoutMs;
  setTimeout(() => {
    controller.abort(
      new Error(`embedding request aborted: timed out after ${timeoutMs}ms`)
    );
  }, timeoutMs);
  return controller.signal;
}
// P35 (2026-10-20) — @xenova/transformers is loaded LAZILY, not at
// module top level. The previous static `import * as _transformersPkg`
// sat on the watcher/ingest static import chain, so every backend boot
// evaluated @xenova/transformers → onnxruntime-node →
// process.dlopen(onnxruntime_binding.node) BEFORE index.ts could
// install its uncaughtException handlers. On a machine where the
// native binding can't load (fresh Windows without the VC++ 2015-2022
// x64 runtime — "The specified module could not be found" — or a
// DLP/AV client blocking the unsigned .node), the backend crashed at
// boot with ERR_DLOPEN_FAILED and exit 1. Field report 2026-10-20:
// exactly that on an audit-department terminal.
//
// The lazy loader below defers the require until something actually
// wants a local BGE pipeline/tokenizer. A load failure is cached and
// re-thrown as an actionable error (install vc_redist / switch
// embedding provider) at ingest/test-connection time instead of
// taking the whole backend down. This mirrors the pattern in
// ner-pipeline-factory.ts (which went lazy for the same reason).
import { createRequire } from "node:module";
import {
  resolveLocalModelPath as sharedResolveLocalModelPath,
  pickBestOnnxFile as sharedPickBestOnnxFile
} from "./model-path-resolver.js";

interface TransformersShape {
  pipeline: (...args: unknown[]) => Promise<unknown>;
  env: Record<string, unknown>;
  AutoTokenizer: {
    from_pretrained: (id: string, opts: Record<string, unknown>) => Promise<TokenizerLike>;
  };
}

let _transformersCache: TransformersShape | null = null;
let _transformersLoadError: Error | null = null;

// Install the same onnxruntime session patch as embedding-worker.ts.
// The in-process fallback (`localBgeEmbeddingInProcess`) hits the
// same InferenceSession.create() call, so without this patch a
// worker-thread crash followed by an in-process retry still OOMs.
// See embedding-worker.ts for the full rationale on why this is
// needed and why we have to patch the onnxruntime-node module
// directly (transformers v2.17.2 does not re-export it). Runs once,
// right after the lazy require succeeds — still before any
// InferenceSession is created in this process.
function installOnnxSessionPatch(req: NodeRequire): void {
  // Same dual-context patch as embedding-worker.ts — see that
  // file for why a bare require() is not enough (require.cache
  // is keyed by resolved filename and transformers' internal
  // require can land on a different copy).
  const candidatePaths: string[] = [];
  try {
    const txMain = req.resolve("@xenova/transformers");
    candidatePaths.push(
      req.resolve("onnxruntime-node", { paths: [path.dirname(txMain)] })
    );
  } catch { /* fall through */ }
  try {
    candidatePaths.push(req.resolve("onnxruntime-node"));
  } catch { /* fall through */ }
  const seen = new Set<string>();
  for (const ortPath of candidatePaths) {
    if (seen.has(ortPath)) continue;
    seen.add(ortPath);
    try {
      const ortNs = req(ortPath) as {
        InferenceSession?: { create?: unknown };
      };
      const Create = ortNs?.InferenceSession?.create;
      if (!Create || typeof Create !== "function") continue;
      if ((Create as { __sagPatched?: boolean }).__sagPatched) continue;
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
          executionProviders: opts?.executionProviders ?? ["cpu"]
        });
      };
      (patched as { __sagPatched?: boolean }).__sagPatched = true;
      ortNs.InferenceSession!.create = patched;
    } catch { /* best-effort per instance */ }
  }
}

function loadTransformers(): TransformersShape {
  if (_transformersCache) return _transformersCache;
  // Fail fast on repeat calls: a broken native binding stays broken
  // for the process lifetime (installing vc_redist requires a backend
  // restart anyway), so don't pay the dlopen attempt per embed batch.
  if (_transformersLoadError) throw _transformersLoadError;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("@xenova/transformers") as TransformersShape;
    installOnnxSessionPatch(req as unknown as NodeRequire);
    _transformersCache = pkg;
    return pkg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const enriched = new Error(
      `local-bge: cannot load @xenova/transformers / onnxruntime-node — ${msg}. ` +
      `Local ONNX embedding is unavailable on this machine. The most common ` +
      `cause on a fresh Windows install is a missing "Microsoft Visual C++ ` +
      `2015-2022 x64 Redistributable" (onnxruntime.dll needs vcruntime140.dll ` +
      `and msvcp140.dll): install vc_redist.x64 and restart SAG. If it is ` +
      `already installed, check whether the DLP/AV client blocked the native ` +
      `module load, or verify resources/native-cache/**/onnxruntime-node/bin/ ` +
      `contains onnxruntime.dll next to onnxruntime_binding.node. Meanwhile ` +
      `you can switch Settings → Embedding to a remote (api) provider.`
    );
    (enriched as { cause?: unknown }).cause = err;
    _transformersLoadError = enriched;
    logger.error(
      { err: msg },
      "local-bge: onnxruntime/transformers load failed — local embedding " +
      "disabled for this process (backend keeps running; see error for fix)"
    );
    throw enriched;
  }
}

/** Diagnostic for settings/status routes: the cached lazy-load failure, if any. */
export function getLocalEmbeddingLoadError(): string | null {
  return _transformersLoadError ? _transformersLoadError.message : null;
}

export interface EmbeddingClient {
  generate(text: string): Promise<number[]>;
  batchGenerate(texts: string[]): Promise<number[][]>;
  /**
   * Probe the configured embedding endpoint with a tiny input and
   * return a structured result. Used by /api/test-connection and by the
   * watcher preflight before it opts into per-file ingest. Never
   * throws — failures are returned as `{ ok: false, error }` so callers
   * can show a one-line UI message instead of a stack trace.
   */
  testConnection(): Promise<{
    ok: boolean;
    provider: string;
    baseUrl: string;
    model: string;
    dimensions: number;
    latencyMs: number;
    error?: string;
    httpStatus?: number;
  }>;
}

export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  async generate(text: string): Promise<number[]> {
    const [embedding] = await this.batchGenerate([text]);
    return embedding;
  }

  /**
   * Conservative per-batch input budget. Different embedding endpoints
   * have different context windows (popular public models range from
   * 2k to 32k tokens); we use 2000 as a safe common value regardless
   * of the configured model. The estimate is by `length/2` (roughly
   * 2 chars per token for English; CJK is denser but our chunks are
   * mixed-language and the budget is generous).
   */
  private static readonly BATCH_TOKEN_BUDGET = 2000;

  /**
   * Split `texts` into chunks whose estimated total input token count is
   * under the budget. Single strings longer than the budget are still
   * emitted as their own (oversized) batch — the upstream chunker is
   * responsible for keeping individual chunks small.
   */
  private splitIntoBatches(texts: string[]): string[][] {
    const batches: string[][] = [];
    let current: string[] = [];
    let currentTokens = 0;
    for (const text of texts) {
      const tokens = Math.ceil(text.length / 2);
      // If a single chunk exceeds the budget, ship it alone. The
      // chunking layer above us is supposed to cap per-chunk tokens;
      // we don't try to split further here because doing so would lose
      // semantic structure.
      if (current.length > 0 && currentTokens + tokens > OpenAICompatibleEmbeddingClient.BATCH_TOKEN_BUDGET) {
        batches.push(current);
        current = [];
        currentTokens = 0;
      }
      current.push(text);
      currentTokens += tokens;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  async batchGenerate(texts: string[]): Promise<number[][]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    // Provider routing:
    //   - "local-bge" → load the user-supplied ONNX model and run
    //     real semantic embeddings.
    //   - "api"      → POST to a remote OpenAI-compatible endpoint.
    //
    // The historical "local" value used to point at a SHA256-hash
    // pseudo-embedding (4 distinct values, cosine=1 across chunks,
    // silently broke semantic search). It was removed 2026-10-13
    // so an operator can't hit that dogshit path by accident. The
    // settings-routes schema rejects "local" outright, and we throw
    // a clear error here as a backstop in case the DB row was
    // written before the schema change.
    if (settings.embeddingProvider === "local-bge") {
      if (!settings.embeddingLocalModelPath) {
        throw new Error(
          "embeddingProvider='local-bge' but embeddingLocalModelPath is empty — " +
            "set a model directory in the AI Provider settings."
        );
      }
      const localTimer = Date.now();
      const out = await localBgeEmbedding(settings.embeddingLocalModelPath, texts, settings.embeddingDimensions);
      const localMs = Date.now() - localTimer;
      logger.info(
        {
          stage: "embedding-per-text",
          provider: "local-bge",
          texts: texts.length,
          totalMs: localMs,
          perTextMs: texts.length > 0 ? localMs / texts.length : 0,
          msg: "embedding batch"
        },
        "embedding batch"
      );
      return out;
    }
    if (settings.embeddingProvider !== "api") {
      // Backstop: if the DB somehow carries a legacy "local" value
      // that the schema would have rejected on the next PUT, fail
      // loudly here so the operator can see "no embedding was
      // computed" instead of silently writing hash junk.
      throw new Error(
        `embeddingProvider='${settings.embeddingProvider}' is no longer supported. ` +
          `Pick 'api' (remote OpenAI-compatible) or 'local-bge' (local ONNX BGE) in the AI Provider settings.`
      );
    }

    // Split the texts into sub-batches sized to fit any embedding model's
    // context window. Without this, a 30-chunk ingest for a long document
    // would hit the API with a single 30*512-token payload and get a 400.
    const batches = this.splitIntoBatches(texts);
    // Run the sub-batches with bounded concurrency so the remote API
    // gets parallelism (one file with 10 chunks/3 batches each used
    // to take 10x a single round-trip; now ~3-4x). Concurrency is
    // EMBEDDING_BATCH_CONCURRENCY (default 3) so we don't blow past
    // the embedding provider's rate limit.
    const batchTimers: number[] = [];
    const out: number[][][] = [];
    const totalStart = Date.now();
    const concurrency = Math.max(1, getRuntimePerformanceSettings().embeddingBatchConcurrency);
    if (batches.length <= 1 || concurrency === 1) {
      for (let i = 0; i < batches.length; i++) {
        const t = Date.now();
        out[i] = await this.embedOneBatch(batches[i], settings);
        batchTimers.push(Date.now() - t);
      }
    } else {
      // Bounded-parallel: at most `concurrency` in flight at a time.
      // Pre-allocate by input slot so the caller's chunks end up in
      // their original order regardless of which batch finished first.
      let next = 0;
      const workers: Array<Promise<void>> = [];
      for (let w = 0; w < Math.min(concurrency, batches.length); w++) {
        workers.push((async () => {
          while (true) {
            const myIdx = next++;
            if (myIdx >= batches.length) return;
            const t = Date.now();
            out[myIdx] = await this.embedOneBatch(batches[myIdx], settings);
            batchTimers[myIdx] = Date.now() - t;
          }
        })());
      }
      await Promise.all(workers);
    }
    const totalMs = Date.now() - totalStart;
    const totalTexts = texts.length;
    const maxBatchMs = batchTimers.length > 0 ? Math.max(...batchTimers) : 0;
    logger.info(
      {
        stage: "embedding-per-text",
        provider: "api",
        texts: totalTexts,
        batches: batches.length,
        batchConcurrency: concurrency,
        totalMs,
        maxBatchMs,
        perTextMs: totalTexts > 0 ? totalMs / totalTexts : 0,
        msg: "embedding batch"
      },
      "embedding batch"
    );
    return out.flat();
  }

  private async embedOneBatch(
    texts: string[],
    settings: { embeddingBaseUrl: string; embeddingModel: string; embeddingDimensions: number; embeddingApiKey: string }
  ): Promise<number[][]> {
    const url = `${settings.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`;
    // Two body shapes are needed depending on the endpoint:
    // - OpenAI-compatible (302ai, openai.com) wants { input: [], dimensions }
    // - MiniMax (api.minimax.chat) wants { texts: [], type: "db" } and
    //   ignores the dimensions parameter (it always returns 1536-d).
    const isMiniMax = /minimax|minimaxi/i.test(settings.embeddingBaseUrl);
    const body = isMiniMax
      ? { model: settings.embeddingModel, type: "db", texts }
      : { model: settings.embeddingModel, input: texts, dimensions: settings.embeddingDimensions };
    const log = createModelCallLogger({
      kind: "embedding",
      operation: "batchGenerate",
      request: {
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body
      }
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.embeddingApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      // Bound the wall-clock cost of a misbehaving embedding endpoint
      // (DNS hang, slow 401, etc.) so a single bad call can't stall the
      // Node main thread indefinitely. EMBEDDING_TIMEOUT_MS defaults
      // to 10 s; previous behavior was no timeout at all. We tag the
      // abort with a clear reason so the error's name + message point
      // straight at the timeout (instead of the generic "This operation
      // was aborted" that hides which stage timed out).
      signal: createEmbeddingTimeoutSignal()
    });
    const { responseText, responseBody } = await readResponseBody(response);

    if (!response.ok) {
      // P-Secrets — cap the embedded response body before it goes into
      // an Error message that the logger will print. A 5xx from the
      // embedding provider sometimes echoes the request's API key in
      // the response body (e.g. {"error":"invalid key sk-3pJ..."}); we
      // cap to 200 chars and rely on the pino redact paths to strip
      // the secret before the line lands in the log file.
      const safeBody = responseText.slice(0, 200);
      const error = new Error(`embedding request failed: ${response.status} ${safeBody}`);
      log.fail(error, {
        status: response.status,
        body: responseBody
      });
      throw error;
    }

    const json = responseBody as {
      data?: Array<{ embedding?: number[] }>;
      vectors?: number[][];  // MiniMax / 302ai alternative shape
    };
    const embeddings = (json.data?.map((item) => item.embedding ?? [])) ?? json.vectors ?? [];
    if (embeddings.length !== texts.length) {
      const error = new Error(`embedding count mismatch: expected=${texts.length}, actual=${embeddings.length}`);
      log.fail(error, {
        status: response.status,
        body: responseBody
      });
      throw error;
    }
    for (const embedding of embeddings) {
      if (embedding.length !== settings.embeddingDimensions) {
        const error = new Error(`embedding dimension mismatch: expected=${settings.embeddingDimensions}, actual=${embedding.length}`);
        log.fail(error, {
          status: response.status,
          body: responseBody
        });
        throw error;
      }
    }
    log.succeed({
      status: response.status,
      body: responseBody
    });
    return embeddings;
  }

  /**
   * Single-shot probe against the configured endpoint. Returns a
   * structured record rather than throwing so the HTTP route / watcher
   * preflight can convert it directly into a JSON response or log line.
   * Times out after EMBEDDING_TIMEOUT_MS so a hung endpoint can't block
   * a watcher start indefinitely.
   */
  async testConnection(): Promise<{
    ok: boolean;
    provider: string;
    baseUrl: string;
    model: string;
    dimensions: number;
    latencyMs: number;
    error?: string;
    httpStatus?: number;
  }> {
    const started = Date.now();
    const settings = await aiSettingsService.getRuntimeSettings();
    const probeText = "sag health probe";
    // "local" provider (SHA256 pseudo-embedding) is no longer
    // supported — the schema rejects it and batchGenerate() throws
    // if it somehow lands in the DB. The probe must mirror that
    // contract so the UI can't show a false "ready" badge for a
    // misconfigured install.
    if (settings.embeddingProvider !== "api" && settings.embeddingProvider !== "local-bge") {
      return {
        ok: false,
        provider: settings.embeddingProvider,
        baseUrl: "(none)",
        model: "(none)",
        dimensions: 0,
        latencyMs: Date.now() - started,
        error: `embeddingProvider='${settings.embeddingProvider}' is no longer supported. Pick 'api' or 'local-bge'.`
      };
    }
    // For the local-bge provider we just verify the model file exists
    // and that we can run the embedding once. For the remote provider
    // we exercise the same /embeddings path batchGenerate uses.
    if (settings.embeddingProvider === "local-bge") {
      if (!settings.embeddingLocalModelPath) {
        return {
          ok: false,
          provider: "local-bge",
          baseUrl: "(local)",
          model: "(empty)",
          dimensions: 0,
          latencyMs: Date.now() - started,
          error: "embeddingLocalModelPath is empty — set a model directory in the AI Provider settings."
        };
      }
      try {
        const out = await localBgeEmbedding(
          settings.embeddingLocalModelPath,
          [probeText],
          settings.embeddingDimensions
        );
        const dims = out[0]?.length ?? 0;
        return {
          ok: dims === settings.embeddingDimensions,
          provider: "local-bge",
          baseUrl: "(local)",
          model: settings.embeddingLocalModelPath,
          dimensions: dims,
          latencyMs: Date.now() - started,
          ...(dims !== settings.embeddingDimensions
            ? { error: `dimension mismatch (got ${dims}, want ${settings.embeddingDimensions})` }
            : {})
        };
      } catch (e) {
        return {
          ok: false,
          provider: "local-bge",
          baseUrl: "(local)",
          model: settings.embeddingLocalModelPath,
          dimensions: 0,
          latencyMs: Date.now() - started,
          error: (e as Error).message
        };
      }
    }
    // Guard against an empty / malformed base URL before we hand a
    // relative path to fetch() — otherwise Node throws "Failed to
    // parse URL from /embeddings" with no actionable hint. We've
    // shipped at least one incident where the migration that clears
    // defaults left `embedding_provider='api'` but
    // `embedding_base_url=''`; the user clicked "测试连接" expecting
    // a real probe and got a useless error.
    const baseUrl = settings.embeddingBaseUrl?.trim() ?? "";
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      return {
        ok: false,
        provider: "api",
        baseUrl: baseUrl || "(empty)",
        model: settings.embeddingModel,
        dimensions: settings.embeddingDimensions,
        latencyMs: Date.now() - started,
        error: "embedding base URL is not configured (set it in Settings → AI 端点)"
      };
    }
    const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;
    const isMiniMax = /minimax|minimaxi/i.test(baseUrl);
    const body = isMiniMax
      ? { model: settings.embeddingModel, type: "db", texts: [probeText] }
      : { model: settings.embeddingModel, input: [probeText], dimensions: settings.embeddingDimensions };
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.embeddingApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: createEmbeddingTimeoutSignal()
      });
      const { responseText } = await readResponseBody(response);
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          provider: "api",
          baseUrl: settings.embeddingBaseUrl,
          model: settings.embeddingModel,
          dimensions: settings.embeddingDimensions,
          latencyMs,
          httpStatus: response.status,
          // P-Secrets — cap to 200 chars; the pino redact config in
          // observability/logger.ts will strip any API key the
          // provider echoes in the 5xx body.
          error: responseText.slice(0, 200) || response.statusText
        };
      }
      // Parse and confirm we got back an embedding of the right length.
      const parsed = parseJsonOrText(responseText) as
        | { data?: Array<{ embedding?: number[] }> }
        | { embeddings?: number[][] }
        | null;
      const vec =
        (parsed && "data" in parsed && parsed.data?.[0]?.embedding) ||
        (parsed && "embeddings" in parsed && parsed.embeddings?.[0]) ||
        null;
      if (!vec) {
        return {
          ok: false,
          provider: "api",
          baseUrl: settings.embeddingBaseUrl,
          model: settings.embeddingModel,
          dimensions: settings.embeddingDimensions,
          latencyMs,
          httpStatus: response.status,
          error: "response missing embedding vector"
        };
      }
      if (vec.length !== settings.embeddingDimensions) {
        return {
          ok: false,
          provider: "api",
          baseUrl: settings.embeddingBaseUrl,
          model: settings.embeddingModel,
          dimensions: vec.length,
          latencyMs,
          httpStatus: response.status,
          error: `dimension mismatch (got ${vec.length}, want ${settings.embeddingDimensions})`
        };
      }
      return {
        ok: true,
        provider: "api",
        baseUrl: settings.embeddingBaseUrl,
        model: settings.embeddingModel,
        dimensions: vec.length,
        latencyMs
      };
    } catch (e) {
      return {
        ok: false,
        provider: "api",
        baseUrl: settings.embeddingBaseUrl,
        model: settings.embeddingModel,
        dimensions: settings.embeddingDimensions,
        latencyMs: Date.now() - started,
        error: (e as Error).message
      };
    }
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}



export const embeddingClient = new OpenAICompatibleEmbeddingClient();

/**
 * Load a Xenova/transformers BGE ONNX model from a local directory. The
 * expected layout is the standard HuggingFace export shape:
 *
 *   <modelPath>/config.json
 *   <modelPath>/tokenizer.json
 *   <modelPath>/tokenizer_config.json
 *   <modelPath>/special_tokens_map.json
 *   <modelPath>/vocab.txt
 *   <modelPath>/onnx/model_int8.onnx   (preferred) or model_quantized.onnx
 *
 * For example, download `Xenova/bge-large-zh-v1.5` once via
 *   HF_ENDPOINT=https://hf-mirror.com hf download Xenova/bge-large-zh-v1.5 \
 *     --local-dir <modelPath>
 * and set `embeddingLocalModelPath` to that directory.
 *
 * Pooling follows BGE's official guidance: CLS token + L2 normalize.
 *
 * The pipeline is cached at module scope so repeated calls reuse the
 * loaded weights — first call is slow (a few seconds), subsequent are
 * per-text forward passes only.
 */
type FeatureExtractionPipeline = (
  text: string,
  options?: {
    pooling?: "none" | "mean" | "cls";
    normalize?: boolean;
    truncation?: boolean;
    max_length?: number;
  }
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineModelPath: string | null = null;
let tokenizerPromise: Promise<TokenizerLike> | null = null;

type TokenizerLike = {
  encode: (
    text: string,
    text_pair?: string | null,
    options?: Record<string, unknown>
  ) => Promise<number[]>;
};

/**
 * Resolve a BGE model directory path against the production layout.
 *
 * The web UI ships model paths from the catalog as relative strings
 * like `models/bge-large-zh-v1.5`. Plain `path.resolve()` anchors at
 * `process.cwd()`, which inside the Electron-launched SEA exe is
 * `<release-desktop>/win-unpacked/`, but the models are actually
 * staged under `resources/models/` next to the exe. So we try, in
 * order:
 *   1. Absolute path (operator hand-edited a custom location).
 *   2. `<exeDir>/resources/<modelPath>` — the SEA production layout.
 *   3. `<exeDir>/<modelPath>` — dev / out-of-tree layout.
 *   4. `<cwd>/<modelPath>` — legacy fallback for `npm run` scripts
 *      and unit tests.
 *
 * The first candidate that exists AND is a directory wins. If none
 * match, we throw with a clear "model not found" message that lists
 * every path we tried so the user can re-download from Settings.
 */
function resolveLocalModelPath(modelPath: string): string {
  return sharedResolveLocalModelPath(modelPath);
}

/**
 * BGE-specific onnx-file scorer — quantised variants get a much
 * bigger boost than the generic helper because BGE-large is large
 * enough that fp32 will OOM on consumer laptops.
 *
 * Higher score wins. The ranking heuristics:
 *   - quantised variants score over fp32 (consumer-GPU friendly)
 *   - shorter basenames score over longer ones when both quantised
 *     variants exist (model_int8 over model_int8_optimized)
 *   - fp32 / no-quantized fall back as the last resort
 */
function scoreOnnxFile(filename: string): number {
  const stem = filename.replace(/\.onnx$/, "").toLowerCase();
  // Quantised variants get a big boost.
  if (/(int8|uint8|q4|q8|quantized|quantised|quant)/.test(stem)) {
    return 1000 - stem.length;
  }
  if (/(fp16|fp32|float)/.test(stem)) {
    return 100 - stem.length;
  }
  return 1;
}

async function getLocalBgePipeline(modelPath: string): Promise<FeatureExtractionPipeline> {
  if (pipelinePromise && pipelineModelPath === modelPath) {
    return pipelinePromise;
  }
  pipelinePromise = (async () => {
    // P35: lazy require via loadTransformers() — a machine whose
    // onnxruntime native binding can't load gets an actionable error
    // here instead of a boot-time crash. (`await import(...)` is still
    // avoided — it triggers "A dynamic import callback was not
    // specified" inside the SEA bundle.)
    const transformers = loadTransformers();
    const createPipeline = transformers.pipeline.bind(transformers);
    const env = transformers.env as { allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string };
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // @xenova/transformers' internal pathJoin does plain string concat
    // with `parts.join('/')`. If we leave `env.localModelPath` at its
    // default ("<__dirname>/models/") and pass an absolute modelPath like
    // "D:\SAG-models\bge-large-zh-v1.5", the joined result becomes
    // "<__dirname>/models/D:\SAG-models\bge-large-zh-v1.5/tokenizer.json"
    // which Node's fs layer can't open. Likewise the Linux-style trick of
    // setting `env.localModelPath = "/"` gives "/D:/SAG-models/..." which
    // Windows reads as drive-relative + absolute → "D:\D:\...".
    //
    // The robust fix is to point `env.localModelPath` at the model
    // directory's parent and pass only the basename to `pipeline()`. That
    // way pathJoin produces e.g. "D:/SAG-models/bge-large-zh-v1.5/..."
    // which Node's fs layer opens correctly on every platform.
    // Use the top-level static `path` import (not `await import(...)`)
    // — SEA's vm-context requires a callback for dynamic imports.
    const absoluteModelPath = resolveLocalModelPath(modelPath);
    const basename = path.basename(absoluteModelPath);
    const parentDir = path.dirname(absoluteModelPath);
    env.localModelPath = parentDir.replace(/\\/g, "/");
    const relativeModelPath = basename;
    // Discover whichever .onnx weight file actually exists in
    // `<model>/onnx/` rather than baking in a specific filename.
    // BGE-specific scoring: prefer quantised variants over fp32 because
    // the BGE-large weights are large enough that fp32 will OOM on
    // consumer laptops. sharedPickBestOnnxFile() in model-path-resolver
    // has the same shape but no quantised bias — see that helper for
    // the NER scoring path.
    const fsPromises = await import("node:fs/promises");
    let onnxFileName: string | undefined;
    try {
      const onnxDir = path.join(parentDir, basename, "onnx");
      const files = await fsPromises.readdir(onnxDir);
      const onnxFiles = files.filter((f) => f.endsWith(".onnx"));
      if (onnxFiles.length > 0) {
        onnxFileName = onnxFiles.sort((a, b) => scoreOnnxFile(b) - scoreOnnxFile(a))[0]
          .replace(/\.onnx$/, "");
      }
    } catch {
      /* directory unreadable; let createPipeline fail with the standard error */
    }
    const extractor = await createPipeline("feature-extraction", relativeModelPath, {
      quantized: false,
      model_file_name: onnxFileName ?? "model_int8",
      local_files_only: true
      // NOTE: same as embedding-worker.ts — transformers v2.17.2
      // ignores `session_options` here. The actual onnxruntime
      // config change comes from the monkey-patch at the top of
      // this file, which wraps InferenceSession.create to inject
      // enableCpuMemArena: false.
    });
    return extractor as unknown as FeatureExtractionPipeline;
  })();
  pipelineModelPath = modelPath;
  try {
    return await pipelinePromise;
  } catch (err) {
    pipelinePromise = null;
    pipelineModelPath = null;
    throw err;
  }
}

async function getLocalBgeTokenizer(modelPath: string): Promise<TokenizerLike> {
  if (tokenizerPromise) return tokenizerPromise;
  tokenizerPromise = (async () => {
    const transformers = loadTransformers();
    const createAutoTokenizer = transformers.AutoTokenizer;
    const absoluteModelPath = resolveLocalModelPath(modelPath);
    const parentDir = path.dirname(absoluteModelPath);
    const env = transformers.env as { allowLocalModels: boolean; localModelPath: string };
    env.allowLocalModels = true;
    env.localModelPath = parentDir.replace(/\\/g, "/");
    const basename = path.basename(absoluteModelPath);
    const tk = await createAutoTokenizer.from_pretrained(basename, {
      quantized: false,
      local_files_only: true
    });
    return tk;
  })().catch((err) => {
    tokenizerPromise = null;
    throw err;
  });
  return tokenizerPromise;
}

// BGE-large's max_position_embeddings = 512 tokens. Anything longer
// trips onnxruntime's "/embeddings/Add_1" broadcast assertion and
// crashes the whole Node process. The chunker is supposed to keep
// chunks under the limit, but LLM-extracted event.content can blow
// past it. We tokenise once per text and slice the original string
// at a character boundary that maps to ≤ MAX_TOKENS tokens.
const BGE_MAX_TOKENS = 510; // leave 2 tokens of headroom for [CLS] / [SEP]

async function truncateToTokenLimit(text: string, tokenizer: TokenizerLike): Promise<string> {
  // Fast path: very short strings don't need tokenisation. We use 500
  // chars as the cut-off because BGE-large's tokenizer sub-tokenises
  // CJK at roughly 1 char = 1 token (verified empirically against
  // bge-large-zh-v1.5: 800 chars of "中" = 800 tokens, far over the
  // 512 ceiling). So the fast path must stay ≤ 510 chars; we use
  // 500 to leave a small safety margin. Any longer string runs the
  // binary search below.
  if (text.length <= 500) return text;
  // transformers' PreTrainedTokenizer.encode(text, text_pair, options)
  // returns a plain `number[]` of token ids (the inner `input_ids`
  // array), not a wrapped `{ input_ids: ... }` object — see
  // node_modules/@xenova/transformers/src/tokenizers.js:2931.
  const encodeOptions = { add_special_tokens: false } as never;
  // Single fast measurement: tokenise the whole text once. If it fits,
  // we're done.
  const ids = await tokenizer.encode(text, null, encodeOptions);
  if (ids.length <= BGE_MAX_TOKENS) return text;
  // Estimate the worst-case char-per-token ratio from this single
  // pass and use it as the upper bound for binary search. CJK text is
  // densest (~1 char/token) so we multiply by 0.9 to stay safely
  // below — the binary search below guarantees ≤ BGE_MAX_TOKENS in
  // the final answer regardless.
  const ratio = text.length / ids.length;
  const upperChars = Math.min(text.length, Math.ceil(BGE_MAX_TOKENS * ratio * 0.9));
  // Binary search for the largest char prefix that tokenises to ≤
  // BGE_MAX_TOKENS. O(log n) iterations, each tokenising a small
  // substring. Converges in at most ~20 passes for any realistic
  // input (text.length up to 10^9 chars). The old implementation only
  // iterated 4 times with 20% shrinks, which left very long CJK
  // inputs at ~2700 tokens — well over the 510-token BGE limit —
  // and the subsequent forward pass crashed onnxruntime.
  let lo = 1;
  let hi = Math.max(1, upperChars);
  let best = "";
  // Cache the encode call: adjacent iterations share most of the
  // prefix, so we re-encode only when the slice length changed by
  // enough to potentially flip the verdict.
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
  // If even a 1-char slice doesn't fit (extremely degenerate case
  // — empty text after strip, or a single token that's huge), return
  // the empty string. The caller falls back to a zero vector.
  return best.trimEnd();
}

/**
 * Embed a batch of texts using the local BGE ONNX model.
 *
 * Defensive: each input is truncated to ≤ BGE_MAX_TOKENS *before* reaching
 * onnxruntime, but ONNX can still occasionally throw a native
 * `Add_1` broadcast mismatch (e.g. axis=1 expected but got 604). That
 * crash propagates past normal try/catch — see `process.on('uncaughtException')`
 * in src/index.ts which keeps the service alive. Here we additionally wrap
 * each per-text call so a single bad chunk fails over to a per-piece
 * embedding (split at 510-token windows, mean-pooled) instead of taking
 * the whole batch down with it.
 */
/**
 * Deterministic offline embedding. Hashes the input text with SHA-256,
 * repeats the digest to fill the requested dimension, and maps each byte
 * to a float in [-1, 1]. Two identical inputs always produce the same
 * vector; two different inputs almost always differ in at least one
 * byte. The result has unit-ish magnitude but isn't normalised — callers
 * that compare distances should L2-normalise first.
 *
 * IMPORTANT: this function is no longer wired into batchGenerate().
 * It survives here only as a test-only escape hatch (see
 * src/test-setup.ts and tests that need a stable, deterministic
 * 1024-d vector without loading the BGE ONNX model). Production
 * embedding goes through 'api' or 'local-bge' exclusively — the
 * "local" provider was removed on 2026-10-13 because the SHA256
 * hash encoding has only 4 distinct value buckets per text length
 * and silently broke semantic search.
 */
function deterministicEmbedding(text: string, dimensions: number): number[] {
  const out = new Array<number>(dimensions);
  // crypto.hash is the Node 22+ synchronous hash. Fall back to
  // createHash for older runtimes.
  let cursor = 0;
  const dim = Math.max(1, dimensions | 0);
  // We seed by hashing `text` once, then we use the digest bytes to
  // fill slots modulo dim. To avoid uniform bias across the dim-axis
  // we mix the input string into the running buffer.
  const seedBytes = new Uint8Array(32);
  // Simple FNV-1a over utf-8 bytes; good enough for shape-only
  // pseudo-embeddings.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  for (let i = 0; i < 32; i++) {
    seedBytes[i] = (h ^ (h >>> ((i % 4) * 8))) & 0xff;
  }
  for (let i = 0; i < dim; i++) {
    const b = seedBytes[(i * 31) % 32];
    out[i] = (b / 127.5) - 1;
  }
  return out;
}

async function localBgeEmbedding(
  modelPath: string,
  texts: string[],
  dimensions: number
): Promise<number[][]> {
  if (texts.length === 0) return [];
  // Prefer the worker thread so ONNX forward passes don't block the
  // main event loop (HTTP server, watcher scan, etc.). If the worker
  // can't be spawned (e.g. during dev where the staged .cjs doesn't
  // exist), fall back to the in-process path so the API still works.
  try {
    const workerMod = await import("./embedding-worker-client.js");
    return await workerMod.localBgeEmbeddingViaWorker(modelPath, texts, dimensions);
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      "local-bge worker unavailable — falling back to in-process embedding"
    );
    return await localBgeEmbeddingInProcess(modelPath, texts, dimensions);
  }
}

/**
 * Exported wrapper so API routes (e.g. the settings local-model
 * 试运行 button) get the SAME worker-first behaviour as ingest.
 * The route previously called localBgeEmbeddingInProcess directly,
 * which meant a native ONNX crash (e.g. the truncated model file
 * that shipped before 2026-10-14, exit 0xC06D007F) killed the whole
 * backend process — desktop 闪退 — instead of being isolated to the
 * worker thread.
 */
export async function localBgeEmbeddingPreferWorker(
  modelPath: string,
  texts: string[],
  dimensions: number
): Promise<number[][]> {
  return localBgeEmbedding(modelPath, texts, dimensions);
}

/**
 * One-shot warmup of the embedding worker. Called from
 * `bootWatchedFolders` so the first embedding request doesn't pay
 * the ~5-15s ONNX pipeline load. Fire-and-forget: errors are
 * logged and the next call will retry.
 */
export async function warmupLocalBgeWorker(modelPath: string): Promise<void> {
  try {
    const workerMod = await import("./embedding-worker-client.js");
    await workerMod.preloadLocalBgeWorker(modelPath);
    logger.info({ modelPath }, "local-bge worker pre-warmed");
  } catch (err) {
    logger.warn(
      { modelPath, error: (err as Error).message },
      "local-bge worker pre-warm failed (will lazy-load on first embed call)"
    );
  }
}

export async function localBgeEmbeddingInProcess(
  modelPath: string,
  texts: string[],
  dimensions: number
): Promise<number[][]> {
  const extractor = await getLocalBgePipeline(modelPath);
  const tokenizer = await getLocalBgeTokenizer(modelPath);
  const results: number[][] = [];
  for (const text of texts) {
    const safeText = await truncateToTokenLimit(text, tokenizer);
    // Belt-and-braces: even after binary-search truncation, ONNX
    // can still blow up on malformed inputs. Catch here so a single
    // bad chunk doesn't take the whole batch (or the whole Node
    // process) down with it. Safe fallback: aggressive truncation
    // to a hard 200-char ceiling, which fits any BGE input.
    let tensor: Awaited<ReturnType<typeof extractor>> | null = null;
    try {
      tensor = await extractor(safeText, { pooling: "cls", normalize: true });
    } catch (err) {
      logger.warn(
        { textLength: text.length, error: (err as Error).message },
        "local-bge: extractor() threw on truncated input — retrying with aggressive 200-char cap"
      );
      try {
        tensor = await extractor(text.slice(0, 200), { pooling: "cls", normalize: true });
      } catch (err2) {
        logger.warn(
          { textLength: text.length, error: (err2 as Error).message },
          "local-bge: even 200-char retry failed — zero vector"
        );
      }
    }
    if (!tensor) {
      results.push(new Array<number>(dimensions).fill(0));
      continue;
    }
    try {
      const dims = tensor.dims;
      const expected = dims[dims.length - 1] ?? 0;
      if (expected !== dimensions) {
        throw new Error(
          `local-bge model output dim ${expected} does not match ` +
            `configured embeddingDimensions ${dimensions}. Pick a model whose ` +
            `hidden_size matches the DB schema (e.g. bge-large-zh-v1.5 for 1024).`
        );
      }
      results.push(Array.from(tensor.data));
    } catch (err) {
      // Per-piece fallback. ONNX can throw "Attempting to broadcast an axis
      // by a dimension other than 1" even after truncation when the input
      // is unusually shaped (e.g. zero-width after stripping, repeated
      // whitespace runs that tokenize oddly, etc.). We slice the input at
      // a safe character boundary, embed each slice independently, and
      // mean-pool the vectors so the caller still gets a single 1024-d
      // embedding for this text. If even the fallback trips, we surface
      // a zero vector so the rest of the batch can proceed; the manifest
      // row will be marked failed upstream if embedding is mandatory.
      logger.warn(
        { textPreview: safeText.slice(0, 80), error: (err as Error).message },
        "local-bge: primary embedding failed, falling back to per-piece mean-pool"
      );
      const fallback = await safeLocalBgeEmbeddingFallback(
        extractor,
        tokenizer,
        safeText,
        dimensions
      );
      if (fallback) {
        results.push(fallback);
      } else {
        // Last resort: zero vector of the right dim so the row at least
        // exists. The watcher treats this as "no embedding" downstream.
        results.push(new Array<number>(dimensions).fill(0));
      }
    }
    // Cooperative yield to the main event loop. The forward pass above
    // is CPU-bound synchronous ONNX work — without yielding, the
    // HTTP server (which also lives on the main thread) cannot run
    // any handler while we're crunching a 500-file batch. Every 3
    // chunks we hand control back via setImmediate so pending HTTP
    // requests get a chance to run. This is the cheap fix the
    // "main-thread blocked" failure doc recommends; the proper fix
    // is worker_threads (which we ALSO have, via embedding-worker).
    // The yield is a belt-and-braces in case the worker thread fails
    // to spawn and we fall back to this in-process path.
    // Reference: 失败原因/2026-08-06-sag-main-thread阻塞.md (修法 3).
    if (results.length % 3 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return results;
}

/**
 * Split a text into ≤ BGE_MAX_TOKENS windows and mean-pool their
 * embeddings. Returns null if every piece also fails.
 */
async function safeLocalBgeEmbeddingFallback(
  extractor: Awaited<ReturnType<typeof getLocalBgePipeline>>,
  tokenizer: TokenizerLike,
  text: string,
  dimensions: number
): Promise<number[] | null> {
  // Estimate token count; if it looks safe, just re-try once (the
  // original error may have been a transient tensor-reuse collision).
  try {
    const direct = await extractor(text, { pooling: "cls", normalize: true });
    return Array.from(direct.data);
  } catch {
    // fall through to windowed mean-pool
  }
  const charsPerToken = Math.max(1, Math.floor(text.length / Math.max(1, Math.ceil(text.length / 1024))));
  const windowChars = Math.max(64, BGE_MAX_TOKENS * charsPerToken);
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += windowChars) {
    pieces.push(text.slice(i, i + windowChars));
  }
  if (pieces.length === 0) return null;
  const sums = new Array<number>(dimensions).fill(0);
  let counted = 0;
  for (const piece of pieces) {
    try {
      const safe = await truncateToTokenLimit(piece, tokenizer);
      const t = await extractor(safe, { pooling: "cls", normalize: true });
      const data = Array.from(t.data);
      if (data.length !== dimensions) continue;
      for (let i = 0; i < dimensions; i++) sums[i] += data[i] ?? 0;
      counted += 1;
    } catch (err) {
      logger.warn(
        { piecePreview: piece.slice(0, 60), error: (err as Error).message },
        "local-bge: fallback piece failed, skipping"
      );
    }
  }
  if (counted === 0) return null;
  for (let i = 0; i < dimensions; i++) sums[i] = (sums[i] ?? 0) / counted;
  return sums;
}
