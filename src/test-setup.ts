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
 */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const usePg = !!process.env.DATABASE_URL;

export async function setup(): Promise<void> {
  // Force the offline deterministic embedding provider so e2e /
  // integration / race-condition suites don't need a real embedding
  // API key. The env fallback path in ai-settings-service.ts honours
  // NODE_ENV=test, so we have to set the env vars here rather than
  // just seed the DB row.
  process.env.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER ?? "local";
  process.env.EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL ?? "http://localhost/offline";
  process.env.EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "deterministic-sha256";
  // LLM client is exercised by ingestion-service; for tests we leave
  // its env config alone so production callers' mocks keep working.

  if (usePg) {
    const pgDataDir = process.env.PG_DATA_DIR ?? "./data/pg-test";
    await pgMigrateAgainstEmbedded(pgDataDir);
    process.env.SAG_WATCHER_SKIP_PREFLIGHT = process.env.SAG_WATCHER_SKIP_PREFLIGHT ?? "1";
    await seedOfflineAiSettings();
  } else {
    const { migrate } = await import("./db/migrate.js");
    process.env.DATABASE_FILE = process.env.DATABASE_FILE ?? "./data/test-sag.db";
    await migrate();
    process.env.SAG_WATCHER_SKIP_PREFLIGHT = process.env.SAG_WATCHER_SKIP_PREFLIGHT ?? "1";
    await seedOfflineAiSettings();
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
         ('global', 'local', '', 'deterministic-sha256',
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