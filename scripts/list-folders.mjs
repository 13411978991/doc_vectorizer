import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const all = db.prepare("SELECT id, display_name, source_id, tenant_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
for (const x of all) console.log(JSON.stringify(x));
db.close();