/**
 * One-shot script: backfill chunk_embeddings for `section-*` chunks that
 * were inserted by ingestion-service without a corresponding embedding.
 *
 * Without this, every document is half-unsearchable: section chunks exist
 * in the `chunks` table but have no row in `chunk_embeddings`, so search/
 * retrieval filters them out.
 *
 * Strategy:
 *   1. Read all section-* chunks that lack a chunk_embeddings row
 *   2. Batch them through embeddingClient to get embedding vectors
 *   3. INSERT ON CONFLICT into chunk_embeddings for each
 */
import Database from "better-sqlite3";
import { embeddingClient } from "../src/ai/embedding-client.js";

const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";

interface MissingSectionRow {
  id: string;
  heading: string;
  content: string;
}

async function main() {
  const db = new Database(DB_PATH);

  const rows = db
    .prepare(
      `select c.id, c.heading, c.content
       from chunks c
       left join chunk_embeddings ce on ce.chunk_id = c.id
       where c.id like 'section-%' and ce.chunk_id is null
       order by c.id`
    )
    .all() as MissingSectionRow[];

  console.log(`[backfill] ${rows.length} section chunks missing embeddings`);

  if (rows.length === 0) {
    console.log(`[backfill] Nothing to do.`);
    return;
  }

  // Batch through embedding client. Reasonable batch size to balance API call
  // cost vs. memory.
  const BATCH_SIZE = 32;
  let totalInserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((r) => `${r.heading}\n${r.content}`);

    let embeddings: number[][];
    try {
      embeddings = await embeddingClient.batchGenerate(inputs);
    } catch (err) {
      console.error(`[backfill] embed batch ${i}/${rows.length} failed:`, (err as Error).message);
      continue;
    }

    const stmt = db.prepare(
      `insert into chunk_embeddings (chunk_id, model, embedding_json)
       values (?, ?, ?)
       on conflict (chunk_id) do update set embedding_json = excluded.embedding_json`
    );

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const emb = embeddings[j];
      if (!emb) continue;
      stmt.run(row.id, "text-embedding-3-small", JSON.stringify(emb));
      totalInserted += 1;
    }

    console.log(`[backfill] processed ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);

    // brief yield so progress is visible during long batches
    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(`\n[backfill] DONE`);
  console.log(`  Section chunks backfilled: ${totalInserted}`);

  // Verify
  const stillMissing = db
    .prepare(
      `select count(*) as n
       from chunks c
       left join chunk_embeddings ce on ce.chunk_id = c.id
       where c.id like 'section-%' and ce.chunk_id is null`
    )
    .get() as { n: number };
  console.log(`  Still missing: ${stillMissing.n}`);
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
