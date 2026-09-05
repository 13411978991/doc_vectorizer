import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
console.log("=== watched_folders full ===");
const w = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former, updated_at FROM watched_folders").all();
for (const r of w) console.log(JSON.stringify(r));
db.close();