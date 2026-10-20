-- The SQLite schema inherited an erroneous events.chunk_id REFERENCES source_chunks(id)
-- FK from the PG design, but source_chunks was never populated — all chunk data lives
-- in the `chunks` table. Drop the dangling FK, the orphan table, and their embeddings.
-- Handle re-run safely in case a prior attempt left events_old behind.

PRAGMA foreign_keys = off;

-- Clean up orphan temp tables from a failed previous run (if any)
DROP TABLE IF EXISTS events_old;
DROP TABLE IF EXISTS events_backup;

-- Fix 1: events table rebuild (same as before)
CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  document_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'document',
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'CONFIRMED',
  rank INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  chunk_id TEXT,
  summary TEXT,
  title_embedding_json TEXT,
  title_embedding BLOB,
  content_embedding_json TEXT,
  content_embedding BLOB
);

INSERT INTO events_new SELECT
  id, source_id, document_id,
  coalesce(source_type, 'document'),
  title, content, category, status, rank,
  deleted_at, coalesce(created_at, datetime('now')),
  chunk_id,
  summary,
  title_embedding_json, title_embedding,
  content_embedding_json, content_embedding
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

-- Fix 2: event_entities had a FK → events_old (dangling, wrong table).
-- Drop and recreate with correct FK → events(id). Since all event_ids
-- in event_entities reference events that are now in the new events table,
-- no data is lost.
DROP TABLE event_entities;

CREATE TABLE event_entities (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);

-- Restore index (was: event_entities_event_idx, event_entities_entity_idx)
CREATE INDEX IF NOT EXISTS event_entities_event_idx ON event_entities(event_id);
CREATE INDEX IF NOT EXISTS event_entities_entity_idx ON event_entities(entity_id);

-- Fix 3: source_chunks was never populated — drop it and its embeddings
DROP TABLE IF EXISTS source_chunk_embeddings;
DROP TABLE IF EXISTS source_chunks;

PRAGMA foreign_keys = on;
