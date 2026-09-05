import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== kb_projects ===");
const kb = db.prepare("SELECT id, name FROM kb_projects").all();
for (const k of kb) console.log(k.id, k.name);

console.log("\n=== kb_sources (汇集1) ===");
const kps = db.prepare("SELECT id, kb_project_id, name, source_type, watched_folder_id FROM kb_sources WHERE kb_project_id IN (SELECT id FROM kb_projects WHERE name='汇集1')").all();
for (const s of kps) console.log(s.id, s.name, s.source_type, "watchedFolder:", s.watched_folder_id);

db.close();