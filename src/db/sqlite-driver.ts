/**
 * sqlite-driver.ts — SQLite-compatible wrapper that mimics the pg Pool
 * interface used throughout the codebase. Allows us to swap PG for SQLite
 * without rewriting every callsite.
 *
 * What we adapt:
 *   - pool.query(sql, params) → pg returns { rows, rowCount }
 *   - We return { rows: [], rowCount: 0 } shape
 *
 * What we DON'T adapt (out of scope for this MVP):
 *   - PG-specific JSONB operators (->>, @>, jsonb_array_elements, etc.)
 *   - PG-specific full-text search (tsvector / tsquery)
 *   - pgvector distance operators (<->, <#>, <=>)
 *   - LISTEN/NOTIFY
 *
 * The MVP migration converts SQL in callers that use these features.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

const databases = new Map<string, Database.Database>();

function getOrOpen(filePath: string): Database.Database {
  const resolved = resolve(filePath);
  const existing = databases.get(resolved);
  // Return only if the cached connection is still open. A closed connection
  // may still exist in the map (e.g. after resetPool); drop and re-open it.
  if (existing && (existing as any).open) return existing;
  if (existing) databases.delete(resolved);
  mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    sqliteVec.load(db);
  } catch (error) {
    // sqlite-vec might not be installed; that's OK, distance functions will
    // surface at query time instead of load time.
    console.warn("[sqlite-driver] sqlite-vec load failed:", (error as Error).message);
  }
  databases.set(resolved, db);
  return db;
}

function bindParams(stmt: Database.Statement, params: unknown[]): unknown[] {
  // SQLite is positional only (?, ?, ?). PG uses $1, $2, ... — translate.
  return stmt.bind(...params) as unknown as unknown[];
}

/**
 * Translate a PG-style SQL string into a SQLite-compatible one. This is a
 * minimal translator that handles the patterns we actually use:
 *
 *   - $1, $2, ... → ?, ?, ...
 *   - $N placeholders may appear multiple times for the same N (PG reuses
 *     the value). SQLite's `?` is positional; we keep $N→? mapping but
 *     also return a `reorderedParams: unknown[]` array of the same length
 *     as the `?` count, duplicating values where the same $N is reused.
 *   - boolean true/false → 1/0 (SQLite has no boolean type)
 *   - ::identifier casts → drop (handles ::jsonb, ::text, ::uuid, ::boolean,
 *     ::int, ::integer, ::bigint, ::numeric, ::float, ::vector, ::uuid[],
 *     and any other PG type suffix).
 *   - `FOR UPDATE` (row-level locking) → drop (SQLite uses begin/concurrent).
 *   - `[]` after `::<array-type>` already gets dropped with the cast; bare
 *     `[]` is left alone.
 *   - jsonb_array_elements/extract paths → TEXT only (we don't expect to
 *     migrate those callers; they fall through with an error if used).
 */
export interface TranslateResult {
  sql: string;
  /** Order of $N placeholders as they appear in the translated SQL. */
  paramOrder: number[];
}

export function translateSql(sql: string): string {
  return translateSqlFull(sql).sql;
}

export function translateSqlFull(sql: string): TranslateResult {
  let out = sql;
  // Replace each $N with a placeholder, recording the N order so callers
  // can expand their $N-keyed parameter list into a positional list.
  const paramOrder: number[] = [];
  out = out.replace(/\$(\d+)/g, (_full, n) => {
    paramOrder.push(Number(n));
    return "?";
  });
  // boolean literals.
  out = out.replace(/\btrue\b/gi, "1").replace(/\bfalse\b/gi, "0");
  // Strip all ::cast suffixes generically (handles ::jsonb, ::text, ::uuid,
  // ::boolean, ::int, ::integer, ::bigint, ::numeric, ::float, ::vector,
  // ::uuid[], ::text[], etc.). Without this, $5::boolean survives and SQLite
  // errors with "unrecognized token :".
  out = out.replace(/::[a-zA-Z_][a-zA-Z0-9_]*(\s*\[\s*\])?/g, "");
  // `FOR UPDATE` is PG row-locking that SQLite ignores (WAL handles concurrency).
  out = out.replace(/\bfor\s+update\b/gi, "");
  // now() → current_timestamp
  out = out.replace(/\bnow\(\)/gi, "current_timestamp");
  // jsonb operators on left side: data->>'k' → json_extract(data, '$.k').
  // Capture optional `prefix.` so qualified columns like `p.metadata->>'k'`
  // don't become `p.json_extract(metadata, '$.k')` (syntax error).
  out = out.replace(/([\w.]+)->>'([^']+)'/g, "json_extract($1, '$.$2')");
  // data->'k' → json_extract(data, '$.k')
  out = out.replace(/([\w.]+)->'([^']+)'/g, "json_extract($1, '$.$2')");
  // data->k (bare key, e.g. column 'k') → json_extract(data, '$.k')
  out = out.replace(/([\w.]+)->(\w+)/g, "json_extract($1, '$.$2')");
  // gen_random_uuid() → SQLite-generated UUID-v4 hex string. We can't
  // produce a real RFC 4122 UUID from SQLite built-ins alone, but we can
  // produce a 32-char lowercase hex blob which the codebase treats
  // opaquely (any token uniquely identifying a row).
  out = out.replace(/\bgen_random_uuid\(\)/gi, "lower(hex(randomblob(16)))");
  // PG array contains: x = any(?) → x in (select value from json_each(?)
  // — after the cast strip, `status = any($1::text[])` and similar reduce
  // to `status = any(?)`. The params module serialises JS arrays to JSON
  // text, which json_each decodes row-by-row.
  out = out.replace(/=\s*any\(\s*\?\s*\)/gi, " in (select value from json_each(?))");
  // PG JSONB merge: `metadata || $4::jsonb` → `json_patch(metadata, $4)`.
  // Handle the all-text fallbacks SQLite produces post-cast-strip.
  out = out.replace(/(\w+)\s*\|\|\s*(\?)/g, "json_patch(coalesce($1, '{}'), $2)");
  // `tbl1.column || tbl2.column` (no params, e.g. ON CONFLICT) →
  // `json_patch(coalesce(tbl1.column, '{}'), tbl2.column)`.
  out = out.replace(
    /(\w+(?:\.\w+)?)\s*\|\|\s*(\w+(?:\.\w+)?)/g,
    "json_patch(coalesce($1, '{}'), $2)"
  );
  // @> containment: we'll skip — not used in core queries.
  return { sql: out, paramOrder };
}

/**
 * SQLite has no default for `id text primary key`. Callers that omit `id`
 * from the INSERT column list expect a unique id. Detect this pattern and
 * inject a generated `id` column plus parameter so the existing column
 * list doesn't need refactoring.
 */
function ensureIdColumn(sql: string): { sql: string; prefixParams: unknown[] } {
  const m = /^\s*insert\s+into\s+([\w."]+)\s*\(([^)]+)\)/i.exec(sql);
  if (!m) return { sql, prefixParams: [] };
  const [, tableRaw, colsRaw] = m;
  const table = tableRaw.toLowerCase().replace(/"/g, "");
  const cols = colsRaw
    .split(",")
    .map((c) => c.trim().toLowerCase().replace(/"/g, ""));
  // Only intervene for tables we know need an auto-generated id (the ones
  // the codebase uses with an `id text primary key` and no DEFAULT).
  const tablesWithoutIdDefault = new Set([
    "watched_folders",
    "watched_folder_runs",
    "sources",
    "documents",
    "chunks",
    "entities",
    "audit_projects",
    "audit_procedures",
    "audit_analyses",
    "audit_indexes",
    "audit_reports",
    "audit_logs",
    "audit_skills",
    "audit_skill_usage",
    "audit_templates",
    "audit_programs",
    "audit_tasks",
    "events",
    "event_entities",
    "kb_projects",
    "kb_sources",
    "shared_folder_config",
    "mcp_api_keys"
  ]);
  if (!tablesWithoutIdDefault.has(table)) return { sql, prefixParams: [] };
  if (cols.includes("id")) return { sql, prefixParams: [] };
  const newColsRaw = "id, " + colsRaw.trim();
  // Replace the column list with the augmented one AND prepend a `?` to
  // the matching values list so parameter bindings stay aligned.
  const newSql = sql.replace(
    /insert\s+into\s+([\w."]+)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/i,
    (_full, t, _cols2, valsRaw) => `insert into ${t}(${newColsRaw}) values (?, ${valsRaw.trim()})`
  );
  return { sql: newSql, prefixParams: [randomHex(16)] };
}

function randomHex(byteLen: number): string {
  // Generate an RFC 4122 v4 UUID string with dashes (8-4-4-4-12 hex).
  // Tests assert the id matches /^[0-9a-f-]{36}$/ so plain hex bytes
  // would not be acceptable here.
  if (byteLen !== 16) {
    // Fall back to plain hex for any other size; we only call this
    // with 16 from ensureIdColumn.
    let out = "";
    for (let i = 0; i < byteLen; i++) {
      out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
    }
    return out;
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Per RFC 4122 §4.4, set the version (high 4 bits of byte 6) to 4
  // and the variant (high 2 bits of byte 8) to 10b.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join("")
  ].join("-");
}

export class SqlitePool {
  constructor(public filePath: string) {}

  private get db(): Database.Database {
    return getOrOpen(this.filePath);
  }

  /**
   * Mimic pg's pool.connect() — SQLite is single-connection so we return self.
   * Callers can use client.query() identically; transactions are no-ops
   * (SQLite defaults to autocommit + WAL mode handles concurrency).
   */
  async connect(): Promise<SqlitePool> {
    return this;
  }

  async release(): Promise<void> {
    // No-op
  }

  async query<T = any>(
    sql: string,
    params: unknown[] = []
  ): Promise<QueryResult<T>> {
    const { sql: translated, paramOrder } = translateSqlFull(sql);
    // If this is an INSERT into a table whose schema has no `id` default
    // and the column list omits `id`, auto-generate one and prefix it to
    // the parameter list.
    const { sql: withId, prefixParams } = ensureIdColumn(translated);
    // Param order: PG reuses $N across the SQL, but SQLite `?` is positional.
    // Expand the $N-keyed param list into a positional list, duplicating
    // values where $N appears multiple times. If the SQL already uses
    // SQLite-native `?` placeholders (no `$N` present), treat each `?`
    // as a positional bind to the params array in order. This lets tests
    // and seam code write SQLite-style queries directly without going
    // through the PG-syntax translator.
    const effectiveParamOrder =
      paramOrder.length > 0
        ? paramOrder
        : Array.from({ length: (withId.match(/\?/g) ?? []).length }, (_, i) => i + 1);
    const positional = effectiveParamOrder.map((n) => params[n - 1]);
    const finalParams = prefixParams.concat(positional);
    // SQLite strictly rejects undefined and boolean true/false. Convert
    // undefined → null and boolean → 0/1 for PG-compatible calling patterns.
    const safeParams = finalParams.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      // TypedArrays (Float32Array, etc.) are passed through to better-sqlite3
      // so sqlite-vec can bind them as vector values. JSON.stringify would
      // mangle them into a text array and break vec_distance_cosine calls.
      if (ArrayBuffer.isView(p) && !(p instanceof DataView)) {
        return p;
      }
      // JSON values are stored as TEXT in SQLite.
      if (p !== null && typeof p === "object" && !Buffer.isBuffer(p) && !(p instanceof Date)) {
        return JSON.stringify(p);
      }
      return p;
    });
    try {
      const stmt = this.db.prepare(withId);
      if (/^\s*(insert|update|delete|create|drop|alter)\b/i.test(withId)
        || /^\s*with\b[\s\S]+\b(insert|update|delete)\b/i.test(withId)) {
        // better-sqlite3 supports INSERT/UPDATE/DELETE...RETURNING via .all(),
        // and bare INSERT/UPDATE/DELETE via .run(). Use one or the other.
        // The second clause handles CTE-prefixed statements like
        // `with ... as (...), delete from entities where ...` — common in
        // PG-styled repository code that wraps DELETE in a CTE.
        if (/\breturning\b/i.test(withId)) {
          const returningRows = stmt.all(...safeParams) as T[];
          return { rows: returningRows, rowCount: returningRows.length };
        }
        const info = stmt.run(...safeParams);
        return { rows: [] as unknown as T[], rowCount: info.changes };
      }
      if (/^\s*(begin|commit|rollback)\b/i.test(withId)) {
        // No-op: SQLite uses autocommit + WAL; explicit BEGIN/COMMIT
        // for transactional grouping isn't needed for our use cases.
        return { rows: [] as unknown as T[], rowCount: 0 };
      }
      const rows = stmt.all(...safeParams) as T[];
      return { rows, rowCount: rows.length };
    } catch (error) {
      // WAL connections can cache a stale schema (e.g. a dropped table that
      // existed when the statement was first prepared). If the error mentions
      // a table that no longer exists, check sqlite_master — if it's truly
      // gone, force a WAL checkpoint to clear the connection's schema cache
      // and retry once.
      const msg = (error as Error).message;
      const staleMatch = msg.match(/no such table: (\w+)/);
      if (staleMatch) {
        const staleTable = staleMatch[1];
        try {
          const exists = this.db
            .prepare("select 1 from sqlite_master where type='table' and name=?")
            .get(staleTable);
          if (!exists) {
            // Table truly doesn't exist — clear WAL cache and retry once.
            this.db.pragma("wal_checkpoint(TRUNCATE)");
            const stmt = this.db.prepare(withId);
            if (/\breturning\b/i.test(withId)) {
              const rows = stmt.all(...safeParams) as T[];
              return { rows, rowCount: rows.length };
            }
            const info = stmt.run(...safeParams);
            return { rows: [] as unknown as T[], rowCount: info.changes };
          }
        } catch {
          // Check or retry failed — fall through to the original error.
        }
      }
      throw new Error(
        `[sqlite-driver] ${msg} | sql: ${withId.slice(0, 200)}`
      );
    }
  }

  async end(): Promise<void> {
    // No-op for the per-file cache (keep DB open for app lifetime).
  }

  closeAll(): void {
    for (const db of databases.values()) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    databases.clear();
  }
}

let poolInstance: SqlitePool | null = null;

export function getPool(): SqlitePool {
  if (!poolInstance) {
      // Default to ./data/sag.db relative to the executable directory, not
      // the cwd, because EXEs launched from a parent shell (e.g. via
      // Trae / Claude MCP config) inherit an unrelated cwd.
      const fallback = join(dirname(process.execPath), "data", "sag.db");
      const filePath = process.env.DATABASE_FILE ?? fallback;
      poolInstance = new SqlitePool(filePath);
    }
  return poolInstance;
}

export function resetPoolForTesting(): void {
  if (poolInstance) {
    poolInstance.closeAll();
    poolInstance = null;
  }
}

export async function closePool(): Promise<void> {
  if (poolInstance) {
    poolInstance.closeAll();
    poolInstance = null;
  }
}

// Test helper: wipe + re-open (used by integration tests).
export function resetForTesting(): void {
  if (poolInstance) {
    poolInstance.closeAll();
    poolInstance = null;
  }
}