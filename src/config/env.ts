import "dotenv/config";
import { z } from "zod";

export const SUPPORTED_EMBEDDING_DIMENSIONS = 1024;
// Public, vendor-neutral defaults. Override via .env (EMBEDDING_BASE_URL,
// LLM_BASE_URL, RERANK_BASE_URL) — leaving these empty in shipped configs
// is the safe default so a fresh install doesn't accidentally point at
// a third-party service the operator never agreed to.
export const DEFAULT_302AI_BASE_URL = "";

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
      `EMBEDDING_DIMENSIONS must be ${SUPPORTED_EMBEDDING_DIMENSIONS} or 4096`),
  // Operator must set EMBEDDING_MODEL via .env. No remote vendor default —
  // a fresh install would otherwise post the user's first request to a
  // random provider the operator never authorised.
  EMBEDDING_MODEL: z.string().default(""),
  EMBEDDING_API_KEY: z.string().default(""),
  // Default empty string is permitted by z.string() (no `.url()`); the
  // embedding client treats "" as "not configured" and surfaces a clear
  // startup error pointing at .env instead of guessing a URL.
  EMBEDDING_BASE_URL: z.string().default(""),
  // "api" calls a remote OpenAI-compatible endpoint; "local" is a
  // deterministic SHA256-based offline pseudo-embedding used by tests
  // (no network, no model file); "local-bge" runs a Xenova/transformers
  // BGE ONNX model locally (no network, no Python).
  EMBEDDING_PROVIDER: z.enum(["api", "local", "local-bge"]).default("api"),
  EMBEDDING_LOCAL_MODEL_PATH: z.string().default(""),
  LLM_MODEL: z.string().default(""),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().default(""),
  // Default 60s. Reasoning: a slow prompt (system + 1-shot example +
  // chunk content) plus a cold gateway cache can spike past 30s. Combined
  // with LLM_MAX_RETRIES=0 this caps worst-case per-file ingest latency
  // without masking genuine hangs (DNS, gateway queue, TCP keep-alive
  // drop). Raise via .env if your endpoint routinely needs longer.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Default 0 (no retries). Previous default 2 caused startup watcher
  // storms to multiply by 3×: each failed embedding request would retry,
  // holding the Node main thread until the HTTP server could answer
  // /health. With 0 a single failure is surfaced in logs immediately.
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(0),
  RERANK_BASE_URL: z.string().default(""),
  RERANK_MODEL: z.string().default(""),
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
  // ─── Large-file optimisation knobs ─────────────────────────────────────
  // Global hard cap on a single ingest file's size. Files above this
  // are skipped during ingest (recorded as "skipped: exceeds maxBytes").
  // The orchestrator-level filter.maxBytes still wins when it is set on
  // the watched folder; this is the last-line ceiling.
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  // PDF parser cap. pdfjs happily decodes 10k-page technical manuals;
  // we cap at a generous 5000 to bound the markdown blast radius.
  MAX_PDF_PAGES: z.coerce.number().int().positive().max(50_000).default(5000),
  // XLSX sheet caps. 200 rows / 26 columns was tuned for audit workbooks
  // where the relevant signal is the top of each sheet. Raising either
  // figure multiplies the embedding cost (each row → ~one chunk).
  MAX_SHEET_ROWS: z.coerce.number().int().positive().max(10_000).default(200),
  MAX_SHEET_COLS: z.coerce.number().int().positive().max(200).default(26),
  // When the converter's markdown output exceeds this many characters,
  // the orchestrator truncates with a clear marker. A 60 MB markdown
  // blob would otherwise balloon chunking + embedding latency and peak
  // Node heap. 50 MB is a soft ceiling that comfortably fits the
  // audit-folder use cases while protecting the runtime.
  MAX_CONVERTED_MARKDOWN_CHARS: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  // Files above this byte threshold use a streaming read path (e.g.
  // PDF page-by-page, TXT/MD line-by-line) instead of readFileSync of
  // the whole file. Keeps peak heap bounded on 100 MB inputs.
  STREAMING_CONVERT_THRESHOLD_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
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
  // may take before it aborts. Default 30s. Combined with
  // LLM_MAX_RETRIES=0 this caps worst-case per-file ingest latency.
  // A large batch (multi-KB content strings) can take 5-15 s on typical
  // remote endpoints; raise via .env if your endpoint routinely needs more.
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
