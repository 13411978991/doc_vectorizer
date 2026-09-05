/**
 * One-shot script: backfill the four vec0 virtual tables from existing
 * `embedding_json` TEXT columns that the backfill scripts wrote earlier.
 *
 * This is the missing piece between JSON-stored embeddings and SQLite-vec
 * vector search. Without it, `searchChunksByVector` / `searchEventsByVector`
 * / `searchEntitiesByVector` cannot match any rows because:
 *   - chunks table has no `embedding` column (PG-only schema)
 *   - chunk_embeddings.embedding BLOB column was never populated
 *
 * Strategy:
 *   1. Trust the migrations runner already created the vec0 tables
 *   2. For each chunk / entity / event pair, parse embedding_json (TEXT)
 *      into a Float32Array(1024) and INSERT into the matching vec0 table
 *   3. Idempotent: vec0 inserts use INSERT OR REPLACE so re-runs are safe
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";
const DIM = 1024;

interface JsonVecRow {
  id: string;
  vec_json: string;
}

function decode(vecJson: string): Float32Array {
  const parsed = JSON.parse(vecJson) as number[];
  if (!Array.isArray(parsed) || parsed.length !== DIM) {
    throw new Error(
      `Expected ${DIM}-dim vector, got ${Array.isArray(parsed) ? parsed.length : "non-array"} values`
    );
  }
  return new Float32Array(parsed);
}

function backfillChunk(db: Database.Database): number {
  const rows = db
    .prepare(
      `select ce.chunk_id as id, ce.embedding_json as vec_json
       from chunk_embeddings ce
       where ce.embedding_json is not null`
    )
    .all() as JsonVecRow[];

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO chunk_vec0(chunk_id, embedding) VALUES (?, ?)"
  );
  let count = 0;
  for (const r of rows) {
    stmt.run(r.id, decode(r.vec_json));
    count += 1;
  }
  return count;
}

function backfillEntity(db: Database.Database): number {
  const rows = db
    .prepare(
      `select id, embedding_json as vec_json
       from entities
       where embedding_json is not null`
    )
    .all() as JsonVecRow[];

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO entity_vec0(entity_id, embedding) VALUES (?, ?)"
  );
  let count = 0;
  for (const r of rows) {
    stmt.run(r.id, decode(r.vec_json));
    count += 1;
  }
  return count;
}

function backfillEventTitle(db: Database.Database): number {
  const rows = db
    .prepare(
      `select id, title_embedding_json as vec_json
       from events
       where title_embedding_json is not null`
    )
    .all() as JsonVecRow[];

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO event_title_vec0(event_id, embedding) VALUES (?, ?)"
  );
  let count = 0;
  for (const r of rows) {
    stmt.run(r.id, decode(r.vec_json));
    count += 1;
  }
  return count;
}

function backfillEventContent(db: Database.Database): number {
  const rows = db
    .prepare(
      `select id, content_embedding_json as vec_json
       from events
       where content_embedding_json is not null`
    )
    .all() as JsonVecRow[];

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO event_content_vec0(event_id, embedding) VALUES (?, ?)"
  );
  let count = 0;
  for (const r of rows) {
    stmt.run(r.id, decode(r.vec_json));
    count += 1;
  }
  return count;
}

function verify(db: Database.Database) {
  const counts = {
    chunks: (db.prepare("select count(*) as n from chunk_vec0").get() as { n: number }).n,
    entities: (db.prepare("select count(*) as n from entity_vec0").get() as { n: number }).n,
    eventTitles: (db.prepare("select count(*) as n from event_title_vec0").get() as { n: number }).n,
    eventContents: (db.prepare("select count(*) as n from event_content_vec0").get() as { n: number }).n,
  };
  console.log("[verify] vec0 row counts:", counts);
}

async function main() {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  // Sanity: make sure vec0 tables exist (migration 006 ran)
  const tables = (db
    .prepare("select name from sqlite_master where type='table' and name like '%_vec0'")
    .all() as { name: string }[]).map((r) => r.name);
  if (tables.length < 4) {
    console.error(
      `[backfill] ERROR: missing vec0 tables. Found: ${tables.join(", ")}. Need to migrate first.`
    );
    process.exit(1);
  }

  const t0 = Date.now();
  const c = backfillChunk(db);
  const e = backfillEntity(db);
  const et = backfillEventTitle(db);
  const ec = backfillEventContent(db);
  const elapsedMs = Date.now() - t0;

  console.log(`[backfill] chunks:        ${c}`);
  console.log(`[backfill] entities:      ${e}`);
  console.log(`[backfill] event titles:  ${et}`);
  console.log(`[backfill] event contents: ${ec}`);
  console.log(`[backfill] total ${c + e + et + ec} rows in ${elapsedMs}ms`);

  verify(db);
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
