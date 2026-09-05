// Verify that DELETE /api/watched-folders/:id actually removes the
// folder's documents (cascade), not just the watched_folders row.
import Database from "better-sqlite3";

const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db", { readonly: true });

const folderId = process.argv[2];
if (!folderId) {
  console.log("usage: node test-delete-folder.mjs <folderId>");
  process.exit(1);
}

function count(label, sql, params = []) {
  const n = db.prepare(sql).get(...params).n;
  console.log(`  ${label}: ${n}`);
}

console.log(`=== BEFORE delete folder ${folderId} ===`);
count("watched_folders", "SELECT count(*) as n FROM watched_folders WHERE id = ?", [folderId]);
const wf = db.prepare("SELECT source_id, json_extract(metadata, '$.formerSourceId') as former FROM watched_folders WHERE id = ?").get(folderId);
console.log(`  source_id=${wf?.source_id?.slice(0,8) || "null"} former=${wf?.former?.slice(0,8) || "null"}`);
const sources = [wf?.source_id, wf?.former].filter(Boolean);
if (sources.length) {
  count("sources", `SELECT count(*) as n FROM sources WHERE id IN (${sources.map((_, i) => `$${i + 1}`).join(",")})`, sources);
  count("documents", `SELECT count(*) as n FROM documents WHERE source_id IN (${sources.map((_, i) => `$${i + 1}`).join(",")})`, sources);
  count("chunks", `SELECT count(*) as n FROM chunks WHERE source_id IN (${sources.map((_, i) => `$${i + 1}`).join(",")})`, sources);
  count("events", `SELECT count(*) as n FROM events WHERE source_id IN (${sources.map((_, i) => `$${i + 1}`).join(",")})`, sources);
  count("entities", `SELECT count(*) as n FROM entities WHERE source_id IN (${sources.map((_, i) => `$${i + 1}`).join(",")})`, sources);
}
db.close();