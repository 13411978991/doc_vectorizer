const HUIJI1 = "c4234006-5804-43d5-839f-ef272b1c3f9d";
import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const all = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
for (const x of all) console.log(`  ${x.display_name.padEnd(10)} id=${x.id} src=${x.source_id}`);
const docs = db.prepare(`
  SELECT wf.display_name as folder, d.id, d.source_id as doc_src
  FROM documents d
  JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  JOIN watched_folders wf ON wf.id = wfm.folder_id
`).all();
console.log("\ndocs:");
for (const d of docs) console.log(`  ${d.folder.padEnd(10)} doc=${d.id.slice(0,8)} src=${d.doc_src.slice(0,8)}`);
db.close();