import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== EXE db info ===");
const r1 = db.prepare("SELECT COUNT(*) as cnt FROM sources").get();
console.log("total sources:", r1.cnt);

const r2 = db.prepare("SELECT tenant_id, COUNT(*) as cnt FROM sources GROUP BY tenant_id").all();
console.log("by tenant:", r2);

const r3 = db.prepare("SELECT id, name, tenant_id FROM sources WHERE tenant_id = 'default' LIMIT 3").all();
console.log("first 3 default tenant:", r3);

db.close();