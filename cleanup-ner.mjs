// Delete duplicates created by the earlier reingest-ner.mjs run that
// minted fresh UUIDs instead of reusing the existing document IDs.
// After cleanup: 100 docs, all matching the original watcher manifest.
import Database from 'better-sqlite3';

const db = new Database('D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/data/sag.db');

const SOURCE_ID = '0b3a4db2-b71b-4c67-b2e9-d4def71c5cd2';
const folderId = 'd07cb0fa-04e8-4bc5-adba-65455a9b0e2f';

const manifests = db.prepare(
  "select document_id from watched_folder_manifests where folder_id = ? and document_id is not null"
).all(folderId);
const originalIds = new Set(manifests.map(m => m.document_id).filter(Boolean));
console.log('Original doc IDs in manifest:', originalIds.size);

const allDocs = db.prepare("select id, title, file_name, source_id from documents where source_id = ?").all(SOURCE_ID);
console.log('All docs for source:', allDocs.length);

const byKey = new Map();
for (const d of allDocs) {
  const key = d.file_name ?? d.title;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(d.id);
}

const duplicates = [];
for (const [key, ids] of byKey) {
  const original = ids.find(id => originalIds.has(id));
  if (!original) {
    duplicates.push(...ids);
  } else {
    for (const id of ids) {
      if (id !== original) duplicates.push(id);
    }
  }
}
console.log('Duplicates to delete:', duplicates.length);

const tx = db.transaction(() => {
  let deleted = 0;
  for (const id of duplicates) {
    const r = db.prepare("delete from documents where id = ?").run(id);
    deleted += r.changes;
  }
  return deleted;
});

const deletedCount = tx();
console.log(`\n✓ Deleted ${deletedCount} duplicate documents`);

const final = db.prepare(`
  select
    (select count(*) from documents where source_id = ?) as docs,
    (select count(*) from chunks where document_id in (select id from documents where source_id = ?)) as chunks,
    (select count(*) from events where document_id in (select id from documents where source_id = ?)) as events,
    (select count(*) from entities where source_id = ?) as entities
`).get(SOURCE_ID, SOURCE_ID, SOURCE_ID, SOURCE_ID);
console.log('Final counts:', JSON.stringify(final));