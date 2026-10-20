-- Migration 020 — remove the legacy "local" embedding provider (2026-10-13)
--
-- The "local" embedding_provider pointed at a SHA256-hash pseudo embedding
-- (4 distinct value buckets per text length, cosine ~ 1.0 across chunks
-- of different content). Operators who had it in their settings ended
-- up with chunks that "embedded fine" but had no semantic content —
-- vector search returned noise. The provider was removed from the
-- EmbeddingProvider TypeScript union and from the settings-routes
-- zod schema on 2026-10-13. This migration rewrites any leftover
-- "local" rows to "local-bge" (the recommended replacement — the
-- BGE ONNX model ships with the repo and runs in-process).
--
-- The embeddingLocalModelPath default is left untouched: the operator
-- may already have it pointed at a valid BGE directory. If not, the
-- runtime will surface a clear "embeddingProvider='local-bge' but
-- embeddingLocalModelPath is empty" error on the next ingest.
update ai_provider_settings
set embedding_provider = 'local-bge',
    updated_at        = current_timestamp
where embedding_provider = 'local';
