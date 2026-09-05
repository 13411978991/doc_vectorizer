import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT tenant_id, COUNT(*) as cnt FROM sources GROUP BY tenant_id").all();
for (const x of r) console.log(x.tenant_id, x.cnt);
db.close();