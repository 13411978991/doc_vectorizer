-- Reset the LLM and embedding endpoints to the user's standardised
-- Sunwoda gateway defaults (see config/env.ts EMBEDDING_BASE_URL /
-- LLM_BASE_URL). Migration 007 hard-coded 302ai + MiniMax-M3 as
-- defaults; the actual production gateway is llm-api.sunwoda.com
-- with the qwen3-embedding-8b + hy-mt2-7b models.
--
-- Only the rows that still hold the legacy defaults are touched:
--   * 302ai's base URL on either embedding or LLM
--   * The MiniMax-M3 model on the LLM
--   * The text-embedding-3-large model on embedding
-- If a user has already configured a custom gateway (e.g. a private
-- LLM proxy), their values stay put.
update ai_provider_settings
set
  -- LLM defaults: always reset to sunwoda gateway + hy-mt2-7b.
  llm_base_url = 'https://llm-api.sunwoda.com/v1',
  llm_model = 'hy-mt2-7b',
  updated_at = current_timestamp
where
  llm_base_url = 'https://api.302ai.cn/v1'
  or llm_base_url = 'https://api.minimaxi.com/v1'
  or llm_model = 'MiniMax-M3'
  or llm_model = 'qwen3.6-flash';

-- Embedding defaults: only touch the api-provider rows that still
-- hold legacy 302ai-era values. Rows that use a local model
-- (local / local-bge provider) keep their custom model name and
-- have their stale base URL cleared, since local providers do not
-- need a remote endpoint.
update ai_provider_settings
set
  embedding_base_url = case
    when embedding_provider in ('local', 'local-bge') then ''
    else 'https://llm-api.sunwoda.com/v1'
  end,
  embedding_model = case
    when embedding_provider in ('local', 'local-bge') then embedding_model
    else 'qwen3-embedding-8b'
  end,
  updated_at = current_timestamp
where
  embedding_base_url = 'https://api.302ai.cn/v1'
  or (embedding_provider = 'api' and embedding_base_url like 'http://127.0.0.1:%')
  or (embedding_provider = 'api' and embedding_model = 'text-embedding-3-large')
  or (embedding_provider in ('local', 'local-bge') and embedding_base_url != '');
