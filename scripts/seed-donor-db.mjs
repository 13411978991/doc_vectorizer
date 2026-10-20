// scripts/seed-donor-db.mjs — create a fake "donor" SAG database at
// <resources>/合并数据/data/sag.db so we can test the merge-data flow
// end-to-end. Run once, then `POST /api/watched-folders/merge-data`.
//
// Uses the real SAG migration SQL files so the schema exactly matches
// what merge-data-service.ts expects.
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const exeDir = process.argv[2];
if (!exeDir) {
  console.error("usage: node scripts/seed-donor-db.mjs <exeDir>");
  process.exit(2);
}

const mergeDir = join(exeDir, "合并数据");
const mergeDataDir = join(mergeDir, "data");
const mergeDbPath = join(mergeDataDir, "sag.db");
mkdirSync(mergeDataDir, { recursive: true });

const db = new Database(mergeDbPath);
db.pragma("journal_mode = WAL");

// Apply the .sql files under <repo>/migrations/ that build the schema
// needed by merge-data-service.ts (documents / chunks / source_chunks /
// chunk_embeddings / entities / events / event_entities / sources /
// watched_folders / audit_projects / audit_procedures / kb_*). The
// migration set was written idempotently for the running SAG which
// tracks `schema_version`, but we want a clean fresh DB so we just
// run them in order and tolerate `duplicate column` errors that come
// from ALTER TABLE statements that re-run.
//
// 006_vec0_indexes.sql needs the sqlite-vec extension which we don't
// load here — skip it. The merge-data service doesn't query vec0.
const migrationsDir = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  if (f === "006_vec0_indexes.sql") continue;
  const sql = readFileSync(join(migrationsDir, f), "utf8");
  try {
    db.exec(sql);
  } catch (err) {
    // Tolerate duplicate-column / duplicate-table noise from re-runs
    // of ALTER TABLE statements across migration files.
    const msg = String(err);
    if (!/duplicate column|already exists/i.test(msg)) throw err;
  }
}

// Insert a watched_folder whose path exactly equals
// getMergedDataFolderPath(exeDir) — merge-data-service checks this.
const folderPath = join(exeDir, "合并数据").replace(/\\/g, "/");
const sid = "src-donor-001";
const fid = "folder-donor-001";
const now = new Date().toISOString();

db.prepare(
  `INSERT INTO sources (id, tenant_id, kind, name, description, folder_id, metadata, created_at, updated_at)
   VALUES (?, 'default', 'auto', 'Donor Library', 'simulated donor', NULL, ?, ?, ?)`
).run(sid, JSON.stringify({ donor: true }), now, now);

db.prepare(
  `INSERT INTO watched_folders (id, tenant_id, display_name, path, enabled, recursive, file_extensions_filter, ignore_patterns, metadata, source_id, created_at, updated_at)
   VALUES (?, 'default', 'Donor Watch', ?, 1, 1, NULL, NULL, '{}', ?, ?, ?)`
).run(fid, folderPath, sid, now, now);

const docId = "doc-donor-1";
db.prepare(
  `INSERT INTO documents (id, source_id, title, file_name, content, parse_status, metadata, created_at, updated_at)
   VALUES (?, ?, 'Donor Sample', 'sample.txt', 'donor test content for merge verification', 'ready', '{}', ?, ?)`
).run(docId, sid, now, now);

db.prepare(
  `INSERT INTO chunks (id, document_id, source_id, rank, content, raw_content, token_count, metadata)
   VALUES (?, ?, ?, 0, ?, ?, 7, '{}')`
).run("chunk-donor-1", docId, sid, "donor test content for merge verification", "donor test content for merge verification");

// 005_clean_orphaned_event_refs.sql drops source_chunks but never
// recreates it. Re-create the minimal table here so the donor looks
// like a real install — merge-data-service copies from source_chunks.
db.exec(`
  CREATE TABLE IF NOT EXISTS source_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'document',
    heading TEXT,
    content TEXT NOT NULL,
    raw_content TEXT,
    token_count INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}',
    rank INTEGER NOT NULL DEFAULT 0
  );
`);

db.prepare(
  `INSERT INTO source_chunks (id, document_id, source_id, source_type, heading, content, raw_content, token_count, metadata, rank)
   VALUES (?, ?, ?, 'document', NULL, ?, ?, 7, '{}', 0)`
).run("sc-donor-1", docId, sid, "donor test content for merge verification", "donor test content for merge verification");

db.prepare(
  `INSERT INTO chunk_embeddings (chunk_id, model, embedding_json, embedding, created_at)
   VALUES (?, 'test-dim', ?, NULL, ?)`
).run("chunk-donor-1", JSON.stringify(new Array(384).fill(0).map((_, i) => 0.001 * i)), now);

db.prepare(
  `INSERT INTO entities (id, source_id, document_id, entity_type_id, name, normalized_name, type, metadata)
   VALUES (?, ?, ?, NULL, 'donor-test-entity', 'donor-test-entity', 'concept', '{}')`
).run("ent-donor-1", sid, docId);

db.close();
console.log(`[seed-donor] donor DB ready at ${mergeDbPath}`);
console.log(`[seed-donor] folder_path=${folderPath}`);
console.log(`[seed-donor] doc=${docId} chunk=chunk-donor-1 entity=ent-donor-1`);
