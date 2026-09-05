import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const all = db.prepare("SELECT id, kind, name FROM sources WHERE name LIKE '%汇集%'").all();
for (const x of all) console.log(`  ${x.name} → id=${x.id}`);
db.close();