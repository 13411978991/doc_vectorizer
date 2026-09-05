import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT id, name FROM sources WHERE tenant_id='default' ORDER BY created_at").all();
for (const s of r) console.log(s.id, s.name);
db.close();