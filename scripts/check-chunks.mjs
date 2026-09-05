import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
const r = db.prepare("SELECT c.id, c.source_id as src, d.source_id as doc_src, d.archived_at FROM chunks c LEFT JOIN documents d ON d.id = c.document_id WHERE c.document_id IN ('7dd04b45', '8a9a310d')").all();
for (const x of r) console.log(JSON.stringify(x));
db.close();