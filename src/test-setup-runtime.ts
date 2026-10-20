/**
 * test-setup-runtime.ts — Per-file setup shim for vitest.
 *
 * Runs in the same V8 worker that executes the test file, AFTER
 * the global migrations are complete (which run in a separate
 * parent process). We call `initPool()` here so the lazy proxy in
 * db/pool.ts gets wired in this worker's module graph; if we
 * called it from globalSetup the value would be set in the parent
 * process and the worker would still see `_pool === null`.
 *
 * Every test that touches `pool.query(...)` depends on this file
 * being listed in vitest.config.ts `setupFiles`. Without it the
 * test will see `db.pool accessed before initPool() resolved` for
 * the very first query.
 */
import { afterAll, beforeAll } from "vitest";

const usePg = !!process.env.DATABASE_URL;

beforeAll(async () => {
  // Wire the lazy pool proxy in this worker process. Both SQLite
  // and the embedded-Postgres paths funnel through the same
  // `initPool()` call, so we branch only to handle the rare
  // case where the globalSetup hasn't yet migrated the schema
  // (rare in CI, common in fresh dev DBs).
  if (!usePg && !process.env.DATABASE_FILE) {
    process.env.DATABASE_FILE = process.env.DATABASE_FILE ?? "./data/test-sag.db";
  }
  const { initPool } = await import("./db/pool.js");
  await initPool();

  // Idempotent seed of the offline AI provider row so tests that
  // exercise ai-settings-service don't fail with "not configured".
  const { pool } = await import("./db/pool.js");
  try {
    await pool.query(
      `insert into ai_provider_settings
         (id, embedding_provider, embedding_base_url, embedding_model,
          embedding_dimensions, llm_base_url, llm_model, llm_timeout_ms,
          llm_max_retries, metadata, updated_at)
       values
         ('global', 'api', 'http://localhost/offline', 'deterministic-sha256',
          1024, '', 'offline', 60000, 0,
          '{"source":"test-setup-runtime"}', current_timestamp)
       on conflict (id) do update set
         embedding_provider = excluded.embedding_provider,
         embedding_base_url = excluded.embedding_base_url,
         embedding_model = excluded.embedding_model,
         embedding_dimensions = excluded.embedding_dimensions,
         llm_base_url = excluded.llm_base_url,
         llm_model = excluded.llm_model,
         updated_at = current_timestamp`,
      []
    );
  } catch (error) {
    console.warn("[test-setup-runtime] ai_provider seed failed (non-fatal):", (error as Error).message);
  }
});

afterAll(async () => {
  // Don't closePool() — globalSetup's migrations only ran once and
  // the next test file in this worker (or a fresh `vitest run`)
  // needs the same open SQLite file handle. Vitest's global
  // teardown shuts the embedded pg instance; SQLite's better-
  // sqlite3 handles are released when the process exits.
});