import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
console.log("=== kb_projects ===");
const k = db.prepare("SELECT id, name, tenant_id, cached_documents_count FROM kb_projects WHERE name = '汇集功能'").all();
for (const x of k) console.log(JSON.stringify(x));
console.log("\n=== kb_sources for 汇集功能 ===");
const s = db.prepare(`
  SELECT ks.id, ks.kb_project_id, ks.source_type, ks.name, ks.watched_folder_id, ks.upload_id, ks.enabled
  FROM kb_sources ks
  JOIN kb_projects kp ON kp.id = ks.kb_project_id
  WHERE kp.name = '汇集功能'
`).all();
for (const x of s) console.log(JSON.stringify(x));
console.log("\n=== watched_folders: any of them point to 汇集功能 source? ===");
const sources = db.prepare("SELECT id, kind, name FROM sources WHERE name = '汇集功能'").all();
for (const x of sources) console.log(JSON.stringify(x));
db.close();