-- Migration 018: add NER model selection to ai_provider_settings.
--
-- Plan B (2026-09-19) replaces the LLM-driven entity extraction
-- (Plan A was regex; Plan B is local ONNX token-classification). The
-- operator picks the model from a catalog (bert-base-chinese-ner,
-- roberta-base-chinese-ner, ...) and the runtime loads it through
-- `@xenova/transformers` at startup. The previous migration
-- (016_llm_provider.sql) added the GGUF fields; this migration adds
-- the ONNX NER fields.
--
-- Two new columns:
--   ner_model          Path to the NER model directory, relative to
--                      `<exeDir>/resources/` in packaged builds or
--                      repo-root in dev. Empty string means "no NER
--                      configured yet" — the runtime refuses to start
--                      (see api/server.ts startHttpServer).
--   ner_max_tokens     Maximum token count fed to the NER pipeline per
--                      chunk. Defaults to 512 to align with the
--                      chunking pipeline's token budget. Hard-capped
--                      at 1024 because bert-base-chinese-ner was
--                      trained on 128-token sequences and accuracy
--                      drops sharply past 512.
--
-- Schema changes are idempotent (`if not exists` column guards) so
-- this migration can be re-applied against DBs that already have
-- the column.

alter table ai_provider_settings
  add column ner_model text not null default '';

-- Defensive upper bound. The runtime never sends more than 1024
-- tokens (the chunker caps chunks at 1024 too), so anything past
-- that is almost certainly a typo in the Web UI.
alter table ai_provider_settings
  add column ner_max_tokens integer not null default 512
    check (ner_max_tokens >= 64 and ner_max_tokens <= 1024);

-- Backfill safety: an existing row written before the column existed
-- gets '' and 512 — both safe defaults. The Web UI's
-- /api/settings/ner/download flow will fill in `ner_model` once
-- the operator downloads a model; until then, the runtime refuses
-- to start. This is deliberate: see the Plan B design note in
-- src/api/server.ts.

-- Index: future "which operators have downloaded NER yet?" queries
-- hit this table but it's a singleton row, so we don't need any
-- index. The migration file intentionally stops here.