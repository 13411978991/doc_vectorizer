-- Clear the shipped AI-endpoint defaults so a fresh install does not
-- silently post data to a third-party or internal gateway the operator
-- never authorised.
--
-- History:
--   007 seeded defaults pointing at 302ai (OpenAI-compatible) and a
--   public LLM endpoint.
--   013 then overrode those with the internal gateway URL and model
--   names. Both migrations leak vendor-specific defaults into the
--   operator's first-run UI; this migration removes the leakage.
--
-- After this migration, the API surfaces "missing configuration" errors
-- the moment a request needs an embedding or LLM call, which is the
-- expected behaviour for an unconfigured install.
update ai_provider_settings
set
  embedding_base_url = '',
  embedding_model    = '',
  embedding_api_key  = '',
  llm_base_url       = '',
  llm_model          = '',
  llm_api_key        = '',
  updated_at         = current_timestamp;
