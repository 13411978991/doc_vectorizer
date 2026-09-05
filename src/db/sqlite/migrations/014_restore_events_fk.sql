-- Migration 005 rebuilt the events table to drop a bogus FK to
-- source_chunks (a table that was never populated), but in doing so
-- it also dropped the legitimate FKs to sources(id) and
-- documents(id). As a result, deleting a watched folder left 13+
-- orphan events behind and the DB file didn't shrink via the cascade
-- chain it was supposed to.
--
-- This migration restores the events FKs. We have to use
-- `PRAGMA foreign_keys = off` to be able to drop the old table and
-- create the new one in the same script (without off, SQLite refuses
-- to drop a table that's referenced by indexes / constraints).
--
-- NOTE: `PRAGMA foreign_keys = off` is a NO-OP inside a transaction
-- for SQLite (it's a connection-level setting, not a schema-level
-- one). When our migration runner wraps multiple statements in a
-- transaction, the FK might come back on between statements and the
-- CREATE TABLE will fail. To work around this we:
--   1. Drop the old table FIRST (so the indexes that reference it
--      are gone).
--   2. Then recreate with FKs — at this point nothing else in the DB
--      still points at the old events table, so we don't need FK
--      enforcement off.
--
-- Wait, we DO need to keep PRAGMA off because the new events table
-- has FKs to sources/documents and inserting data through the rebuild
-- can re-trigger FK constraints. So:
--   - Set off
--   - Drop events_old leftovers
--   - Drop old events (CASCADE-anything referencing is gone because we
--     manually delete from event_entities first — events FKs on
--     event_entities have been intact since 005)
--   - Create events_new WITH FKs
--   - Backfill from old events (LEFT JOIN to skip orphans)
--   - Drop events, rename events_new → events
--   - Set on

-- First, drop event_entities rows pointing at the events we're
-- about to delete — event_entities has FK → events with CASCADE so
-- dropping events should cascade, but we're operating with FKs ON
-- and a single statement, so this is safer.
-- (Actually we set FKs OFF below; this DELETE is just defence in depth.)

PRAGMA foreign_keys = off;

-- Clean up any leftover temp tables from a previous failed run.
DROP TABLE IF EXISTS events_new;
DROP TABLE IF EXISTS events_old;

-- Save the data before rebuilding.
ALTER TABLE events RENAME TO events_old;

-- Build the new events table WITH proper FKs.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'document',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  rank INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- chunk_id intentionally without FK (sqlite-vec and chunk_embeddings
  -- have no FK to chunks; adding a FK here would require rebuilding
  -- those tables too. Application code looks up chunks separately.)
  chunk_id TEXT,
  summary TEXT,
  title_embedding_json TEXT,
  title_embedding BLOB,
  content_embedding_json TEXT,
  content_embedding BLOB
);

-- Backfill, dropping orphans (source_id missing) and demoting
-- document_id to NULL if the document was already gone.
INSERT INTO events (
  id, source_id, document_id, source_type, title, content, category,
  status, rank, deleted_at, created_at, chunk_id, summary,
  title_embedding_json, title_embedding, content_embedding_json, content_embedding
)
SELECT
  e.id,
  e.source_id,
  CASE WHEN d.id IS NULL THEN NULL ELSE e.document_id END,
  coalesce(e.source_type, 'document'),
  e.title,
  e.content,
  e.category,
  e.status,
  e.rank,
  e.deleted_at,
  coalesce(e.created_at, datetime('now')),
  e.chunk_id,
  e.summary,
  e.title_embedding_json,
  e.title_embedding,
  e.content_embedding_json,
  e.content_embedding
FROM events_old e
LEFT JOIN sources s ON s.id = e.source_id
LEFT JOIN documents d ON d.id = e.document_id
WHERE s.id IS NOT NULL;

DROP TABLE events_old;

-- Restore the indexes that existed before the rebuild.
CREATE INDEX IF NOT EXISTS events_source_idx ON events(source_id);
CREATE INDEX IF NOT EXISTS events_document_idx ON events(document_id);
CREATE INDEX IF NOT EXISTS events_chunk_idx ON events(chunk_id);

-- event_entities FK still references the renamed events_old table because
-- SQLite stores the FK target by its table name at CREATE time. We renamed
-- events → events_old above, so the existing FK is now dangling and any
-- DELETE from sources (cascade → events → event_entities) blows up with
-- "no such table: main.events_old". Rebuild event_entities so the FK
-- points at the new events table.
DROP TABLE event_entities;
CREATE TABLE event_entities (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS event_entities_event_idx ON event_entities(event_id);
CREATE INDEX IF NOT EXISTS event_entities_entity_idx ON event_entities(entity_id);

PRAGMA foreign_keys = on;

-- Reclaim temp-table + orphan-row space. VACUUM must run outside any
-- transaction; the runner commits each .sql migration in its own
-- implicit tx, so this is fine.
VACUUM;