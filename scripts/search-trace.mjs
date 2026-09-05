import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const db = new Database("E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db");
sqliteVec.load(db);

const PROJECT_ID = "59bfcc4d-2da3-43b1-a539-9fe605ad0d36";
const SOURCE_ID = "10588ad9-ed27-48ee-96a0-743f46e96c31";  // 盘点表

// 1) Check chunks for source 10588ad9
console.log("=== Chunks count for 盘点表 ===");
const chunkCount = db.prepare("SELECT COUNT(*) as cnt FROM chunks WHERE source_id = ?").get(SOURCE_ID);
console.log(chunkCount);

console.log("\n=== chunk_vec0 count for 盘点表 ===");
const vecCount = db.prepare(`
  SELECT COUNT(*) as cnt
  FROM chunk_vec0 cv
  JOIN chunks c ON c.id = cv.chunk_id
  WHERE c.source_id = ?
`).get(SOURCE_ID);
console.log(vecCount);

console.log("\n=== Sample chunks for 盘点表 ===");
const samples = db.prepare(`
  SELECT c.id, c.heading, substr(c.content, 1, 80) as preview
  FROM chunks c WHERE c.source_id = ? LIMIT 3
`).all(SOURCE_ID);
for (const s of samples) console.log(`  - [${s.id}] ${s.heading} : ${s.preview}`);

console.log("\n=== Embedding dimensions (from any chunk_vec0 row) ===");
const sample = db.prepare(`SELECT vec_length(embedding) as dim FROM chunk_vec0 LIMIT 1`).get();
console.log(sample);

// 2) Embed query "盘点表" using the same provider
const apiKey = process.env.EMBEDDING_API_KEY || "sk-MKSLNwKxx6xIcNBmFH7hahlCY7xEIhVzyCEkZ2HrdDpLjKhU";
const baseUrl = process.env.EMBEDDING_BASE_URL || "https://api.302ai.cn/v1";
const model = "text-embedding-3-large";

console.log("\n=== Embedding query 盘点表 ===");
const resp = await fetch(`${baseUrl}/embeddings`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  },
  body: JSON.stringify({ input: "盘点表", model })
});
const data = await resp.json();
const vec = new Float32Array(data.data[0].embedding);
console.log(`  vector dim: ${vec.length}, first 5: ${vec[0]}, ${vec[1]}, ${vec[2]}, ${vec[3]}, ${vec[4]}`);

console.log("\n=== Direct vec0 search across ALL sources (no filter) ===");
const allRes = db.prepare(`
  SELECT c.id, c.source_id, c.heading, substr(c.content, 1, 60) as preview, cv.distance
  FROM chunk_vec0 cv
  JOIN chunks c ON c.id = cv.chunk_id
  WHERE cv.embedding MATCH ? AND k = 5
  ORDER BY cv.distance LIMIT 5
`).all(vec);
for (const r of allRes) console.log(`  - [${r.id}] src=${r.source_id.slice(0,8)} d=${r.vec_distance.toFixed(4)}  ${r.heading}  ${r.preview}`);

console.log("\n=== Direct vec0 search filtered to sourceIds ===");
const filtRes = db.prepare(`
  SELECT c.id, c.source_id, c.heading, substr(c.content, 1, 60) as preview, cv.distance
  FROM chunk_vec0 cv
  JOIN chunks c ON c.id = cv.chunk_id
  WHERE cv.embedding MATCH ? AND k = 5
    AND c.source_id IN (?, ?)
  ORDER BY cv.distance LIMIT 5
`).all(vec, PROJECT_ID, SOURCE_ID);
for (const r of filtRes) console.log(`  - [${r.id}] src=${r.source_id.slice(0,8)} d=${r.vec_distance.toFixed(4)}  ${r.heading}  ${r.preview}`);

db.close();