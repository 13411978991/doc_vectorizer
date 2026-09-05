-- Sprint 6 follow-up: vec0 virtual tables for SQLite-vec vector search.
--
-- The schema's `chunk_embeddings.embedding` BLOB column was declared in
-- 001_initial.sql but never populated (we only filled `embedding_json` TEXT).
-- Now that all four embedding sources (chunks, events-title, events-content,
-- entities) are 100% backfilled as TEXT JSON, we create vec0 indexes that
-- mirror them, then backfill BLOB storage via a one-shot script.
--
-- sqlite-vec requires:
--  - A FLOAT[N] column where N matches existing JSON dim (1024)
--  - TEXT PRIMARY KEY sharing the entity id (chunk_id / entity_id / event_id)
--  - Vector values are bound as Float32Array, not JSON arrays
--
-- These tables are pure indexes — chunk_embeddings / entities / events still
-- own the canonical rows.

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec0 USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec0 USING vec0(
  entity_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_title_vec0 USING vec0(
  event_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);

CREATE VIRTUAL TABLE IF NOT EXISTS event_content_vec0 USING vec0(
  event_id TEXT PRIMARY KEY,
  embedding FLOAT[1024]
);
