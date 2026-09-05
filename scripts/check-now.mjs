import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== watched_folders now ===");
const r = db.prepare("SELECT id, display_name, source_id, metadata FROM watched_folders").all();
for (const w of r) console.log(w.display_name, "source_id:", w.source_id, "formerSourceId:", JSON.parse(w.metadata || "{}").formerSourceId || "(none)");

console.log("\n=== sources ===");
const s = db.prepare("SELECT id, name FROM sources WHERE tenant_id='default'").all();
for (const x of s) console.log(x.id, x.name);

db.close();