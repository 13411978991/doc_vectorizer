// Re-ingest each document via /ingest with its existing documentId so
// no duplicates are created. The backend now accepts documentId in
// the schema (added in this revision) and passes it through to
// ingestion-service.ts so chunks/events/entities are written under
// the original document_id. Combined with the new
// `entityTypeFromNer` heuristic, the Plan B NER pipeline produces
// real person / location / organization entities instead of the
// Plan A subject/work/metric/product regex labels.
import Database from 'better-sqlite3';

const SOURCE_ID = '0b3a4db2-b71b-4c67-b2e9-d4def71c5cd2';

const db = new Database('D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/data/sag.db', {readonly: true});
const docs = db.prepare(
  "select id, title, content, file_name from documents where source_id = ? order by title"
).all(SOURCE_ID);
db.close();
console.log('docs to re-ingest:', docs.length);

let ok = 0, fail = 0;

for (let i = 0; i < docs.length; i++) {
  const doc = docs[i];
  const body = JSON.stringify({
    sourceId: SOURCE_ID,
    documentId: doc.id,
    title: doc.title,
    content: doc.content,
    extract: true,
    waitForCompletion: true,
    chunking: { mode: "heading_strict", maxTokens: 512, overlapTokens: 100 }
  });
  try {
    const r = await fetch('http://127.0.0.1:4173/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60000)
    });
    if (r.ok) {
      ok++;
      if (i % 10 === 0 || i === docs.length - 1) {
        const data = await r.json();
        console.log(`[${i+1}/${docs.length}] ${doc.title} → ${r.status} chunks=${data.chunkCount} entities=${data.entityCount}`);
      }
    } else {
      fail++;
      console.error(`[${i+1}/${docs.length}] ${doc.title} → ${r.status}: ${await r.text()}`);
    }
  } catch (err) {
    fail++;
    console.error(`[${i+1}/${docs.length}] ${doc.title} → error: ${err.message}`);
  }
}
console.log(`\nDone: ${ok} ok, ${fail} fail.`);