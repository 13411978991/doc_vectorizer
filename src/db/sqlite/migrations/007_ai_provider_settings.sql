-- Create the ai_provider_settings table that the API expects but
-- never got a SQLite migration. Stores embedding + LLM provider config
-- including the new embedding_provider toggle (api / local / local-bge).
create table if not exists ai_provider_settings (
  id text primary key default 'global',
  embedding_provider text not null default 'api'
    check (embedding_provider in ('api', 'local', 'local-bge')),
  embedding_base_url text not null,
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding_api_key text,
  embedding_local_model_path text,
  llm_base_url text not null,
  llm_model text not null,
  llm_api_key text,
  llm_timeout_ms integer not null,
  llm_max_retries integer not null,
  metadata text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

-- Backfill a neutral row if the table is empty so the API has a
-- well-formed "missing config" placeholder to read on first launch.
-- All URL / model fields are intentionally blank — the operator must
-- configure them via the UI before any embedding or LLM call is made.
-- Search-mode metadata keeps the previous shipped defaults so the
-- UI does not display empty values.
insert or ignore into ai_provider_settings (
  id, embedding_provider, embedding_base_url, embedding_model,
  embedding_dimensions, embedding_api_key, embedding_local_model_path,
  llm_base_url, llm_model, llm_api_key, llm_timeout_ms, llm_max_retries,
  metadata
) values (
  'global',
  'api',
  '',
  '',
  1024,
  null,
  null,
  '',
  '',
  null,
  60000,
  0,
  '{"defaultSearchMode":"fast","defaultSearchTopK":10,"defaultChunkingMode":"heading_strict","chunkTokenLimit":512,"chunkOverlapTokens":100}'
);
