/**
 * migrate.ts — SQLite migration runner.
 *
 * The PG schema has accumulated 19 migrations that reference types like
 * `jsonb`, `uuid`, `timestamptz`, and pgvector `vector(N)`. For the SQLite
 * MVP we only need a minimal schema that covers:
 *   - watched_folders
 *   - documents / chunks / entities
 *   - audit_projects / audit_procedures / audit_analyses
 *   - audit_templates / audit_template_procedures
 *   - kb_projects / kb_sources
 *   - audit_logs
 *   - audit_skills / audit_skill_usage
 *   - shared_folder_config / audit_programs / audit_tasks
 *
 * Rather than translating every PG migration (most of which we don't yet
 * use), we write a single SQLite-native migration that mirrors the schema.
 * The PG migrations stay on disk untouched — they simply won't be applied
 * when running against SQLite.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { logger } from "../observability/logger.js";
import { closePool } from "./sqlite-driver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
// MIGRATIONS_DIR override (used by the SAG Windows SEA bundle, which
// unpacks the .sql files alongside sag.exe instead of under the project
// tree). Falls back to the in-tree path during normal `npm run` usage.
const sqliteMigrationsDir = process.env.MIGRATIONS_DIR
  ? path.resolve(process.env.MIGRATIONS_DIR)
  : path.join(rootDir, "src/db/sqlite/migrations");

export async function migrate(): Promise<void> {
  const filePath = process.env.DATABASE_FILE ?? "./data/sag.db";
  mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  // Required for any migration that creates vec0 virtual tables. Without
  // this, `CREATE VIRTUAL TABLE ... USING vec0(...)` errors with
  // "no such module: vec0".
  try {
    sqliteVec.load(db);
  } catch (error) {
    logger.warn(
      { error: (error as Error).message },
      "migrate: sqlite-vec load failed; vec0 migrations will be skipped"
    );
  }

  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at text not null default current_timestamp
    )
  `);

  await fs.mkdir(sqliteMigrationsDir, { recursive: true });
  logger.info({ dir: sqliteMigrationsDir }, "migrate: searching for migration files");

  const files = (await fs.readdir(sqliteMigrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const exists = db
      .prepare("select 1 from schema_migrations where name = ?")
      .get(file);
    if (exists) {
      logger.info({ migration: file }, "migration already applied");
      continue;
    }

    const sql = await fs.readFile(path.join(sqliteMigrationsDir, file), "utf8");
    try {
      db.exec(sql);
    } catch (error) {
      logger.error({ migration: file, error }, "migration exec failed");
      throw error;
    }
    db.prepare("insert into schema_migrations (name) values (?)").run(file);
    logger.info({ migration: file }, "migration applied");
  }

  db.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  migrate()
    .then(async () => closePool())
    .catch(async (error: unknown) => {
      logger.error({ error }, "migration failed");
      await closePool();
      process.exit(1);
    });
}