import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const r = db.prepare("UPDATE ai_provider_settings SET embedding_dimensions = 4096 WHERE id = 'global'").run();
console.log("updated:", r.changes);
const row = db.prepare("SELECT embedding_dimensions FROM ai_provider_settings WHERE id='global'").get();
console.log("current:", row);
db.close();