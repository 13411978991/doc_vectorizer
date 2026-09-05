import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT embedding_api_key, llm_api_key FROM ai_provider_settings WHERE id='global'").get();
console.log(JSON.stringify(r, null, 2));
db.close();