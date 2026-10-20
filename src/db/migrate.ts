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

/**
 * Find the byte offset of the LAST `;VACUUM;` (or `VACUUM;` at the
 * start of the script) so we can split a migration into the
 * DDL portion (which runs inside the wrapping tx) and the
 * trailing `VACUUM` (which SQLite refuses to run inside a
 * transaction).
 *
 * The `VACUUM` keyword is reserved; finding it via string scan
 * is unambiguous in practice. We accept either a `;` separator
 * (the canonical "end of previous statement" form) or a `;`-free
 * start-of-script, so a one-liner like `VACUUM;` is also split
 * correctly. The regex requires a trailing `;` (optional whitespace
 * after) so column references or comments don't false-positive.
 */
export function findTrailingVacuumIndex(sql: string): number {
  // Look for the LAST occurrence of: either `;` (preceding
  // separator) or start-of-string, then optional whitespace,
  // then `VACUUM`, then optional whitespace, then `;`, then
  // optional trailing whitespace. We anchor to the end-of-string
  // to catch only the trailing VACUUM, not a mid-script one.
  // (V8's regex engine has a known quirk with `\Z` on some inputs
  // — we use `$` with a manual end-of-string check instead.)
  // `m` flag is essential: without it, `(?:^|;)` only matches input
  // start. We want a line start (right after a newline) to also
  // count as a valid separator so `;VACUUM;` and `\nVACUUM;` both
  // match. With `m`, `^` also matches right after a `\n`.
  //
  // Whitespace before `VACUUM` is `[ \t]*` (no newlines — those are
  // Algorithm — a regex (with one post-validate step) finally
  // converges. The pre-`m`-flag approach kept misidentifying the
  // separator between the DDL block and the trailing VACUUM, and
  // the "last `;` + tail check" approach collapsed mid-script
  // and end-of-script cases when the trimmed tail was empty.
  //
  // We use `m` flag so `^` matches right after `\n` (the typical
  // trailing-VACUUM layout: a `\n` on its own line, then
  // `VACUUM;`). The first alternative `(?:^|[;\n])` is the
  // separator: input start, a `;`, or a newline (any of these
  // is a valid statement boundary). Trailing whitespace is
  // `[ \t]*` — no newlines, because a newline before `VACUUM` is
  // the separator, not intra-statement padding. The end of the
  // match is `$` which with `m` is the line end; we then post-
  // validate that the match consumes everything up to end-of-
  // script (modulo trailing whitespace) to avoid matching a mid-
  // script VACUUM.
  const re = /(?:^|[;\n])[ \t]*VACUUM[ \t]*;?[ \t]*$/gim;
  let lastIdx = -1;
  let lastMatchLen = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    lastIdx = match.index;
    lastMatchLen = match[0].length;
  }
  if (lastIdx < 0) return -1;
  const afterMatch = sql.slice(lastIdx + lastMatchLen);
  if (afterMatch.trim().length > 0) return -1;
  // The match's first captured separator is the chunk the runner
  // slices up to. If the match started with `;` (or with `\n`),
  // that character is part of the post-commit VACUUM and
  // shouldn't go into the pre-DDL block — slice ends BEFORE the
  // match. If the match started at input start (i.e. the whole
  // script is the VACUUM), idx is 0 and the pre block is empty.
  if (lastMatchLen > 0) {
    const sep = sql[lastIdx];
    if (sep === ";" || sep === "\n") {
      return lastIdx; // slice up to (not including) the separator
    }
  }
  // Whole script is the VACUUM. Return 0 so the runner records
  // the migration name in schema_migrations inside an empty
  // transaction (which is a no-op DDL-wise) and runs the VACUUM
  // post-commit.
  return 0;
}

/**
 * Compute the SQL that runs inside the migration transaction.
 * Exported so the regression test pins the EXACT production
 * slicing — a previous inline ternary (`idx > 0 ? slice : ""`)
 * collapsed the "no trailing VACUUM" (-1) and "whole script is
 * VACUUM" (0) branches, so every VACUUM-free migration executed
 * `db.exec("")` and fresh DBs booted with an empty schema while
 * schema_migrations claimed otherwise. Keeping this pure and
 * exported makes that class of drift testable.
 */
export function slicePreVacuumSql(sql: string, lastVacuumIdx: number): string {
  if (lastVacuumIdx > 0) return sql.slice(0, lastVacuumIdx);
  if (lastVacuumIdx === 0) return ""; // whole script is the VACUUM
  return sql; // no trailing VACUUM — run everything inside the tx
}

export async function migrate(): Promise<void> {
  // Use the same path resolver as getPool() so migrations land in the
  // same DB the rest of the app reads from. The previous hardcoded
  // "./data/sag.db" silently drifted from the production path after
  // the Electron migration moved 黑洞.exe deeper under resources/,
  // producing a hidden split where migrations ran against an empty
  // stub and the real legacy DB (often hundreds of MB at the
  // operator's original install location) never got its schema
  // upgraded. resolveDatabasePath() honours `DATABASE_FILE` /
  // `SAG_DATA_DIR` / `<exeDir>/data/sag.db` in that order — explicit
  // env vars point anywhere else, otherwise the DB sits next to the
  // running process so we apply migrations to the DB the app
  // actually serves. (Earlier versions picked the largest of four
  // parent-dir candidates; that heuristic was confusing in dev where
  // /node_modules/sag.db shadowed the real one, so it was removed.)
  const filePath = process.env.DATABASE_FILE ?? (await import("./sqlite-driver.js")).resolveDatabasePath();
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

  // Repair DBs corrupted by the preVacuumSql "" bug (shipped in the
  // VACUUM-split change): schema_migrations has rows but the actual
  // schema was never created because every VACUUM-free migration
  // executed an empty string. Such a DB is indistinguishable from a
  // healthy one at the schema_migrations level, so we probe for a
  // table that 001 always creates. If it's missing while migrations
  // are recorded, the records are lies — wipe them and re-run the
  // whole series. Re-running is safe precisely because the schema is
  // empty: every CREATE TABLE lands on a blank slate. On a healthy
  // DB the probe finds the table and this block is a no-op, which
  // matters because most migrations (ALTER TABLE ADD COLUMN etc.)
  // are NOT idempotent and must never re-run against a real schema.
  const recordedCount = db
    .prepare("select count(*) as n from schema_migrations")
    .get() as { n: number };
  if (recordedCount.n > 0) {
    const coreTable = db
      .prepare(
        "select 1 from sqlite_master where type = 'table' and name = 'watched_folders'"
      )
      .get();
    if (!coreTable) {
      logger.warn(
        { recorded: recordedCount.n },
        "migrate: schema_migrations records exist but core tables are " +
          "missing (empty-schema bug from an earlier build) — wiping " +
          "migration records and re-running all migrations"
      );
      db.exec("delete from schema_migrations");
    }
  }

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
    // P-Migration-Tx — wrap each migration in a transaction so a
    // partial failure (e.g. ALTER TABLE on a half-applied schema
    // after a network blip) rolls back cleanly. Without this, a
    // mid-migration crash leaves the DB in an unrecoverable state
    // and the operator has to manually SQL-against-prod. The
    // migration is recorded in schema_migrations inside the same
    // transaction, so a crashed migration isn't re-attempted on
    // next boot (which would otherwise re-run and fail again).
    //
    // Special case: SQLite forbids `VACUUM` inside a transaction
    // ("cannot VACUUM from within a transaction"). Migration 014
    // (and any future migration that ends with `VACUUM;`) must run
    // outside the wrapping transaction. We find the LAST
    // `;VACUUM;` in the script (no anchors — `;` preceding the
    // VACUUM keyword is the canonical separator). Anything before
    // that point runs inside the tx so the schema_migrations
    // insert rolls back together with the DDL on failure. The
    // trailing VACUUM runs after the tx commits; if it fails, the
    // migration is still recorded so we don't loop on next boot.
    //
    // We deliberately don't use `;\s*VACUUM\s*;?\s*\Z` here:
    // Node's V8 regex engine has a known issue with `\Z` on some
    // input shapes (the anchor matches but the engine skips the
    // `match.index` arithmetic). A last-occurrence search via
    // `lastIndexOf` is unambiguous and side-steps the bug.
    const lastVacuumIdx = findTrailingVacuumIndex(sql);
    // `lastVacuumIdx` is the byte offset of the `;` / `\n` boundary
    // between the DDL block and the trailing VACUUM — the separator
    // belongs to the VACUUM side, not the pre-DDL side, so we slice
    // WITHOUT including it. See slicePreVacuumSql for the three-way
    // contract (and why the -1 case must return the full script).
    const preVacuumSql = slicePreVacuumSql(sql, lastVacuumIdx);
    const hasTrailingVacuum = lastVacuumIdx >= 0;
    const tx = db.transaction((migrationSql: string, name: string) => {
      db.exec(migrationSql);
      db.prepare("insert into schema_migrations (name) values (?)").run(name);
    });
    try {
      tx(preVacuumSql, file);
    } catch (error) {
      logger.error({ migration: file, error }, "migration exec failed");
      throw error;
    }
    if (hasTrailingVacuum) {
      // Run the trailing VACUUM outside the transaction. The
      // migration is already recorded in schema_migrations at this
      // point, so a future boot won't try to re-run the whole
      // script — but the VACUUM is best-effort, so if it fails
      // we log a warning rather than crashing the boot.
      try {
        db.exec("VACUUM");
        logger.info({ migration: file }, "migration: post-commit VACUUM done");
      } catch (error) {
        logger.warn(
          { migration: file, error: (error as Error).message },
          "migration: post-commit VACUUM failed (non-fatal)"
        );
      }
    }
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