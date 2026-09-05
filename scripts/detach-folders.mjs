import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");

// Find folders that are currently bound to a project (=source_id) and
// have a formerSourceId in metadata, restore source_id back.
const rows = db.prepare(`
  SELECT id, source_id, metadata
  FROM watched_folders
  WHERE json_extract(metadata, '$.formerSourceId') IS NOT NULL
`).all();

console.log("folders to detach:", rows.length);
for (const r of rows) {
  const meta = JSON.parse(r.metadata || "{}");
  const former = meta.formerSourceId;
  if (!former) continue;
  delete meta.formerSourceId;
  db.prepare(`
    UPDATE watched_folders
    SET source_id = ?, metadata = ?, updated_at = current_timestamp
    WHERE id = ?
  `).run(former, JSON.stringify(meta), r.id);
  console.log("detached", r.id, "-> source_id", former);
}

// Also: if documents under the project id are still attached, revert them
// to their former source id. Search for documents where source_id = a project
// that no longer has folders bound.
const docs = db.prepare(`
  SELECT d.id, d.source_id
  FROM documents d
  WHERE d.source_id NOT IN (SELECT id FROM sources)
`).all();
console.log("orphan documents (source_id missing from sources):", docs.length);

// Skip orphan fix — projects might exist for docs created directly.

db.close();
console.log("DONE");