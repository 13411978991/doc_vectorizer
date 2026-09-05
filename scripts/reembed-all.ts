/**
 * One-shot script: re-embed every chunk / entity / event in the DB with
 * the *current* embeddingClient, then sync all four vec0 virtual tables.
 *
 * Use case: switching embedding provider (e.g. text-embedding-3-small →
 * Xenova/bge-large-zh-v1.5). Old rows hold values from the previous
 * model; they share the 1024-dim schema but live in a different vector
 * space, so a query against the new model ranks old vectors as noise.
 * Wipe + rebuild fixes that.
 *
 * Idempotent: re-running after a clean prior run is a no-op.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { embeddingClient } from "../src/ai/embedding-client.js";

const DB_PATH = process.env.DATABASE_FILE ?? "E:\\sag\\dist\\builds\\sag-20260813-171645\\data\\sag.db";
const DIM = 4096;
const BATCH_SIZE = 8;
const MODEL_TAG = "qwen3-embedding-8b@sunwoda";
// qwen3-embedding-8b context window is 32k tokens, but Chinese audit text
// can include very long boilerplate (e.g. full HTML tables). Truncate to
// a safe 8000 chars to keep one row under the API's max input.
const MAX_INPUT_CHARS = 8000;
const DONT_DELETE_CHUNKS = process.argv.includes("--skip-chunks");

interface ChunkRow { id: string; heading: string | null; content: string }
interface EntityRow { id: string; name: string; type: string | null; description: string | null }
interface EventRow { id: string; title: string; content: string; summary: string | null }

interface Target {
  label: string;
  pkColumn: string;        // "chunk_id" or "id"
  jsonColumn: string;      // "embedding_json" / "title_embedding_json" / "content_embedding_json"
  jsonTable: string;       // "chunk_embeddings" / "entities" / "events"
  vecTable: string;        // "chunk_vec0" / "entity_vec0" / "event_title_vec0" / ...
  vecPkColumn: string;     // "chunk_id" / "entity_id" / "event_id"
  fetch: (db: Database.Database) => Array<{ id: string; [k: string]: unknown }>;
  inputFor: (row: any) => string;
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function emptyToUnit(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  if (norm > 1e-6) return vec;
  const out = new Float32Array(vec.length);
  out[0] = 1;
  return out;
}

async function reembed(
  db: Database.Database,
  target: Target,
  rows: Array<{ id: string; [k: string]: unknown }>
) {
  console.log(`[reembed] ${target.label}: ${rows.length} rows`);

  // --skip-chunks: chunks already done in a prior run; skip only the chunk path
  if (DONT_DELETE_CHUNKS && target.label === "chunks") {
    console.log(`[reembed] ${target.label}: skipped (--skip-chunks)`);
    return;
  }
  // For chunk_embeddings: PK is chunk_id, no other NOT NULL cols we own
  // besides model. Safe to wipe + bulk-insert.
  // For entities / events: parent tables have other NOT NULL cols (source_id,
  // document_id, etc.). We must NOT delete from them; instead UPDATE the
  // embedding column in place.
  if (target.label === "chunks") {
    db.exec(`delete from ${target.jsonTable};`);
    db.exec(`delete from ${target.vecTable};`);
  } else {
    db.exec(`update ${target.jsonTable} set ${target.jsonColumn} = null;`);
    db.exec(`delete from ${target.vecTable};`);
  }

  const t0 = Date.now();
  let done = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const inputs = batch.map((r) => {
      const raw = target.inputFor(r);
      return raw.length > MAX_INPUT_CHARS ? raw.slice(0, MAX_INPUT_CHARS) : raw;
    });
    let embeddings: number[][];
    try {
      embeddings = await embeddingClient.batchGenerate(inputs);
    } catch (err) {
      console.error(`[reembed] ${target.label} batch ${i}/${rows.length} failed:`, (err as Error).message);
      // Chunks path: DELETE already ran so partial progress is fine; skip this batch.
      // Entities/events: UPDATE is in-place so skip is also fine.
      if (target.label === "chunks") {
        console.error(`[reembed] ${target.label} batch skipped, continuing...`);
        continue;
      }
      throw err;
    }

    // json write — chunk_embeddings INSERT (wiped); entities / events UPDATE in place
    const jsonSql = target.label === "chunks"
      ? `insert into ${target.jsonTable} (${target.pkColumn}, model, ${target.jsonColumn}) values (?, ?, ?)`
      : `update ${target.jsonTable} set ${target.jsonColumn} = ? where ${target.pkColumn} = ?`;
    const jsonStmt = db.prepare(jsonSql);
    const txJson = db.transaction(() => {
      for (let j = 0; j < batch.length; j += 1) {
        const row = batch[j];
        const emb = embeddings[j];
        if (!row || !emb) continue;
        if (target.label === "chunks") {
          jsonStmt.run(row.id, MODEL_TAG, JSON.stringify(emb));
        } else {
          jsonStmt.run(JSON.stringify(emb), row.id);
        }
      }
    });
    txJson();

    // vec0 write
    const stmt = db.prepare(
      `insert or replace into ${target.vecTable} (${target.vecPkColumn}, embedding) values (@id, @vector)`
    );
    const txVec = db.transaction(() => {
      for (let j = 0; j < batch.length; j += 1) {
        const emb = embeddings[j];
        if (!emb) continue;
        stmt.run({
          id: batch[j].id,
          vector: vecToBuffer(emptyToUnit(new Float32Array(emb)))
        });
      }
    });
    txVec();

    done = Math.min(i + BATCH_SIZE, rows.length);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write(`\r[reembed] ${target.label}  ${done}/${rows.length}  (${elapsed}s)`);
  }
  process.stdout.write(`\n`);
}

async function main() {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  const chunks = db
    .prepare(`select id, heading, content from chunks order by document_id, rank`)
    .all() as ChunkRow[];

  const entities = db
    .prepare(`select id, name, type, description from entities order by id`)
    .all() as EntityRow[];

  const events = db
    .prepare(`select id, title, content, summary from events where deleted_at is null order by id`)
    .all() as EventRow[];

  const targets: Array<{ target: Target; rows: any[] }> = [
    {
      target: {
        label: "chunks",
        pkColumn: "chunk_id",
        jsonColumn: "embedding_json",
        jsonTable: "chunk_embeddings",
        vecTable: "chunk_vec0",
        vecPkColumn: "chunk_id",
        fetch: () => [],
        inputFor: (r: ChunkRow) => `${r.heading ?? ""}\n${r.content}`.trim()
      },
      rows: chunks
    },
    {
      target: {
        label: "entities",
        pkColumn: "id",
        jsonColumn: "embedding_json",
        jsonTable: "entities",
        vecTable: "entity_vec0",
        vecPkColumn: "entity_id",
        fetch: () => [],
        inputFor: (r: EntityRow) =>
          `${r.name}${r.type ? ` (${r.type})` : ""}${r.description ? `\n${r.description}` : ""}`
      },
      rows: entities
    },
    {
      target: {
        label: "event_titles",
        pkColumn: "id",
        jsonColumn: "title_embedding_json",
        jsonTable: "events",
        vecTable: "event_title_vec0",
        vecPkColumn: "event_id",
        fetch: () => [],
        inputFor: (r: EventRow) => r.title
      },
      rows: events.map((e) => ({ id: e.id, title: e.title }))
    },
    {
      target: {
        label: "event_contents",
        pkColumn: "id",
        jsonColumn: "content_embedding_json",
        jsonTable: "events",
        vecTable: "event_content_vec0",
        vecPkColumn: "event_id",
        fetch: () => [],
        inputFor: (r: EventRow) => `${r.content ?? ""}${r.summary ? `\n${r.summary}` : ""}`.trim()
      },
      rows: events
    }
  ];

  console.log(
    `[reembed] starting full re-embed: ${chunks.length} chunks, ${entities.length} entities, ${events.length} events (x2)`
  );
  console.log(`[reembed] model: ${MODEL_TAG} (via embeddingClient)`);
  console.log(`[reembed] dim:   ${DIM}`);
  console.log("");

  for (const { target, rows } of targets) {
    await reembed(db, target, rows);
  }

  console.log(`\n[reembed] verifying row counts:`);
  const checks: Array<[string, string]> = [
    ["chunks", "chunks"],
    ["chunk_embeddings", "chunk_embeddings"],
    ["chunk_vec0", "chunk_vec0"],
    ["entities", "entities"],
    ["entity_vec0", "entity_vec0"],
    ["event_title_vec0", "event_title_vec0"],
    ["event_content_vec0", "event_content_vec0"]
  ];
  for (const [label, table] of checks) {
    const c = db.prepare(`select count(*) as n from ${table}`).get() as { n: number };
    console.log(`  ${label.padEnd(22)} ${c.n}`);
  }
  console.log(`\n[reembed] DONE`);
}

main().catch((err) => {
  console.error("[reembed] FAILED:", err);
  process.exit(1);
});
