/**
 * src/ai/local-llm-client.ts — bundled GGUF inference via node-llama-cpp.
 *
 * Why this exists
 * ---------------
 * The legacy `llm-client.ts` only talked to OpenAI-compatible HTTP
 * endpoints (`/v1/chat/completions`). Operators who wanted to keep all
 * inference on-device had to install a third-party server (Ollama,
 * llama.cpp's `llama-server`, LM Studio) and point SAG at it via
 * `llmBaseUrl` + `llmModel`. That worked but had two papercuts:
 *
 *   1. Operators had to manage a separate process lifecycle.
 *   2. The UI couldn't tell the difference between "no LLM chosen" and
 *      "Ollama is installed but the model hasn't been pulled yet".
 *
 * Migration 016 introduced an `llm_provider = 'local'` toggle that
 * resolves through this module. We use `node-llama-cpp` (which ships
 * prebuilt napi binaries for Windows x64) so the model runs in the
 * same Node process as the Fastify server. The trade-off is a longer
 * cold-start (~5-8s for a 2 GB GGUF the first time) and a permanently
 * larger RSS footprint.
 *
 * JSON-mode enforcement
 * ---------------------
 * The SAG extraction prompt asks the model for a strict shape:
 *
 *   {
 *     "type": "response",
 *     "data": {
 *       "items": [{ "title": "...", "entities": [...], ... }],
 *       "meta": { "reason": "..." }
 *     }
 *   }
 *
 * Smaller models (Qwen2.5-3B, SmolLM2-135M) drift on free-form JSON
 * — they wrap the output in markdown code blocks, drop the closing
 * brace, or hallucinate extra top-level keys. Rather than write a
 * fragile regex-based extractor, we hand node-llama-cpp a
 * GBNF grammar generated from the schema. The grammar makes any
 * malformed output structurally impossible — the sampler can only
 * produce tokens that continue the expected shape.
 *
 * Concurrency
 * -----------
 * We serialize all chat calls behind an in-process Promise queue.
 * llama.cpp's CPU forward pass is single-threaded (per model) so
 * parallel calls would just time-slice the same kernel and add
 * KV-cache thrash. This queue is fine for SAG's ingestion pipeline
 * because the orchestrator already chunks one file at a time
 * (INGEST_CONCURRENCY=1).
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../observability/logger.js";
import type { AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEvent } from "../types.js";
import { getRuntimePerformanceSettings } from "../services/performance-settings-service.js";

// node-llama-cpp v3 is ESM-only and exposes both ESM and CJS entry
// points. We import the ESM entry and let `tsx` (dev) or `tsc` (build)
// resolve it; the napi binary ships prebuilt under
// node_modules/node-llama-cpp/dist/napi-v3/.
//
// We lazy-import so the module can be loaded in environments where
// the binary isn't yet available (e.g. the SEA bundle before postject
// has copied the .node file). The first actual inference call will
// fail with a clear "Could not load native binding" error which the
// probe / warmup endpoints surface to the UI.
type LlamaModule = typeof import("node-llama-cpp");
let llamaModule: LlamaModule | null = null;
async function getLlamaModule(): Promise<LlamaModule> {
  if (llamaModule) return llamaModule;
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  llamaModule = await import("node-llama-cpp");
  return llamaModule;
}

// v3 splits the API into two layers:
//   - module-level: `getLlama()`, `LlamaGrammar`, `LlamaChatSession`, etc.
//   - instance-level on `Llama`: `loadModel()`, `createGrammarForJsonSchema()`
// `loadModel` is on the instance because model loading depends on the
// resolved llama.cpp binary path which is determined when `getLlama()`
// resolves the platform-specific prebuilt.
type LlamaInstance = Awaited<ReturnType<typeof getLlamaModule>> extends infer M
  ? M extends { getLlama: () => Promise<infer L> }
    ? L
    : never
  : never;
let llamaInstance: LlamaInstance | null = null;
async function getLlamaInstance(): Promise<LlamaInstance> {
  if (llamaInstance) return llamaInstance;
  const mod = await getLlamaModule();
  // VERBOSE_DEBUG: surface the underlying node-llama-cpp init error
  // so the operator can diagnose EISDIR / "Cannot find module" / etc.
  // without having to dig through the inlined bundle source. We
  // intentionally wrap the await in a try/catch and re-throw with
  // the full Node stack (including error.code, error.path) baked in.
  try {
    llamaInstance = await mod.getLlama();
  } catch (err: any) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const baseDir = process.env.SAG_NATIVE_CACHE_DIR || "<unset>";
    const probe: string[] = [
      "process.execPath=" + process.execPath,
      "process.cwd=" + process.cwd(),
      "baseDir=" + baseDir,
    ];
    // Probe a few well-known candidate paths and report existence
    // + the kind of entry (FILE vs DIR) so the operator can see at
    // a glance whether the build script copied the .node binaries
    // and the node-llama-cpp JSON config files into the right tree.
    const candidates = [
      "node_modules/@node-llama-cpp/win-x64/bins/win-x64/llama-addon.node",
      "node_modules/@node-llama-cpp/win-x64/bins/win-x64/_nlcBuildMetadata.json",
      "node_modules/@node-llama-cpp/win-x64/package.json",
      "node_modules/node-llama-cpp/llama/binariesGithubRelease.json",
      "node_modules/node-llama-cpp/llama/llama.cpp.info.json",
      "node_modules/node-llama-cpp/package.json",
      "node_modules/chalk/source/util.js",
      "node_modules/supports-color/index.js",
      "node_modules/slice-ansi/index.js",
    ];
    for (const rel of candidates) {
      const abs = path.join(baseDir, rel);
      let info = "missing";
      try {
        const st = fs.statSync(abs);
        info = (st.isDirectory() ? "DIR" : "FILE") + " size=" + st.size;
      } catch (e: any) {
        info = e.code || "missing";
      }
      probe.push(rel + " => " + info);
    }
    // If the underlying error message contains a path, show it.
    const errPath = err?.path ? `error.path=${err.path}` : "";
    const wrapped = new Error(
      "node-llama-cpp init failed: " + (err?.message || String(err)) +
      "\n  error.code=" + (err?.code || "LLAMA_INIT_FAILED") +
      "\n  " + errPath +
      "\n  stack=" + (err?.stack || "<no stack>").slice(0, 3000) +
      "\n  probe=\n    " + probe.join("\n    "),
    );
    (wrapped as any).code = err?.code || "LLAMA_INIT_FAILED";
    throw wrapped;
  }
  return llamaInstance;
}

interface LoadedModel {
  // Absolute path to the GGUF on disk. Used by `dispose()` to log
  // which model is being freed.
  path: string;
  // The exact path string the caller passed to `loadLocalLlmModel`,
  // preserved verbatim (which may be relative — e.g.
  // "models/qwen2.5-3b-instruct-q4_k_m.gguf"). Settings service
  // compares THIS against `settings.llmLocalModelPath` so a relative
  // path set by the operator matches the loaded record without
  // re-resolving.
  inputPath: string;
  label: string;
  // The model + context pair is intentionally kept together so we
  // dispose them as a unit. `model.dispose()` would also dispose the
  // contexts that were created from it, but being explicit makes the
  // cleanup order obvious in the logs.
  model: import("node-llama-cpp").LlamaModel;
  context: import("node-llama-cpp").LlamaContext;
  loadedAt: number;
}

// Module-level singleton. A single loaded model is enough because:
//   1. SAG's extraction prompt is the only consumer in v1.
//   2. llama.cpp's CPU forward pass is single-threaded per model.
//   3. Hot-swapping models requires disposing the old KV cache
//      first, which is what `reloadModel()` does explicitly.
let current: LoadedModel | null = null;
// Serialize every inference call. node-llama-cpp exposes `sequence`
// APIs that are safe to call concurrently *in theory*, but on CPU the
// forward pass saturates a single core so concurrent calls just add
// context-switch overhead. The promise queue preserves the caller's
// expected behaviour (first request wins) without bouncing events.
let inflight: Promise<unknown> = Promise.resolve();

export interface LoadedModelInfo {
  path: string;
  // Mirrors `LoadedModel.inputPath` — see that comment for why we
  // keep both the resolved absolute path (for logging / dispose)
  // and the original input (for the settings equality check).
  inputPath: string;
  label: string;
  loadedAt: string; // ISO timestamp
}

/**
 * Return the currently-loaded model descriptor, or `null` if nothing
 * is loaded. The settings route calls this on every `GET
 * /api/settings/ai` so the UI shows a live "model ready" badge without
 * a separate pub/sub channel.
 */
export function getLoadedLocalLlmInfo(): LoadedModelInfo | null {
  if (!current) return null;
  return {
    path: current.path,
    inputPath: current.inputPath,
    label: current.label,
    loadedAt: new Date(current.loadedAt).toISOString()
  };
}

/**
 * Resolve a (possibly relative) GGUF path to an absolute one.
 *
 * Resolution order — first match wins:
 *
 *   1. Absolute path as supplied — used directly.
 *   2. `process.resourcesPath/<rel>` — Electron main process only.
 *      `process.resourcesPath` is NOT set on the SEA child process
 *      the Electron shell spawns, so for the SEA runtime this branch
 *      is always skipped.
 *   3. SEA runtime (Electron-shell spawn) — exe lives at
 *      `<install>/resources/本地知识检索-后端.exe`, so exeDir is
 *      `<install>/resources/`. Models ship at `<exeDir>/models/<file>`.
 *      Try `<exeDir>/models/<rel>` first.
 *   4. Cwd-walk fallback — node and the SEA binary are launched from
 *      different working directories in dev mode, so walk up a few
 *      levels looking for a `models/` directory.
 *
 * The function never throws on "not found" — it returns the candidate
 * path and lets the caller stat-check it. This keeps the probe
 * endpoint cheap (no try/catch in the hot path).
 */
export function resolveLocalLlmModelPath(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;

  const resourcesRoot = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesRoot) {
    const candidate = path.join(resourcesRoot, trimmed);
    if (existsSync(candidate)) return candidate;
  }

  // SEA runtime — exe is inside `<install>/resources/`, models are at
  // `<exeDir>/models/`. Try this BEFORE the cwd walk so a bare
  // filename like "qwen2.5-1.5b-instruct-q4_k_m.gguf" resolves
  // correctly instead of falling back to the (always-missing) cwd.
  const exeDir = path.dirname(process.execPath);
  const seaCandidate = path.join(exeDir, "models", trimmed);
  if (existsSync(seaCandidate)) return seaCandidate;

  // Dev-mode fallback: walk up to 4 levels looking for `models/`.
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    const candidate = path.join(dir, "models", trimmed);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last-resort: just return the cwd-joined path so the caller can
  // surface a precise "file not found" error with the actual path.
  return path.join(process.cwd(), trimmed);
}

/**
 * Load a GGUF file into RAM and create a context sized for the SAG
 * extraction prompt. Idempotent: if the same path is already loaded
 * we return the existing handle without disposing. A different path
 * triggers a clean unload + reload so the user can switch models
 * without restarting the server.
 *
 * Throws on:
 *   - empty path
 *   - file not found / not a .gguf
 *   - llama.cpp context allocation failure (e.g. OOM, napi load error)
 *
 * Returns the file basename without extension as `label` so the UI can
 * show "Qwen2.5-3B-Instruct (Q4_K_M)" without parsing the path again.
 */
export async function loadLocalLlmModel(
  modelPath: string,
  contextSize: number,
  options?: { threads?: number }
): Promise<LoadedModelInfo> {
  const resolved = resolveLocalLlmModelPath(modelPath);
  if (!resolved) throw new Error("modelPath is empty");
  if (!existsSync(resolved)) throw new Error(`GGUF not found at ${resolved}`);
  if (!resolved.toLowerCase().endsWith(".gguf")) {
    throw new Error(`Model must be a .gguf file (got: ${path.basename(resolved)})`);
  }

  if (current && current.path === resolved) {
    logger.info({ path: resolved }, "local-llm: model already loaded, returning existing handle");
    return getLoadedLocalLlmInfo()!;
  }

  // VERBOSE_DEBUG: emit the exact `process.cwd()` and resolved
  // model path the runtime sees, plus a `fs.statSync` of the file
  // (file vs DIR vs missing). This is the difference between
  // "EISDIR" and a real load failure, and the bundled node-llama-cpp
  // doesn't surface it itself when it bubbles up through `loadModel`.
  logger.info(
    {
      process_cwd: process.cwd(),
      process_execPath: process.execPath,
      resolved_path: resolved,
      stat: await (async () => {
        try {
          const st = await (await import("node:fs")).promises.stat(resolved);
          return st.isDirectory() ? "DIR" : "FILE size=" + st.size;
        } catch (e: any) {
          return e.code || String(e);
        }
      })(),
      parent_dir: await (async () => {
        try {
          const fs = await import("node:fs");
          return fs.existsSync(resolved) ? "ok" : "missing";
        } catch {
          return "?";
        }
      })(),
    },
    "local-llm: about to call llama.loadModel"
  );

  // Preserve the original input string so the settings service can
  // match it back against the user-supplied path without a re-resolve
  // round-trip. Without this, `current.path` is the absolute path
  // (resolved) but `settings.llmLocalModelPath` is whatever the
  // operator typed — typically relative.

  // Dispose the previous model BEFORE loading the new one so we don't
  // double-count VRAM/RSS. `dispose()` is async because the underlying
  // napi call schedules a free callback.
  if (current) {
    logger.info({ path: current.path }, "local-llm: disposing previous model before reload");
    try {
      await current.context.dispose();
    } catch (err) {
      logger.warn({ error: (err as Error).message }, "local-llm: context.dispose threw — continuing");
    }
    try {
      await current.model.dispose();
    } catch (err) {
      logger.warn({ error: (err as Error).message }, "local-llm: model.dispose threw — continuing");
    }
    current = null;
  }

  const llama = await getLlamaInstance();
  const t0 = Date.now();
  // `loadModel` reads + parses the GGUF header. The actual weight
  // mmap happens lazily on first context.eval(). For a 2 GB Q4_K_M
  // model expect ~200 ms header parse and ~2-3 s first eval.
  // VERBOSE_DEBUG: catch loadModel errors and re-throw with extra
  // context so we can tell EISDIR (path is a directory?) apart
  // from genuine GGUF parse failures.
  let model;
  try {
    model = await llama.loadModel({ modelPath: resolved });
  } catch (err: any) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const probe = [
      "resolved_path=" + resolved + " exists=" + fs.existsSync(resolved) +
      (fs.existsSync(resolved) ? " isDir=" + fs.statSync(resolved).isDirectory() : ""),
      "process.cwd=" + process.cwd(),
      "process.execPath=" + process.execPath,
    ];
    const wrapped = new Error(
      "loadModel failed: " + (err?.message || String(err)) +
      "\n  error.code=" + (err?.code || "?") +
      "\n  error.path=" + (err?.path || "?") +
      "\n  stack=" + (err?.stack || "<no stack>").slice(0, 3000) +
      "\n  probe=\n    " + probe.join("\n    "),
    );
    (wrapped as any).code = err?.code || "LOAD_MODEL_FAILED";
    throw wrapped;
  }
  // Bound the context window at the user-configured size. The KV
  // cache grows linearly with context size — 8192 is roughly 50 MB
  // for Qwen2.5-3B. Above 16k on CPU the first-token latency
  // balloons, so the schema caps at 32768 and we soft-warn above
  // 8192.
  //
  // `threads` is sourced from the performance service (env
  // LLM_THREADS, default 4) so operators can tune from the
  // Settings → Performance panel. Hyperthreading on a 12-core
  // E5-2676 v3 saturates at ~8 physical cores; oversubscribing
  // (e.g. 24 threads) just adds context-switch overhead to the
  // matrix-multiply hot loop. The current model is reloaded when
  // the operator changes the value (and they re-warmup via the
  // /api/settings/llm/local-model/warmup endpoint) so the new
  // thread count takes effect on the next prompt.
  //
  // Resolution order: explicit `options.threads` (the warmup
  // endpoint awaits the DB read so it has the freshest value)
  // first, then the sync cache (`getRuntimePerformanceSettings`).
  // The cache can be stale right after a PUT (CACHE_TTL_MS window
  // or a pre-populate cache hit returning envDefaults), so the
  // explicit path is the safe one for hot-reload.
  const threads = options?.threads ?? getRuntimePerformanceSettings().llmThreads;
  const context = await model.createContext({ contextSize, threads });
  const label = path.basename(resolved, path.extname(resolved));
  current = { path: resolved, inputPath: modelPath, label, model, context, loadedAt: Date.now() };
  logger.info(
    { path: resolved, inputPath: modelPath, contextSize, tookMs: Date.now() - t0 },
    "local-llm: model loaded"
  );
  return getLoadedLocalLlmInfo()!;
}

/**
 * P7 fix: lazy-load the local LLM on first use, with a single-flight
 * lock so concurrent ingest workers don't all try to load the same
 * 1.1 GB GGUF at the same time (would OOM the box).
 *
 * Behaviour:
 *   - model already loaded     → returns immediately (no-op)
 *   - provider !== "local"     → returns immediately (remote LLM
 *                                path, no in-process model)
 *   - path empty / not present → returns false (caller falls back
 *                                to its deterministic path; no
 *                                silent regex dummy data is written
 *                                in production paths that check the
 *                                return value)
 *   - load succeeds             → returns true
 *   - load fails                → returns false, sets lastError so
 *                                /health + UI can surface the cause
 *
 * The previous code never called loadLocalLlmModel() in the ingest
 * pipeline — the smoke endpoint did, the warmup endpoint did, but
 * the actual extractEventsFromChunk call hit
 *   `throw new Error("local-llm: no model loaded — ...")`
 * and fell into the regex catch. The user-facing symptom: events /
 * entities look like garbage and the model-call-log says
 * `SUCCEEDED` with `error: "local-llm: no model loaded"`.
 */
let lastLoadError: string | null = null;
let inflightLoad: Promise<boolean> | null = null;

export function getLastLocalLlmLoadError(): string | null {
  return lastLoadError;
}

export async function ensureLocalLlmLoaded(settings: {
  llmProvider: string;
  llmLocalModelPath: string | null;
  llmLocalContextSize?: number;
  llmThreads?: number;
}): Promise<boolean> {
  // Remote LLM paths don't have an in-process model.
  if (settings.llmProvider !== "local") return false;
  // Already loaded → done.
  if (current) return true;
  // No path → can't load, surface that to the caller.
  if (!settings.llmLocalModelPath) {
    lastLoadError = "local-llm: provider=local but llmLocalModelPath is empty";
    return false;
  }
  // Single-flight: if a load is already in progress, wait for it.
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      await loadLocalLlmModel(
        settings.llmLocalModelPath as string,
        settings.llmLocalContextSize ?? 4096,
        { threads: settings.llmThreads }
      );
      lastLoadError = null;
      return true;
    } catch (error) {
      lastLoadError = (error as Error).message;
      logger.warn(
        { error: lastLoadError, path: settings.llmLocalModelPath },
        "local-llm: lazy-load failed"
      );
      return false;
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

/**
 * Dispose the loaded model. Called on shutdown via the index.ts
 * signal handlers, and explicitly by the settings service when the
 * operator clears the path. Returns immediately if nothing is loaded.
 */
export async function disposeLocalLlmModel(): Promise<void> {
  if (!current) return;
  // Wait for any in-flight inference to finish before disposing —
  // otherwise we'd race the napi free against the still-running
  // forward pass and crash.
  await inflight.catch(() => undefined);
  const prev = current;
  current = null;
  try {
    await prev.context.dispose();
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "local-llm: context.dispose threw");
  }
  try {
    await prev.model.dispose();
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "local-llm: model.dispose threw");
  }
  logger.info({ path: prev.path }, "local-llm: model disposed");
}

// ────────────────────────────────────────────────────────────────────────
// Inference helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * The 11 entity types we ask the LLM to classify into. Mirrors
 * `benchmarkEntityTypes()` in llm-client.ts exactly — any drift
 * between the two would let the model emit "subject" for everything
 * because it's the catch-all default.
 *
 * Listed in priority order so the JSON schema `enum` puts the more
 * specific types first (the grammar tries them in order when it
 * needs to backtrack).
 */
const ENTITY_TYPES = [
  "person",
  "organization",
  "location",
  "time",
  "product",
  "metric",
  "action",
  "work",
  "group",
  "subject",
  "tags"
] as const;

/**
 * JSON Schema matching the extraction prompt in llm-client.ts. We
 * hand this to `llama.createGrammarForJsonSchema()` which compiles
 * it to GBNF under the hood — much less error-prone than writing
 * the grammar by hand.
 *
 * What the schema enforces:
 *   - top-level { type: "response", data: {...} }
 *   - data.items is 0..1 events
 *   - each event has the required string fields
 *   - entities[].type is one of ENTITY_TYPES
 *
 * What it does NOT enforce (left to the prompt + post-parse validation):
 *   - the title / summary content
 *   - entity.description non-emptiness
 *   - exact reference ids
 */
function buildExtractionJsonSchema() {
  return {
    type: "object",
    required: ["type", "data"],
    properties: {
      type: { const: "response" },
      data: {
        type: "object",
        required: ["items", "meta"],
        properties: {
          items: {
            type: "array",
            minItems: 0,
            maxItems: 1,
            items: {
              type: "object",
              required: ["title", "summary", "content", "category", "keywords", "references", "entities", "is_valid"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
                category: { type: "string" },
                keywords: { type: "array", items: { type: "string" } },
                priority: { enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] },
                status: { enum: ["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"] },
                references: { type: "array", items: { type: "integer" } },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "name", "description"],
                    properties: {
                      type: { enum: [...ENTITY_TYPES] },
                      name: { type: "string" },
                      description: { type: "string" }
                    }
                  }
                },
                is_valid: { type: "boolean" },
                children: { type: "array", maxItems: 0 }
              }
            }
          },
          meta: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
              confidence: { type: "number" }
            }
          }
        }
      }
    }
  };
}

function buildRerankJsonSchema() {
  return {
    type: "object",
    required: ["useful_event_ids"],
    properties: {
      useful_event_ids: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
}

interface ExtractionInput {
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
  schema: "extraction" | "rerank";
  // When true, the JSON-schema-derived grammar is skipped — useful
  // for smoke tests where the caller wants "did the model generate
  // anything at all" without paying the grammar-sampler cost. See
  // sag_local-llm-grammar-deadlock-20260917.md for the GBNF deadlock
  // context that motivated this flag.
  skipGrammar?: boolean;
  // Hard cap on tokens generated per prompt. Defaults to 1024 for
  // extraction, 256 for rerank; the /test smoke endpoint overrides
  // to 96 so a smoke test completes in a couple of seconds even on
  // CPU.
  maxTokens?: number;
  onProgress?: (preview: string) => void;
}

/**
 * Run a chat completion with a JSON-schema-derived grammar constraint.
 * The grammar eliminates structural hallucinations; we still parse
 * the output defensively because:
 *   - the grammar can leave a trailing newline
 *   - llama.cpp can emit a stop token mid-string on truncated UTF-8
 *
 * v3 API note: `systemPrompt` lives on the `LlamaChatSession`
 * constructor, not on `prompt()` options. We thread it through there.
 *
 * P1 — see sag_local-llm-grammar-deadlock-20260917.md.
 *
 * Caveat: with Qwen2.5 + GBNF grammar on CPU-only Windows,
 * llama.cpp's grammar sampler occasionally enters a state where it
 * doesn't honour the AbortSignal and the JS event loop can't fire
 * timers (because the napi extension is synchronously consuming the
 * thread). The hard-deadline `Promise.race` would normally rescue
 * us — but in practice the napi work holds the thread long enough
 * that even the deadline's `setTimeout` can't queue until the
 * sample finishes, and the sample never finishes. We mitigate this
 * in `runChatCompletion` by skipping the grammar when callers pass
 * `skipGrammar: true` (used by the /test endpoint, where the JSON
 * schema is overkill for a smoke-test).
 */
async function runChatCompletion(input: ExtractionInput): Promise<string> {
  if (!current) throw new Error("local-llm: no model loaded — call loadLocalLlmModel() first");
  const llama = await getLlamaInstance();
  const mod = await getLlamaModule();
  // Skip the grammar for the /test smoke endpoint — the test asks
  // "can the model load and emit a few tokens", not "can it produce
  // valid JSON". With Qwen2.5 + CPU the GBNF grammar sampler can
  // deadlock (see note above the function), so the test uses a
  // plain completion that we know exits cleanly.
  const useGrammar = !input.skipGrammar;
  const grammar = useGrammar
    ? await llama.createGrammarForJsonSchema(
        (input.schema === "extraction"
          ? buildExtractionJsonSchema()
          : buildRerankJsonSchema()) as any
      )
    : undefined;

  const session = new mod.LlamaChatSession({
    contextSequence: current.context.getSequence(),
    systemPrompt: input.systemPrompt,
    // P8 mitigation: autoDisposeSequence=true ensures the sequence
    // slot is returned to the pool when the session is disposed
    // OR garbage-collected. With autoDisposeSequence=false (the
    // node-llama-cpp default), if the underlying napi prompt hangs
    // past our deadline, the session.dispose() call also hangs
    // waiting on the napi thread — so the sequence leaks. We saw
    // this exact pattern in the 信息系统监理 run: first extraction
    // hung 64s → leaked sequence → 30+ subsequent calls all
    // failed with "No sequences left" because the pool was empty.
    // The grammar dead-lock fix (skipGrammar=true) helps with the
    // hang root cause, but a sequence leak from any other napi
    // failure mode would still kill the whole ingest run.
    autoDisposeSequence: true
  });

  // Wrap the prompt in an AbortController race so the caller's
  // timeoutMs budget is honoured even if node-llama-cpp ignores its
  // own internal deadline (which it does — there's no per-prompt
  // timeout knob in v3).
  //
  // P0 — see sag_local-llm-prompt-deadlock-20260916.md. On Windows
  // with Qwen2.5 Q4_K_M + CPU-only inference, `session.prompt()`
  // sometimes hangs indefinitely even after the AbortSignal fires —
  // most likely because llama.cpp's grammar sampler enters a state
  // where it can't honour the abort mid-token. The signal alone is
  // not enough. We race the prompt against a hard setTimeout that
  // resolves with an empty string; that releases the request
  // thread back to the caller, who can either retry or surface a
  // clear "timed out" message. The leaked `session.prompt` keeps
  // running in the background but no longer blocks the HTTP
  // response — the next /test call gets a fresh session anyway.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("local-llm-timeout");
  }, input.timeoutMs);
  try {
    const promptPromise = session.prompt(input.userPrompt, {
      ...(grammar ? { grammar } : {}),
      temperature: 0.1,
      maxTokens: input.maxTokens ?? (input.schema === "extraction" ? 128 : 256),
      signal: controller.signal
    });
    // Hard deadline that fires even if llama.cpp ignores the signal.
    const hardDeadline = new Promise<string>((resolve) => {
      setTimeout(() => resolve(""), input.timeoutMs + 2_000);
    });
    const reply = await Promise.race([promptPromise, hardDeadline]);
    if (reply === "") {
      // hard deadline won — log + throw a real error so the caller
      // gets a clean response instead of an empty body.
      logger.warn(
        { timeoutMs: input.timeoutMs, signal: controller.signal?.aborted },
        "local-llm: prompt hung past deadline; releasing HTTP response"
      );
      throw new Error(
        `local-llm: prompt hung past ${input.timeoutMs}ms deadline; ` +
        `signal.aborted=${controller.signal?.aborted}. ` +
        `The grammar sampler may have deadlocked. ` +
        `Try a smaller maxTokens or a different model.`
      );
    }
    return typeof reply === "string" ? reply : String(reply);
  } catch (err) {
    // node-llama-cpp v3 occasionally throws non-Error values (e.g.
    // a plain string from the napi boundary, or an empty abort
    // signal). Wrap so the settings/UI surface has something to
    // log and we don't silently swallow the cause.
    const wrapped: Error =
      err instanceof Error
        ? err
        : new Error(
            `local-llm: prompt failed with non-Error value (${typeof err}): ${String(err)}`
          );
    logger.warn(
      {
        error: wrapped.message,
        stack: wrapped.stack,
        signal: controller.signal?.aborted,
        timedOut,
        abortedReason: controller.signal?.aborted ? String(controller.signal.reason) : null
      },
      "local-llm: runChatCompletion prompt failed"
    );
    throw wrapped;
  } finally {
    clearTimeout(timer);
    try {
      // P1 — see sag_local-llm-sequences-exhausted-20260916.md.
      // P8 mitigation: race dispose() against a 1s deadline. If
      // the underlying napi thread is stuck (the same root cause
      // as the prompt hang), session.dispose() itself hangs and
      // the sequence slot leaks. With autoDisposeSequence=true on
      // the session (see above), the slot will eventually be
      // reclaimed on GC, but a 1s timeout here means a hung
      // dispose doesn't hold up the next extraction call. We log
      // + swallow so a stuck dispose never poisons the queue.
      const disposePromise = session.dispose({ disposeSequence: true });
      const disposeTimeout = new Promise<void>((resolve) => setTimeout(resolve, 1000));
      await Promise.race([disposePromise, disposeTimeout]);
    } catch {
      /* swallow */
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Public API — drop-in replacement for the HTTP chatJson() path
// ────────────────────────────────────────────────────────────────────────

/**
 * Smoke-test the loaded model without going through the JSON-schema
 * grammar. Returns the raw generated text (typically a short echo /
 * continuation of the user's prompt) plus metadata so the UI can
 * show "extracted N tokens in M seconds" without ever entering the
 * GBNF grammar sampler (see
 * sag_local-llm-grammar-deadlock-20260917.md — the grammar sampler
 * can deadlock on Qwen2.5 + CPU, and the test endpoint just needs
 * to prove the model works).
 *
 * Mirrors the shape of the embedding `/test` endpoint so the
 * Settings UI badge logic stays uniform.
 */
export interface SmokeTestEntity {
  type: string;
  name: string;
  description: string;
}

export interface SmokeTestResult {
  text: string;
  tokenCount: number;
  tookMs: number;
  // Optional extraction view, surfaced only when the model returns
  // parseable JSON. The UI's Settings panel renders these directly;
  // they are NOT persisted anywhere — the test endpoint is
  // read-only smoke-checking the loaded model. When the model
  // returns prose instead of JSON these stay undefined and the UI
  // falls back to showing the raw `text`.
  eventCount?: number;
  entityCount?: number;
  entities?: SmokeTestEntity[];
  title?: string | null;
  summary?: string | null;
}

/**
 * Smoke-test the loaded model without going through the JSON-schema
 * grammar. Returns the raw generated text plus a best-effort
 * extraction view (`title` / `summary` / `entities`) so the UI can
 * show "extracted N entities · M entities · K ms" the same way it
 * did before the GBNF-deadlock fix.
 *
 * Why no grammar: the production extraction sampler can deadlock
 * on Qwen2.5 + CPU (see sag_local-llm-grammar-deadlock-20260917.md).
 * The test endpoint just needs to prove the model loads + runs and
 * produces a useful answer, so we ask for JSON *in the prompt* and
 * parse leniently. The reply is whatever the model generates; if
 * the JSON parse fails the smoke test still succeeds and surfaces
 * `text` for the UI to render.
 */
export async function smokeTestLocalLlm(
  settings: AiRuntimeSettings,
  args: { system: string; user: string }
): Promise<SmokeTestResult> {
  const t0 = Date.now();
  const reply = await withSerializedInference(() =>
    runChatCompletion({
      systemPrompt:
        "你是一个 SAG 审计助手。请严格按照 JSON 格式输出，不要任何解释或额外文字。",
      userPrompt:
        `${args.user}\n\n请从上述文本中抽取事件，按以下 JSON 格式输出（可省略 fields 为空数组 / null）：\n` +
        `{"title":"事件标题(≤15字)","summary":"事件概述(1-2 句)","entities":[{"type":"person|location|object|org|datetime","name":"实体名","description":"角色/上下文"}]}`,
      timeoutMs: Math.min(settings.llmTimeoutMs, 300_000),
      schema: "extraction", // unused when skipGrammar=true
      skipGrammar: true,
      maxTokens: 320
    })
  );
  const text = reply.trim();
  const parsed = parseSmokeTestJson(text);
  const result: SmokeTestResult = {
    text,
    tokenCount: text.length,
    tookMs: Date.now() - t0
  };
  if (parsed) {
    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .filter((e: unknown): e is Record<string, unknown> => Boolean(e && typeof e === "object"))
          .map((e) => ({
            type: String((e as Record<string, unknown>).type ?? ""),
            name: String((e as Record<string, unknown>).name ?? ""),
            description: String((e as Record<string, unknown>).description ?? "")
          }))
          .filter((e) => e.name.length > 0)
      : [];
    result.eventCount = parsed.title ? 1 : 0;
    result.entityCount = entities.length;
    result.entities = entities;
    result.title = parsed.title ?? null;
    result.summary = parsed.summary ?? null;
  }
  return result;
}

/**
 * Lenient JSON extractor for the smoke-test reply. Looks for the
 * first balanced JSON object in the text and returns the parsed
 * shape, or null when nothing usable is found. Doesn't throw —
 * the caller falls back to `text` only.
 */
function parseSmokeTestJson(text: string): {
  title?: string;
  summary?: string;
  entities?: unknown[];
} | null {
  if (!text) return null;
  // Common case: the entire reply is the JSON.
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") return obj as { title?: string; summary?: string; entities?: unknown[] };
  } catch {
    /* fall through to scan */
  }
  // Look for the first '{' and try a balanced-brace scan.
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const obj = JSON.parse(candidate);
          if (obj && typeof obj === "object") {
            return obj as { title?: string; summary?: string; entities?: unknown[] };
          }
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract one event + entities from a chunk. Mirrors
 * `llm-client.extractEventsFromChunk`'s contract: returns an array
 * of `ExtractedEvent`. Empty array when the chunk is junk.
 *
 * On any llama.cpp / parse error we rethrow so the caller's
 * retry/abort logic can take over (same as the HTTP path).
 */
export async function extractEventsViaLocalLlm(
  settings: AiRuntimeSettings,
  args: { system: string; user: string; operation: string }
): Promise<ExtractedEvent[]> {
  const reply = await withSerializedInference(() =>
    runChatCompletion({
      systemPrompt: args.system,
      userPrompt: args.user,
      // P9 fix: Qwen2.5-1.5B Q4_K_M on CPU can take 60-120s per
      // extraction call. Use a hard 180s floor for the local path so
      // the model has a realistic chance to finish rather than always
      // falling back to regex. The settings.llmTimeoutMs may still be
      // 60s from a prior install; this override ensures the local path
      // is never slower than 180s.
      timeoutMs: Math.max(settings.llmTimeoutMs, 180_000),
      schema: "extraction",
      // P8 mitigation: with Qwen2.5 + GBNF grammar on CPU the
      // sampler deadlocks on virtually every chunk (logs show
      // "prompt hung past 60000ms deadline" for every extraction
      // call, then fall back to regex). The grammar's only job
      // is structural correctness — we instead trust the model
      // to follow the system-prompt JSON example and parse
      // defensively below (we already strip ```json fences and
      // surface parse errors as model-call-log DEGRADED rows).
      // /test still uses grammar for the JSON-schema smoke test;
      // production extraction paths are grammar-less.
      skipGrammar: true
    })
  );

  // Strip a leading ```json fence if the model added one despite
  // the grammar. The grammar shouldn't allow it, but llama.cpp's
  // stop-token handling sometimes emits it on the first iteration
  // before the sampler realises the grammar is active.
  const trimmed = reply.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`local-llm: extraction returned invalid JSON: ${(err as Error).message}; raw=${reply.slice(0, 200)}`);
  }

  // Pull the first item out of the response wrapper. Same shape as
  // the HTTP path so callers don't need to branch.
  const items = parsed?.data?.items;
  if (!Array.isArray(items) || items.length === 0) return [];
  const item = items[0];
  if (!item || item.is_valid === false) return [];

  const entities = Array.isArray(item.entities)
    ? item.entities
        .map((e: any) => ({
          type: String(e?.type ?? "subject"),
          name: String(e?.name ?? "").trim(),
          description: String(e?.description ?? "").trim()
        }))
        .filter((e: { name: string }) => e.name.length > 1)
    : [];

  return [
    {
      title: String(item.title ?? "").trim(),
      summary: String(item.summary ?? "").trim(),
      content: String(item.content ?? "").trim(),
      category: String(item.category ?? "").trim(),
      keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
      priority: typeof item.priority === "string" ? (item.priority as any) : "UNKNOWN",
      status: typeof item.status === "string" ? (item.status as any) : "UNKNOWN",
      references: Array.isArray(item.references) ? item.references.map(Number).filter(Number.isFinite) : [],
      entities
    }
  ];
}

/**
 * Rerank candidates by usefulness. Returns the candidate IDs in
 * usefulness order, top-K. The HTTP path also does this; we keep
 * the surface identical so the LlmClient can swap.
 */
export async function rerankEventsViaLocalLlm(
  settings: AiRuntimeSettings,
  args: { system: string; user: string; topK: number; candidateIds: string[] }
): Promise<string[]> {
  const reply = await withSerializedInference(() =>
    runChatCompletion({
      systemPrompt: args.system,
      userPrompt: args.user,
      // Match the HTTP path's hard 8s deadline so a slow local model
      // can't make a single query feel sluggish. Anything longer and
      // the caller gives up via the existing timeout-race branch.
      // P9 fix: local Qwen2.5-1.5B on CPU takes 60-120s; 8s is never
      // enough. Bump to 180s so rerank has a realistic chance.
      timeoutMs: Math.max(settings.llmTimeoutMs, 180_000),
      schema: "rerank",
      // Same P8 mitigation as extraction — Qwen2.5 + GBNF grammar
      // deadlocks on CPU; rerank's JSON is a simple {"useful_event_ids":[...]}
      // so the model can produce it without grammar guidance most
      // of the time. Caller still falls back to localRerank on
      // parse failure (line below).
      skipGrammar: true
    })
  );
  const trimmed = reply.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return []; // caller falls back to local rerank
  }
  const ids = parsed?.useful_event_ids ?? parsed?.event_ids;
  if (!Array.isArray(ids)) return [];
  return ids
    .map(String)
    .filter((id) => args.candidateIds.includes(id))
    .slice(0, args.topK);
}

/**
 * Serialize inference calls through a single shared promise. Each
 * call queues behind the previous one; if the previous fails the
 * rejection propagates so the caller sees a real error (not a
 * swallowed one).
 */
function withSerializedInference<T>(fn: () => Promise<T>): Promise<T> {
  const next = inflight.then(() => fn(), () => fn());
  // Keep the chain alive even when this call rejects, otherwise the
  // *next* call would inherit the rejection as its queue tail.
  inflight = next.catch(() => undefined);
  return next;
}
