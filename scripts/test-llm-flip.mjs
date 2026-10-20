// scripts/test-llm-flip.mjs — one-off helper to flip the DB row
// for testing the LLM_PROVIDER branches. Not part of production
// code; remove after the integration test is wired in CI.
import Database from "better-sqlite3";
const db = new Database("./data/sag.db");
const mode = process.argv[2] ?? "show";
if (mode === "show") {
  const row = db.prepare(
    "select id, llm_provider, llm_base_url, llm_model, llm_api_key is not null as has_key, ner_model from ai_provider_settings"
  ).get();
  console.log(JSON.stringify(row, null, 2));
} else if (mode === "api-unconfigured") {
  db.prepare(
    "update ai_provider_settings set llm_base_url = '', llm_model = '', llm_api_key = null, llm_provider = 'api' where id = 'global'"
  ).run();
  console.log("flipped to api (unconfigured) — runtime should throw clear error");
} else if (mode === "api-configured") {
  db.prepare(
    "update ai_provider_settings set llm_base_url = 'http://127.0.0.1:9999/v1', llm_model = 'fake-model', llm_api_key = 'test-key', llm_provider = 'api' where id = 'global'"
  ).run();
  console.log("flipped to api (configured) — runtime should try remote LLM");
} else if (mode === "local") {
  db.prepare(
    "update ai_provider_settings set llm_provider = 'local' where id = 'global'"
  ).run();
  console.log("flipped to local — runtime should use NER");
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(1);
}