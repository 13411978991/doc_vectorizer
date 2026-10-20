import Database from 'better-sqlite3';
const db = new Database('D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/data/sag.db', {readonly: true});

const schemas = ['documents', 'chunks', 'chunk_embeddings', 'events', 'entities'];
for (const name of schemas) {
  const s = db.prepare(`select sql from sqlite_master where name='${name}'`).get();
  console.log(`\n=== ${name} ===`);
  console.log(s?.sql);
}
