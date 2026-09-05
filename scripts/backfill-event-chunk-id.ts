/**
 * Backfill events.chunk_id for events whose chunk_id is NULL.
 *
 * Root cause: ingestion-service INSERT missed the `chunk_id` column, so
 * every event in the DB has chunk_id = NULL. That breaks
 * `getSectionsForEvents` (JOIN chunks on e.chunk_id returns 0 rows) and
 * makes the multi-strategy search fall back to a generic chunk vector
 * search, returning irrelevant top-1 results.
 *
 * Strategy: for each event with NULL chunk_id, find the chunk in the
 * same document whose `content_embedding_json` is most cosine-similar
 * to the event's `content_embedding_json`.
 */
import Database from "better-sqlite3";
import * as path from "node:path";

const DB_PATH = process.env.DATABASE_FILE ?? path.resolve(process.cwd(), "data/sag.db");

function parseEmbeddingJson(value: unknown): number[] | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => typeof n === "number" && Number.isFinite(n))) {
      return parsed as number[];
    }
  } catch {
    return null;
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]; const bi = b[i];
    dot += ai * bi; na += ai * ai; nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface EventRow {
  id: string;
  document_id: string | null;
  content_embedding_json: string | null;
}

interface ChunkRow {
  id: string;
  document_id: string;
  embedding_json: string | null;
}

async function main() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  // 1. Find all events with NULL chunk_id
  const events = db.prepare(`
    SELECT id, document_id, content_embedding_json
    FROM events
    WHERE chunk_id IS NULL
  `).all() as EventRow[];
  console.log(`Events with NULL chunk_id: ${events.length}`);

  // 2. Load all chunks with embeddings (only documents that have events)
  const docIds = Array.from(new Set(events.map((e) => e.document_id).filter((x): x is string => x != null)));
  console.log(`Documents touched: ${docIds.length}`);

  const placeholders = docIds.map(() => "?").join(",");
  const chunks = db.prepare(`
    SELECT c.id, c.document_id, ce.embedding_json
    FROM chunks c
    JOIN chunk_embeddings ce ON ce.chunk_id = c.id
    WHERE c.document_id IN (${placeholders})
      AND ce.embedding_json IS NOT NULL
  `).all(...docIds) as ChunkRow[];
  console.log(`Candidate chunks (with embedding): ${chunks.length}`);

  // Group chunks by document_id for fast lookup
  const chunksByDoc = new Map<string, ChunkRow[]>();
  for (const chunk of chunks) {
    if (!chunksByDoc.has(chunk.document_id)) chunksByDoc.set(chunk.document_id, []);
    chunksByDoc.get(chunk.document_id)!.push(chunk);
  }

  // 3. For each event, find best-matching chunk in its document by cosine
  const updateStmt = db.prepare(`UPDATE events SET chunk_id = ? WHERE id = ?`);
  let matched = 0;
  let noEmbed = 0;
  let noChunk = 0;
  const startTime = Date.now();

  const tx = db.transaction(() => {
    for (const event of events) {
      if (event.document_id == null) { noChunk++; continue; }
      const eventEmb = parseEmbeddingJson(event.content_embedding_json);
      if (!eventEmb) { noEmbed++; continue; }
      const candidates = chunksByDoc.get(event.document_id) ?? [];
      if (candidates.length === 0) { noChunk++; continue; }
      let best: { id: string; score: number } | null = null;
      for (const chunk of candidates) {
        const chunkEmb = parseEmbeddingJson(chunk.embedding_json);
        if (!chunkEmb) continue;
        const score = cosineSimilarity(eventEmb, chunkEmb);
        if (!best || score > best.score) {
          best = { id: chunk.id, score };
        }
      }
      if (best) {
        updateStmt.run(best.id, event.id);
        matched++;
      } else {
        noEmbed++;
      }
    }
  });
  tx();

  const elapsed = Date.now() - startTime;
  console.log(`\n=== Done in ${elapsed}ms ===`);
  console.log(`Matched & updated: ${matched}`);
  console.log(`No event embedding: ${noEmbed}`);
  console.log(`No chunks for document: ${noChunk}`);

  // Verify
  const stillNull = db.prepare(`SELECT count(*) FROM events WHERE chunk_id IS NULL`).get() as { "count(*)": number };
  console.log(`Events still with NULL chunk_id: ${stillNull["count(*)"]}`);
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});