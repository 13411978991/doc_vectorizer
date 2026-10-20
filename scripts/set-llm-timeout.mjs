import Database from "better-sqlite3";
const path = process.argv[2];
const ms = parseInt(process.argv[3] ?? "300000", 10);
const db = new Database(path);
const r = db.prepare("UPDATE ai_provider_settings SET llm_timeout_ms = ? WHERE id = 'global'").run(ms);
console.log(`updated ${r.changes} row(s) to llm_timeout_ms=${ms}`);
db.close();
