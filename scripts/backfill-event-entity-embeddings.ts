/**
 * One-shot script: backfill embedding_json columns for events (title+content)
 * and entities (name) in any project, matching the convention ingestion-service
 * uses when it actually persists embeddings.
 *
 * Skips rows that already have a populated embedding (idempotent re-runs).
 */
import Database from "better-sqlite3";
import { embeddingClient } from "../src/ai/embedding-client.js";

const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";
const BATCH_SIZE = 32;
const MODEL = "text-embedding-3-small";

interface EventRow {
  id: string;
  title: string;
  content: string;
}

interface EntityRow {
  id: string;
  name: string;
}

function toVectorJson(embedding: number[]): string {
  return JSON.stringify(embedding);
}

async function main() {
  const db = new Database(DB_PATH);

  // ── Events ─────────────────────────────────────────────────────────────
  const events = db
    .prepare(
      `select id, title, content from events
       where title_embedding_json is null or content_embedding_json is null
       order by id`
    )
    .all() as EventRow[];

  console.log(`[backfill] Events needing embeddings: ${events.length}`);

  let eventDone = 0;
  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const batch = events.slice(i, i + BATCH_SIZE);
    // Two embeddings per event (title + content), batched together.
    const inputs: string[] = [];
    for (const e of batch) {
      inputs.push(e.title);
      inputs.push(`${e.title}\n\n${e.content}`);
    }

    let embs: number[][];
    try {
      embs = await embeddingClient.batchGenerate(inputs);
    } catch (err) {
      console.error(
        `[backfill] events batch ${i}/${events.length} failed:`,
        (err as Error).message
      );
      continue;
    }

    const stmt = db.prepare(
      `update events
       set title_embedding_json = ?,
           content_embedding_json = ?
       where id = ?`
    );
    for (let j = 0; j < batch.length; j++) {
      const titleEmb = embs[j * 2];
      const contentEmb = embs[j * 2 + 1];
      if (!titleEmb || !contentEmb) continue;
      stmt.run(toVectorJson(titleEmb), toVectorJson(contentEmb), batch[j].id);
      eventDone += 1;
    }
    console.log(
      `[backfill] events ${Math.min(i + BATCH_SIZE, events.length)}/${events.length}`
    );
  }

  console.log(`[backfill] Events done: ${eventDone}`);

  // ── Entities ───────────────────────────────────────────────────────────
  const entities = db
    .prepare(
      `select id, name from entities where embedding_json is null order by id`
    )
    .all() as EntityRow[];

  console.log(`[backfill] Entities needing embeddings: ${entities.length}`);

  let entityDone = 0;
  for (let i = 0; i < entities.length; i += BATCH_SIZE) {
    const batch = entities.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((e) => e.name);

    let embs: number[][];
    try {
      embs = await embeddingClient.batchGenerate(inputs);
    } catch (err) {
      console.error(
        `[backfill] entities batch ${i}/${entities.length} failed:`,
        (err as Error).message
      );
      continue;
    }

    const stmt = db.prepare(
      `update entities set embedding_json = ? where id = ?`
    );
    for (let j = 0; j < batch.length; j++) {
      const emb = embs[j];
      if (!emb) continue;
      stmt.run(toVectorJson(emb), batch[j].id);
      entityDone += 1;
    }
    console.log(
      `[backfill] entities ${Math.min(i + BATCH_SIZE, entities.length)}/${entities.length}`
    );
  }

  console.log(`[backfill] Entities done: ${entityDone}`);

  // Verify
  const evMissing = (db
    .prepare(
      `select count(*) as n from events where title_embedding_json is null or content_embedding_json is null`
    )
    .get() as { n: number }).n;
  const enMissing = (db
    .prepare(
      `select count(*) as n from entities where embedding_json is null`
    )
    .get() as { n: number }).n;

  console.log(`\n[backfill] DONE`);
  console.log(`  Events still missing: ${evMissing}`);
  console.log(`  Entities still missing: ${enMissing}`);
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
