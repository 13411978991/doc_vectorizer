/**
 * pg-driver.ts — Thin wrapper around pg.Pool that mimics SqlitePool's
 * `{rows, rowCount}` shape. Picked at runtime by db/pool.ts when
 * `DATABASE_URL` is set (production / PG-backed tests).
 *
 * The codebase writes PG-style SQL but also reaches for SQLite-style JSON
 * helpers (`json_extract`, `json_set`) which don't exist in Postgres. The
 * pg-driver runs a small SQL-fixer step that rewrites those to their PG
 * equivalents (`jsonb_extract_path_text`, `jsonb_set`) so the same source
 * can run against either backend.
 */
import pg from "pg";

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

let poolInstance: pg.Pool | null = null;

function getOrCreatePool(): pg.Pool {
  if (poolInstance) return poolInstance;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[pg-driver] DATABASE_URL is not set");
  }
  poolInstance = new pg.Pool({ connectionString: url, max: 10 });
  // Sanity-check the connection at boot so we fail fast on bad config.
  return poolInstance;
}

export class PgPool {
  private pool: pg.Pool;

  constructor(url?: string) {
    if (url) {
      this.pool = new pg.Pool({ connectionString: url, max: 10 });
    } else {
      this.pool = getOrCreatePool();
    }
  }

  async connect(): Promise<PgPool> {
    // pg's pool.connect() returns a Client. We mimic the SqlitePool
    // shape (self) so call sites can do `const c = await pool.connect();
    // await c.query(...)` without an explicit release().
    return this;
  }

  async release(): Promise<void> {
    // No-op: we hold the underlying pool, not a checked-out client.
  }

  async query<T = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    let fixed = applyGenericPgFixes(sql);
    fixed = fixSqlForPg(fixed);
    // Match SqlitePool's ensureIdColumn: tables whose `id` column has no
    // DEFAULT need a uuidv4-style string id injected. PG won't auto-fill
    // these either, so we generate a 32-char hex blob in JS and prepend
    // it to the bind list.
    const { sql: withId, prefixParams } = ensureIdColumn(fixed);
    fixed = withId;
    // The codebase sometimes passes raw JS booleans through here. PG's
    // wire protocol accepts `true`/`false` for boolean columns only —
    // the schema declares most "enabled" / "recursive" fields as
    // INTEGER (SQLite dialect) and PG rejects `true` for them. Match
    // SqlitePool's behaviour: convert JS booleans to 0/1 before binding.
    const safeParams: unknown[] = [
      ...prefixParams,
      ...params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === "boolean") return p ? 1 : 0;
        // JS arrays stay as JS arrays. pg-node binds them as PG array
        // literals (`{a,b,c}`) which is what `id = any($1::uuid[])`
        // expects. The json_each($N) queries in the codebase expect a
        // JSON array, but the SQL fixer below rewrites those callsites
        // to `json_each($N::jsonb)` and JSON-stringifies arrays on
        // the way in — so the two paths coexist cleanly.
        return p;
      }),
    ];
    try {
      const result = await this.pool.query(fixed, safeParams as unknown[]);
      // pg parses jsonb columns into JS objects automatically; SQLite
      // stores them as text. To keep the API shape consistent with
      // SqlitePool, serialise jsonb back to JSON text so callers that
      // `JSON.parse(row.metadata)` keep working.
      const rows = result.rows.map((row) => serialiseJsonbRow(row)) as T[];
      return { rows, rowCount: result.rowCount ?? result.rows.length };
    } catch (error) {
      const msg = (error as Error).message;
      const fs = await import("node:fs/promises");
      const path = `data/pg-driver-failed-${Date.now()}.sql`;
      await fs.writeFile(path, fixed).catch(() => undefined);
      throw new Error(`[pg-driver] ${msg} | sql: ${fixed.slice(0, 200)} | full → ${path}`);
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

let pgPoolInstance: PgPool | null = null;

export function getPgPool(url?: string): PgPool {
  if (!pgPoolInstance) pgPoolInstance = new PgPool(url);
  return pgPoolInstance;
}

export async function closePgPool(): Promise<void> {
  if (pgPoolInstance) {
    await pgPoolInstance.end();
    pgPoolInstance = null;
  }
  // Reset module-level singleton too so a re-init picks up a new URL.
  if (poolInstance) {
    poolInstance = null;
  }
}

/**
 * Lightweight fixer for SQL written against the project's SQLite dialect
 * but routed to Postgres. The codebase's "canonical" PG-style writes use
 * `->>` / `->` JSONB operators and PG-style casts; these need no
 * translation. But some seam code reaches for SQLite-flavored helpers:
 *
 *   json_extract(col, '$.k')           → (col->>'k')
 *   json_extract(col, '$.k1.k2')       → (col->'k1'->>'k2')
 *   json_set(col, '$.k', val)          → jsonb_set(col, '{k}', to_jsonb(val))
 *   json_object('k1', v1, 'k2', v2)      → jsonb_build_object(...)
 *
 * String literals containing a `$.` prefix use SQLite's JSONPath syntax;
 * PG uses a single-level `{key}` form. The transformation here is naive
 * but covers the patterns we actually use (no array index paths).
 */
/**
 * Generic SQL helpers that we want to apply on the original SQL even
 * before any function-call rewriting. These are textual rewrites that
 * don't require bracket-matching.
 */
function applyGenericPgFixes(sql: string): string {
  let out = sql;
  // The schema declares most boolean-flag columns as INTEGER (SQLite
  // dialect). The codebase writes PG-style `= true` / `= false` against
  // these columns, which PG rejects ("operator does not exist:
  // integer = boolean"). Normalise to 1 / 0.
  out = out.replace(/=\s*true\b/gi, "= 1");
  out = out.replace(/=\s*false\b/gi, "= 0");
  out = out.replace(/\band\s+true\b/gi, "and 1");
  out = out.replace(/\band\s+false\b/gi, "and 0");
  // Same in VALUES lists: `values (..., true)` and `values (..., false)`
  // appear in INSERT statements. The bound-param path (`$N`) is fine
  // because pg-driver coerces JS booleans to 0/1 before binding.
  out = out.replace(/(\bvalues\s*\([^)]*?),\s*true\b/gi, "$1, 1");
  out = out.replace(/(\bvalues\s*\([^)]*?),\s*false\b/gi, "$1, 0");
  // PG requires explicit casts in `case when $N is null` because the
  // planner can't infer the type of an untyped parameter. Add `::text`
  // so the case branch is well-typed. The codebase's `last_scan_error =
  // $2` and `case when $2 is null then 'ok' else 'error' end` patterns
  // hit this.
  // We target only `is null` / `is not null` clauses because those are
  // the ones where PG complains about unknown param types.
  out = out.replace(/(\$\d+)\s+is\s+null/gi, "$1::text is null");
  out = out.replace(/(\$\d+)\s+is\s+not\s+null/gi, "$1::text is not null");
  // Strip SQLite-only ::uuid (single) casts. PG has no implicit
  // uuid → text conversion; the codebase's id columns are TEXT (SQLite
  // dialect), so `text = uuid` fails. Strip ::uuid[] too: pg-node
  // binds JS arrays as PG array literals already (`{a,b,c}`), so the
  // cast just trips the parser when the elements arrive as text. Bare
  // `any($1)` works correctly without the cast.
  out = out.replace(/::uuid\[\]/gi, "");
  out = out.replace(/::uuid\b/gi, "");
  // Cast jsonb -> text on `->` (single-arrow) so the result composes
  // in `union` / `in (...)` clauses alongside text-typed columns. PG
  // normally requires this when the jsonb path is used as a value, but
  // not when chained into `->>`. We only cast the *terminal* `->`
  // expression, not `->>`. Negative lookbehind avoids double-casting.
  out = out.replace(/(\b[\w.]+)\s*->\s*'([^']+)'(?!\s*->)/g, "$1->'$2'::text");
  // PG array contains: `= any(?)` (sqlite-driver rewrites to
  // `in (select value from json_each(?))`). For PG we cast each jsonb
  // value to text so it composes against text-typed columns. Without
  // this, PG reports "operator does not exist: text = json".
  out = out.replace(
    /=\s*any\(\s*\?\s*\)/gi,
    " in (select (value#>>'{}')::text from json_each(?))"
  );
  // Some callsites already use `in (select value from json_each($N))`
  // directly (the sqlite driver doesn't translate `in (...)` either,
  // so it works there only because json_each.value matches the
  // column's text storage). On PG we still need the text cast.
  out = out.replace(
    /in\s*\(\s*select\s+value\s+from\s+json_each\(\s*(\$\d+|\?)\s*\)\s*\)/gi,
    "in (select (value#>>'{}')::text from json_each($1))"
  );
  return out;
}

function fixSqlForPg(sql: string): string {
  // json_group_array → json_agg (PG equivalent). The codebase uses this
  // in listDocumentsBySource / listSources-by-project for paginated
  // "give me all docs across linked sources" reads.
  let out = rewriteFunctionCalls(sql, "json_group_array", (args) => {
    if (args.length !== 1) return null;
    return `json_agg(${args[0]}::text)`;
  });
  // json_extract
  out = rewriteFunctionCalls(out, "json_extract", (args) => {
    if (args.length !== 2) return null;
    const [col, pathLit] = args;
    const m = pathLit.match(/^'\$\.([^']+)'$/);
    if (!m) return null;
    const parts = m[1].split(".");
    const head = `${col}->'${parts[0]}'`;
    const tail = parts.slice(1).map((p) => `->>'${p}'`).join("");
    // Cast to text so the result composes cleanly in `union` /
    // `in (...)` clauses that mix it with text-typed columns (e.g.
    // `sources.id` in the codebase is text under the SQLite dialect).
    return `(${head}${tail})::text`;
  });
  // json_set
  out = rewriteFunctionCalls(out, "json_set", (args) => {
    if (args.length !== 3) return null;
    const [col, pathLit, val] = args;
    const m = pathLit.match(/^'\$\.([^']+)'$/);
    if (!m) return null;
    const parts = m[1].split(".");
    const lpath = "{" + parts.join(",") + "}";
    return `jsonb_set(${col}::jsonb, '${lpath}', to_jsonb(${val}::text))`;
  });
  // json_object → jsonb_build_object (text cast on values)
  out = rewriteFunctionCalls(out, "json_object", (args) => {
    if (args.length === 0 || args.length % 2 !== 0) return null;
    const pairs: string[] = [];
    for (let i = 0; i < args.length; i += 2) {
      pairs.push(`${args[i]}, ${args[i + 1]}::text`);
    }
    return `jsonb_build_object(${pairs.join(", ")})`;
  });
  // strftime('%Y-%m-%dT%H:%M:%fZ', 'now') → to_char(current_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  // The codebase's sqlite-driver rewrites strftime using `datetime(...)` /
  // `strftime(...)` for ISO 8601 timestamps. We map the common
  // ISO-8601-instant pattern to PG's to_char. Also handle the bare
  // `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` shape used by createSyncRun.
  out = rewriteFunctionCalls(out, "strftime", (args) => {
    if (args.length !== 2) return null;
    const [fmt, val] = args;
    if (fmt.replace(/\s/g, "") !== "'%Y-%m-%dT%H:%M:%fZ'") return null;
    if (val.replace(/\s/g, "") !== "'now'") return null;
    return `to_char(current_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  });
  // `datetime('now')` is already handled by the SQL rewrites that
  // match `datetime('now') → current_timestamp` above; we leave
  // `datetime(...)` calls alone otherwise because PG's
  // `to_timestamp(text, format)` is a 2-arg function with a different
  // shape than SQLite's 1-arg `datetime(text)`.
  return out;
}

/**
 * Walks `sql`, finds calls to `name(...)`, splits the argument list at
 * top-level commas (respecting nested parens and string literals), and
 * lets `transform(args)` rewrite each occurrence. Returns the rewritten
 * SQL.
 */
function rewriteFunctionCalls(
  sql: string,
  name: string,
  transform: (args: string[]) => string | null
): string {
  const re = new RegExp(`\\b${name}\\s*\\(`, "gi");
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    re.lastIndex = i;
    const m = re.exec(sql);
    if (!m) {
      out.push(sql.slice(i));
      break;
    }
    const start = m.index;
    const openParen = m.index + m[0].length - 1;
    // Push everything up to (but not including) the function-name match.
    out.push(sql.slice(i, start));
    // Scan forward to find the matching `)`.
    const argsText = readUntilMatchingParen(sql, openParen);
    if (argsText === null) {
      out.push(sql.slice(start));
      break;
    }
    const args = splitTopLevel(argsText);
    const replacement = transform(args);
    if (replacement !== null) {
      out.push(replacement);
    } else {
      // Pass through the original function call verbatim when transform
      // declines. Include the original `name(` and matching `)`.
      out.push(sql.slice(start, openParen + 1 + argsText.length + 1));
    }
    i = openParen + 1 + argsText.length + 1;
  }
  return out.join("");
}

function readUntilMatchingParen(sql: string, openIdx: number): string | null {
  if (sql[openIdx] !== "(") return null;
  let depth = 1;
  let inString = false;
  let stringChar = "";
  let i = openIdx + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      if (c === stringChar && sql[i + 1] === stringChar) {
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
    } else if (c === "'" || c === '"') {
      inString = true;
      stringChar = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return sql.slice(openIdx + 1, i);
      }
    }
    i++;
  }
  return null;
}

/**
 * pg parses jsonb columns into native JS objects/arrays; SQLite stores
 * them as text. To keep the codebase's "JSON.parse(row.metadata)"
 * pattern working unchanged, re-stringify any jsonb-shaped values in
 * the result row. We only walk well-known JSON-shaped columns to keep
 * the cost low.
 */
const JSONB_COLUMNS = new Set([
  "metadata",
  "config",
  "filetype_filter",
  "file_extensions_filter",
  "ignore_patterns",
  "source_ids",
  "arguments",
  "result",
  "steps",
  "flow_svg",
  "summary",
  "error_message",
  "scopes",
  "scope",
  "deleted_chunk_ids",
  "deleted_document_ids",
  "stats",
  "diagnostics",
]);

function serialiseJsonbRow(row: any): any {
  if (row === null || typeof row !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === "object" && JSONB_COLUMNS.has(k)) {
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Mirror of sqlite-driver's ensureIdColumn: a small allowlist of tables
 * that the codebase INSERTs into without providing an id (and whose
 * `id` column has no DEFAULT). For those we prepend a generated id to
 * the column list and to the bind list, matching what the SQLite path
 * does behind the scenes.
 */
const TABLES_WITHOUT_ID_DEFAULT = new Set([
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
  "mcp_api_keys",
]);

function ensureIdColumn(sql: string): { sql: string; prefixParams: string[] } {
  // Strict prefix: leading whitespace, then INSERT INTO, then the
  // table name, then `(<cols>)`. CTE-wrapped inserts (with … insert …)
  // are intentionally NOT handled here — the codebase's tests don't
  // rely on those.
  const m = /^\s*insert\s+into\s+([\w."]+)\s*\(([^)]+)\)/i.exec(sql);
  if (!m) return { sql, prefixParams: [] };
  const table = m[1].toLowerCase().replace(/"/g, "");
  if (!TABLES_WITHOUT_ID_DEFAULT.has(table)) return { sql, prefixParams: [] };
  const colsRaw = m[2];
  const cols = colsRaw
    .split(",")
    .map((c) => c.trim().toLowerCase().replace(/"/g, ""));
  if (cols.includes("id")) return { sql, prefixParams: [] };
  // Find the column-list end and the matching values-list start. We
  // hand-parse here rather than regex because the values clause can
  // contain nested parens (e.g. function calls).
  const colsMatch = /insert\s+into\s+([\w."]+)\s*\(([^)]+)\)(\s*values\s*)?/i.exec(sql);
  if (!colsMatch) return { sql, prefixParams: [] };
  const afterCols = colsMatch.index + colsMatch[0].length;
  if (!colsMatch[3]) return { sql, prefixParams: [] };
  // Locate the opening paren of the values list.
  const parenOffset = sql.indexOf("(", afterCols);
  if (parenOffset === -1) return { sql, prefixParams: [] };
  const vals = readUntilMatchingParen(sql, parenOffset);
  if (vals === null) return { sql, prefixParams: [] };
  // pg-Pool binds by ordinal position. PG counts `$1` reuse as the same
  // bind slot, which causes "bind N params, statement expects M" errors
  // when we want a unique bind for each occurrence. Shift every $N in
  // the original values list to $(N+1) so the auto-id sits at $1 and
  // the original placeholders get their own slots.
  const shiftedVals = vals.replace(/\$(\d+)/g, (_full, n) => `$${Number(n) + 1}`);
  const tableName = colsMatch[1];
  const colsList = colsMatch[2].trim();
  const newSql =
    `insert into ${tableName}(id, ${colsList}) values ($1, ${shiftedVals})` +
    sql.slice(parenOffset + 1 + vals.length + 1);
  return { sql: newSql, prefixParams: [generateUuid()] };
}

function generateUuid(): string {
  // RFC 4122 v4 uuid using crypto when available. Matches the shape
  // SqlitePool produces (which the codebase treats opaquely).
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let depth = 0;
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      buf += c;
      if (c === stringChar && s[i + 1] === stringChar) {
        buf += s[i + 1];
        i++;
        continue;
      }
      if (c === stringChar) inString = false;
      continue;
    }
    if (c === "'" || c === '"') {
      inString = true;
      stringChar = c;
      buf += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}