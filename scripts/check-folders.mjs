import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

console.log("=== folder-a / folder-b sources ===");
const r1 = db.prepare("SELECT id, name, archived_at, metadata FROM sources WHERE id IN ('7e73fd18-6d18-4f38-83f6-af3e9e359e85', '3f76cd5e-f6aa-4f61-9627-91ed813a95a9')").all();
for (const s of r1) console.log(s.id, s.name, "meta:", s.metadata);

console.log("\n=== documents under folder-a/folder-b ===");
const r2 = db.prepare("SELECT id, source_id, title FROM documents WHERE source_id IN ('7e73fd18-6d18-4f38-83f6-af3e9e359e85', '3f76cd5e-f6aa-4f61-9627-91ed813a95a9')").all();
for (const d of r2) console.log(d.id, d.source_id, d.title);

console.log("\n=== chunks count under folder-a/folder-b ===");
const r3 = db.prepare("SELECT s.name, COUNT(c.id) as cnt FROM sources s LEFT JOIN documents d ON d.source_id = s.id LEFT JOIN chunks c ON c.document_id = d.id WHERE s.id IN ('7e73fd18-6d18-4f38-83f6-af3e9e359e85', '3f76cd5e-f6aa-4f61-9627-91ed813a95a9') GROUP BY s.id").all();
for (const x of r3) console.log(x.name, x.cnt);

db.close();