import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

const all = db.prepare("SELECT id, kind, name FROM sources WHERE name LIKE '%汇集%'").all();
console.log("=== Sources named 汇集* ===");
for (const x of all) console.log(`  ${x.id.slice(0,8)} ${x.kind.padEnd(8)} ${x.name}`);

console.log("\n=== watched_folders: source binding ===");
const wf = db.prepare("SELECT id, display_name, source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
for (const x of wf) {
  const srcName = all.find(s => s.id === x.source_id)?.name ?? "null";
  console.log(`  ${x.display_name.padEnd(10)} src=${srcName.padEnd(10)} former=${x.former?.slice(0,8) ?? "null"}`);
}

console.log("\n=== documents: per folder, per source ===");
const docs = db.prepare(`
  SELECT d.id, d.source_id as doc_src, d.archived_at, wf.display_name as folder
  FROM documents d
  LEFT JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  LEFT JOIN watched_folders wf ON wf.id = wfm.folder_id
  ORDER BY wf.display_name, d.id
`).all();
for (const d of docs) {
  const srcName = all.find(s => s.id === d.doc_src)?.name ?? "null";
  console.log(`  folder=${(d.folder ?? "?").padEnd(10)} doc=${d.id.slice(0,8)} src=${srcName} arch=${d.archived_at ? "Y" : "n"}`);
}
db.close();