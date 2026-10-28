/**
 * performance-settings-service.ts — Runtime-tunable performance knobs.
 *
 * Why this exists:
 *   The product promise of stage 1 is "the user can adjust concurrency /
 *   timeouts / file size from the WebUI and the change takes effect
 *   immediately". The env-based config in src/config/env.ts only takes
 *   effect at process start — restarting sag.exe every time the user
 *   drags a slider is unacceptable.
 *
 * Strategy:
 *   Persist the tunables in ai_provider_settings.metadata JSONB
 *   (already exists, already used for chunking defaults) so we don't
 *   touch the schema or migrations. Read order at runtime is:
 *     1. ai_provider_settings.metadata.performance (DB)
 *     2. env defaults (config.*)
 *   The PublicPerformanceSettings response always returns the *effective*
 *   values, so the UI can show what the engine actually sees.
 *
 * What lives here vs config/env.ts:
 *   - config/env.ts = bootstrap / cold-start defaults
 *   - performance-settings-service.ts = live, mutable, UI-driven overrides
 *   - Any code that wants the *current* value should call this service
 *     instead of reading config.* directly. We do NOT retrofit every
 *     callsite in this PR; we add a new module that callers can adopt
 *     incrementally. The Settings panel + the new ingest hot-path call
 *     it; legacy code keeps the env default until migrated.
 */

import { config } from "../config/env.js";
import {
  getAiProviderSettings,
  upsertAiProviderSettings
} from "../db/repositories.js";
import { pool } from "../db/pool.js";
import { toLocalISO } from "../db/row-helpers.js";

export type PerformanceProfile = "low" | "balanced" | "aggressive";

/**
 * Every field the user can tune from the UI. Keys are deliberately
 * camelCase to match the JSON shape returned to the React layer; the
 * service maps to env-style names when consulting config fallback.
 */
export interface PerformanceSettings {
  profile: PerformanceProfile;
  /** Parallel files inside a single watched folder ingest pipeline.
   *  Range 1-10. env INGEST_CONCURRENCY default 4. */
  ingestConcurrency: number;
  /** Parallel sub-batches inside one file's batchGenerate call.
   *  Range 1-10. env EMBEDDING_BATCH_CONCURRENCY default 5. */
  embeddingBatchConcurrency: number;
  /** Per-folder watcher concurrency.
   *  Range 1-5. env WATCHER_MAX_CONCURRENT default 1. */
  watcherMaxConcurrent: number;
  /** Per-call wall-clock budget for embedding HTTP calls (ms).
   *  Range 5_000-180_000. env EMBEDDING_TIMEOUT_MS default 30_000. */
  embeddingTimeoutMs: number;
  /** Per-call wall-clock budget for LLM HTTP calls (ms).
   *  Range 10_000-600_000. env LLM_TIMEOUT_MS default 60_000. */
  llmTimeoutMs: number;
  /** CPU thread count for the local GGUF LLM forward pass.
   *  Range 1-64. env LLM_THREADS default 8.
   *  Effective on the next model load (call
   *  /api/settings/llm/local-model/dispose + warmup to pick up). */
  llmThreads: number;
  /** Global hard cap on a single ingest file's size (bytes).
   *  Range 1MB-1GB. env MAX_FILE_BYTES default 200MB. */
  maxFileBytes: number;
  /** How old a tombstoned manifest row must be before the sweep
   *  physically removes it (days). Range 0-30. env default 7. */
  tombstoneRetentionDays: number;
  /** Maximum rows kept from any single XLSX/CSV sheet when converted
   *  to markdown. Extra rows are dropped and a `truncated:` marker is
   *  appended to the sheet. Range 1-10_000. env MAX_SHEET_ROWS
   *  default 200. Effective on the next ingest run. */
  maxSheetRows: number;
  /** Maximum columns kept per XLSX/CSV sheet. Range 1-200.
   *  env MAX_SHEET_COLS default 26. Effective on the next ingest. */
  maxSheetCols: number;
}

export interface PublicPerformanceSettings extends PerformanceSettings {
  /** True when these values came from the DB (vs env fallback). Useful
   *  for the UI to render "customized" badges. */
  fromDatabase: boolean;
  updatedAt: string;
}

export const PERFORMANCE_BOUNDS = {
  ingestConcurrency: { min: 1, max: 10, default: 1 },
  embeddingBatchConcurrency: { min: 1, max: 10, default: 5 },
  watcherMaxConcurrent: { min: 1, max: 5, default: 1 },
  embeddingTimeoutMs: { min: 5_000, max: 180_000, default: 30_000 },
  llmTimeoutMs: { min: 10_000, max: 600_000, default: 180_000 },
  llmThreads: { min: 1, max: 64, default: 8 },
  maxFileBytes: { min: 1 * 1024 * 1024, max: 1024 * 1024 * 1024, default: 200 * 1024 * 1024 },
  tombstoneRetentionDays: { min: 0, max: 30, default: 7 },
  // P10 — audit workbooks run 10k+ rows × 50+ columns routinely.
  // The old default of 200/26 caused sheets to be silently skipped
  // as "detail data" and the user saw no content in retrieval. Bumped
  // to 2000/50 so a default install captures most audit content; users
  // who want a tighter cap can lower this from the Settings page.
  maxSheetRows: { min: 1, max: 10_000, default: 2000 },
  maxSheetCols: { min: 1, max: 200, default: 50 }
} as const;

const CACHE_TTL_MS = 5_000;

/**
 * Build an env-only PerformanceSettings record. Used as the very first
 * snapshot before the DB read completes, and as the fallback when the
 * DB has no metadata.performance row.
 */
function envDefaults(): PerformanceSettings {
  return {
    profile: "balanced",
    ingestConcurrency: config.INGEST_CONCURRENCY,
    embeddingBatchConcurrency: config.EMBEDDING_BATCH_CONCURRENCY,
    watcherMaxConcurrent: config.WATCHER_MAX_CONCURRENT,
    embeddingTimeoutMs: config.EMBEDDING_TIMEOUT_MS,
    llmTimeoutMs: config.LLM_TIMEOUT_MS,
    llmThreads: config.LLM_THREADS,
    maxFileBytes: config.MAX_FILE_BYTES,
    tombstoneRetentionDays: config.TOMBSTONE_RETENTION_DAYS,
    maxSheetRows: config.MAX_SHEET_ROWS,
    maxSheetCols: config.MAX_SHEET_COLS
  };
}

const PROFILE_PRESETS: Record<PerformanceProfile, Omit<PerformanceSettings, "profile">> = {
  low: {
    ingestConcurrency: 1,
    embeddingBatchConcurrency: 1,
    watcherMaxConcurrent: 1,
    embeddingTimeoutMs: 60_000,
    llmTimeoutMs: 120_000,
    llmThreads: 4,
    maxFileBytes: 50 * 1024 * 1024,
    tombstoneRetentionDays: 7,
    // 老旧机器 — 取表头 + 少量行就够检索；保留原文以便用户追溯
    maxSheetRows: 50,
    maxSheetCols: 26
  },
  balanced: {
    ingestConcurrency: 1,
    embeddingBatchConcurrency: 5,
    watcherMaxConcurrent: 1,
    embeddingTimeoutMs: 30_000,
    llmTimeoutMs: 60_000,
    llmThreads: 4,
    maxFileBytes: 200 * 1024 * 1024,
    tombstoneRetentionDays: 7,
    // P10 — audit workbooks are 2k rows × 50 cols routinely.
    maxSheetRows: 2000,
    maxSheetCols: 50
  },
  aggressive: {
    ingestConcurrency: 3,
    embeddingBatchConcurrency: 10,
    watcherMaxConcurrent: 2,
    embeddingTimeoutMs: 20_000,
    llmTimeoutMs: 45_000,
    llmThreads: 8,
    maxFileBytes: 500 * 1024 * 1024,
    tombstoneRetentionDays: 3,
    // P10 — large box / offline task — full workbook with chunked
    // embeds so we still get past the LLM's context window per row.
    maxSheetRows: 5000,
    maxSheetCols: 50
  }
};

/**
 * Build a complete PerformanceSettings record from the user-supplied
 * profile + overrides. `undefined` overrides keep the preset value.
 */
export function resolvePerformanceSettings(
  profile: PerformanceProfile,
  overrides: Partial<PerformanceSettings> = {}
): PerformanceSettings {
  const preset = PROFILE_PRESETS[profile];
  return {
    profile,
    ingestConcurrency: clampInt(overrides.ingestConcurrency, preset.ingestConcurrency, PERFORMANCE_BOUNDS.ingestConcurrency),
    embeddingBatchConcurrency: clampInt(overrides.embeddingBatchConcurrency, preset.embeddingBatchConcurrency, PERFORMANCE_BOUNDS.embeddingBatchConcurrency),
    watcherMaxConcurrent: clampInt(overrides.watcherMaxConcurrent, preset.watcherMaxConcurrent, PERFORMANCE_BOUNDS.watcherMaxConcurrent),
    embeddingTimeoutMs: clampInt(overrides.embeddingTimeoutMs, preset.embeddingTimeoutMs, PERFORMANCE_BOUNDS.embeddingTimeoutMs),
    llmTimeoutMs: clampInt(overrides.llmTimeoutMs, preset.llmTimeoutMs, PERFORMANCE_BOUNDS.llmTimeoutMs),
    llmThreads: clampInt(overrides.llmThreads, preset.llmThreads, PERFORMANCE_BOUNDS.llmThreads),
    maxFileBytes: clampInt(overrides.maxFileBytes, preset.maxFileBytes, PERFORMANCE_BOUNDS.maxFileBytes),
    tombstoneRetentionDays: clampInt(overrides.tombstoneRetentionDays, preset.tombstoneRetentionDays, PERFORMANCE_BOUNDS.tombstoneRetentionDays),
    maxSheetRows: clampInt(overrides.maxSheetRows, preset.maxSheetRows, PERFORMANCE_BOUNDS.maxSheetRows),
    maxSheetCols: clampInt(overrides.maxSheetCols, preset.maxSheetCols, PERFORMANCE_BOUNDS.maxSheetCols)
  };
}

export class PerformanceSettingsService {
  /** In-process cache for the getCached() hot-path reader. Refreshed
   *  lazily on every read; force-invalidated by update() / reset(). */
  private cached: PerformanceSettings | null = null;
  private cachedAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  /**
   * Effective values + provenance. Always returns a complete object so
   * the UI never has to handle partial state.
   */
  async getEffective(): Promise<PublicPerformanceSettings> {
    const row = await this.readDbSettings();
    const settings = this.mergeWithEnv(row?.settings ?? null);
    return {
      ...settings,
      fromDatabase: row !== null,
      updatedAt: row?.updatedAt ?? toLocalISO()
    };
  }

  /**
   * In-process cached snapshot for hot-path callers (sync-orchestrator,
   * embedding-client, analyzer). Returns the most recently observed
   * performance settings; if we've never queried the DB yet in this
   * process, returns env defaults synchronously and schedules an async
   * refresh so the next call sees the persisted values.
   *
   * The cache TTL is short (5s) so a UI tweak takes effect within one
   * sync cycle at most — acceptable because we deliberately snapshot
   * once per `syncFolder` invocation rather than per file (see the
   * long comment block at the top of sync-orchestrator.ts).
   */
  getCached(): PerformanceSettings {
    const now = Date.now();
    if (this.cached && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cached;
    }
    // Try a synchronous read from the cached DB result, falling back to
    // env defaults. The DB read is wrapped in a fire-and-forget async
    // refresh that updates the cache on success.
    this.refreshCacheAsync();
    if (this.cached) {
      // TTL expired but DB refresh in flight; return stale value rather
      // than env defaults to avoid surprise behaviour changes mid-run.
      return this.cached;
    }
    return envDefaults();
  }

  /**
   * Force the cache to refresh now (used by update/reset paths so the
   * NEXT hot-path read sees the new values without waiting for TTL).
   */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
    this.refreshInFlight = null;
  }

  private refreshCacheAsync(): void {
    if (this.refreshInFlight) return;
    this.refreshInFlight = (async () => {
      try {
        const row = await this.readDbSettings();
        this.cached = this.mergeWithEnv(row?.settings ?? null);
        this.cachedAt = Date.now();
      } catch {
        // Leave the cache as-is; the next call will retry.
      } finally {
        this.refreshInFlight = null;
      }
    })();
  }

  /**
   * Persist a new profile + optional overrides. Returns the *effective*
   * settings after write so the UI can immediately reflect truth.
   */
  async update(input: { profile: PerformanceProfile; overrides?: Partial<PerformanceSettings> }): Promise<PublicPerformanceSettings> {
    const next = resolvePerformanceSettings(input.profile, input.overrides ?? {});
    // Make sure the ai_provider_settings row exists so we have a place to
    // attach metadata. upsertAiProviderSettings requires the embedding/LLM
    // fields even if the user only wants to tune performance; we preserve
    // whatever is already there.
    const existing = await getAiProviderSettings();
    this.invalidate();
    await upsertAiProviderSettings({
      embeddingProvider: existing?.embeddingProvider ?? config.EMBEDDING_PROVIDER,
      embeddingBaseUrl: existing?.embeddingBaseUrl ?? config.EMBEDDING_BASE_URL,
      embeddingModel: existing?.embeddingModel ?? config.EMBEDDING_MODEL,
      embeddingDimensions: existing?.embeddingDimensions ?? config.EMBEDDING_DIMENSIONS,
      embeddingApiKey: existing?.embeddingApiKey ?? null,
      preserveEmbeddingApiKey: true,
      embeddingLocalModelPath: existing?.embeddingLocalModelPath ?? null,
      llmProvider: existing?.llmProvider ?? "api",
      llmBaseUrl: existing?.llmBaseUrl ?? config.LLM_BASE_URL,
      llmModel: existing?.llmModel ?? config.LLM_MODEL,
      llmApiKey: existing?.llmApiKey ?? null,
      preserveLlmApiKey: true,
      llmLocalModelPath: existing?.llmLocalModelPath ?? null,
      llmLocalContextSize: existing?.llmLocalContextSize ?? 4096,
      metadata: {
        ...(existing?.metadata ?? {}),
        performance: next
      }
    });
    return {
      ...next,
      fromDatabase: true,
      updatedAt: toLocalISO()
    };
  }

  /**
   * Reset to env defaults by removing the DB override. The row stays;
   * only the metadata.performance key is cleared.
   *
   * Implementation note: we do NOT go through upsertAiProviderSettings
   * here because the `metadata || excluded.metadata` SQL pattern uses
   * json_patch under SQLite, which is additive (RFC 6902) — it cannot
   * delete a key. The original behavior (before this fix) deleted the
   * key in memory but json_patch then re-added it via the existing
   * row's preserved value, so reset was a silent no-op. We run a
   * targeted UPDATE with json_remove($, '$.performance') instead.
   */
  async reset(): Promise<PublicPerformanceSettings> {
    const existing = await getAiProviderSettings();
    if (!existing) {
      return this.getEffective();
    }
    // json_remove is the SQLite equivalent of pg's `metadata - 'key'`
    // (jsonb key deletion). Coalesce to '{}' first so the row is always
    // valid JSON even if metadata is somehow NULL.
    await pool.query(
      `update ai_provider_settings
         set metadata = coalesce(json_remove(metadata, '$.performance'), '{}'::jsonb),
             updated_at = now()
       where id = 'global'`
    );
    this.invalidate();
    return this.getEffective();
  }

  private async readDbSettings(): Promise<{ settings: PerformanceSettings; updatedAt: string } | null> {
    try {
      const row = await getAiProviderSettings();
      if (!row) return null;
      const perf = row.metadata?.performance;
      if (!perf || typeof perf !== "object") return null;
      const validated = validateStoredPerformance(perf as Record<string, unknown>);
      if (!validated) return null;
      return { settings: validated, updatedAt: row.updatedAt };
    } catch {
      return null;
    }
  }

  private mergeWithEnv(db: PerformanceSettings | null): PerformanceSettings {
    if (db) return db;
    return {
      profile: "balanced",
      ingestConcurrency: config.INGEST_CONCURRENCY,
      embeddingBatchConcurrency: config.EMBEDDING_BATCH_CONCURRENCY,
      watcherMaxConcurrent: config.WATCHER_MAX_CONCURRENT,
      embeddingTimeoutMs: config.EMBEDDING_TIMEOUT_MS,
      llmTimeoutMs: config.LLM_TIMEOUT_MS,
      llmThreads: config.LLM_THREADS,
      maxFileBytes: config.MAX_FILE_BYTES,
      tombstoneRetentionDays: config.TOMBSTONE_RETENTION_DAYS,
      maxSheetRows: config.MAX_SHEET_ROWS,
      maxSheetCols: config.MAX_SHEET_COLS
    };
  }
}

function validateStoredPerformance(raw: Record<string, unknown>): PerformanceSettings | null {
  const profile = raw.profile;
  if (profile !== "low" && profile !== "balanced" && profile !== "aggressive") {
    return null;
  }
  // Re-resolve with the saved profile + the saved overrides so anything
  // out-of-bounds clamps to the preset rather than blowing up the boot path.
  const overrides: Partial<PerformanceSettings> = {};
  for (const key of [
    "ingestConcurrency",
    "embeddingBatchConcurrency",
    "watcherMaxConcurrent",
    "embeddingTimeoutMs",
    "llmTimeoutMs",
    "llmThreads",
    "maxFileBytes",
    "tombstoneRetentionDays",
    "maxSheetRows",
    "maxSheetCols"
  ] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key])) {
      overrides[key] = raw[key] as never;
    }
  }
  return resolvePerformanceSettings(profile, overrides);
}

function clampInt(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(bounds.min, Math.min(Math.trunc(n), bounds.max));
}

export const performanceSettingsService = new PerformanceSettingsService();

/**
 * Sync read for hot-path callers. Equivalent to
 * `performanceSettingsService.getCached()` but with a one-token call site.
 *
 * Reads at most once every 5s per process; UI PUTs invalidate the cache
 * so the next call sees the new values immediately.
 */
export function getRuntimePerformanceSettings(): PerformanceSettings {
  return performanceSettingsService.getCached();
}
