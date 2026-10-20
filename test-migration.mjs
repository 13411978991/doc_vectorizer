import BetterSqlite3 from 'better-sqlite3';
const db = new BetterSqlite3('D:/IT审计/SAG-windows-pack/doc_vectorizer/release/data/sag.db');
const cols = db.prepare('pragma table_info(chunks)').all();
console.log('chunks columns:', cols.map(c => c.name));
const chunkCount = db.prepare('select count(*) as c from chunks').get();
console.log('chunks count:', chunkCount.c);
const chunkSample = db.prepare('select * from chunks limit 1').get();
console.log('sample chunk keys:', chunkSample ? Object.keys(chunkSample) : 'none');
