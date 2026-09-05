import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

// Mimic expandProjectToSources
const PROJECT_ID = "59bfcc4d-2da3-43b1-a539-9fe605ad0d36";
const TENANT = "default";

const rows = db.prepare(`
  SELECT id, json_extract(metadata, '$.formerSourceId') as former
  FROM watched_folders
  WHERE tenant_id = ? AND source_id = ?
`).all(TENANT, PROJECT_ID);

console.log("Watched folders attached to 汇集功能:");
for (const r of rows) {
  console.log(`  - ${r.id}  former=${r.former}`);
}

const sources = new Set([PROJECT_ID]);
for (const r of rows) {
  if (r.former) sources.add(r.former);
}
console.log("\nExpanded sourceIds:");
for (const s of sources) console.log(`  - ${s}`);

console.log("\nVerify each in sources table:");
for (const sid of sources) {
  const r = db.prepare("SELECT id, name, archived_at FROM sources WHERE id = ?").get(sid);
  console.log(`  - ${sid}  name=${r?.name}  archived=${r?.archived_at}`);
}

console.log("\nDocs per source:");
for (const sid of sources) {
  const r = db.prepare("SELECT COUNT(*) as cnt FROM documents WHERE source_id = ?").get(sid);
  console.log(`  - ${sid}  docs=${r.cnt}`);
}

console.log("\nEvents per source:");
for (const sid of sources) {
  const r = db.prepare("SELECT COUNT(*) as cnt FROM events WHERE source_id = ?").get(sid);
  console.log(`  - ${sid}  events=${r.cnt}`);
}

db.close();