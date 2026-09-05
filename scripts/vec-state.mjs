import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
sqliteVec.load(db);

console.log("=== Total chunks vs chunk_vec0 ===");
const totals = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM chunks) as total_chunks,
    (SELECT COUNT(*) FROM chunk_vec0) as total_vecs
`).get();
console.log(totals);

console.log("\n=== Chunks without vec per source ===");
const missing = db.prepare(`
  SELECT c.source_id, COUNT(*) as missing
  FROM chunks c
  LEFT JOIN chunk_vec0 cv ON cv.chunk_id = c.id
  WHERE cv.chunk_id IS NULL
  GROUP BY c.source_id
`).all();
for (const m of missing) console.log(`  - src=${m.source_id.slice(0,8)}: ${m.missing} chunks missing vec`);

console.log("\n=== chunk_vec0 count per source ===");
const have = db.prepare(`
  SELECT c.source_id, COUNT(*) as vec_count
  FROM chunk_vec0 cv
  JOIN chunks c ON c.id = cv.chunk_id
  GROUP BY c.source_id
`).all();
for (const h of have) console.log(`  - src=${h.source_id.slice(0,8)}: ${h.vec_count} vecs`);

db.close();