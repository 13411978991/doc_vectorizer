/**
 * src/api/settings-routes.ts — User-facing settings endpoints.
 *
 *   GET /api/settings/ai   - read AI provider / chunking / search defaults
 *   PUT /api/settings/ai   - update AI provider / chunking / search defaults
 *   GET /api/settings/mcp  - read MCP server public settings (no secrets)
 *
 *   GET /api/settings/embedding/local-model/probe?path=...
 *     - verify the path points at a usable ONNX/transformers model dir
 *       (config.json + *.onnx present). Returns { ready, files[], reason }.
 *
 *   POST /api/settings/embedding/local-model/warmup
 *     - force a local-bge pre-load so the UI shows the load time and any
 *       error in real time instead of waiting for the first ingest call.
 *
 *   POST /api/settings/embedding/local-model/test
 *     - run a single probe embedding against the configured local model
 *       and return { dim, sample, tookMs } for UI sanity-check feedback.
 *
 * The MCP settings handler is read-only — it's the source of truth for
 * the web UI's MCP config card; mutations go through the MCP service
 * layer (kept outside the v1 surface to avoid drift).
 */

import { promises as fs, existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import {
  PERFORMANCE_BOUNDS,
  performanceSettingsService
} from "../services/performance-settings-service.js";
import { watcherAutostartService } from "../services/watcher-autostart-service.js";
import { aiSettingsSchema } from "./server-helpers.js";
import { registerNerRoutes } from "./ner-routes.js";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";

/**
 * Resolve the runtime "models" directory the same way the LLM loader does.
 * Used by the catalog/installed/download endpoints so the user sees the
 * actual on-disk path (`process.resourcesPath/models/`) rather than
 * whatever the Web shell thinks.
 *
 * Exported (Plan B 2026-09-19) so `ner-routes.ts` can reuse the same
 * candidate order. Keeping a single source of truth avoids the LLM and
 * NER downloaders disagreeing about where to drop files.
 */
export function getModelsInstallDir(): string {
  const resourcesRoot = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesRoot) {
    // Electron main process path — `<resourcesPath>/models/` is the
    // canonical location. Same in dev (`<repo>/`) and packaged
    // (`<install>/resources/`).
    return path.join(resourcesRoot, "models");
  }
  // SEA / Node-spawn fallback: `process.resourcesPath` is an Electron
  // property and is undefined when 本地知识检索-后端.exe runs as a
  // standalone SEA child process. There are two supported layouts:
  //
  //   - Packaged (Electron-shell spawn):
  //       exe at <install>/resources/本地知识检索-后端.exe
  //       models at <install>/resources/models/
  //       → <exeDir>/models
  //
  //   - Dev (npm run dev, electron .):
  //       exe at <repo>/release/本地知识检索-后端.exe (or similar)
  //       models at <repo>/release-desktop/win-unpacked/resources/models/
  //       → <exeDir>/../resources/models (one level up to repo root,
  //         then down into electron-builder's output resources/ tree)
  //
  // Both probe as candidate[0]/[1] and we pick the one that exists;
  // default to whichever the user is most likely to be running.
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "models"),                  // packaged layout (exe already inside resources/)
    path.join(exeDir, "..", "resources", "models"), // dev layout (exe in release/, models in release-desktop/.../resources/)
    path.join(exeDir, "resources", "models"),     // legacy pre-Electron layout — keep probing for back-compat but DON'T prefer
    path.join(process.cwd(), "models")
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  // Default to the canonical packaged layout so we create it on first
  // download even if nothing is there yet.
  return candidates[0];
}

/**
 * In-process tracker for active GGUF downloads so the cancel endpoint
 * can find the right child process. Keyed by catalog id. One download
 * per model at a time — a second request for the same id while one is
 * active returns 409.
 */
/**
 * Per-active-download state for the BGE ONNX downloader.
 *
 * `abortController` fires on CANCEL — kills curl + wipes partial +
 * closes the SSE stream. Pause/resume don't touch it.
 *
 * `pauseResolver` is set while the download loop is parked waiting
 * for a resume signal. The /resume endpoint resolves it; /pause
 * triggers the pause by killing the curl child (which makes the file
 * download exit with non-zero status, falling into the "paused? wait"
 * branch), then sets `pauseResolver`.
 *
 * `pauseRequested` is the boolean flag the loop checks each iteration.
 */
type activeBgeDownload = {
  abortController: AbortController;
  startedAt: number;
  pauseRequested: boolean;
  pauseResolver: (() => void) | null;
  // The currently-spawned curl child for this download. The pause
  // endpoint reaches in via this reference to terminate the in-flight
  // file transfer without touching the cancel controller.
  currentChild: import("node:child_process").ChildProcess | null;
};
const activeBgeDownloads = new Map<string, activeBgeDownload>();

/**
 * Per-active-download state for the GGUF downloader.
 *
 * Mirrors `activeBgeDownload`: abortController fires on CANCEL (wipes
 * partial + closes SSE); pauseRequested + pauseResolver drive the
 * pause/resume flow without touching the abort signal.
 */
type activeLlmDownload = {
  child: ChildProcess | null;
  abortController: AbortController;
  startedAt: number;
  pauseRequested: boolean;
  pauseResolver: (() => void) | null;
};
const activeDownloads = new Map<string, activeLlmDownload>();

/**
 * Catalog of well-known GGUF chat models the local-llm provider
 * can suggest. Sized for SAG's actual use case: chunk extraction +
 * rerank. We deliberately bias toward small + fast because the
 * orchestrator calls the LLM serially (INGEST_CONCURRENCY=1) and a
 * single ingest of a 60-page audit folder can fire 50-100 LLM
 * calls. A 7B Q4 model would balloon that to 30+ minutes.
 *
 * `sagCompatible` mirrors the embedding catalog: every entry here
 * runs against the in-process node-llama-cpp runtime, so the only
 * compatibility check is "the model actually produces JSON-shaped
 * output for the SAG extraction prompt". We mark entries that have
 * been verified end-to-end as `sagCompatible: true`; newer or
 * experimental entries get a flag so the UI can show "works, but
 * expect retries" without hiding them.
 *
 * `sizeHintMB` is the on-disk size of the recommended quantization
 * variant — Q4_K_M is the sweet spot for CPU (Q5 is ~30% slower
 * for <1% accuracy gain on the extraction task).
 */
const LOCAL_LLM_CATALOG: Array<{
  id: string;
  label: string;
  repo: string;
  filename: string;
  sizeHintMB: number;
  contextSize: number;
  speed: "fast" | "medium" | "slow";
  sagCompatible: boolean;
  /** Ordered list of GGUF download URLs. Tried in order; first non-error wins. */
  mirrors: string[];
  notes: string;
  /** UI hint: render the entry as the recommended default pick. */
  recommended?: boolean;
  /** UI hint: warn that this is heavy on low-RAM laptops. */
  heavyOnLaptop?: boolean;
}> = [
  {
    // RECOMMENDED DEFAULT — 8G-no-GPU laptops can still load this.
    // 1.1 GB on disk, ~1.8 GB peak RSS at warmup. Trades some entity-
    // type accuracy (occasionally mixes subject ↔ work) for ~50 t/s on
    // CPU, which keeps a 60-file audit ingest tractable. The QA pair
    // shows 1.5B catches ~85% of entities with correct type vs ~92%
    // for 3B — acceptable trade-off for the speed.
    id: "qwen2.5-1.5b-instruct",
    label: "Qwen2.5-1.5B-Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sizeHintMB: 1100,
    contextSize: 4096,
    speed: "fast",
    sagCompatible: true,
    recommended: true,
    mirrors: [
      "https://www.modelscope.cn/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
      "https://hf-mirror.com/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
    ],
    notes: "中文事件抽取 · 1.1GB · 50+ t/s CPU · 8G 笔记本友好（默认推荐）"
  },
  {
    // Better entity typing, larger model. Use on ≥16 GB laptops or
    // desktops. 2 GB on disk, ~3.2 GB peak RSS.
    id: "qwen2.5-3b-instruct",
    label: "Qwen2.5-3B-Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    sizeHintMB: 2000,
    contextSize: 4096,
    speed: "medium",
    sagCompatible: true,
    heavyOnLaptop: true,
    mirrors: [
      "https://www.modelscope.cn/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
      "https://hf-mirror.com/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf"
    ],
    notes: "中文事件抽取 · 2GB · 30-40 t/s CPU · 笔记本 ≥16 GB RAM 时可选"
  },
  {
    // Highest accuracy. 4.7 GB on disk, ~6.5 GB peak RSS — likely
    // OOMs on 8 GB laptops. Reserve for desktops.
    id: "qwen2.5-7b-instruct",
    label: "Qwen2.5-7B-Instruct (Q4_K_M)",
    repo: "Qwen/Qwen2.5-7B-Instruct-GGUF",
    filename: "qwen2.5-7b-instruct-q4_k_m.gguf",
    sizeHintMB: 4700,
    contextSize: 4096,
    speed: "slow",
    sagCompatible: true,
    heavyOnLaptop: true,
    mirrors: [
      "https://www.modelscope.cn/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
      "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
      "https://hf-mirror.com/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf"
    ],
    notes: "中文事件抽取 · 4.7GB · 12-18 t/s · 精度最高但笔记本慎用 (≥32 GB RAM)"
  }
  // NOTE: SmolLM2-135M and other sagCompatible:false entries were
  // removed 2026-09-13 — they showed up as a "不适用" red badge in
  // the UI which was confusing. Users who want a tiny smoke-test
  // model can drop their own GGUF in (see Custom Model card below).
];

/**
 * Catalog of well-known ONNX embedding models the UI can suggest.
 * Each entry's `repo` is the HuggingFace id; `dim` is the model's
 * native output dimension (drives EMBEDDING_DIMENSIONS compatibility).
 * The catalog intentionally stays small — every entry here is one we
 * have actually shipped in tests; user-supplied paths still work.
 *
 * IMPORTANT — `sagCompatible`:
 *   SAG's SQLite-vec schema locks the embedding tables to FLOAT[1024]
 *   (`src/db/sqlite/migrations/006_vec0_indexes.sql`). Anything with a
 *   different `dim` would either crash on insert or silently corrupt
 *   search results. The catalog marks such entries as `sagCompatible:
 *   false` so the UI can show a clear red banner instead of pretending
 *   the model will work — they still probe + warm up but ingest will
 *   fail with a dimension-mismatch error. The user should pick a 1024d
 *   model unless they've rebuilt the vec0 indexes for the new dim.
 *
 * Speed column reflects the on-device forward pass time on CPU
 * (Xenova/transformers.js) — quantized variants are roughly 2x faster
 * than fp32 but all bge-large variants are still "slow" relative to
 * the smaller models. The "推荐轻量" tag goes to the fastest 1024d
 * compatible entry (currently bge-large-zh-v1.5 with the int8
 * quantized ONNX shipped here — same accuracy as fp32 within ~1% on
 * retrieval, ~326 MB on disk).
 */
const LOCAL_MODEL_CATALOG: Array<{
  id: string;
  label: string;
  repo: string;
  dim: number;
  sizeHintMB: number;
  speed: "fast" | "medium" | "slow";
  sagCompatible: boolean;
  notes: string;
  /**
   * Xenova-published file list to grab. We download only the int8
   * quantized ONNX — the fp32 model.onnx is 4× the size and offers
   * <1% retrieval accuracy improvement. Mirror order: ModelScope first
   * (verified in CN), then HF, then hf-mirror.
   */
  files: string[];
  mirrors: string[];
}> = [
  {
    id: "bge-large-zh-v1.5",
    label: "BGE-large-zh-v1.5",
    repo: "Xenova/bge-large-zh-v1.5",
    dim: 1024,
    sizeHintMB: 326,
    speed: "medium",
    sagCompatible: true,
    notes: "中文向量化 · 与 SAG DB schema 匹配（1024d）· 量化版仅 326MB",
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "vocab.txt",
      "quantize_config.json",
      "onnx/model_int8.onnx"
    ],
    mirrors: [
      "https://hf-mirror.com",
      "https://huggingface.co"
    ]
  },
  {
    id: "bge-m3",
    label: "BGE-M3 (multilingual)",
    repo: "Xenova/bge-m3",
    dim: 1024,
    sizeHintMB: 568,
    speed: "slow",
    sagCompatible: true,
    notes: "多语（中英日韩）· 与 SAG DB schema 匹配（1024d）· 量化版 568MB",
    // File list verified against
    // https://huggingface.co/api/models/Xenova/bge-m3/tree/main — note
    // the tokenizer is sentencepiece-based (no vocab.txt; uses
    // sentencepiece.bpe.model). Previous versions of this list
    // shipped vocab.txt and the download silently 404'd there.
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "sentencepiece.bpe.model",
      "quantize_config.json",
      "onnx/model_int8.onnx"
    ],
    mirrors: [
      "https://hf-mirror.com",
      "https://huggingface.co"
    ]
  }
  // NOTE: bge-small-zh-v1.5 (512d) and bge-base-zh-v1.5 (768d) were
  // removed 2026-09-13 — their hidden_size doesn't match the SAG
  // SQLite-vec schema (FLOAT[1024]). Showing them as a "维度不兼容"
  // red badge was confusing. Users who need a smaller model can use
  // the Custom Model card and point it at any Xenova-compatible ONNX
  // directory that actually outputs 1024d.
];

// Build full Xenova file URLs from a mirror base + repo id + relative path.
// HF resolve endpoint: <base>/<repo>/resolve/main/<rel>
function buildXenovaFileUrl(base: string, repo: string, rel: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return `${trimmed}/${repo}/resolve/main/${rel}`;
}

/**
 * Resolve a (possibly relative) BGE model directory path to an absolute
 * one. Mirrors `resolveLocalLlmModelPath` in src/ai/local-llm-client.ts
 * but specialized for *directories*, not files. The UI fills
 * `models/<id>` from the catalog and we need to map that against the
 * installed models dir regardless of where cwd happens to be.
 *
 *   1. Absolute path as supplied.
 *   2. `<exe-dir>/resources/<rel>` — packaged Electron layout.
 *   3. `<exe-dir>/<rel>`           — SEA-only layout (no resources/).
 *   4. Cwd-relative (last resort)  — dev mode.
 */
function resolveLocalModelDirPath(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  if (path.isAbsolute(trimmed)) return trimmed;

  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(exeDir, "resources", trimmed),
    path.join(exeDir, trimmed)
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return path.join(process.cwd(), trimmed);
}

// Wire an AbortController to a curl child process so cancellation
// tears down curl quickly without us having to repeat the taskkill
// dance at every call site. Returns the abort listener so callers
// can detach if needed.
function attachAbort(child: ChildProcess, controller: AbortController): () => void {
  const onAbort = () => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch { /* ignore */ }
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  return () => controller.signal.removeEventListener("abort", onAbort);
}

async function probeLocalModelDir(
  modelPath: string,
  expectedFiles?: string[]
): Promise<{
  ready: boolean;
  files: string[];
  missing?: string[];
  reason?: string;
}> {
  // A valid transformers.js model directory contains:
  //   - config.json (model config)
  //   - tokenizer.json / tokenizer_config.json
  //   - one or more *.onnx weight files
  // We accept either ONNX or quantized variants.
  //
  // Xenova exports the ONNX weights inside an `onnx/` subfolder (not
  // the model root) so we walk one level deep in addition to the root.
  // Anything deeper than that we leave alone — caller's responsibility
  // to flatten if needed.
  const trimmed = (modelPath ?? "").trim();
  if (!trimmed) {
    return { ready: false, files: [], reason: "path is empty" };
  }
  // Catalog rows ship relative paths like "models/bge-large-zh-v1.5".
  // The probe must resolve those against the installed models dir
  // (which may be `<exe-dir>/resources/models/`) rather than cwd, or
  // every operator-typed "未就绪" silently fails.
  const resolved = resolveLocalModelDirPath(trimmed);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (error) {
    return {
      ready: false,
      files: [],
      reason: `path not accessible (resolved to ${resolved}): ${(error as Error).message}`
    };
  }
  if (!stat.isDirectory()) {
    return { ready: false, files: [], reason: "path is not a directory" };
  }
  let rootNames: string[];
  try {
    rootNames = await fs.readdir(resolved);
  } catch (error) {
    return { ready: false, files: [], reason: `readdir failed: ${(error as Error).message}` };
  }

  // Walk the immediate `onnx/` subfolder if present — that's where
  // Xenova-bge ships its weight files.
  let subNames: string[] = [];
  if (rootNames.includes("onnx")) {
    try {
      subNames = await fs.readdir(path.join(resolved, "onnx"));
    } catch {
      // Subfolder unreadable — treat as "no weights at root" so the
      // user sees a clear "no .onnx weight file found" rather than a
      // cryptic readdir error.
    }
  }

  const allNames = [...rootNames, ...subNames.map((n) => `onnx/${n}`)];
  // Strict mode: when the caller passes the catalog's `files` list,
  // verify every expected file is present by exact path. This catches
  // a real-world regression where an older bge-large-zh-v1.5 download
  // shipped `onnx/model_quantized.onnx` (Xenova's pre-2.13 naming)
  // but the loader expects `onnx/model_int8.onnx` (current Xenova
  // naming). Without this check the probe reports "ready · 8 files"
  // while the warmup fails with `local_files_only`. The alias map
  // accepts older names as a fallback so existing downloads remain
  // usable without forcing a 327 MB re-download.
  const legacyAliases: Record<string, string[]> = {
    "onnx/model_int8.onnx": ["onnx/model_quantized.onnx", "onnx/model_uint8.onnx", "onnx/model_q4.onnx"]
  };
  if (expectedFiles && expectedFiles.length > 0) {
    const missing = expectedFiles.filter((rel) => {
      if (allNames.includes(rel)) return false;
      const aliases = legacyAliases[rel];
      return !aliases || !aliases.some((a) => allNames.includes(a));
    });
    if (missing.length > 0) {
      return {
        ready: false,
        files: allNames.sort(),
        missing,
        reason: `missing catalog file(s): ${missing.join(", ")}`
      };
    }
    return { ready: true, files: allNames.sort() };
  }
  const hasConfig = rootNames.includes("config.json");
  const hasTokenizer = rootNames.some((n) => n.startsWith("tokenizer"));
  const hasWeights = subNames.some((n) => n.endsWith(".onnx") || n.endsWith(".onnx_data"));
  const ready = hasConfig && hasTokenizer && hasWeights;
  let reason: string | undefined;
  if (!hasConfig) reason = "missing config.json";
  else if (!hasTokenizer) reason = "missing tokenizer.json (or tokenizer_config.json)";
  else if (!hasWeights) reason = "no .onnx weight file found (looked in onnx/ subfolder too)";
  return { ready, files: allNames.sort(), reason };
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  // Surface the actual SAG server bind so the web UI can render the
  // HTTP / MCP HTTP endpoints the user needs to configure Agents
  // against. The host is reported as "0.0.0.0" verbatim (not normalized
  // to localhost) so a remote user sees the bind address, not a
  // loopback alias that won't work from another machine.
  app.get("/api/server/info", async () => ({
    httpHost: config.HTTP_HOST,
    httpPort: config.HTTP_PORT,
    mcpHttpPort: config.MCP_HTTP_PORT
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });

  // ── Plan B (2026-09-19): NER model settings routes ────────────────────
  // Catalog / installed / download / cancel / probe / warmup / dispose.
  // See src/api/ner-routes.ts for the full surface.
  registerNerRoutes(app);

  // ── Local BGE embedding model helpers ───────────────────────────────────
  app.get("/api/settings/embedding/local-model/catalog", async () => ({
    catalog: LOCAL_MODEL_CATALOG.map((e) => ({
      // Don't ship the raw file list to the UI — keep the on-wire
      // shape minimal. The download endpoint knows what to fetch.
      id: e.id,
      label: e.label,
      repo: e.repo,
      dim: e.dim,
      sizeHintMB: e.sizeHintMB,
      speed: e.speed,
      sagCompatible: e.sagCompatible,
      notes: e.notes
    })),
    defaultLocalModelPath: "models/bge-large-zh-v1.5",
    // The schema-level dim is 1024 (see SUPPORTED_EMBEDDING_DIMENSIONS);
    // other dims surface as dimension-mismatch errors at ingest time.
    supportedDimensions: [1024],
    // Mirror the LLM catalog: the UI needs to know where to drop a
    // user-supplied model directory (path is relative to process
    // .resourcesPath in packaged mode, ./models in dev mode).
    modelsDir: getModelsInstallDir()
  }));

  /**
   * List BGE model directories currently present on disk. UI uses this
   * to render per-row "已下载" / "点击下载" badges in the catalog.
   * Mirrors /api/settings/llm/local-model/installed.
   */
  app.get("/api/settings/embedding/local-model/installed", async () => {
    const dir = getModelsInstallDir();
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      // No models dir yet — return empty list, not a 500.
    }
    const out: Array<{ id: string; path: string; ready: boolean; reason?: string }> = [];
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try {
        st = await fs.stat(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const probe = await probeLocalModelDir(p);
      const id = LOCAL_MODEL_CATALOG.find((e) => e.id === n)?.id ?? n;
      out.push({ id, path: p, ready: probe.ready, reason: probe.reason });
    }
    return { installed: out, modelsDir: dir };
  });

  /**
   * Download a BGE embedding model from the catalog. The Xenova repo
   * ships ~6 files (config + tokenizer + 1 quantized ONNX). We loop
   * them and use curl with resume so a network blip doesn't restart
   * the 326 MB ONNX from zero.
   *
   * Streamed SSE response shape (mirrors the LLM download):
   *   event: start       → { modelId, path, mirror, files: [...] }
   *   event: file_start  → { file, index, total }
   *   event: progress    → { file, fileBytes, fileTotal, totalBytes, totalDone, totalSize, percent, speedBps }
   *   event: file_done   → { file, fileBytes, tookMs }
   *   event: done        → { path, tookMs }
   *   event: error       → { message }
   *
   * One download per catalog id at a time. 409 on re-request.
   */
  app.post("/api/settings/embedding/local-model/download", async (request, reply) => {
    const body = (request.body ?? {}) as { modelId?: string; mirrorIndex?: number };
    const modelId = (body.modelId ?? "").trim();
    const mirrorIndex = Math.max(0, Math.floor(Number(body.mirrorIndex ?? 0)));
    const entry = LOCAL_MODEL_CATALOG.find((c) => c.id === modelId);
    if (!entry) {
      return reply.code(400).send({ error: `unknown modelId: ${modelId}` });
    }
    const mirrorBase = entry.mirrors[mirrorIndex] ?? entry.mirrors[0];
    if (!mirrorBase) {
      return reply.code(500).send({ error: `catalog entry ${modelId} has no mirrors` });
    }
    if (activeBgeDownloads.has(modelId)) {
      return reply.code(409).send({ error: `download for ${modelId} already in progress` });
    }

    const dir = getModelsInstallDir();
    const dest = path.join(dir, entry.id);
    await fs.mkdir(dest, { recursive: true });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });
    const abortController = new AbortController();
    const startedAt = Date.now();
    const send = (event: string, data: unknown) => {
      // Don't gate on `abortController.signal.aborted` — the user
      // pressing Cancel sets the abort flag, but we still need to
      // emit the final `error: cancelled` event so the UI's auto-
      // dismiss timer fires. The reply.raw.destroyed / writableEnded
      // checks below catch the case where the client actually
      // disconnected.
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch { /* ignore */ }
    };
    activeBgeDownloads.set(modelId, {
      abortController,
      startedAt,
      pauseRequested: false,
      pauseResolver: null,
      currentChild: null
    });
    const active = activeBgeDownloads.get(modelId)!;

    // We don't know total size up-front for every file; fall back to
    // the sizeHintMB figure for an aggregate denominator.
    const totalSizeGuess = entry.sizeHintMB * 1024 * 1024;
    let totalBytesDone = 0;
    let lastReportedBytes = -1;
    let lastPollAt = Date.now();
    let lastPolledBytes = 0;

    const curlBin = process.platform === "win32" ? "curl.exe" : "curl";

    send("start", { modelId, path: dest, mirror: mirrorBase, files: entry.files });

    const fileResults: Array<{ file: string; ok: boolean; bytes: number; tookMs: number; error?: string }> = [];
    let overallError: string | null = null;

    /**
     * Run one curl fetch with up to 2 attempts:
     *   1. `-C -` (resume if a partial file exists on disk).
     *   2. If the first attempt exits non-zero, wipe the partial and
     *      retry with NO `-C -`. This handles the common 416 Range
     *      Not Satisfiable case where a previous interrupted run
     *      left bytes on disk that don't match what the server has.
     */
    const downloadOne = async (
      fileDest: string,
      url: string,
      relForError: string
    ): Promise<{ ok: boolean; paused?: boolean; bytes: number; tookMs: number; error?: string; exitCode: number }> => {
      const baseArgs = [
        "-L", "-f", "-s", "-S",
        "--connect-timeout", "30",
        "--max-time", "86400"
      ];
      const attempt = async (useResume: boolean): Promise<{ exitCode: number; stderrTail: string }> => {
        const args = useResume
          ? [...baseArgs, "-C", "-", "-o", fileDest, url]
          : [...baseArgs, "-o", fileDest, url];
        const child = spawn(curlBin, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
        attachAbort(child, abortController);
        // Expose the in-flight child to the /pause endpoint so it can
        // terminate the curl subprocess without touching the cancel
        // controller (cancel would wipe the partial file).
        active.currentChild = child;
        let stderrTail = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1500);
        });
        const exitCode: number = await new Promise((resolve) => {
          child.on("exit", (code) => resolve(code ?? 1));
        });
        if (active.currentChild === child) active.currentChild = null;
        return { exitCode, stderrTail };
      };

      const t0 = Date.now();
      const first = await attempt(true);
      if (first.exitCode === 0) {
        const st = await fs.stat(fileDest).catch(() => null);
        return { ok: true, bytes: st?.isFile() ? st.size : 0, tookMs: Date.now() - t0, exitCode: 0 };
      }
      // Pause path — the /pause endpoint killed this curl on purpose.
      // DO NOT wipe the partial file; the outer loop will park on
      // pauseResolver and the resume retry will use `-C -` against
      // the bytes already on disk.
      if (active.pauseRequested && !abortController.signal.aborted) {
        const partialBytes = (await fs.stat(fileDest).catch(() => null))?.isFile()
          ? (await fs.stat(fileDest)).size
          : 0;
        logger.info(
          { modelId, file: relForError, partialBytes, exitCode: first.exitCode },
          "settings: BGE downloadOne returning paused (first attempt killed)"
        );
        return {
          ok: false,
          paused: true,
          bytes: partialBytes,
          tookMs: Date.now() - t0,
          exitCode: first.exitCode
        };
      }
      // If the server reports 404 (HTTP 404 / curl exit 22 with "not
      // found"), retrying with no resume header won't help — the URL
      // itself is wrong. Surface a precise error so the user knows
      // it's a catalog mistake, not a flaky network.
      if (/HTTP\/.* 404|\(404\)|"Not Found"|"Entry not found"/i.test(first.stderrTail)) {
        await fs.rm(fileDest, { force: true }).catch(() => undefined);
        return {
          ok: false,
          bytes: 0,
          tookMs: Date.now() - t0,
          exitCode: first.exitCode,
          error: `${relForError} 不在 ${mirrorBase}/${entry.repo} 上，请检查 catalog 文件清单（catalog 可能与上游不一致）`
        };
      }
      // Real error path — wipe partial so a fresh download has a
      // clean slate, then retry without `-C -`.
      await fs.rm(fileDest, { force: true }).catch(() => undefined);
      if (abortController.signal.aborted) {
        return { ok: false, bytes: 0, tookMs: Date.now() - t0, exitCode: first.exitCode, error: "cancelled" };
      }
      logger.warn(
        { modelId, file: relForError, exitCode: first.exitCode, stderr: first.stderrTail },
        "settings: BGE download resume attempt failed, retrying without resume"
      );
      const second = await attempt(false);
      if (second.exitCode === 0) {
        const st = await fs.stat(fileDest).catch(() => null);
        return { ok: true, bytes: st?.isFile() ? st.size : 0, tookMs: Date.now() - t0, exitCode: 0 };
      }
      if (active.pauseRequested && !abortController.signal.aborted) {
        // Pause arrived during the no-resume retry — same handling as
        // above, keep partial for resume.
        const partialBytes = (await fs.stat(fileDest).catch(() => null))?.isFile()
          ? (await fs.stat(fileDest)).size
          : 0;
        return {
          ok: false,
          paused: true,
          bytes: partialBytes,
          tookMs: Date.now() - t0,
          exitCode: second.exitCode
        };
      }
      // Both attempts failed — keep the partial deleted so the next
      // user retry starts clean.
      await fs.rm(fileDest, { force: true }).catch(() => undefined);
      const tail = second.stderrTail.split("\n").filter(Boolean).pop() ?? `curl exit ${second.exitCode}`;
      return {
        ok: false,
        bytes: 0,
        tookMs: Date.now() - t0,
        error: `${tail} (after resume-retry)`,
        exitCode: second.exitCode
      };
    };

    for (let i = 0; i < entry.files.length; i++) {
      if (abortController.signal.aborted) break;
      // Pause-before-file: if pause was requested while we were between
      // files (e.g., user clicked pause right after a file_done event),
      // park before starting the next curl.
      if (active.pauseRequested) {
        send("paused", {
          file: entry.files[i],
          index: i,
          total: entry.files.length,
          partialBytes: 0,
          downloadedBytes: totalBytesDone,
          totalSize: totalSizeGuess,
          percent: Math.max(0, Math.min(100, (totalBytesDone / totalSizeGuess) * 100))
        });
        await new Promise<void>((resolve) => {
          active.pauseResolver = resolve;
        });
        if (abortController.signal.aborted) break;
      }
      const rel = entry.files[i];
      const fileDest = path.join(dest, rel);
      await fs.mkdir(path.dirname(fileDest), { recursive: true });
      const url = buildXenovaFileUrl(mirrorBase, entry.repo, rel);
      const fileStart = Date.now();
      send("file_start", { file: rel, index: i, total: entry.files.length });

      const filePoll = setInterval(() => {
        if (abortController.signal.aborted) return;
        fs.stat(fileDest)
          .then((st) => {
            if (!st.isFile()) return;
            const fileBytes = st.size;
            const now = Date.now();
            const elapsedMs = Math.max(1, now - lastPollAt);
            const bytesPerMs = (totalBytesDone + fileBytes - lastPolledBytes) / elapsedMs;
            const speedBps = Math.max(0, Math.round(bytesPerMs * 1000));
            const totalDone = totalBytesDone + fileBytes;
            const percent = Math.max(0, Math.min(100, (totalDone / totalSizeGuess) * 100));
            if (totalDone - lastReportedBytes > 64 * 1024) {
              send("progress", {
                file: rel,
                fileBytes,
                totalBytes: totalDone,
                totalSize: totalSizeGuess,
                percent,
                speedBps
              });
              lastReportedBytes = totalDone;
            }
          })
          .catch(() => { /* file may not exist yet mid-mkdir */ });
      }, 500);

      const result = await downloadOne(fileDest, url, rel);
      clearInterval(filePoll);
      lastPollAt = Date.now();
      lastPolledBytes = totalBytesDone + result.bytes;

      // Pause path — the /pause endpoint killed the in-flight curl
      // child, the file didn't complete (result.ok === false), but
      // we want to preserve the partial bytes for resume. Park here
      // until /resume is called.
      if (!result.ok && active.pauseRequested && !abortController.signal.aborted) {
        const partialBytes = (await fs.stat(fileDest).catch(() => null))?.isFile()
          ? (await fs.stat(fileDest)).size
          : 0;
        send("paused", {
          file: rel,
          index: i,
          total: entry.files.length,
          partialBytes,
          downloadedBytes: totalBytesDone + partialBytes,
          totalSize: totalSizeGuess,
          percent: Math.max(0, Math.min(100, ((totalBytesDone + partialBytes) / totalSizeGuess) * 100))
        });
        await new Promise<void>((resolve) => {
          active.pauseResolver = resolve;
        });
        // Loop back to retry the same file index (the partial bytes
        // stay on disk, so `attempt(true)` with `-C -` picks up).
        i -= 1;
        continue;
      }

      if (!result.ok || abortController.signal.aborted) {
        fileResults.push({
          file: rel,
          ok: false,
          bytes: 0,
          tookMs: Date.now() - fileStart,
          error: result.error ?? `curl exit ${result.exitCode}`
        });
        overallError = abortController.signal.aborted ? "cancelled" : `failed to download ${rel} (exit ${result.exitCode})`;
        send("file_done", { file: rel, ok: false });
        break;
      }
      fileResults.push({ file: rel, ok: true, bytes: result.bytes, tookMs: Date.now() - fileStart });
      totalBytesDone += result.bytes;
      send("file_done", { file: rel, fileBytes: result.bytes, tookMs: Date.now() - fileStart });
    }

    activeBgeDownloads.delete(modelId);
    if (overallError) {
      send("error", { message: overallError, files: fileResults });
    } else {
      send("done", { path: dest, tookMs: Date.now() - startedAt, files: fileResults });
    }
    try { reply.raw.end(); } catch { /* ignore */ }
  });

  app.post("/api/settings/embedding/local-model/download/cancel", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    const active = activeBgeDownloads.get(modelId);
    if (!active) return { ok: false, error: `no active download for ${modelId}` };
    // If paused, the loop is parked in pauseResolver — wake it so it
    // sees the abort signal and exits cleanly.
    if (active.pauseResolver) {
      const r = active.pauseResolver;
      active.pauseResolver = null;
      r();
    }
    if (active.currentChild) {
      try {
        if (process.platform === "win32" && active.currentChild.pid) {
          spawn("taskkill", ["/F", "/T", "/PID", String(active.currentChild.pid)], { windowsHide: true });
        } else {
          active.currentChild.kill("SIGTERM");
        }
      } catch { /* ignore */ }
    }
    active.abortController.abort();
    return { ok: true };
  });

  /**
   * Pause the in-flight download: terminate the current curl child
   * (its partial file is preserved) and park the loop on
   * pauseResolver. The next /resume call wakes it.
   */
  app.post("/api/settings/embedding/local-model/download/pause", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    const active = activeBgeDownloads.get(modelId);
    if (!active) return { ok: false, error: `no active download for ${modelId}` };
    if (active.pauseRequested) return { ok: true, alreadyPaused: true };
    active.pauseRequested = true;
    logger.info(
      { modelId, hasChild: !!active.currentChild, childPid: active.currentChild?.pid },
      "settings: BGE pause requested"
    );
    if (active.currentChild && active.currentChild.pid) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(active.currentChild.pid)], { windowsHide: true });
        } else {
          active.currentChild.kill("SIGTERM");
        }
      } catch { /* ignore */ }
    }
    // If the loop is between files (no curl child), we still need to
    // park it on the next iteration's pause check — that's fine,
    // pauseRequested is checked at the top of each iteration's flow.
    return { ok: true };
  });

  /** Resume a paused download — resolves pauseResolver; loop retries the current file with `-C -`. */
  app.post("/api/settings/embedding/local-model/download/resume", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    const active = activeBgeDownloads.get(modelId);
    if (!active) return { ok: false, error: `no active download for ${modelId}` };
    if (!active.pauseRequested) return { ok: true, alreadyRunning: true };
    active.pauseRequested = false;
    if (active.pauseResolver) {
      const r = active.pauseResolver;
      active.pauseResolver = null;
      r();
    }
    return { ok: true };
  });

  app.get("/api/settings/embedding/local-model/probe", async (request) => {
    // Frontend hits GET /probe?path=<p>. We stat the (resolved) directory
    // and return { ready, files, reason } — no model load, no side
    // effects. The misnamed earlier version of this route called
    // warmupLocalBgeWorker instead, which meant typing any path
    // silently started loading 1.3 GB of ONNX into RAM.
    const q = request.query as { path?: unknown };
    const rawPath = typeof q.path === "string" ? q.path : "";
    const resolved = resolveLocalModelDirPath(rawPath);
    // Match the operator's path against a known catalog entry so we
    // can pass its `files` list into the probe. Without this, a
    // bge-large-zh-v1.5 directory with the older `model_quantized.onnx`
    // (instead of the current `model_int8.onnx`) reports "ready · 8
    // files" while warmup fails with `local_files_only`. Strict
    // matching catches the mismatch and surfaces it to the UI.
    const trimmed = rawPath.trim();
    const id = trimmed.startsWith("models/") ? trimmed.slice("models/".length).replace(/\/+$/, "") : "";
    const catalogEntry = LOCAL_MODEL_CATALOG.find((c) => c.id === id);
    const probe = await probeLocalModelDir(rawPath, catalogEntry?.files);
    return {
      path: rawPath,
      resolvedPath: resolved,
      ...probe
    };
  });

  app.post("/api/settings/embedding/local-model/warmup", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string };
    const rawPath = (body.modelPath ?? "").trim();
    if (!rawPath) {
      return { ok: false, error: "modelPath is required" };
    }
    // The catalog fills `models/<id>` — a relative path that resolves
    // against the installed models dir, NOT cwd. cwd happens to be
    // `<install-root>/` (Electron spawn working dir), so a bare
    // path.resolve would miss by one directory.
    const modelPath = resolveLocalModelDirPath(rawPath);
    const t0 = Date.now();
    try {
      const { warmupLocalBgeWorker } = await import("../ai/embedding-client.js");
      await warmupLocalBgeWorker(modelPath);
      return { ok: true, tookMs: Date.now() - t0, resolvedPath: modelPath };
    } catch (error) {
      logger.warn({ modelPath, error: (error as Error).message }, "settings: local-model warmup failed");
      return { ok: false, tookMs: Date.now() - t0, error: (error as Error).message, resolvedPath: modelPath };
    }
  });

  app.post("/api/settings/embedding/local-model/test", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; text?: string };
    const rawPath = (body.modelPath ?? "").trim();
    const text = (body.text ?? "").trim() || "hello";
    if (!rawPath) {
      return { ok: false, error: "modelPath is required" };
    }
    const modelPath = resolveLocalModelDirPath(rawPath);
    const t0 = Date.now();
    try {
      // Use the worker-first path (not localBgeEmbeddingInProcess
      // directly) so a native ONNX crash is isolated to the worker
      // thread instead of taking the whole backend down (desktop
      // 闪退, exit 0xC06D007F with the pre-2026-10-14 truncated
      // model file). If the worker can't spawn, the wrapper falls
      // back to in-process automatically.
      const { localBgeEmbeddingPreferWorker } = await import("../ai/embedding-client.js");
      const vec = await localBgeEmbeddingPreferWorker(
        modelPath,
        [text],
        config.EMBEDDING_DIMENSIONS
      );
      const first = vec[0] ?? [];
      return {
        ok: true,
        tookMs: Date.now() - t0,
        dim: first.length,
        sample: Array.from(first.slice(0, 5)).map((v) => Number(v.toFixed(6)))
      };
    } catch (error) {
      logger.warn({ modelPath, error: (error as Error).message }, "settings: local-model test failed");
      return { ok: false, tookMs: Date.now() - t0, error: (error as Error).message };
    }
  });

  // ── Local LLM (GGUF) helpers ───────────────────────────────────────────
  // Mirrors the embedding endpoints above. Catalog → probe → warmup
  // → test gives the UI the same one-click workflow that local-bge
  // uses; the underlying loader is `node-llama-cpp` (see
  // src/ai/local-llm-client.ts for the JSON-grammar implementation).
  app.get("/api/settings/llm/local-model/catalog", async () => ({
    catalog: LOCAL_LLM_CATALOG,
    defaultLocalModelPath: "models/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    defaultContextSize: 4096,
    modelsDir: getModelsInstallDir()
  }));

  /**
   * List GGUF files currently present on disk in the models directory.
   * The Web UI merges this with the catalog to render an "已下载" badge
   * and to decide whether clicking a catalog row should fill the path
   * (already installed) or trigger a download (not installed).
   *
   * We don't restrict to catalog entries — user-supplied GGUFs also
   * count as installed. The id is derived from the filename; if it
   * matches a known catalog entry, that label is surfaced, otherwise
   * the bare filename is shown.
   */
  app.get("/api/settings/llm/local-model/installed", async () => {
    const dir = getModelsInstallDir();
    let names: string[] = [];
    try {
      await fs.mkdir(dir, { recursive: true });
      names = await fs.readdir(dir);
    } catch (error) {
      logger.warn({ dir, error: (error as Error).message }, "settings: cannot list models dir");
      return { dir, installed: [] };
    }
    const installed: Array<{
      id: string;
      filename: string;
      path: string;
      sizeBytes: number;
      mtime: string;
      label?: string;
      sizeHintMB?: number;
      sagCompatible?: boolean;
      /**
       * True iff the on-disk file is at least 95% of the catalog
       * sizeHintMB. A file present but truncated (e.g. a previous
       * download was interrupted before the completion-validation
       * check existed, or the user killed curl mid-flight) is
       * flagged `complete: false` so the UI can show "需重新下载"
       * instead of the misleading "已下载". Without this field the
       * UI was happy to label a 66 MB stub as installed just because
       * the filename matched.
       */
      complete: boolean;
    }> = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".gguf")) continue;
      const full = path.join(dir, name);
      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue; // EISDIR defense — skip dirs matching .gguf name
      const catalogMatch = LOCAL_LLM_CATALOG.find((c) => c.filename === name);
      const expectedBytes = catalogMatch ? catalogMatch.sizeHintMB * 1024 * 1024 : null;
      const complete =
        expectedBytes === null ? true : stat.size >= expectedBytes * 0.95;
      installed.push({
        id: catalogMatch?.id ?? name.replace(/\.gguf$/i, ""),
        filename: name,
        path: full,
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString(),
        label: catalogMatch?.label,
        sizeHintMB: catalogMatch?.sizeHintMB,
        sagCompatible: catalogMatch?.sagCompatible,
        complete
      });
    }
    return { dir, installed };
  });

  // Resolve a possibly-relative path to an absolute one and stat it.
  // Returns the resolved path (so the UI can show the user the
  // "actual" file we're about to load) plus ready/reason.
  app.get("/api/settings/llm/local-model/probe", async (request) => {
    const q = request.query as { path?: unknown };
    const modelPath = typeof q.path === "string" ? q.path : "";
    const { resolveLocalLlmModelPath, getLoadedLocalLlmInfo } = await import("../ai/local-llm-client.js");
    const resolved = resolveLocalLlmModelPath(modelPath);
    if (!resolved) {
      return { path: modelPath, resolved: "", ready: false, reason: "path is empty" };
    }
    const exists = existsSync(resolved);
    const isGguf = resolved.toLowerCase().endsWith(".gguf");
    let sizeBytes: number | null = null;
    if (exists) {
      try {
        sizeBytes = statSync(resolved).size;
      } catch {
        /* swallow — size stays null */
      }
    }
    const loaded = getLoadedLocalLlmInfo();
    return {
      path: modelPath,
      resolved,
      ready: exists && isGguf,
      isGguf,
      sizeBytes,
      // Surface the loaded-model state so the UI can show
      // "currently loaded: Qwen2.5-3B-Instruct (Q4_K_M)" without
      // a separate `/loaded` round trip.
      loaded: loaded && loaded.path === resolved ? loaded : null,
      reason: !exists
        ? `file not found: ${resolved}`
        : !isGguf
          ? "file is not a .gguf"
          : undefined
    };
  });

  // Load (or reload) the GGUF. We pass the configured context size
  // through so the warmup honours whatever the user picked in the
  // UI — the default of 4096 fits the SAG prompt with headroom.
  app.post("/api/settings/llm/local-model/warmup", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; contextSize?: number; forceReload?: boolean };
    const modelPath = (body.modelPath ?? "").trim();
    const contextSize = Math.max(256, Math.min(32_768, Number(body.contextSize ?? 4096) || 4096));
    const t0 = Date.now();
    try {
      const { loadLocalLlmModel, disposeLocalLlmModel, getLoadedLocalLlmInfo } = await import("../ai/local-llm-client.js");
      // `modelPath` may be empty when the Performance Settings panel
      // triggers a reload after changing `llmThreads` — in that case we
      // reuse whichever model is already loaded. The user almost always
      // has the same model loaded when nudging threads, so this avoids
      // threading the path through the perf UI.
      const effectivePath =
        modelPath ||
        getLoadedLocalLlmInfo()?.inputPath ||
        getLoadedLocalLlmInfo()?.path ||
        "";
      if (!effectivePath) return { ok: false, error: "modelPath is required (no model is currently loaded)" };
      // Read the latest performance settings async so we can hand
      // `threads` to createContext directly. `getRuntimePerformanceSettings`
      // is sync and only sees the in-process cache, which can return
      // env defaults right after a PUT invalidated it. The explicit
      // option is the safe path for hot-reload.
      const performance = await performanceSettingsService.getEffective();
      if (body.forceReload) {
        await disposeLocalLlmModel();
      }
      const info = await loadLocalLlmModel(effectivePath, contextSize, {
        threads: performance.llmThreads
      });
      logger.info(
        { modelPath: effectivePath, contextSize, threads: performance.llmThreads, forceReload: body.forceReload ?? false },
        "settings: local-llm warmup"
      );
      return { ok: true, tookMs: Date.now() - t0, loaded: info, threads: performance.llmThreads };
    } catch (error) {
      logger.warn({ modelPath, error: (error as Error).message }, "settings: local-llm warmup failed");
      return { ok: false, tookMs: Date.now() - t0, error: (error as Error).message };
    }
  });

  // Force-unload. Used when the operator wants to free RSS without
  // restarting the server, or before pointing at a different GGUF.
  app.post("/api/settings/llm/local-model/dispose", async () => {
    try {
      const { disposeLocalLlmModel } = await import("../ai/local-llm-client.js");
      await disposeLocalLlmModel();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  /**
   * Download a catalog GGUF with SSE progress events.
   *
   *   Body: { modelId: string, mirrorIndex?: number }
   *   Stream:
   *     event: start     → { modelId, path, totalBytes?, mirror }
   *     event: progress  → { downloadedBytes, totalBytes?, percent, speedBps, etaSec }
   *     event: done      → { path, sizeBytes, tookMs, mirror }
   *     event: error     → { message }
   *
   * Implementation notes:
   *   - We shell out to `curl.exe` because (a) it ships with Windows 10/11
   *     so there's no extra binary to bundle, (b) it has built-in `-C -`
   *     resume, so a network blip just retries the unfinished tail, and
   *     (c) its stdout is easy to silence so the Fastify response stream
   *     is the only thing the user sees.
   *   - Progress is derived by polling `fs.stat(dest).size` every 500ms.
   *     Curl's own progress meter is suppressed; we surface one source of
   *     truth (the actual file on disk) rather than racing curl's stderr
   *     against disk I/O.
   *   - Total size comes from Content-Length when curl emits it on stderr.
   *     When the mirror doesn't return Content-Length (rare; ModelScope /
   *     HF both do), the percent field stays 0 and the UI shows MB only.
   *   - EISDIR defense: if a directory with the destination filename
   *     exists on disk (the same shape-mismatch bug we've seen before),
   *     we rmdir it before curl starts.
   *   - One download per catalog id at a time. Re-requesting returns 409.
   *   - Cancellable via POST /download/cancel — kills the child process
   *     AND removes the partial file so a retry starts clean.
   */
  app.post("/api/settings/llm/local-model/download", async (request, reply) => {
    const body = (request.body ?? {}) as { modelId?: string; mirrorIndex?: number };
    const modelId = (body.modelId ?? "").trim();
    const mirrorIndex = Math.max(0, Math.floor(Number(body.mirrorIndex ?? 0)));

    const entry = LOCAL_LLM_CATALOG.find((c) => c.id === modelId);
    if (!entry) {
      return reply.code(400).send({ error: `unknown modelId: ${modelId}` });
    }
    let mirror = entry.mirrors[mirrorIndex] ?? entry.mirrors[0];
    if (!mirror) {
      return reply.code(500).send({ error: `catalog entry ${modelId} has no mirrors` });
    }
    if (activeDownloads.has(modelId)) {
      return reply.code(409).send({ error: `download for ${modelId} already in progress` });
    }

    const dir = getModelsInstallDir();
    const dest = path.join(dir, entry.filename);

    // EISDIR shape-mismatch defense. We've shipped at least one incident
    // where a directory ended up at the GGUF path and node-llama-cpp
    // crashed with `illegal operation on a directory, read`. Same hazard
    // applies here — if anything ever wrote a dir at <dest>, curl will
    // silently fail in confusing ways. Wipe any pre-existing shape that
    // isn't a regular file.
    //
    // Also short-circuit if a fully-complete file is already on disk
    // (≥ 95% of sizeHintMB — the completion check below uses the same
    // threshold so a "complete" call here and a "complete" call from
    // curl exit 0 are mutually consistent).
    let resumedFromBytes = 0;
    try {
      const st = await fs.stat(dest).catch(() => null);
      if (st) {
        if (st.isDirectory()) {
          await fs.rm(dest, { recursive: true, force: true });
        } else if (st.isFile()) {
          const expected = entry.sizeHintMB * 1024 * 1024;
          if (st.size >= expected * 0.95) {
            return {
              path: dest,
              alreadyComplete: true,
              sizeBytes: st.size
            };
          }
          if (st.size > 0) {
            // Partial download on disk — curl will resume from this
            // byte offset via `-C -`. Surface it on the SSE `start`
            // event so the UI can render "Resuming from X MB" instead
            // of looking like a fresh download every retry.
            resumedFromBytes = st.size;
          }
        }
      }
    } catch {
      /* best-effort */
    }
    await fs.mkdir(dir, { recursive: true });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });
    const abortController = new AbortController();
    const startedAt = Date.now();
    const send = (event: string, data: unknown) => {
      // Don't gate on `abortController.signal.aborted` — the user
      // pressing Cancel sets the abort flag, but we still need to
      // emit the final `error: cancelled` event so the UI's auto-
      // dismiss timer fires. The reply.raw.destroyed / writableEnded
      // checks below catch the case where the client actually
      // disconnected.
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      try {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* ignore write errors — caller will trigger error path */
      }
    };

    // Use the system curl. On Windows it's `C:\Windows\System32\curl.exe`
    // (ships since Windows 10 1803); on macOS/Linux it's on PATH.
    const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
    const buildCurlArgs = () => [
      "-L", // follow redirects (ModelScope → OSS / HF CDN both redirect)
      "-f", // fail on HTTP 4xx/5xx (no body write)
      "-s", // silent
      "-S", // but show errors
      "-C", "-", // resume from previous byte position if dest exists
      "--connect-timeout", "30",
      "--max-time", "86400", // 24h ceiling per attempt
      "-w", "%{http_code} %{size_download} %{size_header}\n", // final line we parse
      "-o", dest,
      "-X", "GET",
      mirror
    ];
    // Force curl.exe to resolve DNS fresh for every attempt. SEA's
    // child processes inherit an undocumented DNS cache layer from
    // the host (a Windows behaviour specific to long-running native
    // processes spawned with `windowsHide: true`); curl --version
    // resolves fine but the first GET sometimes hits `curl: (6)
    // Could not resolve host` before the cache warms. `--ipv4`
    // sidesteps the IPv6 race that triggers this in practice.
    if (process.platform === "win32") {
      process.env.CURL_RESOLVE = "1";
    }

    logger.info({ modelId, mirror, dest }, "settings: starting GGUF download");
    // Snapshot the on-disk size BEFORE curl opens the file so the UI
    // can show "resuming from X MB" when the user is retrying a
    // partial download. A non-zero value means curl will use `-C -`
    // and pick up from this byte offset instead of starting over —
    // surfacing that distinction here stops the user from thinking
    // "why is it downloading again?" every time they click the
    // catalog row. (resumedFromBytes was computed by the EISDIR /
    // already-complete stat block at the top of this handler.)
    send("start", {
      modelId,
      path: dest,
      mirror,
      filename: entry.filename,
      sizeHintMB: entry.sizeHintMB,
      resumedFromBytes
    });

    // Seed `totalBytes` from the catalog's `sizeHintMB` so the
    // progress bar can render a real percentage from the very first
    // tick. curl only emits `Content-Length` to stderr in verbose
    // mode (and we run with `-s -S`), so without this seed every
    // progress event would carry `percent: 0` even as bytes flow
    // because `totalBytes` is null. If a real `Content-Length`
    // arrives mid-download and disagrees with the catalog estimate
    // (rare — HF and ModelScope both ship the exact on-disk size
    // for the recommended quant), we let the header value win.
    let totalBytes: number | null = entry.sizeHintMB * 1024 * 1024;
    let headerBytes = 0;
    let lastReportedBytes = -1;
    let lastPollAt = Date.now();
    let lastPolledBytes = 0;

    /**
     * Run one curl child to completion (success / error / pause-kill).
     * Returns the curl exit code AND the captured stderr tail. Callers
     * decide what to do next (resume, surface error, end the loop).
     */
    const spawnCurlOnce = (): Promise<{ exitCode: number; stderrTail: string; signal: NodeJS.Signals | null }> => {
      const child = spawn(curlBin, buildCurlArgs(), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      // Reflect into the active map so the /pause endpoint can reach
      // the live child for taskkill (separate from abortController so
      // pause doesn't wipe the partial file).
      const slot = activeDownloads.get(modelId);
      if (slot) slot.child = child;

      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail = (stderrTail + text).slice(-2000);
        const m = /Content-Length:\s*(\d+)/i.exec(text);
        if (m && !totalBytes) {
          const v = Number(m[1]);
          if (Number.isFinite(v) && v > 0) totalBytes = v;
        }
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        const m = /^(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(text);
        if (m) headerBytes = Number(m[3]);
      });

      return new Promise((resolve) => {
        child.on("error", (err) => {
          stderrTail = (stderrTail + " " + err.message).slice(-2000);
          resolve({ exitCode: 1, stderrTail, signal: null });
        });
        child.on("close", (code, signal) => {
          resolve({ exitCode: code ?? 1, stderrTail, signal });
        });
      });
    };

    // Poll the destination file size on a timer. Mirrors the previous
    // implementation but now lives at module scope (not per-spawn) so
    // pause→resume doesn't drop progress events across the gap.
    const pollTimer = setInterval(() => {
      if (abortController.signal.aborted) return;
      const slot = activeDownloads.get(modelId);
      if (slot?.pauseRequested) return;
      fs.stat(dest)
        .then((st) => {
          if (!st.isFile()) return;
          const downloadedBytes = st.size;
          const now = Date.now();
          const elapsedMs = Math.max(1, now - lastPollAt);
          const bytesPerMs = (downloadedBytes - lastPolledBytes) / elapsedMs;
          const speedBps = Math.max(0, Math.round(bytesPerMs * 1000));
          const etaSec =
            speedBps > 0 && totalBytes
              ? Math.max(0, Math.round((totalBytes - downloadedBytes) / speedBps))
              : null;
          const percent = totalBytes ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 1000) / 10) : 0;
          lastPollAt = now;
          lastPolledBytes = downloadedBytes;
          if (downloadedBytes !== lastReportedBytes) {
            lastReportedBytes = downloadedBytes;
            send("progress", {
              downloadedBytes,
              totalBytes: totalBytes ?? undefined,
              percent,
              speedBps,
              etaSec
            });
          }
        })
        .catch(() => {
          /* dest not yet created — first poll before curl opens the file */
        });
    }, 500);

    activeDownloads.set(modelId, {
      // Real child is set by spawnCurlOnce a few lines down. Using a
      // placeholder (e.g. `curl --version`) means the dummy exits in
      // milliseconds and its PID gets recycled by Windows, so a later
      // taskkill via /pause or /cancel can kill an unrelated process.
      // `child: null` lets the cancel/pause handlers no-op safely
      // until the first real child is wired in.
      child: null,
      abortController,
      startedAt,
      pauseRequested: false,
      pauseResolver: null
    });

    const cleanup = () => {
      clearInterval(pollTimer);
      activeDownloads.delete(modelId);
    };

    /**
     * Send the paused event with current on-disk partial size, then
     * park on the resume endpoint's signal. The next /resume call
     * resolves `pauseResolver`; the outer loop re-spawns curl with
     * `-C -` against the saved bytes.
     */
    const waitForResume = async (): Promise<boolean> => {
      const partialBytes = (await fs.stat(dest).catch(() => null))?.isFile()
        ? (await fs.stat(dest)).size
        : 0;
      send("paused", {
        downloadedBytes: partialBytes,
        totalBytes: totalBytes ?? undefined,
        percent: totalBytes ? Math.min(100, Math.round((partialBytes / totalBytes) * 1000) / 10) : 0
      });
      const slot = activeDownloads.get(modelId);
      if (!slot) return false;
      return await new Promise<boolean>((resolve) => {
        slot.pauseResolver = () => resolve(true);
      });
    };

    // Run the curl in a pause-aware loop. Each iteration spawns one
    // child against the current mirror. The loop exits when (a) curl
    // exits 0 (done), (b) the abortController fires (cancel/stream
    // close), or (c) curl exits non-zero with no pause pending and no
    // mirror fallback remaining (true error).
    //
    // Mirror fallback: a "Could not resolve host" (curl exit 6) or a
    // connection reset (curl exit 56) usually means the picked
    // mirror is unreachable from this network (DNS caching quirks,
    // regional CDN issue, etc.). Instead of failing the whole
    // download we walk the remaining `entry.mirrors` list — same
    // `-C -` semantics, so the partial bytes are preserved.
    (async () => {
      try {
        let exit: { exitCode: number; stderrTail: string; signal: NodeJS.Signals | null } | null = null;
        let mirrorIdx = mirrorIndex;
        const totalMirrors = entry.mirrors.length;
        const triedMirrors: string[] = [];
        let lastCurlErr: string | null = null;
        while (true) {
          const slot = activeDownloads.get(modelId);
          if (!slot) return; // cancelled mid-pause

          // Pause-before-spawn: /pause arrived while we were between
          // runs (e.g., the previous run finished but the user
          // clicked pause just before resume could fire).
          if (slot.pauseRequested) {
            const resumed = await waitForResume();
            if (!resumed) return;
          }

          // Pick the active mirror. If a previous attempt failed in a
          // way that warrants a fallback, advance.
          const activeMirror = entry.mirrors[mirrorIdx] ?? entry.mirrors[0];
          if (activeMirror !== mirror) {
            mirror = activeMirror;
            send("mirror-switch", {
              mirror,
              index: mirrorIdx,
              total: totalMirrors,
              reason: lastCurlErr ?? "previous mirror failed"
            });
          }

          exit = await spawnCurlOnce();
          triedMirrors.push(activeMirror);

          if (abortController.signal.aborted) break;

          if (exit.exitCode === 0) break; // success

          const slotAfter = activeDownloads.get(modelId);
          if (slotAfter?.pauseRequested && !abortController.signal.aborted) {
            const resumed = await waitForResume();
            if (!resumed) break;
            continue;
          }

          // Non-zero exit. Decide whether to fall back to the next
          // mirror. Curl exit codes that mean "this mirror is
          // unreachable from this network" — and are NOT caused by
          // the user cancelling or by the partial file going bad:
          //   6  Could not resolve host
          //   7  Could not connect
          //   28 Operation timeout (used both for connect and for
          //      transfer — but the `LastReportedBytes` loop above
          //      catches stuck transfers)
          //   35, 56  TLS / connection reset mid-stream
          //   52  empty reply from server
          //   18  partial file transfer (server hung up)
          const tail = exit.stderrTail;
          const isTransientNetErr =
            exit.exitCode === 6 ||
            exit.exitCode === 7 ||
            exit.exitCode === 28 ||
            exit.exitCode === 35 ||
            exit.exitCode === 56 ||
            exit.exitCode === 52 ||
            exit.exitCode === 18;
          if (isTransientNetErr && mirrorIdx + 1 < totalMirrors) {
            lastCurlErr = `curl exit ${exit.exitCode}: ${
              tail.split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "unknown"
            }`;
            mirrorIdx += 1;
            // Don't wipe the partial — the next curl with `-C -`
            // will resume from it.
            continue;
          }
          break; // real error, no more mirrors to try
        }

        cleanup();

        if (abortController.signal.aborted) {
          await fs.rm(dest, { force: true }).catch(() => undefined);
          send("error", { message: "cancelled" });
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
          return;
        }
        if (!exit || exit.exitCode !== 0) {
          const tail = (exit?.stderrTail ?? "")
            .split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
          send("error", {
            message: `curl exited with code ${exit?.exitCode ?? -1}${tail ? ` · ${tail}` : ""}`,
            code: exit?.exitCode,
            tried: triedMirrors
          });
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
          return;
        }
        const st = await fs.stat(dest).catch(() => null);
        const finalSize = st?.isFile() ? st.size : 0;
        // Completion validation: a curl that exits 0 with a
        // truncated file (e.g. a mirror that quietly truncated the
        // response, or a user kill that landed mid-flush) would
        // otherwise leave a 66 MB / 1100 MB stub that the UI happily
        // labels as "已下载" because the filename exists. We reject
        // anything < 95% of the catalog sizeHintMB, delete the
        // partial, and surface a clear error so the user knows to
        // retry (which will then start clean because dest is gone).
        const expected = entry.sizeHintMB * 1024 * 1024;
        if (finalSize < expected * 0.95) {
          logger.warn(
            {
              modelId,
              dest,
              finalSize,
              expected,
              ratio: expected > 0 ? finalSize / expected : 0,
              mirror
            },
            "settings: GGUF download marked done but file is too small; deleting"
          );
          await fs.rm(dest, { force: true }).catch(() => undefined);
          send("error", {
            message: `下载不完整：${(finalSize / 1024 / 1024).toFixed(1)} MB / 期望 ${entry.sizeHintMB} MB。请重试。`,
            code: "INCOMPLETE_FILE",
            expectedBytes: expected,
            actualBytes: finalSize,
            tried: triedMirrors
          });
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
          return;
        }
        send("done", {
          path: dest,
          sizeBytes: finalSize,
          tookMs: Date.now() - startedAt,
          mirror
        });
        logger.info(
          { modelId, dest, sizeBytes: finalSize, tookMs: Date.now() - startedAt, mirror },
          "settings: GGUF download complete"
        );
      } finally {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    })();

    // Wire cancellation: client disconnect OR explicit abort
    const abortNow = () => {
      const slot = activeDownloads.get(modelId);
      if (slot?.pauseResolver) {
        const r = slot.pauseResolver;
        slot.pauseResolver = null;
        // Signal the waitForResume Promise to return false so the
        // outer loop sees "no slot, bail out" instead of looping.
        r();
      }
      abortController.abort();
      try {
        if (slot?.child?.pid) {
          if (process.platform === "win32") {
            spawn("taskkill", ["/F", "/T", "/PID", String(slot.child.pid)], { windowsHide: true });
          } else {
            slot.child.kill("SIGTERM");
          }
        }
      } catch {
        /* ignore */
      }
    };
    request.raw.on("aborted", abortNow);
    reply.raw.on("close", abortNow);
  });

  /**
   * Cancel an in-flight download. No-op if no download for that id is
   * active. Also wipes the partial file so a retry starts clean.
   */
  app.post("/api/settings/llm/local-model/download/cancel", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    if (!modelId) return { ok: false, error: "modelId is required" };
    const active = activeDownloads.get(modelId);
    if (!active) return { ok: false, error: "no active download for that id" };
    // If we're parked on pause, wake the resolver so the outer loop
    // sees the abort signal and exits cleanly instead of waiting
    // forever for /resume.
    if (active.pauseResolver) {
      const r = active.pauseResolver;
      active.pauseResolver = null;
      r();
    }
    active.abortController.abort();
    try {
      if (active.child?.pid) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(active.child.pid)], { windowsHide: true });
        } else {
          active.child.kill("SIGTERM");
        }
      }
    } catch {
      /* ignore */
    }
    return { ok: true, modelId };
  });

  /**
   * Pause the in-flight GGUF download: terminate the current curl
   * child (its partial file is preserved) and park the loop on
   * pauseResolver. The next /resume call wakes it.
   */
  app.post("/api/settings/llm/local-model/download/pause", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    if (!modelId) return { ok: false, error: "modelId is required" };
    const active = activeDownloads.get(modelId);
    if (!active) return { ok: false, error: "no active download for that id" };
    if (active.pauseRequested) return { ok: true, alreadyPaused: true };
    active.pauseRequested = true;
    logger.info(
      { modelId, hasChild: !!active.child, childPid: active.child?.pid },
      "settings: LLM pause requested"
    );
    if (active.child?.pid) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/F", "/T", "/PID", String(active.child.pid)], { windowsHide: true });
        } else {
          active.child.kill("SIGTERM");
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  });

  /** Resume a paused GGUF download — resolves pauseResolver; loop re-spawns curl with `-C -`. */
  app.post("/api/settings/llm/local-model/download/resume", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = (body.modelId ?? "").trim();
    if (!modelId) return { ok: false, error: "modelId is required" };
    const active = activeDownloads.get(modelId);
    if (!active) return { ok: false, error: "no active download for that id" };
    if (!active.pauseRequested) return { ok: true, alreadyRunning: true };
    active.pauseRequested = false;
    if (active.pauseResolver) {
      const r = active.pauseResolver;
      active.pauseResolver = null;
      r();
    }
    return { ok: true };
  });

  // Run a tiny smoke-test against the loaded model and return the
  // generated text so the UI can show "模型工作正常 ✓" without ever
  // entering the JSON-schema grammar sampler. The full extraction
  // grammar has a known GBNF deadlock on Qwen2.5 + CPU (see
  // sag_local-llm-grammar-deadlock-20260917.md), so /test stays on
  // the plain-completion path. Mirrors the embedding `/test`
  // endpoint shape so the UI badge logic stays uniform.
  app.post("/api/settings/llm/local-model/test", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; text?: string };
    const modelPath = (body.modelPath ?? "").trim();
    const text = (body.text ?? "").trim() || "审计发现：张三在北京签署了一份关于 Q4 销售报表。";
    if (!modelPath) return { ok: false, error: "modelPath is required" };
    const t0 = Date.now();
    try {
      const { loadLocalLlmModel, smokeTestLocalLlm } = await import("../ai/local-llm-client.js");
      await loadLocalLlmModel(modelPath, 4096);
      const settings = await aiSettingsService.getRuntimeSettings();
      const result = await smokeTestLocalLlm(settings, {
        system: "你是一个 SAG 审计助手。请严格按照 JSON 格式输出，不要任何解释或额外文字。",
        user: text
      });
      // Shape mirrors what the UI expects from the legacy "extraction
      // test" path: title / summary / entities / counts. The backend
      // also returns the raw `text` + `tokenCount` so a future
      // redesign of the UI badge has the raw model output to render.
      return {
        ok: true,
        tookMs: result.tookMs,
        text: result.text,
        tokenCount: result.tokenCount,
        eventCount: result.eventCount ?? 0,
        entityCount: result.entityCount ?? 0,
        entities: result.entities ?? [],
        title: result.title ?? null,
        summary: result.summary ?? null
      };
    } catch (error) {
      const msg = (error as Error)?.message || (typeof error === "string" ? error : JSON.stringify(error));
      logger.warn({ modelPath, error: msg, stack: (error as Error)?.stack }, "settings: local-llm test failed");
      return { ok: false, tookMs: Date.now() - t0, error: msg };
    }
  });

  // Production extraction smoke test. Goes through the REAL
  // extractEventsViaLocalLlm path (GBNF grammar + full
  // schema) so we can verify the deadlock-prone code path isn't
  // actually deadlocking on this machine. The plain-completion
  // /test endpoint above is fast and safe; this one is slow and
  // should match ingest throughput. If it hangs, the GBNF
  // sampler is wedged again (see
  // sag_local-llm-grammar-deadlock-20260917.md).
  app.post("/api/settings/llm/local-model/test-extraction", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; text?: string };
    const modelPath = (body.modelPath ?? "").trim();
    const text = (body.text ?? "").trim() || "审计发现：张三在 2025 年 10 月于北京签署了关于 Q4 销售报表的合规审查文件。";
    if (!modelPath) return { ok: false, error: "modelPath is required" };
    const t0 = Date.now();
    try {
      const { loadLocalLlmModel, extractEventsViaLocalLlm } = await import("../ai/local-llm-client.js");
      await loadLocalLlmModel(modelPath, 4096);
      const settings = await aiSettingsService.getRuntimeSettings();
      const events = await extractEventsViaLocalLlm(settings, {
        system:
          "你是一个 SAG 审计助手。请从给定的 chunk 中抽取 1 个事件及其关联实体。返回的 JSON 顶层形如 {data:{items:[{...}]}}。只输出 JSON。",
        user: text,
        operation: "smoke-test"
      });
      return {
        ok: true,
        tookMs: Date.now() - t0,
        eventCount: events.length,
        events: events.map((e) => ({
          title: e.title,
          summary: e.summary,
          content: e.content,
          category: e.category,
          priority: e.priority,
          status: e.status,
          entities: e.entities
        }))
      };
    } catch (error) {
      const msg = (error as Error)?.message || (typeof error === "string" ? error : JSON.stringify(error));
      logger.warn({ modelPath, error: msg, stack: (error as Error)?.stack }, "settings: local-llm test-extraction failed");
      return { ok: false, tookMs: Date.now() - t0, error: msg };
    }
  });

  // ── Performance settings (stage 1 productization) ───────────────────────
  // Why: previous product feedback said "threading can't be tuned". These
  // endpoints expose the env-bound knobs (INGEST_CONCURRENCY,
  // EMBEDDING_BATCH_CONCURRENCY, WATCHER_MAX_CONCURRENT, *_TIMEOUT_MS,
  // MAX_FILE_BYTES, TOMBSTONE_RETENTION_DAYS) as a REST surface backed by
  // ai_provider_settings.metadata JSONB. The service layer falls back to
  // env defaults so a brand-new install still works with no DB row.
  app.get("/api/settings/performance", async () => ({
    settings: await performanceSettingsService.getEffective(),
    bounds: PERFORMANCE_BOUNDS
  }));

  const performanceUpdateSchema = z.object({
    profile: z.enum(["low", "balanced", "aggressive"]),
    overrides: z
      .object({
        ingestConcurrency: z.number().int().optional(),
        embeddingBatchConcurrency: z.number().int().optional(),
        watcherMaxConcurrent: z.number().int().optional(),
        embeddingTimeoutMs: z.number().int().optional(),
        llmTimeoutMs: z.number().int().optional(),
        llmThreads: z.number().int().min(1).max(64).optional(),
        maxFileBytes: z.number().int().optional(),
        tombstoneRetentionDays: z.number().int().optional(),
        maxSheetRows: z.number().int().min(1).max(10_000).optional(),
        maxSheetCols: z.number().int().min(1).max(200).optional()
      })
      .partial()
      .optional()
  });

  app.put("/api/settings/performance", async (request) => {
    const input = performanceUpdateSchema.parse(request.body);
    const settings = await performanceSettingsService.update({
      profile: input.profile,
      overrides: input.overrides
    });
    logger.info(
      {
        profile: settings.profile,
        ingestConcurrency: settings.ingestConcurrency,
        embeddingBatchConcurrency: settings.embeddingBatchConcurrency,
        maxFileBytes: settings.maxFileBytes
      },
      "settings: performance profile updated"
    );
    return { settings };
  });

  app.post("/api/settings/performance/reset", async () => {
    const settings = await performanceSettingsService.reset();
    logger.info("settings: performance profile reset to env defaults");
    return { settings };
  });

  // Watcher autostart toggle. The env triple-gate
  // (ALLOW_PROD_WATCHER / WATCHER_AUTOSTART / STARTUP_SYNC) is the hard
  // production guard; this endpoint only flips the in-process value
  // that index.ts bootWatchedFolders consults after the env gate.
  app.get("/api/settings/watcher/autostart", async () => {
    return {
      enabled: watcherAutostartService.current(),
      hasDbOverride: watcherAutostartService.hasDbOverride(),
      envAutostart:
        config.ALLOW_PROD_WATCHER || config.WATCHER_AUTOSTART || config.STARTUP_SYNC,
      productionHardGated: config.NODE_ENV === "production" && !config.ALLOW_PROD_WATCHER
    };
  });

  const watcherAutostartBodySchema = z.object({ enabled: z.boolean() });
  app.put("/api/settings/watcher/autostart", async (request) => {
    const body = watcherAutostartBodySchema.parse(request.body ?? {});
    await watcherAutostartService.setEnabled(body.enabled);
    logger.info({ enabled: body.enabled }, "settings: watcher autostart updated");
    return {
      enabled: watcherAutostartService.current(),
      hasDbOverride: watcherAutostartService.hasDbOverride(),
      envAutostart:
        config.ALLOW_PROD_WATCHER || config.WATCHER_AUTOSTART || config.STARTUP_SYNC,
      productionHardGated: config.NODE_ENV === "production" && !config.ALLOW_PROD_WATCHER
    };
  });
}
