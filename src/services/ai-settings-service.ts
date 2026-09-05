import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import { toLocalISO } from "../db/row-helpers.js";
import type { AiProviderSettingsRecord, ChunkingMode, EmbeddingProvider, PublicAiProviderSettings, SearchMode } from "../types.js";

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
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
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
  hasRemoteLlm: boolean;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
}

export interface UpdateAiSettingsInput {
  embeddingProvider?: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string;
  clearEmbeddingApiKey?: boolean;
  embeddingLocalModelPath?: string;
  clearEmbeddingLocalModelPath?: boolean;
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  clearLlmApiKey?: boolean;
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
    // Embedding is "remote" if the provider is 'api' AND a key is set.
    // LLM is "remote" if an API key is configured.
    return {
      embeddingProvider: provider,
      embeddingBaseUrl: settings.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel,
      embeddingDimensions: settings.embeddingDimensions,
      embeddingApiKey,
      embeddingLocalModelPath,
      hasRemoteEmbedding: provider === "api" && embeddingApiKey.length > 0,
      llmBaseUrl: settings.llmBaseUrl,
      llmModel: settings.llmModel,
      llmApiKey,
      llmTimeoutMs: settings.llmTimeoutMs ?? config.LLM_TIMEOUT_MS,
      hasRemoteLlm: llmApiKey.length > 0,
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
    const trimmedEmbeddingBaseUrl = input.embeddingBaseUrl.trim();
    const embeddingBaseUrl = trimmedEmbeddingBaseUrl || config.EMBEDDING_BASE_URL;
    const trimmedEmbeddingModel = input.embeddingModel.trim();
    const embeddingModel = trimmedEmbeddingModel || config.EMBEDDING_MODEL;
    const trimmedLlmBaseUrl = input.llmBaseUrl?.trim() ?? "";
    const llmBaseUrl = trimmedLlmBaseUrl || current.llmBaseUrl || config.LLM_BASE_URL;
    const trimmedLlmModel = input.llmModel?.trim() ?? "";
    const llmModel = trimmedLlmModel || current.llmModel || config.LLM_MODEL;
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
      llmBaseUrl,
      llmModel,
      llmApiKey,
      preserveLlmApiKey: !input.clearLlmApiKey && llmApiKey == null,
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
    llmBaseUrl: config.LLM_BASE_URL,
    llmModel: config.LLM_MODEL,
    llmApiKey: config.LLM_API_KEY || null,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
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
  return {
    id: "global",
    embeddingProvider: provider,
    embeddingBaseUrl: settings.embeddingBaseUrl,
    embeddingModel: settings.embeddingModel,
    embeddingDimensions: settings.embeddingDimensions,
    hasEmbeddingApiKey: (settings.embeddingApiKey?.trim() ?? "").length > 0,
    embeddingLocalModelPath: localPath || null,
    embeddingLocalModelLoaded: provider !== "local-bge" || localPath.length > 0,
    llmBaseUrl: settings.llmBaseUrl,
    llmModel: settings.llmModel,
    hasLlmApiKey: (settings.llmApiKey?.trim() ?? "").length > 0,
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

export const aiSettingsService = new AiSettingsService();
