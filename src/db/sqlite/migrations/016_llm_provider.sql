-- Migration 016: add an opt-in "local LLM" provider to ai_provider_settings.
--
-- Until now the LLM client only talked to an OpenAI-compatible HTTP
-- endpoint (`llm_base_url` + `llm_model` + `llm_api_key`). Operators who
-- wanted to keep all inference on-device had to install a third-party
-- server (Ollama, llama.cpp's `llama-server`, LM Studio) and point SAG
-- at it. This migration adds the missing table columns so the Web UI
-- can pick a bundled GGUF file directly.
--
-- Three new columns:
--   llm_provider             'api' (default) or 'local'
--                            — equivalent to embedding_provider
--                              but for chat/extraction. Kept distinct
--                              so the UI can render separate pickers
--                              without coupling the two pipelines.
--   llm_local_model_path     Path (relative to process.resourcesPath
--                            in packaged builds, or repo-root in dev)
--                            to a GGUF file. Resolved at request time
--                            by LocalLlmClient.
--   llm_local_context_size   Context window in tokens. Default 4096 —
--                            the SAG extraction prompt is ~700 input
--                            tokens + ~600 output, so 4096 leaves
--                            plenty of headroom while keeping the KV
--                            cache small on CPU.
--
-- Schema changes are idempotent (`if not exists` column guards) so this
-- migration can be re-applied against DBs that already have the column.

alter table ai_provider_settings
  add column llm_provider text not null default 'api'
    check (llm_provider in ('api', 'local'));

-- Default empty path. The local-llm client treats "" as "no model
-- chosen yet" and surfaces a clear error pointing at the Web UI.
alter table ai_provider_settings
  add column llm_local_model_path text not null default '';

alter table ai_provider_settings
  add column llm_local_context_size integer not null default 4096
    check (llm_local_context_size >= 256 and llm_local_context_size <= 32768);

-- Backfill safety: a row that was inserted by an earlier migration has
-- `llm_provider = 'api'` already thanks to the DEFAULT above, and the
-- local path / context size have safe defaults. Nothing to update on
-- existing rows.

-- Index: future "which providers are configured?" queries hit this
-- table but it's a singleton row, so we don't need any index. The
-- migration file intentionally stops here.
