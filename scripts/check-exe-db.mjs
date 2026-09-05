import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const r = db.prepare("SELECT * FROM sources WHERE tenant_id = 'default' ORDER BY id LIMIT 100").all();
console.log("sources:", r.length);
for (const s of r) console.log(s.id, s.name);
db.close();