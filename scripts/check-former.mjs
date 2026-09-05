import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT id, json_extract(metadata, '$.formerSourceId') as former, source_id as cs FROM watched_folders").all();
for (const x of r) console.log(JSON.stringify(x));