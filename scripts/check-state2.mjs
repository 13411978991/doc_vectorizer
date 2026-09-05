import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const all = db.prepare("SELECT id, kind, name FROM sources WHERE name LIKE '%汇集%' OR name LIKE '%folder%'").all();
console.log("=== sources matching 汇集/folder ===");
for (const x of all) console.log(`  ${x.id.slice(0,8)} ${x.kind.padEnd(10)} ${x.name}`);
console.log("\n=== watched_folders ===");
const wf = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
for (const x of wf) console.log(`  ${x.display_name.padEnd(10)} id=${x.id.slice(0,8)} src=${(x.source_id || "NULL").slice(0,8)} former=${(x.former || "null").slice(0,8)}`);
console.log("\n=== documents ===");
const docs = db.prepare(`
  SELECT wf.display_name as folder, d.id, d.source_id as doc_src, d.archived_at
  FROM documents d
  JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  JOIN watched_folders wf ON wf.id = wfm.folder_id
  ORDER BY wf.display_name, d.id
`).all();
for (const d of docs) console.log(`  ${d.folder.padEnd(10)} doc=${d.id.slice(0,8)} src=${d.doc_src.slice(0,8)} arch=${d.archived_at ? "Y" : "n"}`);
db.close();