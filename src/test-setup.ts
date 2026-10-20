/**
 * test-setup.ts — Global setup for vitest.
 *
 * Picks between two backends:
 *   - DATABASE_URL set → spin up an embedded Postgres, run pgMigrate, set
 *     DATABASE_URL so db/pool.ts wires PgPool.
 *   - otherwise        → run the SQLite migrate against ./data/test-sag.db
 *     and let db/pool.ts wire SqlitePool.
 *
 * Each test file runs serially (file parallelism is disabled) so we don't
 * have to deal with concurrent writers to the same DB.
 *
 * IMPORTANT: this file is invoked BOTH ways:
 *   1. globalSetup (`./src/test-setup.ts`) — runs once in a parent
 *      process before any test file. We use it to spin up the
 *      embedded Postgres + run the schema migrations.
 *   2. setupFiles (`./src/test-setup-runtime.ts`) — runs IN each
 *      test file's worker before its tests start. We use it to
 *      call `initPool()` so the lazy proxy in db/pool.ts is wired
 *      in the same V8 isolate that executes the test code.
 *
 * Calling `initPool()` from `globalSetup` is a no-op for tests:
 * the `_pool` module is loaded fresh per worker, so any value set
 * in the parent process is invisible to the children. That's why
 * the per-file setupFiles shim exists.
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const usePg = !!process.env.DATABASE_URL;

export async function setup(): Promise<void> {
  // Force a deterministic offline embedding for tests. The "local"
  // (SHA256 pseudo-embedding) provider was removed from the runtime
  // union on 2026-10-13, so the env path no longer carries it.
  // Tests that need a stable deterministic 1024-d vector now
  // call deterministicEmbedding() directly (see
  // src/ai/__tests__/llm-client-repair.test.ts) rather than
  // routing through batchGenerate. We still set
  // EMBEDDING_PROVIDER='api' (the only safe prod-side value) so
  // code paths that read the env don't trip zod validation.
  process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? "api";
  process.env.EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL ?? "http://localhost/offline";
  process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "deterministic-sha256";
  // LLM client is exercised by ingestion-service; for tests we leave
  // its env config alone so production callers' mocks keep working.

  if (usePg) {
    const pgDataDir = process.env.PG_DATA_DIR ?? "./data/pg-test";
    await pgMigrateAgainstEmbedded(pgDataDir);
    process.env.SAG_WATCHER_SKIP_PREFLIGHT = process.env.SAG_WATCHER_SKIP_PREFLIGHT ?? "1";
  } else {
    const { migrate } = await import("./db/migrate.js");
    // 2026-10-13: refuse to run tests against the production DB.
    // Previously, if DATABASE_FILE was unset, the tests would default
    // to ./data/test-sag.db, but if it was already pointed at the
    // production DB (e.g. by a misconfigured runner, or by `npm test`
    // without an explicit env), the test setup would clobber the
    // real ai_provider_settings row. We now hard-fail instead so a
    // test run can never overwrite the operator's settings.
    const dbFile = process.env.DATABASE_FILE ?? "./data/test-sag.db";
    if (dbFile === "./data/sag.db") {
      throw new Error(
        "test-setup: refusing to run against the production DB (./data/sag.db). " +
          "Unset DATABASE_FILE to use ./data/test-sag.db, or set it to a different path."
      );
    }
    process.env.DATABASE_FILE = dbFile;
    await migrate();
    process.env.SAG_WATCHER_SKIP_PREFLIGHT = process.env.SAG_WATCHER_SKIP_PREFLIGHT ?? "1";
  }
}

async function seedOfflineAiSettings(): Promise<void> {
  const pool = (await import("./db/pool.js")).pool;
  // pg-driver / sqlite-driver both expose .query with the same shape.
  try {
    await pool.query(
      `insert into ai_provider_settings
         (id, embedding_provider, embedding_base_url, embedding_model,
          embedding_dimensions, llm_base_url, llm_model, llm_timeout_ms,
          llm_max_retries, metadata, updated_at)
       values
         ('global', 'api', 'http://localhost/offline', 'deterministic-sha256',
          1024, '', 'offline', 60000, 0,
          '{"source":"test-setup"}', current_timestamp)
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
    // Don't fail test setup if the seed can't run — individual tests
    // that need it can insert manually.
    console.warn("[test-setup] failed to seed offline ai_provider_settings:", (error as Error).message);
  }
}

async function pgMigrateAgainstEmbedded(dataDir: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.rm(dataDir, { recursive: true, force: true });

  const port = 54329;
  const user = "sag_test";
  const password = "sag_test";
  const dbName = "sag_test";
  const url = process.env.DATABASE_URL ?? `postgres://${user}:${password}@127.0.0.1:${port}/${dbName}`;

  const pgInstance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
    initdbFlags: ["--no-locale", "--encoding=UTF8"],
  });

  await pgInstance.initialise();
  await pgInstance.start();
  await pgInstance.createDatabase(dbName).catch((e) => {
    // "database already exists" is fine if a previous run left it.
    if (!String(e).toLowerCase().includes("already exists")) throw e;
  });

  process.env.DATABASE_URL = url;

  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const { pgMigrate } = await import("./db/pg-migrate.js");
    await pgMigrate(client);
  } finally {
    client.release();
    await pool.end();
  }

  // Stash the running instance on a global so teardown can shut it down.
  // Vitest's globalSetup exposes a `teardown` export that runs at the end
  // of the run.
  (globalThis as any).__sagEmbeddedPg = pgInstance;
}

export async function teardown(): Promise<void> {
  const pgInstance = (globalThis as any).__sagEmbeddedPg;
  if (pgInstance) {
    try {
      await pgInstance.stop();
    } catch {
      // Best effort — vitest may have already killed the child process.
    }
  }
}