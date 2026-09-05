import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

console.log("=== rows ===");
const rows = db.prepare("SELECT id, tenant_id, source_id FROM watched_folders").all();
for (const r of rows) console.log(r.id, r.tenant_id, "source:", r.source_id);

console.log("\n=== index entries ===");
const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='watched_folders'").all();
for (const i of idx) console.log(i.name, ":", i.sql);

db.close();