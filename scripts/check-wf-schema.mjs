import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("PRAGMA table_info(watched_folders)").all();
for (const x of r) console.log(x);
console.log("\n=== watched_folders ===");
const r2 = db.prepare("SELECT * FROM watched_folders").all();
for (const w of r2) console.log(JSON.stringify(w));
db.close();