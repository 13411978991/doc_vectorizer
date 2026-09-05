import Database from "better-sqlite3";
const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });
console.log("=== events schema ===");
for (const c of db.prepare("PRAGMA table_info(events)").all()) {
  console.log(`  ${c.cid} ${c.name} ${c.type} ${c.notnull ? "NOT NULL" : ""} ${c.dflt_value || ""}`);
}
console.log("\n=== events FK list ===");
const fks = db.prepare("PRAGMA foreign_key_list(events)").all();
console.log(`count: ${fks.length}`);
for (const f of fks) console.log("  ", JSON.stringify(f));

console.log("\n=== orphan events (source_id not in sources) ===");
const orphans = db.prepare(`
  SELECT id, source_id, document_id, title
  FROM events
  WHERE source_id NOT IN (SELECT id FROM sources)
  LIMIT 20
`).all();
console.log(`count: ${orphans.length}`);
for (const o of orphans.slice(0, 5)) console.log(`  ${o.id.slice(0,8)} src=${o.source_id.slice(0,8)} doc=${o.document_id?.slice(0,8) || "null"} ${o.title?.slice(0, 40)}`);
console.log("\n=== chunk_id FK check ===");
const hasChunkFk = db.prepare("SELECT 1 FROM pragma_foreign_key_list(events) WHERE \"table\" = 'chunks' OR \"table\" = 'source_chunks'").all();
console.log(`chunk_id references chunks/source_chunks: ${hasChunkFk.length > 0 ? "YES" : "NO"}`);
console.log("\n=== other table FK samples ===");
for (const t of ["documents", "chunks", "entities", "chunk_embeddings"]) {
  const fk = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
  console.log(`  ${t}: ${fk.length} FKs`);
}
db.close();