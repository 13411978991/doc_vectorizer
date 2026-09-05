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

-- Backfill from current .env-derived state if the table was empty.
-- The API and ingestion both read from this row first; if missing, the
-- runtime falls back to env values. So this insert is best-effort and
-- harmless if the user later re-saves from the UI.
insert or ignore into ai_provider_settings (
  id, embedding_provider, embedding_base_url, embedding_model,
  embedding_dimensions, embedding_api_key, embedding_local_model_path,
  llm_base_url, llm_model, llm_api_key, llm_timeout_ms, llm_max_retries,
  metadata
) values (
  'global',
  'api',
  'https://api.302ai.cn/v1',
  'text-embedding-3-large',
  1024,
  null,
  null,
  'https://api.minimaxi.com/v1',
  'MiniMax-M3',
  null,
  60000,
  2,
  '{"defaultSearchMode":"fast","defaultSearchTopK":10,"defaultChunkingMode":"heading_strict","chunkTokenLimit":512,"chunkOverlapTokens":100}'
);
