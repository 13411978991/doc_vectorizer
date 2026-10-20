-- Add columns the API queries expect but which SQLite didn't carry over
-- from the PG schema. These stay null for existing rows; new ingestion
-- only populates a subset of them. The API consumers already handle
-- null for embedding preview / description / summary / chunk_id.

alter table source_chunks add column embedding_json text;
alter table source_chunks add column embedding blob;

alter table events add column chunk_id text references source_chunks(id) on delete set null;
alter table events add column summary text;
alter table events add column title_embedding_json text;
alter table events add column title_embedding blob;
alter table events add column content_embedding_json text;
alter table events add column content_embedding blob;

alter table entities add column description text;
alter table entities add column embedding_json text;
alter table entities add column embedding blob;

create index if not exists events_chunk_idx on events(chunk_id);
