import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== sources ===");
const r1 = db.prepare("SELECT id, name, archived_at FROM sources WHERE tenant_id='default'").all();
for (const s of r1) console.log(s.id, s.name, s.archived_at || "active");

console.log("\n=== watched_folders ===");
const r2 = db.prepare("SELECT id, path, display_name, project_id, enabled FROM watched_folders WHERE tenant_id='default'").all();
for (const w of r2) console.log(w.id, w.path, w.display_name, "project:", w.project_id || "(none)", "enabled:", w.enabled);

console.log("\n=== watched_folder_sources link ===");
const r3 = db.prepare("SELECT * FROM watched_folder_sources").all();
console.log(JSON.stringify(r3, null, 2));

console.log("\n=== documents by source ===");
const r4 = db.prepare("SELECT source_id, COUNT(*) as cnt FROM documents GROUP BY source_id").all();
for (const d of r4) console.log(d.source_id, d.cnt);

db.close();