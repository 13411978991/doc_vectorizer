/**
 * One-shot script: re-run ingestion on Downloads project documents to rebuild
 * event_entities relations that were dropped when the ingestion pipeline was
 * skipping events/entity persistence.
 *
 * Strategy:
 *   1. For each document in Downloads, run chunkMarkdown + extractEventsFromChunk
 *      (matches the production ingestion pipeline)
 *   2. Insert events / entities / event_entities using the EXISTING document_id
 *      (not creating new documents — we re-attach extracted content to originals)
 *   3. Skip embedding generation for speed — embeddings can be backfilled later
 */
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { chunkMarkdown } from "../src/ingestion/chunking/markdown.js";
import { extractEventsFromChunk } from "../src/ingestion/extract/extractor.js";
import { aiSettingsService } from "../src/services/ai-settings-service.js";
import { llmClient } from "../src/ai/llm-client.js";


const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";
const SOURCE_ID = "8904ad22-bb4a-4af2-892a-27a8be78e9eb";
const TENANT = "default";

interface DocRow {
  id: string;
  title: string;
  content: string;
  metadata: string;
}

const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

async function main() {
  const docs = db
    .prepare(
      "select id, title, content, metadata from documents where source_id = ? and archived_at is null order by created_at"
    )
    .all(SOURCE_ID) as DocRow[];

  console.log(`[reingest] Found ${docs.length} documents in Downloads (${SOURCE_ID})`);

  const runtimeSettings = await aiSettingsService.getRuntimeSettings();
  const chunkingOptions = {
    mode: runtimeSettings.defaultChunkingMode,
    maxTokens: runtimeSettings.chunkTokenLimit,
    overlapTokens: (runtimeSettings as any).chunkOverlapTokens ?? 100
  };

  let totalEvents = 0;
  let totalRelations = 0;
  let totalEntitiesCreated = 0;

  for (const doc of docs) {
    if (!doc.content || doc.content.trim().length === 0) {
      console.log(`  [skip] ${doc.id} ${doc.title} (empty content)`);
      continue;
    }
    console.log(`[doc] ${doc.id} "${doc.title}" (${doc.content.length} chars)`);
    const chunking = chunkMarkdown(doc.content, chunkingOptions);
    console.log(`  chunks: ${chunking.chunks.length}`);

    for (const chunk of chunking.chunks) {
      let events: any[] = [];
      try {
        events = await extractEventsFromChunk({
          llm: llmClient,
          documentTitle: doc.title,
          heading: chunk.heading,
          content: chunk.content,
          references: chunk.sectionIds
        });
      } catch (err) {
        console.error(`    [extract-err doc=${doc.id}]`, (err as Error).message ?? err);
        continue;
      }
      if (events.length === 0) continue;
      console.log(`    chunk[${chunk.rank}] → ${events.length} events`);

      for (const event of events) {
        const eventId = randomUUID();
        db.prepare(
          `insert into events
             (id, source_id, document_id, source_type, title, content, category, status, rank, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).run(
          eventId,
          SOURCE_ID,
          doc.id,
          'document',
          event.title,
          event.content,
          event.category ?? "fact",
          event.status ?? "CONFIRMED",
          0
        );
        totalEvents += 1;

        for (const entity of event.entities) {
          // upsert entity by (source_id, document_id, name)
          let entityId: string | undefined;
          const existing = db
            .prepare(
              "select id from entities where source_id = ? and document_id = ? and name = ? limit 1"
            )
            .get(SOURCE_ID, doc.id, entity.name) as { id: string } | undefined;
          if (existing) {
            entityId = existing.id;
          } else {
            entityId = randomUUID();
            const insertResult = db
              .prepare(
                `insert into entities
                   (id, source_id, document_id, name, normalized_name, type, metadata, description)
                 values (?, ?, ?, ?, ?, ?, '{}', ?)`
              )
              .run(
                entityId,
                SOURCE_ID,
                doc.id,
                entity.name,
                entity.name.toLowerCase().trim(),
                entity.type,
                entity.description ?? null
              );
            if (insertResult.changes > 0) totalEntitiesCreated += 1;
          }

          // event_entities link
          const linkResult = db
            .prepare(
              `insert into event_entities (id, event_id, entity_id) values (?, ?, ?)
                 on conflict do nothing`
            )
            .run(randomUUID(), eventId, entityId);
          if (linkResult.changes > 0) totalRelations += 1;
        }
      }
    }
    console.log(`  running: events=${totalEvents}, relations=${totalRelations}`);
  }

  console.log(`\n[reingest] DONE`);
  console.log(`  Documents processed: ${docs.length}`);
  console.log(`  Events created: ${totalEvents}`);
  console.log(`  Entities created: ${totalEntitiesCreated}`);
  console.log(`  event_entities links created: ${totalRelations}`);
}

main().catch((err) => {
  console.error("[reingest] FAILED:", err);
  process.exit(1);
});
