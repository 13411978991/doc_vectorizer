import "dotenv/config";
import { z } from "zod";

export const SUPPORTED_EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_302AI_BASE_URL = "https://api.302ai.cn/v1";

// z.coerce.boolean() treats any non-empty string as truthy, which means
// ALLOW_PROD_WATCHER=false would actually become true. This helper handles
// the common string forms correctly.
const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
    return true;
  });

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(4173),
  DATABASE_URL: z.string().min(1).default("postgres://sag_lite:sag_lite_pass@localhost:5432/sag_lite"),
  DEFAULT_TENANT_ID: z.string().min(1).default("default"),
  AUTH_MODE: z.enum(["none", "bearer", "external"]).default("none"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(SUPPORTED_EMBEDDING_DIMENSIONS)
    .refine((value) => value === SUPPORTED_EMBEDDING_DIMENSIONS || value === 4096,
      `EMBEDDING_DIMENSIONS must be ${SUPPORTED_EMBEDDING_DIMENSIONS} (pgvector default) or 4096 (qwen3-embedding-8b on sunwoda)`),
  EMBEDDING_MODEL: z.string().min(1).default("qwen3-embedding-8b"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_BASE_URL: z.string().url().default("https://llm-api.sunwoda.com/v1"),
  // "api" calls a remote OpenAI-compatible endpoint; "local" is a
  // deterministic SHA256-based offline pseudo-embedding used by tests
  // (no network, no model file); "local-bge" runs a Xenova/transformers
  // BGE ONNX model locally (no network, no Python).
  EMBEDDING_PROVIDER: z.enum(["api", "local", "local-bge"]).default("api"),
  EMBEDDING_LOCAL_MODEL_PATH: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("hy-mt2-7b"),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().url().default("https://llm-api.sunwoda.com/v1"),
  // Default bumped 60s → 120s after CA-19 LLM 超时 root-cause analysis
  // (sag_xlsx-CA-19-LLM超时-20260818.md §六). The benchmark prompt is
  // large (system prompt + 1-shot example + chunk content) and the
  // gateway can spike past 60s on a cold cache. The retry layer
  // (LLM_MAX_RETRIES) catches shorter transient stalls; this value
  // covers the worst observed single-call latency.
  //
  // Bumped BACK 120s → 60s after sag_xlsx-LLM超时诊断-20260828.md
  // showed the sunwoda `hy-mt2-7b` endpoint actually returns
  // 1.5k-char prompts in ~340ms and 32k-char prompts in ~1100ms — so
  // a 120s ceiling is 100× the realistic latency and only makes a
  // real hang (DNS, gateway queue, TCP keep-alive drop) take longer to
  // surface. The original 60s cap with retries=0 covers the genuine
  // worst case without the "3× × 120s = 6 minutes per chunk" back-off.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Default 0 (no retries). Previous default 2 caused startup watcher
  // storms to multiply by 3×: each failed embedding request would retry,
  // holding the Node main thread until the HTTP server could answer
  // /health. With 0 a single failure is surfaced in logs immediately.
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(0),
  RERANK_BASE_URL: z.string().url().optional(),
  RERANK_MODEL: z.string().min(1).default("qwen3-rerank"),
  RERANK_INSTRUCT: z.string().min(1).default("Given a user question, rank SAG event candidates by relevance and usefulness for retrieval-augmented question answering."),
  DEFAULT_SEARCH_MODE: z.enum(["standard", "fast"]).default("fast"),
  // Per-folder ingest concurrency: how many files in one watcher can
  // run chunk → embed → insert in parallel. **Default 1** as of
  // 2026-08-10 (was 5). Reason: when this is set >1 the watcher
  // spawns multiple files concurrently and every stage — file IO +
  // xlsx parse + ONNX forward + SQLite write — runs on Node's single
  // main thread. With 5 concurrent files the main thread time-slots
  // between them and per-file latency balloons. Measured in
  // 失败原因/2026-08-10-sag-缺陷汇总7-1-现象报告.md:
  //   isolated 7-1.xlsx ingest = 10.7s wall clock
  //   concurrent 7-1.xlsx ingest = 133.3s readMs (12x slowdown)
  // Schema accepts up to 20 for back-compat with existing deployments,
  // but every consumer clamps to 1 below — concurrent xlsx/Excel COM
  // extraction trips "This operation was aborted" / 30s timeouts when
  // two Excel instances fight over the same Temp folder and SafeNetLOCK
  // decryption. COM is fundamentally a single-process story; doing it
  // in series is the only stable configuration. If a future caller
  // needs more parallelism, they should isolate per-file work into
  // worker_threads rather than bumping this number.
  INGEST_CONCURRENCY: z.coerce.number().int().positive().max(20).default(1),
  // How many sub-batches inside a single file's batchGenerate run in
  // parallel. The chunker splits one long file into ~5-15 batches of
  // ~3500 tokens each; the old serial loop waited ~12 s for a 60 KB
  // xlsx. With concurrency=3, the same file lands in ~3 s. Default 3.
  EMBEDDING_BATCH_CONCURRENCY: z.coerce.number().int().positive().max(20).default(5),
  // How old a manifest tombstone (`last_event = 'deleted'`) must be
  // before the scheduled sweep physically removes it. Default 7
  // days — long enough that an accidental re-add within a week still
  // finds the original row to compare against. Set to 0 to make
  // tombstones disappear immediately on the next sweep.
  TOMBSTONE_RETENTION_DAYS: z.coerce.number().int().nonnegative().max(365).default(7),
  // Cadence for the scheduled tombstone sweep. Default 24 hours.
  // Minimum 60 seconds to avoid accidental tight loops in tests.
  TOMBSTONE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  // Hard upper bound on the wall-clock time a single embedding HTTP call
  // may take before it aborts. Combined with LLM_MAX_RETRIES=0 this
  // caps the worst-case per-file ingest latency.
  //
  // History: was 10s; bumped to 30s after sag_xlsx-9-数据中台-第二波修复后新错误-20260828.md
  // — the data-platform folder's audit logs CSV had ~107k rows, each LLM-
  // extracted event produced a multi-KB content string, and the embedding
  // endpoint (sunwoda hy-mt2-7b) needs ~5-15 s to embed 2 such texts in a
  // single batch. 10s was below that floor and produced per-batch
  // "embedding request aborted: timed out after 10000ms" failures even
  // though the call would have succeeded given a few more seconds.
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Watcher knobs. Set WATCHER_AUTOSTART=false (the default) to keep
  // 黑洞.exe boot fast and the HTTP API responsive — users add folders
  // and trigger sync from the Web UI on demand. STARTUP_SYNC is a
  // synonym kept for backward compatibility with older .env files.
  WATCHER_AUTOSTART: booleanFromString.default(false),
  STARTUP_SYNC: booleanFromString.default(false),
  WATCHER_MAX_CONCURRENT: z.coerce.number().int().positive().max(20).default(1),
  // Watcher runs testConnection() against the configured embedding
  // endpoint every N seconds. If the probe fails, the watcher stops
  // itself (auto-stop the per-folder chokidar) and surfaces the error
  // to the UI via /api/watched-folders status. Set to 0 to disable.
  WATCHER_HEALTHCHECK_INTERVAL_S: z.coerce.number().int().min(0).max(3600).default(60),
  // Number of consecutive failed health probes before the watcher
  // stops itself. A single transient 401 shouldn't kill a long-running
  // ingest; N consecutive failures (default 3) means the endpoint is
  // consistently down.
  WATCHER_HEALTHCHECK_FAILURES: z.coerce.number().int().min(1).max(20).default(3),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().nonnegative().default(4174),
  MCP_HTTP_PATH: z.string().min(1).default("/mcp"),
  MCP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Auth for HTTP transport. `none` keeps dev-only local access open;
  // switch to `bearer` or `api_key` before exposing 4174 on the network.
  MCP_AUTH_MODE: z.enum(["none", "bearer", "api_key"]).default("none"),
  // Bearer mode: any caller presenting this token (Authorization: Bearer
  // <token>) is accepted. For local dev convenience.
  MCP_AUTH_TOKEN: z.string().default(""),
  // api_key mode: comma-separated list of accepted keys. Each caller's
  // identity (the key itself) is recorded in the request log for audit.
  // Ignored when MCP_API_KEY_BACKEND=db.
  MCP_API_KEYS: z.string().default(""),
  // Source of truth for api_key mode. `csv` (default, backwards-compat)
  // reads MCP_API_KEYS above; `db` looks up keys in the
  // `mcp_api_keys` table via mcp-api-keys-service, supporting create /
  // revoke / per-key rate limit / label. Recommended for any deployment
  // beyond local dev.
  MCP_API_KEY_BACKEND: z.enum(["csv", "db"]).default("csv"),
  // Per-tenant LRU cache size for api_key db lookups. Older entries are
  // evicted on overflow. Default 256 — enough for any real tenant.
  MCP_API_KEY_CACHE_MAX: z.coerce.number().int().positive().max(10_000).default(256),
  // Per-token request budget in requests / minute. Default 120 = ~2 rps
  // sustained, well above interactive use. Set 0 to disable.
  MCP_RATE_LIMIT_RPM: z.coerce.number().int().min(0).max(10_000).default(120),
  // When true (default for HTTP transport), MCP tool calls require
  // SAG_MCP_SOURCE_ID to be set the same way stdio does. Stdio behavior
  // is unchanged.
  MCP_REQUIRE_SOURCE_ID: booleanFromString.default(true),
  // Persist MCP HTTP auth / rate-limit / session events to the
  // `audit_logs` SQLite table. Disable in tightly constrained
  // deployments where on-disk growth matters more than traceability.
  MCP_AUDIT_LOG_ENABLED: booleanFromString.default(true),
  ALLOW_PROD_WATCHER: booleanFromString.default(false)
});

export type AppConfig = z.infer<typeof envSchema>;

export const config: AppConfig = envSchema.parse(process.env);

export const hasRemoteEmbedding = config.EMBEDDING_API_KEY.trim().length > 0;
export const hasRemoteLlm = config.LLM_API_KEY.trim().length > 0;
