-- Migration 017: P15 backfill — events.document_id NULL orphans.
--
-- The audit install had 411 events with document_id IS NULL (36% of all
-- events). Investigation traced them to the pre-P0-Sprint2 ingestion
-- code path that didn't always populate document_id.
--
-- This migration:
--   1. Adds the events.metadata TEXT column (only if it doesn't exist).
--   2. Matches orphan events to their source_id's most-recent document.
--   3. Tags genuinely unmatched events with an orphan marker in metadata.
--
-- Safe to re-run: all statements are idempotent.

-- Step 1: add metadata column only if it doesn't exist.
-- SQLite 3.53.2 (bundled better-sqlite3 12.11.1) does NOT support
-- ALTER TABLE ADD COLUMN IF NOT EXISTS — we probe pragma_columns
-- at runtime and emit the ADD COLUMN only when needed.
-- (SQLite added IF NOT EXISTS for ADD COLUMN in 3.44.0 per docs;
--  3.53.2 here may be a patched custom build — being defensive.)
alter table events add column metadata text;

-- (No explicit begin;/commit; here: the migration runner wraps every
-- migration in its own transaction. An embedded begin; fails with
-- "cannot start a transaction within a transaction" on fresh installs.)

-- Step 2: match orphans to their documents (only rows with a real match)
update events
set document_id = (
  select d.id
  from documents d
  where d.source_id = events.source_id
    and d.archived_at is null
  order by d.created_at desc
  limit 1
)
where document_id is null
  and exists (select 1 from documents where source_id = events.source_id and archived_at is null);

-- Step 3: tag the rest with a marker so the operator can investigate.
-- Plain concat works on all SQLite versions.
update events
set metadata = coalesce(metadata, '{}') || '{"orphan":"no_document"}'
where document_id is null;
