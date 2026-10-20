import Database from "better-sqlite3";
const path = process.argv[2];
const db = new Database(path, { readonly: true });
console.log("=== watched_folders ===");
for (const r of db.prepare("SELECT id, display_name, path, source_id FROM watched_folders").all())
  console.log(`  ${r.display_name} (${r.id.slice(0, 8)}) → source=${r.source_id.slice(0, 8)} path=${r.path}`);
console.log("=== sources ===");
for (const r of db.prepare("SELECT id, kind, name FROM sources").all())
  console.log(`  ${r.kind}: ${r.name} (${r.id.slice(0, 8)})`);
console.log("=== documents ===");
for (const r of db.prepare("SELECT id, source_id, title, file_name FROM documents").all())
  console.log(`  ${r.title} (${r.id.slice(0, 8)}) src=${r.source_id.slice(0, 8)} file=${r.file_name}`);
console.log("=== chunks ===");
for (const r of db.prepare("SELECT id, document_id, source_id, content FROM chunks").all())
  console.log(`  ${r.id.slice(0, 8)}: ${r.content.slice(0, 40)}...`);
console.log("=== entities ===");
for (const r of db.prepare("SELECT id, source_id, name, type FROM entities").all())
  console.log(`  ${r.type}: ${r.name} (${r.id.slice(0, 8)})`);
db.close();
