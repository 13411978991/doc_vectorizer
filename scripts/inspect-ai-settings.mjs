import Database from "better-sqlite3";
const path = process.argv[2];
const db = new Database(path, { readonly: true });
const r = db.prepare("SELECT * FROM ai_provider_settings").all();
for (const row of r) console.log(JSON.stringify(row, null, 2));
db.close();
