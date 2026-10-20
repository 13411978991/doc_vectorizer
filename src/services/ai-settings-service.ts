import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import { toLocalISO } from "../db/row-helpers.js";
import { getRuntimePerformanceSettings } from "./performance-settings-service.js";
import type { AiProviderSettingsRecord, ChunkingMode, EmbeddingProvider, LlmProvider, PublicAiProviderSettings, SearchMode } from "../types.js";
import { getLoadedLocalLlmInfo } from "../ai/local-llm-client.js";
import { getLoadedNerInfo } from "../ai/ner-pipeline-factory.js";

export const DEFAULT_SEARCH_TOP_K = 10;
export const DEFAULT_LOCAL_MODEL_PATH = "models/bge-large-zh-v1.5";
export const MAX_SEARCH_TOP_K = 50;
export const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
export const DEFAULT_CHUNK_TOKEN_LIMIT = 1024;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;

export interface AiRuntimeSettings {
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey: string;
  embeddingLocalModelPath: string;
  hasRemoteEmbedding: boolean;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  // Path to the bundled GGUF (relative to process.resourcesPath or
  // repo-root). Resolved by LocalLlmClient at request time.
  llmLocalModelPath: string;
  // Context window for the local model. Affects KV cache size and
  // the maximum combined prompt+output tokens.
  llmLocalContextSize: number;
  // Resolved wall-clock timeout for a single chat/completions call.
  // Read from the DB column (`ai_provider_settings.llm_timeout_ms`) so
  // a WebUI tweak or a previous run's value sticks across restarts.
  // The env default (`config.LLM_TIMEOUT_MS`) is the bootstrap value
  // for the very first row insert.
  //
  // History: pre-P3 the LLM client only consulted `config.LLM_TIMEOUT_MS`
  // (env default 120s) so any DB-side value was silently ignored.
  // Coupled with the wrapper-style abort reason (replaced in P2),
  // every chunk aborted with the same misleading "llm request
  // aborted: timed out after 120000ms" message regardless of the
  // user's actual setting (see sag_xlsx-LLM超时诊断-20260828.md).
  llmTimeoutMs: number;
  // CPU thread count for the local GGUF LLM forward pass. Sourced
  // from the performance service (env LLM_THREADS default 8). The
  // local-llm-client reads this at createContext() time, so a
  // change only takes effect on the next model load — operators
  // need to call /api/settings/llm/local-model/warmup with
  // forceReload=true after tweaking the Performance panel.
  llmThreads: number;
  // `true` when the LLM is the OpenAI-compatible HTTP client (the
  // legacy code path). `false` when the LLM is a bundled GGUF that
  // LocalLlmClient should handle — even if the operator happens to
  // have entered an API key, the local provider takes priority
  // because it's a deliberate "no external call" choice.
  hasRemoteLlm: boolean;
  // Plan B (2026-09-19): NER model selection. Same shape as the
  // llmLocalModelPath fields above — relative path under
  // <exeDir>/resources/models/. The runtime blocks startup when
  // this is empty so an operator who hasn't picked a model yet
  // gets a clear "go download one" error instead of a silent
  // regression to the Plan A regex fallback.
  nerModel: string;
  nerMaxTokens: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
}

export interface UpdateAiSettingsInput {
  embeddingProvider?: EmbeddingProvider;
  // Optional on the wire — local-bge operators don't need to set
  // a remote endpoint. The service layer falls back to the env
  // default or the current DB row when this is omitted.
  embeddingBaseUrl?: string;
  // local-bge ignores this field (loads from embeddingLocalModelPath
  // instead), so the wire schema makes it optional. The service falls
  // back to the current DB row or the env default when omitted.
  embeddingModel?: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  embeddingLocalModelPath?: string;
  clearEmbeddingLocalModelPath?: boolean;
  llmProvider?: LlmProvider;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
  // Optional path to a GGUF file. Empty string means "don't change
  // the existing path". The local-llm probe endpoint reads this
  // value before warmup.
  llmLocalModelPath?: string;
  clearLlmLocalModelPath?: boolean;
  llmLocalContextSize?: number;
  // Plan B (2026-09-19): NER columns. Empty string means "don't
  // change the existing path" — same semantics as the LLM path
  // fields above. clearNerModel lets the Web UI explicitly blank
  // it out (e.g. when the operator wants to switch models and the
  // UI wants to show "no model chosen" before the next download
  // completes).
  nerModel?: string;
  clearNerModel?: boolean;
  nerMaxTokens?: number;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
}

export class AiSettingsService {
  async getPublicSettings(): Promise<PublicAiProviderSettings> {
    return toPublicSettings(await this.getSettingsOrFallback());
  }

  async getRuntimeSettings(): Promise<AiRuntimeSettings> {
    const settings = await this.getSettingsOrFallback();
    const embeddingApiKey = settings.embeddingApiKey?.trim() ?? "";
    let embeddingLocalModelPath = settings.embeddingLocalModelPath?.trim() ?? "";
    const provider = settings.embeddingProvider ?? "api";
    // When local-bge is selected with no explicit path, use the bundled default model.
    if (provider === "local-bge" && !embeddingLocalModelPath) {
      embeddingLocalModelPath = DEFAULT_LOCAL_MODEL_PATH;
    }
    const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    const llmApiKey = settings.llmApiKey?.trim() ?? "";
    // LLM provider mirrors embedding_provider: 'api' goes through the
    // OpenAI-compatible HTTP client, 'local' goes through LocalLlmClient
    // + node-llama-cpp. Migration 016 introduced this; older rows default
    // to "api" which preserves the legacy behaviour exactly.
    //
    // Safe fallback (2026-09-24): if the operator chose 'api' but
    // didn't actually configure the endpoint (no base URL / model /
    // key), downgrade to 'local' for this read so the runtime doesn't
    // crash on a misconfigured fresh install. The persisted DB value
    // stays 'api' so the WebUI's toggle still shows the operator's
    // intent — they just need to fill in Base URL/Model/Key in the
    // Settings panel. Without this safeguard every ingest would
    // throw on a fresh install (the migration backfilled 'api' but
    // left the endpoint blank).
    const dbLlmProvider: LlmProvider = settings.llmProvider === "local" ? "local" : "api";
    const llmProvider: LlmProvider =
      dbLlmProvider === "api" && (llmApiKey.length === 0 || !settings.llmBaseUrl || !settings.llmModel)
        ? "local"
        : dbLlmProvider;
    return {
      embeddingProvider: provider,
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
      embeddingApiKey,
      embeddingLocalModelPath,
      hasRemoteEmbedding: provider === "api" && embeddingApiKey.length > 0,
      llmProvider,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey,
      llmLocalModelPath: settings.llmLocalModelPath ?? "",
      llmLocalContextSize: readBoundedInteger(settings.llmLocalContextSize, 4096, 256, 32768),
      // llmTimeoutMs priority: performance service (UI-driven, hot
      // path) → ai_provider_settings.llm_timeout_ms column (legacy
      // persisted value) → env default. The performance service
      // supersedes so a UI tweak in the new "Performance settings"
      // panel wins over any stale value written by the old settings UI.
      llmTimeoutMs: getRuntimePerformanceSettings().llmTimeoutMs ?? settings.llmTimeoutMs ?? config.LLM_TIMEOUT_MS,
      // llmThreads: only sourced from the performance service / env.
      // No legacy DB column exists. Performance service is the
      // canonical knob so the WebUI can tune without a restart
      // (though the model needs to be reloaded for the new value
      // to actually take effect — see local-llm-client's
      // createContext({ threads }) call).
      llmThreads: getRuntimePerformanceSettings().llmThreads,
      // `hasRemoteLlm` only flips true when the operator chose the
      // HTTP API provider AND configured a key. A local-llm operator
      // can leave the key column empty (or set it — it's just ignored)
      // without accidentally triggering the legacy HTTP client.
      hasRemoteLlm: llmProvider === "api" && llmApiKey.length > 0,
      // Plan B: NER fields. Empty `nerModel` means "not configured
      // yet" — the runtime refuses to start until /api/settings/ner/download
      // populates it. We clamp `nerMaxTokens` to the same [64, 1024]
      // window the DB CHECK constraint enforces, so a malformed row
      // can't yield NaN here.
      nerModel: settings.nerModel?.trim() ?? "",
      nerMaxTokens: readBoundedInteger(settings.nerMaxTokens, 512, 64, 1024),
      defaultSearchMode: readDefaultSearchMode(settings.metadata),
      defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
      defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
      chunkTokenLimit,
      chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1)
    };
  }

  async updateSettings(input: UpdateAiSettingsInput): Promise<PublicAiProviderSettings> {
    if (input.embeddingDimensions !== SUPPORTED_EMBEDDING_DIMENSIONS) {
      throw new Error(`embeddingDimensions must be ${SUPPORTED_EMBEDDING_DIMENSIONS}`);
    }
    const chunkTokenLimit = clampInteger(input.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    const chunkOverlapTokens = clampInteger(input.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1);
    const current = await this.getSettingsOrFallback();
    const embeddingApiKey = input.clearEmbeddingApiKey ? null : normalizeOptionalSecret(input.embeddingApiKey);
    const llmApiKey = input.clearLlmApiKey ? null : normalizeOptionalSecret(input.llmApiKey);
    // If the user submits an empty Base URL/Model for embedding or LLM,
    // fall back to the env defaults so we never persist a blank value
    // that would later fail the embedding/LLM call. Trim first —
    // whitespace-only counts as empty. The env defaults are intentionally
    // empty in shipped configs, so an unconfigured install surfaces a
    // clear "missing configuration" error at request time.
    const trimmedEmbeddingBaseUrl = (input.embeddingBaseUrl ?? "").trim();
    const embeddingBaseUrl = trimmedEmbeddingBaseUrl || config.EMBEDDING_BASE_URL;
    // embeddingModel is optional since local-bge doesn't need a remote
    // model name; fall back to the current value, then env default.
    const trimmedEmbeddingModel = (input.embeddingModel ?? "").trim();
    const embeddingModel = trimmedEmbeddingModel || current.embeddingModel || config.EMBEDDING_MODEL;
    const trimmedLlmBaseUrl = input.llmBaseUrl?.trim() ?? "";
    const llmBaseUrl = trimmedLlmBaseUrl || current.llmBaseUrl || config.LLM_BASE_URL;
    const trimmedLlmModel = input.llmModel?.trim() ?? "";
    const llmModel = trimmedLlmModel || current.llmModel || config.LLM_MODEL;
    // LLM provider: explicit input wins, otherwise fall back to the
    // existing DB row. This is what lets a user flip from 'api' to
    // 'local' without us erasing the previously-saved base URL.
    const llmProvider: LlmProvider = input.llmProvider ?? current.llmProvider ?? "api";
    // Local-llm path: explicit clear > explicit value > current row.
    // An empty string with `clearLlmLocalModelPath` set is treated as
    // an explicit "wipe" (mirrors the embedding path behaviour).
    let llmLocalModelPath: string | null;
    if (input.clearLlmLocalModelPath) {
      llmLocalModelPath = "";
    } else if (input.llmLocalModelPath !== undefined) {
      const trimmed = input.llmLocalModelPath.trim();
      llmLocalModelPath = trimmed.length > 0 ? trimmed : "";
    } else {
      llmLocalModelPath = current.llmLocalModelPath ?? "";
    }
    const llmLocalContextSize = clampInteger(input.llmLocalContextSize ?? current.llmLocalContextSize ?? 4096, 4096, 256, 32768);
    // Plan B: NER path. Mirrors the LLM path semantics above — an
    // explicit `clearNerModel` wipes the column (so the runtime blocks
    // startup with a clear "go download one" error instead of silently
    // loading the old model).
    let nerModel: string | null;
    if (input.clearNerModel) {
      nerModel = "";
    } else if (input.nerModel !== undefined) {
      const trimmed = input.nerModel.trim();
      nerModel = trimmed.length > 0 ? trimmed : "";
    } else {
      nerModel = current.nerModel ?? "";
    }
    const nerMaxTokens = clampInteger(input.nerMaxTokens ?? current.nerMaxTokens ?? 512, 512, 64, 1024);
    const updated = await upsertAiProviderSettings({
      embeddingProvider: input.embeddingProvider ?? "api",
      embeddingBaseUrl,
      embeddingModel,
      embeddingDimensions: input.embeddingDimensions,
      embeddingApiKey,
      preserveEmbeddingApiKey: !input.clearEmbeddingApiKey && embeddingApiKey == null,
      embeddingLocalModelPath: input.clearEmbeddingLocalModelPath
        ? null
        : normalizeOptionalSecret(input.embeddingLocalModelPath),
      llmProvider,
      llmBaseUrl,
      llmModel,
      llmApiKey,
      preserveLlmApiKey: !input.clearLlmApiKey && llmApiKey == null,
      llmLocalModelPath,
      llmLocalContextSize,
      nerModel,
      nerMaxTokens,
      metadata: {
        updatedVia: "webui",
        previousUpdatedAt: current.updatedAt,
        defaultSearchMode: input.defaultSearchMode,
        defaultSearchTopK: clampInteger(input.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
        defaultChunkingMode: input.defaultChunkingMode,
        chunkTokenLimit,
        chunkOverlapTokens
      }
    });
    // Plan B: if the operator switched models, drop the cached NER
    // pipeline so the next ingest call reloads from disk. We don't
    // await — the dispose is best-effort and the next call to
    // `getLocalNerPipeline()` will rebuild anyway if the singleton
    // is gone. Mirrors the LLM warmup endpoint's force-reload behaviour.
    if (input.nerModel !== undefined || input.clearNerModel) {
      const { disposeNerPipeline } = await import("../ai/ner-pipeline-factory.js");
      await disposeNerPipeline();
    }
    return toPublicSettings(updated);
  }

  private async getSettingsOrFallback(): Promise<AiProviderSettingsRecord> {
    if (config.NODE_ENV === "test") {
      return envSettings();
    }
    try {
      const settings = await getAiProviderSettings();
      if (settings) {
        return settings;
      }
    } catch {
      // Tests and fresh installs can run before migrations. Runtime callers still
      // need a deterministic fallback so local operation stays bootstrappable.
    }
    return envSettings();
  }
}

function envSettings(): AiProviderSettingsRecord {
  const now = toLocalISO();
  return {
    id: "global",
    embeddingProvider: config.EMBEDDING_PROVIDER,
    embeddingBaseUrl: config.EMBEDDING_BASE_URL,
    embeddingModel: config.EMBEDDING_MODEL,
    embeddingDimensions: SUPPORTED_EMBEDDING_DIMENSIONS,
    embeddingApiKey: config.EMBEDDING_API_KEY || null,
    embeddingLocalModelPath: config.EMBEDDING_LOCAL_MODEL_PATH || null,
    llmProvider: "api",
    llmBaseUrl: config.LLM_BASE_URL,
    llmModel: config.LLM_MODEL,
    llmApiKey: config.LLM_API_KEY || null,
    llmLocalModelPath: "",
    llmLocalContextSize: 4096,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    // Plan B: NER defaults. Empty path means "not configured yet";
    // the runtime refuses to start until the operator picks one.
    nerModel: "",
    nerMaxTokens: 512,
    metadata: {
      defaultSearchMode: config.DEFAULT_SEARCH_MODE,
      defaultSearchTopK: DEFAULT_SEARCH_TOP_K,
      defaultChunkingMode: DEFAULT_CHUNKING_MODE,
      chunkTokenLimit: DEFAULT_CHUNK_TOKEN_LIMIT,
      chunkOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS
    },
    createdAt: now,
    updatedAt: now
  };
}

function toPublicSettings(settings: AiProviderSettingsRecord): PublicAiProviderSettings {
  const chunkTokenLimit = readBoundedInteger(settings.metadata.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
  const provider = settings.embeddingProvider ?? "api";
  const localPath = settings.embeddingLocalModelPath?.trim() ?? "";
  const llmProvider: LlmProvider = settings.llmProvider === "local" ? "local" : "api";
  const llmLocalModelPath = settings.llmLocalModelPath?.trim() ?? "";
  // Live loaded-model state: ask the singleton client. It returns
  // null when nothing is loaded yet, which the Web UI surfaces as
  // the "preheat model" button. We resolve on every call so the UI
  // stays in sync without a separate pub/sub channel.
  //
  // Equality check: compare the operator's stored path against the
  // inputPath the client remembered when it loaded the model. We
  // deliberately do NOT compare against `loadedInfo.path` (absolute)
  // because the operator typically types a *relative* path like
  // "models/qwen2.5-3b-instruct-q4_k_m.gguf" into the Settings
  // panel, while `path` is the resolved absolute location. Matching
  // by the raw input string keeps a relative `llmLocalModelPath`
  // honest with whatever the user actually configured.
  const loadedInfo = getLoadedLocalLlmInfo();
  const llmLocalModelLoaded =
    llmProvider !== "local" || (loadedInfo !== null && loadedInfo.inputPath === llmLocalModelPath);
  // Plan B: read the live NER pipeline state so the Web UI can show
  // "preheat" vs "reload" vs the success tick. Mirrors the LLM
  // loadedInfo lookup above.
  const loadedNerInfo = getLoadedNerInfo();
  return {
    id: "global",
    embeddingProvider: provider,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDimensions: settings.embeddingDimensions,
    hasEmbeddingApiKey: (settings.embeddingApiKey?.trim() ?? "").length > 0,
    embeddingLocalModelPath: localPath || null,
    embeddingLocalModelLoaded: provider !== "local-bge" || localPath.length > 0,
    llmProvider,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    hasLlmApiKey: (settings.llmApiKey?.trim() ?? "").length > 0,
    llmLocalModelPath: llmLocalModelPath || null,
    llmLocalModelLoaded,
    llmLocalModelLabel: loadedInfo?.label ?? null,
    // Plan B: NER fields. Mirrors the LLM shape — the Web UI uses
    // `nerModelLoaded` to decide whether to render "Download NER"
    // vs "Reload NER" vs the green tick. `getLoadedNerInfo()` is
    // imported from the factory module at the top of this file.
    nerModel: settings.nerModel?.trim() ? settings.nerModel.trim() : null,
    nerMaxTokens: settings.nerMaxTokens ?? 512,
    nerModelLoaded:
      (settings.nerModel?.trim() ?? "").length > 0 &&
      loadedNerInfo !== null &&
      loadedNerInfo.modelPath === settings.nerModel,
    nerModelLabel: loadedNerInfo ? deriveNerLabel(loadedNerInfo.modelPath) : null,
    defaultSearchMode: readDefaultSearchMode(settings.metadata),
    defaultSearchTopK: readBoundedInteger(settings.metadata.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, MAX_SEARCH_TOP_K),
    defaultChunkingMode: readDefaultChunkingMode(settings.metadata),
    chunkTokenLimit,
    chunkOverlapTokens: readBoundedInteger(settings.metadata.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, chunkTokenLimit - 1),
    updatedAt: settings.updatedAt
  };
}

function readDefaultSearchMode(metadata: Record<string, unknown>): SearchMode {
  return metadata.defaultSearchMode === "standard" ? "standard" : "fast";
}

function readDefaultChunkingMode(metadata: Record<string, unknown>): ChunkingMode {
  return metadata.defaultChunkingMode === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return clampInteger(value, fallback, min, max);
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.trunc(numberValue), max));
}

function normalizeOptionalSecret(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Plan B: derive a human-readable label for a loaded NER model path.
 * Mirrors the LLM `LoadedModelInfo.label` field but the NER factory
 * doesn't track a label itself — we recover it from the basename of
 * the model path (e.g. "bert-base-chinese-ner"). The Web UI shows
 * this next to the warmup button so operators don't have to remember
 * which of "models/bert-base-chinese-ner" and
 * "models/roberta-base-chinese-ner" they currently have loaded.
 */
function deriveNerLabel(modelPath: string): string {
  // Strip "models/" prefix if present, then take the basename.
  const withoutPrefix = modelPath.replace(/^models\//, "");
  const base = withoutPrefix.split(/[\\/]/).pop() ?? withoutPrefix;
  return base || modelPath;
}

export const aiSettingsService = new AiSettingsService();
