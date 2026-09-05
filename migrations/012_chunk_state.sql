-- 012_chunk_state.sql — split ingest into two stages (chunk + embed) with
-- optimistic locking + state machine.
--
-- Goal: decouple the cheap chunking stage from the expensive embedding
-- stage so the cheap stage doesn't have to wait for the slow one. The
-- watcher first writes chunks (state='pending'), then a background
-- embedding worker claims each chunk, embeds it, and marks it
-- (state='embedded'). On crash, the chunk_state field is the single
-- source of truth: pending = needs embedding, embedded = done, failed
-- = skip and surface to UI.
--
-- Lock timeout: 5 minutes. Embedding a single chunk should never take
-- that long (we measured ~750ms for BGE-large on CPU). 5 min covers
-- any worker crash so the next pickup cycle can claim it again.
--
-- This is the schema half of the change; the code half lives in
-- src/workers/embedding-worker.ts (claim/embed/release loop) and
-- src/services/ingestion-service.ts (set chunk_state at insert time,
-- skip embed if state already embedded).

alter table chunks add column chunk_state text not null default 'embedded';
  -- existing chunks are assumed already embedded (legacy data);
  -- new ingests set 'pending' explicitly
alter table chunks add column locked_by text;
alter table chunks add column locked_at text;

alter table watched_folder_manifests add column chunked_at text;
alter table watched_folder_manifests add column embedded_at text;
alter table watched_folder_manifests add column chunk_count_pending integer not null default 0;
alter table watched_folder_manifests add column chunk_count_embedded integer not null default 0;
alter table watched_folder_manifests add column chunk_count_failed integer not null default 0;

create index if not exists idx_chunks_state_pending on chunks(chunk_state) where chunk_state = 'pending';
create index if not exists idx_chunks_doc_state on chunks(document_id, chunk_state);
create index if not exists idx_manifest_pending on watched_folder_manifests(chunk_count_pending)
  where chunk_count_pending > 0;