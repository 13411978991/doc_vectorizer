// One-shot repair: existing folders had formerSourceId overwritten by
// attach-to-other-project. The correct value is the folder's own home
// source — typically the source row whose `name` matches the folder's
// display_name (created at folder-create time). Re-stamp that.
import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
const folders = db.prepare("SELECT id, display_name, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders").all();
for (const f of folders) {
  // Find a source whose name = folder display_name (auto-created at folder
  // creation time). If there's no exact match, fall back to whatever
  // documents.source_id points at for the folder's manifests.
  let home = db.prepare("SELECT id FROM sources WHERE name = ? AND tenant_id = 'default'").get(f.display_name);
  if (!home) {
    home = db.prepare(`
      SELECT DISTINCT d.source_id as id
      FROM documents d
      JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
      WHERE wfm.folder_id = ? AND d.archived_at IS NULL
      LIMIT 1
    `).get(f.id);
  }
  if (home?.id && home.id !== f.former) {
    const r = db.prepare("UPDATE watched_folders SET metadata = json_set(coalesce(metadata, '{}'), '$.formerSourceId', ?) WHERE id = ?").run(home.id, f.id);
    console.log(`  ${f.display_name.padEnd(10)} ${f.former || "null"} → ${home.id.slice(0,8)} (${r.changes} row)`);
  } else {
    console.log(`  ${f.display_name.padEnd(10)} ${f.former || "null"} (unchanged)`);
  }
}
db.close();