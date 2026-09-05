import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare(`
  SELECT d.title, d.content, wf.display_name as folder
  FROM documents d
  JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  JOIN watched_folders wf ON wf.id = wfm.folder_id
  WHERE d.archived_at IS NULL
    AND d.source_id = 'c4234006-5804-43d5-839f-ef272b1c3f9d'
  ORDER BY wf.display_name, d.id
`).all();
for (const x of r) {
  console.log(`\n--- ${x.folder}: ${x.title} ---`);
  console.log(`  ${(x.content ?? "").slice(0, 400)}`);
}
db.close();