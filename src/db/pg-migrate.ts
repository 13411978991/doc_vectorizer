/**
 * pg-migrate.ts — Postgres migration runner.
 *
 * Mirrors migrate.ts (SQLite) but drives a real pg.Pool. Re-uses the same
 * migration files under ../migrations/ — those files are written in
 * "SQLite-flavoured PG" (integer for booleans, text for uuids), which
 * works fine on Postgres. We strip `PRAGMA` statements (SQLite-only) and
 * skip `sqlite-vec` module loads before applying the SQL.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { logger } from "../observability/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const migrationsDir = path.join(rootDir, "migrations");

export async function pgMigrate(client: pg.PoolClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at text not null default current_timestamp
    )
  `);

  const files = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const exists = await client.query(
      "select 1 from schema_migrations where name = $1",
      [file]
    );
    if (exists.rowCount && exists.rowCount > 0) {
      logger.info({ migration: file }, "pg-migrate: migration already applied");
      continue;
    }

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    // Strip SQLite-only PRAGMA directives (PG doesn't recognise them).
    // Rewrite SQLite functions/types to PG equivalents:
    //   BLOB → BYTEA
    //   datetime('now') → current_timestamp
    //   current_timestamp returns timestamptz; coalesce(text_col, current_timestamp)
    //     fails on PG because the types don't agree. We cast current_timestamp
    //     to text inside COALESCE to match the SQLite semantics.
    //   DROP TABLE without IF EXISTS / CASCADE fails on PG when FKs point
    //     at the table (SQLite uses PRAGMA foreign_keys=off for this).
    //     Add CASCADE so the migration sequences in 005 and 014 work.
    const insertRewritten = rewriteInsertOrIgnore(sql);

    const cleaned = insertRewritten
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim().toLowerCase();
        if (trimmed.startsWith("pragma ")) return false;
        if (trimmed === "vacuum;") return false;
        return true;
      })
      .join("\n")
      .replace(/\bblob\b/gi, "bytea")
      .replace(/datetime\s*\(\s*'now'\s*\)/gi, "current_timestamp")
      .replace(/coalesce\s*\(\s*([\w.]+)\s*,\s*current_timestamp\s*\)/gi,
               "coalesce($1, current_timestamp::text)")
      // The codebase's queries do `metadata->>'key'` (PG JSONB operator)
      // and `metadata->'key'` and `metadata->`key`` and `metadata || $n`
      // (PG JSONB merge). On SQLite the column is TEXT storing JSON, and
      // sqlite-driver rewrites these. On PG the column needs to actually
      // be jsonb. Promote every `metadata` column declared as TEXT with a
      // JSON-style default to jsonb.
      .replace(/metadata\s+text\s+not\s+null\s+default\s+'\{\}'/gi,
               "metadata jsonb not null default '{}'::jsonb")
      .replace(/metadata\s+text\s+not\s+null\s+default\s+'\[\\\]'/gi,
               "metadata jsonb not null default '[]'::jsonb")
      .replace(/metadata\s+text\s+not\s+null\s+default\s+'\[\\\]'/gi,
               "metadata jsonb not null default '[]'::jsonb")
      .replace(/source_ids\s+text\s+not\s+null\s+default\s+'\[\\\]'/gi,
               "source_ids jsonb not null default '[]'::jsonb")
      .replace(/(\w+)\s+text\s+not\s+null\s+default\s+'\[\\\]'/gi,
               "$1 jsonb not null default '[]'::jsonb")
      .replace(/^drop\s+table\s+(if\s+exists\s+)?(\w+)\s*;?\s*$/gim,
               (_full, ifExists, name) => {
                 // Migrations we ship DROP TABLE events / event_entities /
                 // source_chunks, which all have dependents in PG. CASCADE
                 // is safe and necessary; SQLite uses PRAGMA foreign_keys=off
                 // for the same effect.
                 return `drop table ${ifExists ?? ""}${name} cascade;`;
               })
      // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING. Rewritten by
      // rewriteInsertOrIgnore below; see comment there.

    // PG strictly enforces forward references for DDL — `entities` FK to
    // `entity_types` fails if `entity_types` isn't created first. PG
    // doesn't allow CREATE TABLE … REFERENCES a table that doesn't yet
    // exist, even with IF NOT EXISTS guards.
//
// Strategy: split the file into individual statements; pull out the
// CREATE TABLE IF NOT EXISTS statements; topologically sort them by FK
// dependencies; run them first. CREATE TABLE without IF NOT EXISTS
// (i.e. table rebuilds like migration 005's "drop+recreate event_entities")
// stays in the "others" bucket and runs in original file order so the
// DROP-before-CREATE invariant holds.
    const allStmts = splitSqlStatements(cleaned).map((s) => s.trim()).filter(Boolean);
    const createTableIfNotExists: string[] = [];
    const others: string[] = [];
    for (const s of allStmts) {
      if (/^create\s+table\s+if\s+not\s+exists\b/i.test(s)) {
        createTableIfNotExists.push(s);
      } else if (/^create\s+virtual\s+table\b/i.test(s)) {
        // sqlite-vec virtual tables — skip on PG (we don't have the
        // extension loaded; queries fall back to JS-side cosine).
        continue;
      } else if (/^create\s+table\b/i.test(s)) {
        others.push(s);
      } else {
        others.push(s);
      }
    }
    const sortedCreate = topoSortCreateTables(createTableIfNotExists);
    for (const stmt of [...sortedCreate, ...others]) {
      try {
        await client.query("BEGIN");
        await client.query(stmt);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.error(
          { migration: file, sql: stmt.slice(0, 200), error },
          "pg-migrate: statement failed"
        );
        throw error;
      }
    }
    await client.query(
      "insert into schema_migrations (name) values ($1)",
      [file]
    );
    logger.info({ migration: file }, "pg-migrate: migration applied");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL must be set for pgMigrate");
    process.exit(1);
  }
  (async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const client = await pool.connect();
    try {
      await pgMigrate(client);
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

/**
 * Naive SQL splitter. Walks the string and yields each statement terminated
 * by `;`. Honors parentheses nesting and `--` line comments so we don't
 * split inside a CREATE TABLE body. Not a full SQL parser — adequate for
 * the migration files we ship.
 */
function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    // Line comment skip
    if (!inString && c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      buf += "\n";
      continue;
    }
    if (!inString && c === "'") {
      inString = true;
      stringChar = "'";
    } else if (!inString && c === '"') {
      inString = true;
      stringChar = '"';
    } else if (inString && c === stringChar) {
      // Postgres uses '' to escape a single quote.
      if (next === stringChar) {
        buf += c + next;
        i += 2;
        continue;
      }
      inString = false;
    } else if (!inString && c === "(") {
      depth++;
    } else if (!inString && c === ")") {
      depth--;
    } else if (!inString && depth === 0 && c === ";") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * Topologically sort CREATE TABLE statements by FK references.
 * Each table is a node; an edge T1 → T2 means T1 has a FK to T2.
 * We want T2 before T1 (FK targets created first). Cycles fall back
 * to original order (rare in our migration files; mostly a self-FK or
 * a table that PG accepts anyway via deferred constraints).
 */
function topoSortCreateTables(stmts: string[]): string[] {
  type Entry = { name: string; deps: string[]; sql: string };
  const entries: Entry[] = [];
  for (const sql of stmts) {
    const m = sql.match(/^create\s+table\s+(?:if\s+not\s+exists\s+)?["']?(\w+)["']?/i);
    if (!m) {
      entries.push({ name: `__unknown_${entries.length}`, deps: [], sql });
      continue;
    }
    const name = m[1].toLowerCase();
    const deps = new Set<string>();
    const re = /references\s+(?:["']?(\w+)["']?)/gi;
    let rm: RegExpExecArray | null;
    while ((rm = re.exec(sql))) {
      deps.add(rm[1].toLowerCase());
    }
    deps.delete(name); // self-FK → ignore
    entries.push({ name, deps: Array.from(deps), sql });
  }

  // Simple Kahn-style topo sort. A node is ready when every dep is
  // either already placed or not part of this migration (e.g. cross-migration
  // FKs to tables the next migration will create).
  const result: string[] = [];
  const remaining = [...entries];
  const placed = new Set<string>();
  const names = new Set(entries.map((e) => e.name));

  let progress = true;
  while (remaining.length > 0 && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; i++) {
      const e = remaining[i];
      const ready = e.deps.every((d) => placed.has(d) || !names.has(d));
      if (ready) {
        result.push(e.sql);
        placed.add(e.name);
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }
  }
  // Any leftovers (cycles / unresolved deps) — keep in original order.
  for (const e of remaining) result.push(e.sql);
  return result;
}

/**
 * Replace every `INSERT OR IGNORE INTO …` statement with its PG form:
 *   INSERT INTO … ON CONFLICT DO NOTHING;
 *
 * We parse the statement boundaries (respecting string literals and
 * nested parens) and only rewrite statements that don't end with a
 * RETURNING clause — those should keep their conflict-free semantics
 * so the caller can read the inserted rows back.
 */
function rewriteInsertOrIgnore(sql: string): string {
  const re = /\binsert\s+or\s+ignore\s+into\b/gi;
  const out: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    re.lastIndex = cursor;
    const m = re.exec(sql);
    if (!m) {
      out.push(sql.slice(cursor));
      break;
    }
    out.push(sql.slice(cursor, m.index));
    out.push("insert into ");
    // Walk forward to find the statement's terminating `;`. If the body
    // contains a top-level `returning` clause, leave it alone.
    const stmtStart = m.index + m[0].length;
    const body = readStatementBody(sql, stmtStart);
    if (!body) {
      out.push(sql.slice(m.index));
      break;
    }
    const hasReturning = /\breturning\b/i.test(body.text);
    if (hasReturning) {
      // Strip the "OR IGNORE" semantics and let it run as plain insert.
      out.push(body.text);
    } else {
      // Insert ON CONFLICT DO NOTHING before the trailing `;`.
      const trimmed = body.text.replace(/;\s*$/, "");
      out.push(`${trimmed} on conflict do nothing;`);
    }
    cursor = body.end;
  }
  return out.join("");
}

interface StatementBody {
  /** Statement text up to (and including) the terminating `;`. */
  text: string;
  /** Index just past the `;`. */
  end: number;
}

function readStatementBody(sql: string, startIdx: number): StatementBody | null {
  let i = startIdx;
  let depth = 0;
  let inString = false;
  let stringChar = "";
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      if (c === stringChar && sql[i + 1] === stringChar) {
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      inString = true;
      stringChar = c;
      i++;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      i++;
      continue;
    }
    if (c === ";" && depth === 0) {
      return { text: sql.slice(startIdx, i + 1), end: i + 1 };
    }
    i++;
  }
  return null;
}