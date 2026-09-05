import Database from "better-sqlite3";
const db = new Database("E:\\sag\\export\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT id, name, archived_at FROM sources WHERE tenant_id='default' ORDER BY created_at").all();
for (const s of r) console.log(s.id, s.name, s.archived_at || "active");
db.close();