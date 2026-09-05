import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT id, kind, name FROM sources").all();
for (const x of r) console.log(`  ${x.id.slice(0,8)} ${x.kind.padEnd(10)} ${x.name}`);
db.close();