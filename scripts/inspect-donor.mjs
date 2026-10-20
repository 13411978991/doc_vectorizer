import Database from "better-sqlite3";
const path = process.argv[2];
const db = new Database(path, { readonly: true });
const cols = db.prepare("PRAGMA table_info(chunk_embeddings)").all();
console.log("chunk_embeddings columns:");
for (const c of cols) console.log(`  ${c.name} ${c.type}`);
db.close();
