// One-shot restore: previous buggy attach/detach rewrote
// documents.source_id (and chunks/events/entities) to the project ID.
// The correct invariant is that documents always live under the folder's
// own formerSourceId — the project only aggregates via watched_folders.
// This script rebinds documents/chunks/events/entities back to the
// folder's formerSourceId so we don't lose the user's data. Run from
// outside the running service (read-only DB otherwise).
import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

const rows = db.prepare(`
  SELECT
    d.id as doc_id,
    wf.id as folder_id,
    wf.display_name,
    json_extract(wf.metadata, '$.formerSourceId') as former
  FROM documents d
  JOIN watched_folder_manifests wfm ON wfm.document_id = d.id
  JOIN watched_folders wf ON wf.id = wfm.folder_id
`).all();
console.log(`${rows.length} docs to fix`);

const moved = { docs: 0, chunks: 0, events: 0, entities: 0 };
for (const r of rows) {
  if (!r.former) {
    console.log(`  ! folder ${r.display_name} has no formerSourceId — skipping doc ${r.doc_id}`);
    continue;
  }
  // documents
  const u1 = db.prepare("UPDATE documents SET source_id = ?, archived_at = NULL, updated_at = current_timestamp WHERE id = ? AND source_id != ?").run(r.former, r.doc_id, r.former);
  if (u1.changes) moved.docs++;

  // chunks
  const u2 = db.prepare("UPDATE chunks SET source_id = ? WHERE document_id = ? AND source_id != ?").run(r.former, r.doc_id, r.former);
  if (u2.changes) moved.chunks += u2.changes;

  // events
  const u3 = db.prepare("UPDATE events SET source_id = ? WHERE document_id = ? AND source_id != ?").run(r.former, r.doc_id, r.former);
  if (u3.changes) moved.events += u3.changes;

  // entities
  const u4 = db.prepare("UPDATE entities SET source_id = ? WHERE document_id = ? AND source_id != ?").run(r.former, r.doc_id, r.former);
  if (u4.changes) moved.entities += u4.changes;
}
console.log("moved:", JSON.stringify(moved));
db.close();