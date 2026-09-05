import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

const wf = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
console.log("=== watched_folders ===");
for (const f of wf) console.log(`  ${f.display_name.padEnd(10)} source_id=${(f.source_id || "NULL").slice(0,8)} former=${(f.former || "null").slice(0,8)}`);

const docs = db.prepare(`
  SELECT wf.display_name as folder, d.id, d.source_id as doc_src, d.archived_at
  FROM documents d
  JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  JOIN watched_folders wf ON wf.id = wfm.folder_id
  ORDER BY wf.display_name, d.id
`).all();
console.log("\n=== documents per folder ===");
for (const d of docs) console.log(`  ${d.folder.padEnd(10)} doc=${d.id.slice(0,8)} src=${d.doc_src.slice(0,8)} archived=${d.archived_at ? "YES" : "no"}`);

db.close();