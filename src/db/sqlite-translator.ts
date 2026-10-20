/**
 * src/db/sqlite-translator.ts — Pure-function SQL translator shared
 * between the main process (sqlite-driver.ts) and the db-write-worker
 * child process (db-write-worker-entry.ts). Audit Tier 2 #14 found
 * that the translator was duplicated verbatim in two files with no
 * enforcement that the two stay in lock-step — a single regex change
 * would silently leave one side behind.
 *
 * This module has zero imports from better-sqlite3, sqlite-vec, or
 * any other native binding — it's pure string manipulation. The
 * child process can import it without dragging the main codebase's
 * dependency graph into its own process.
 */

export interface TranslateResult {
  sql: string;
  /** Order of $N placeholders as they appear in the translated SQL. */
  paramOrder: number[];
}

/**
 * Translate a PG-style SQL string into a SQLite-compatible one. This is a
 * minimal translator that handles the patterns the codebase actually uses:
 *
 *   - $1, $2, ... → ?, ?, ...
 *   - $N placeholders may appear multiple times for the same N (PG reuses
 *     the value). SQLite's `?` is positional; we keep $N→? mapping but
 *     also return a `paramOrder: number[]` array of the same length as
 *     the `?` count, duplicating values where the same $N is reused.
 *   - boolean true/false → 1/0 (SQLite has no boolean type)
 *   - ::identifier casts → drop (handles ::jsonb, ::text, ::uuid, ::boolean,
 *     ::int, ::integer, ::bigint, ::numeric, ::float, ::vector, ::uuid[],
 *     and any other PG type suffix).
 *   - `FOR UPDATE` (row-level locking) → drop (SQLite uses begin/concurrent).
 *   - `[]` after `::<array-type>` already gets dropped with the cast;
 *     bare `[]` is left alone.
 *   - jsonb_array_elements/extract paths → TEXT only (we don't expect to
 *     migrate those callers; they fall through with an error if used).
 */
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
  // PG array contains: x = any(?) → x in (select value from json_each(?))
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

/** Convenience wrapper that returns just the translated SQL string.
 *  Used by the bulk of the codebase that doesn't need the
 *  paramOrder metadata. */
export function translateSql(sql: string): string {
  return translateSqlFull(sql).sql;
}

/**
 * SQLite has no default for `id text primary key`. Callers that omit `id`
 * from the INSERT column list expect a unique id. Detect this pattern and
 * inject a generated `id` column plus parameter so the existing column
 * list doesn't need refactoring.
 *
 * The worker child process also calls this with the same input. Keeping
 * the implementation in the shared module prevents the two sides from
 * diverging (audit Tier 2 #14).
 */
export function ensureIdColumn(sql: string): { sql: string; prefixParams: unknown[] } {
  const m = /^\s*insert\s+into\s+([\w."]+)\s*\(([^)]+)\)/i.exec(sql);
  if (!m) return { sql, prefixParams: [] };
  const [, tableRaw, colsRaw] = m;
  const table = tableRaw.toLowerCase().replace(/"/g, "");
  const cols = colsRaw
    .split(",")
    .map((c) => c.trim().toLowerCase().replace(/"/g, ""));
  if (cols.includes("id")) return { sql, prefixParams: [] };
  // Generate a 32-char lowercase hex blob — same scheme as
  // translateSqlFull's gen_random_uuid() substitution. The main
  // driver accepts this in lieu of a real RFC 4122 UUID.
  const id = `lower(hex(randomblob(16)))`;
  return {
    sql: sql.replace(/(\([^)]+\))/, (colsPart) => `(id, ${colsPart.slice(1)}`),
    prefixParams: [id]
  };
}

/**
 * Decode parameter values for safe binding. Floats (number) pass
 * through, base64-encoded TypedArrays become Buffer (so sqlite-vec
 * sees the raw float bytes for vec0 inserts), booleans become 0/1,
 * undefined becomes null, plain objects JSON-stringify. Matches
 * sqlite-driver.ts's safeParams behavior so both processes handle
 * parameters identically.
 */
export function safeBindParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    // Base64-encoded TypedArray / Buffer from the IPC channel. Decode
    // back to the right concrete type so sqlite-vec sees the raw
    // float bytes it expects for vec0 inserts.
    if (
      p !== null &&
      typeof p === "object" &&
      !Buffer.isBuffer(p) &&
      !(p instanceof Date) &&
      (p as { __sag_b64?: unknown }).__sag_b64 !== undefined &&
      typeof (p as { __sag_b64: unknown }).__sag_b64 === "string"
    ) {
      return Buffer.from((p as { __sag_b64: string }).__sag_b64, "base64");
    }
    if (ArrayBuffer.isView(p) && !(p instanceof DataView)) return p;
    if (p !== null && typeof p === "object" && !Buffer.isBuffer(p) && !(p instanceof Date)) {
      return JSON.stringify(p);
    }
    return p;
  });
}
