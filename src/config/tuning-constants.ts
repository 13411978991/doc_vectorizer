/**
 * src/config/tuning-constants.ts — Single source of truth for the
 * non-env-tunable magic numbers that show up throughout the hot paths.
 *
 * Why this file exists: Audit Tier 2 #15 found ~30 magic numbers
 * (8_000, 200, 5_000, 60_000, 16, 8, ...) scattered across
 * ingestion-service, db-write-worker-pool, db-write-worker-entry,
 * analyzer, ingest-queue, and the embedding client. Each has a
 * "why this value" comment but no name to grep for. When tuning
 * "the watcher is slow on spinning disks, what concurrency should I
 * bump?" the maintainer had to read every file's comments to find
 * the relevant constant.
 *
 * What belongs here:
 *   - Constants that are NOT user-tunable (env vars live in env.ts)
 *   - Constants whose value has a measured or documented rationale
 *   - Constants used in 2+ files (the dedup is the main win)
 *
 * What does NOT belong here:
 *   - Env-var defaults (those live in env.ts and are operator-tunable)
 *   - Per-file format-specific limits (those stay with their module
 *     because the value is a measurement specific to that format)
 *
 * Each group below has the original value + a comment with the
 * source where it was first introduced. When bumping a value,
 * update the comment with the new measurement date.
 */

// ─── Ingest pipeline ──────────────────────────────────────────────
/** Max characters per chunk sent to an embedding model. The BGE
 *  tokenizer caps at 512 tokens, and the encoding roughly maps
 *  1 CJK character ≈ 1.5 tokens; 8_000 chars leaves headroom for
 *  mixed CJK + Latin content while staying well under 512 tokens
 *  after the truncateToTokenLimit() binary-search pass. */
export const EMBEDDING_INPUT_MAX_CHARS = 8_000;

/** How many in-flight embedding API requests a single file can
 *  run in parallel. The chunker splits one long file into ~5-15
 *  batches of ~3500 tokens each; serial took ~12s for a 60 KB
 *  xlsx, concurrency=3 lands it in ~3s. */
export const EMBEDDING_BATCH_CONCURRENCY_DEFAULT = 5;

// ─── db-write-worker ─────────────────────────────────────────────
/** How many worker statements to run before re-checking the abort
 *  flag. The check itself is a single boolean read so cost is
 *  negligible; the choice is "how quickly do we want abort to land
 *  after a user clicks pause?". 16 was chosen because single
 *  statements average ~50ms, so abort lands within ~800ms of
 *  pause — fast enough to feel responsive without burning cycles. */
export const DB_WRITE_ABORT_CHECK_EVERY = 16;

/** Per-op IPC timeout between main process and db-write-worker
 *  child. The longest real op (a 200-statement dbWrite) finishes
 *  in ~9s. 60s gives ~6x headroom for slow disks before failing
 *  the batch and falling back. */
export const DB_WRITE_OP_TIMEOUT_MS = 60_000;

/** busy_timeout (ms) shared between main process and the
 *  db-write-worker child. Must be identical on both sides of the
 *  IPC channel — see sqlite-driver.ts:42 and
 *  db-write-worker-entry.ts:69. The value matches SQLite's
 *  default-busy behaviour: long enough to outlast a 9s dbWrite
 *  cycle on a quiet DB without holding HTTP handlers open forever
 *  if the worker truly wedges. */
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

// ─── Watcher ─────────────────────────────────────────────────────
/** Concurrent SHA-1 hashes per scanFolder call. SHA-1 reads every
 *  file end-to-end, so the wall-clock cost on a 27k-file folder
 *  was 10-30 minutes when serialised. 8 is the sweet spot for
 *  SSD; the parallel readdir (DIR_CONCURRENCY below) keeps the
 *  disk scheduler busy enough that bumping this higher shows
 *  diminishing returns. */
export const SCAN_CONCURRENCY = 8;

/** Concurrent directory reads during scanFolder. Kept equal to
 *  SCAN_CONCURRENCY so the disk scheduler sees a constant stream
 *  of work — splitting these two limits would have one bottleneck
 *  on the other. */
export const DIR_CONCURRENCY = 8;

// ─── Watcher health check ─────────────────────────────────────────
/** How often the watcher runs testConnection() against the
 *  configured embedding endpoint, in seconds. 60 was chosen
 *  because probes are cheap (one HTTP call) and 1/min lets a
 *  misconfigured auth key surface within a minute without
 *  hammering the endpoint. */
export const WATCHER_HEALTHCHECK_INTERVAL_S_DEFAULT = 60;

/** Consecutive failed health probes before the watcher stops
 *  itself. 3 absorbs a single transient 401/network blip; 4+ in a
 *  row is a real outage. */
export const WATCHER_HEALTHCHECK_FAILURES_DEFAULT = 3;

// ─── Pause / abort plumbing ──────────────────────────────────────
/** How long a folder can stay in 'syncing' before the next
 *  startup's cleanupStaleSyncRuns() flips it back. 10 minutes
 *  absorbs a long-running ingest that crashed mid-flight; if the
 *  user re-pauses, the next resume sees the row in `pending`
 *  state and re-enqueues it. Anything shorter risks
 *  flipping rows that are still legitimately in flight. */
export const STALE_SYNC_RUN_RETENTION_MS = 10 * 60 * 1000;

// ─── Ingest queue ────────────────────────────────────────────────
/** How long drainFolder() sleeps between polls for the next
 *  pending item. 100ms is fast enough that the user never notices
 *  the gap, slow enough that a 5-folder concurrent sync doesn't
 *  pin a CPU on the busy-poll. */
export const DRAIN_POLL_INTERVAL_MS = 100;
