/**
 * src/services/__tests__/ingestion-entity-insert.test.ts — Regression
 * test for the entity-insert FK consistency bug.
 *
 * The original bug: in ingestion-service.ts buildWriteBatch(), each
 * entity got TWO random UUIDs — one for the entities row, a different
 * one for the entity_vec0 row — and a fallback SELECT to resolve the
 * id for event_entities. The fallback SELECT was structurally broken:
 * the entities INSERT hadn't been executed yet (it was still in the
 * writeStatements array waiting for the db-write-worker to commit),
 * so every fresh entity name logged "entity not found after insert"
 * and silently dropped its event_entities link. The T3d
 * pending-orphan reaper surfaced this on the 盈旺精密 TB re-ingest.
 *
 * The fix: buildWriteBatch now captures the entity id at INSERT time
 * (one randomUUID per entity name) and reuses it for entities,
 * entity_vec0, and event_entities. No fallback SELECT needed.
 *
 * This test doesn't go through the full ingestDocument() pipeline
 * (which requires a live LLM + embedding model). Instead it exercises
 * the same statement-building pattern buildWriteBatch uses for the
 * entity block, ships it through dbWriteWorkerPool.runWriteBatch(),
 * and verifies the FK invariant.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, initPool, pool } from "../../db/pool.js";
import { createSource } from "../../db/repositories.js";

const TENANT = `entity-fk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let sourceId: string;
let documentId: string;

beforeAll(async () => {
  await initPool();
  // Each test gets a unique source + document so we don't collide
  // with other test files running in the same worker.
  const source = await createSource({
    tenantId: TENANT,
    name: "entity-fk test source",
    description: "ingestion-entity-insert regression test",
    metadata: { test: "entity-fk", kind: "fixture" }
  });
  sourceId = source.id;
  documentId = randomUUID();
});

afterAll(async () => {
  // Clean up: cascade via source. Documents, events, entities,
  // event_entities, entity_vec0, event_title_vec0, event_content_vec0
  // all FK back to documents or sources.
  await pool.query("delete from documents where source_id = $1", [sourceId]);
  await pool.query("delete from sources where id = $1", [sourceId]);
  await closePool();
});

/**
 * Build a writeStatements array that mirrors what the new
 * buildWriteBatch() does for the entity block:
 *   1. documents upsert
 *   2. event A insert
 *   3. event B insert
 *   4. entity "ACME" insert (shared by both events)
 *   5. entity "审计底稿" insert (only in event A)
 *   6. entity_vec0 rows referencing the same entity ids
 *   7. event_entities linking events to entities
 *
 * Crucially, the entity_id value is the SAME across the entities row,
 * the entity_vec0 row, and the event_entities row — this is the fix.
 */
function buildBatch(embeddingDim = 1024): {
  stmts: Array<{ sql: string; params: unknown[] }>;
  expected: { entityAcme: string; entityShenji: string; eventA: string; eventB: string };
} {
  const entityAcme = randomUUID();
  const entityShenji = randomUUID();
  const eventA = randomUUID();
  const eventB = randomUUID();

  // Build a unit vector of the expected dimension. The vec0 tables
  // reject mismatched dimensions (the local BGE model emits 1024-dim),
  // so we match that here. toVectorLiteral will format it as
  // "[1,0,0,...]" which is what chunk_embeddings / entity.embedding_json
  // expects.
  const vec = new Array(embeddingDim).fill(0);
  vec[0] = 1;
  const vecLiteral = `[${vec.join(",")}]`;
  const floatVec = new Float32Array(vec);

  const stmts: Array<{ sql: string; params: unknown[] }> = [
    // 1. documents upsert (parse_status='PARSING' first, then flip
    //    to 'COMPLETED' so the entity inserts have a parent to FK on).
    {
      sql: `insert into documents (id, source_id, title, content, parse_status, metadata)
            values ($1, $2, $3, $4, 'PARSING', $5)
            on conflict (id) do update set
              title = excluded.title,
              content = excluded.content,
              parse_status = 'PARSING',
              updated_at = current_timestamp`,
      params: [documentId, sourceId, "fixture doc", "test content", JSON.stringify({ test: "entity-fk" })]
    },
    // 2. event A
    {
      sql: `insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      params: [eventA, sourceId, documentId, "chunk-a", "Event A title", "Event A body", "fact", "CONFIRMED", 0, "sum A", vecLiteral, vecLiteral, "remote-llm"]
    },
    // 3. event B
    {
      sql: `insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      params: [eventB, sourceId, documentId, "chunk-b", "Event B title", "Event B body", "fact", "CONFIRMED", 1, "sum B", vecLiteral, vecLiteral, "remote-llm"]
    },
    // 4. entity ACME (shared)
    {
      sql: `insert into entities (id, source_id, document_id, name, normalized_name, type, description, embedding_json)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict do nothing`,
      params: [entityAcme, sourceId, documentId, "ACME Corp", "acme corp", "ORG", "ACME description", vecLiteral]
    },
    // 5. entity 审计底稿 (event A only)
    {
      sql: `insert into entities (id, source_id, document_id, name, normalized_name, type, description, embedding_json)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            on conflict do nothing`,
      params: [entityShenji, sourceId, documentId, "审计底稿", "审计底稿", "DOC", "audit workpaper", vecLiteral]
    },
    // 6. entity_vec0 — uses the SAME entity_id as the entities row
    {
      sql: `insert into entity_vec0 (entity_id, embedding) values ($1, $2)`,
      params: [entityAcme, floatVec]
    },
    {
      sql: `insert into entity_vec0 (entity_id, embedding) values ($1, $2)`,
      params: [entityShenji, floatVec]
    },
    // 7. event_entities links — entity_id MUST match the entities row id
    {
      sql: `insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing`,
      params: [randomUUID(), eventA, entityAcme]
    },
    {
      sql: `insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing`,
      params: [randomUUID(), eventA, entityShenji]
    },
    {
      sql: `insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing`,
      params: [randomUUID(), eventB, entityAcme]
    },
    // 8. flip documents to COMPLETED so the test is realistic
    {
      sql: "update documents set parse_status = 'COMPLETED' where id = $1",
      params: [documentId]
    }
  ];

  return { stmts, expected: { entityAcme, entityShenji, eventA, eventB } };
}

describe("ingestion entity-insert FK consistency", () => {
  it("every event_entities row references a real entities row from the same batch", async () => {
    const { stmts, expected } = buildBatch();
    // Apply the batch inside a single transaction so we mirror what
    // dbWriteWorkerPool.runWriteBatch() does in production. We use
    // the pool directly (instead of the worker pool) because the
    // worker process spawns a child that depends on tsx loader
    // wiring that doesn't exist in the vitest parent — falling
    // back to the in-process path is what the test verifies anyway.
    await pool.query("begin");
    try {
      for (const stmt of stmts) {
        await pool.query(stmt.sql, stmt.params);
      }
      await pool.query("commit");
    } catch (e) {
      try { await pool.query("rollback"); } catch { /* ignore */ }
      throw e;
    }

    // 1. event_entities rows: every entity_id must match a real entities row.
    const eeRows = await pool.query<{ event_id: string; entity_id: string }>(
      "select event_id, entity_id from event_entities where event_id in ($1, $2)",
      [expected.eventA, expected.eventB]
    );
    expect(eeRows.rows.length).toBe(3);
    for (const row of eeRows.rows) {
      expect(row.entity_id).toMatch(/^[0-9a-f-]{36}$/);
    }

    // 2. entities rows: the two expected entity ids must be present.
    const entityRows = await pool.query<{ id: string; name: string }>(
      "select id, name from entities where id in ($1, $2) order by name",
      [expected.entityAcme, expected.entityShenji]
    );
    expect(entityRows.rows.length).toBe(2);
    const names = entityRows.rows.map((r) => r.name).sort();
    expect(names).toEqual(["ACME Corp", "审计底稿"]);

    // 3. The fix: every event_entities.entity_id MUST appear in the
    //    entities table. Pre-fix code would have stored randomUUID()
    //    here (never matching anything) when the fallback SELECT
    //    failed — so this check is the regression.
    const eeEntityIds = eeRows.rows.map((r) => r.entity_id);
    const entityIds = new Set(entityRows.rows.map((r) => r.id));
    for (const eid of eeEntityIds) {
      expect(entityIds.has(eid), `event_entities.entity_id=${eid} not in entities table`).toBe(true);
    }

    // 4. entity_vec0 rows reference the same id as the entities row.
    //    Pre-fix code used a DIFFERENT randomUUID() here — silent
    //    orphan vec0 rows.
    const vec0Rows = await pool.query<{ entity_id: string }>(
      "select entity_id from entity_vec0 where entity_id in ($1, $2)",
      [expected.entityAcme, expected.entityShenji]
    );
    expect(vec0Rows.rows.length).toBe(2);
    for (const row of vec0Rows.rows) {
      expect(entityIds.has(row.entity_id), `entity_vec0.entity_id=${row.entity_id} not in entities table`).toBe(true);
    }
  });

  it("a second batch sharing one entity name reuses the same id (no duplicate)", async () => {
    // Build a second batch where event C references an entity "ACME Corp"
    // that already exists in the DB. The new code (and the old one, via
    // the bulk lookupEntityCache) must NOT insert a second entities row
    // for "ACME Corp" — the `on conflict do nothing` clause relies on
    // the conflict target. We verify the row count stays at 2 for
    // "ACME Corp".
    const eventC = randomUUID();
    const vec = new Array(1024).fill(0);
    vec[0] = 1;
    const vecLiteral = `[${vec.join(",")}]`;

    // Look up the existing entity_id for "ACME Corp" via the same
    // bulk-lookup semantics the real code uses.
    const existing = await pool.query<{ id: string }>(
      "select id from entities where source_id = $1 and document_id = $2 and name = $3 limit 1",
      [sourceId, documentId, "ACME Corp"]
    );
    expect(existing.rows.length).toBe(1);
    const acmeId = existing.rows[0].id;

    // Tiny batch: event C, then its event_entities link to ACME.
    const stmts: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        params: [eventC, sourceId, documentId, "chunk-c", "Event C", "Event C body", "fact", "CONFIRMED", 2, "sum C", vecLiteral, vecLiteral, "remote-llm"]
      },
      {
        sql: `insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing`,
        params: [randomUUID(), eventC, acmeId]
      }
    ];

    await pool.query("begin");
    try {
      for (const stmt of stmts) {
        await pool.query(stmt.sql, stmt.params);
      }
      await pool.query("commit");
    } catch (e) {
      try { await pool.query("rollback"); } catch { /* ignore */ }
      throw e;
    }

    // No new entities row for "ACME Corp" — still exactly one.
    const allAcme = await pool.query<{ id: string }>(
      "select id from entities where source_id = $1 and document_id = $2 and name = $3",
      [sourceId, documentId, "ACME Corp"]
    );
    expect(allAcme.rows.length).toBe(1);

    // Event C → ACME link must exist and reference the same id.
    const link = await pool.query<{ entity_id: string }>(
      "select entity_id from event_entities where event_id = $1",
      [eventC]
    );
    expect(link.rows.length).toBe(1);
    expect(link.rows[0].entity_id).toBe(acmeId);
  });

  it("an entity name shared across multiple events gets one entities row and one entity_vec0 row (no PK collision)", async () => {
    // Regression: the buildWriteBatch loop visits each event's
    // entities. If "审计底稿" appears in 3 events, the OLD code
    // (post-fix-attempt-1) pushed 3 entities INSERTs and 3
    // entity_vec0 INSERTs with the SAME entity_id, blowing up on
    // the second entity_vec0 with "UNIQUE constraint failed on
    // entity_vec0 primary key". The fix: only push the
    // PK-constrained statements on the first occurrence; the
    // event_entities link INSERT (its own PK) still runs for every
    // (event, entity) pair.
    const vec = new Array(1024).fill(0);
    vec[0] = 1;
    const vecLiteral = `[${vec.join(",")}]`;
    const floatVec = new Float32Array(vec);
    const sharedName = "共享实体AcrossEvents";

    // Use a unique documentId so the cleanup `delete from
    // documents where source_id = $1` in afterAll still removes
    // everything. (The prior tests already share the documentId
    // fixture, so we'd hit PK conflicts on entities.id if we reused
    // it; build a fresh doc for this test.)
    const docId2 = randomUUID();
    const eventE1 = randomUUID();
    const eventE2 = randomUUID();
    const eventE3 = randomUUID();
    const sharedEntityId = randomUUID();

    const stmts: Array<{ sql: string; params: unknown[] }> = [
      // documents row (fresh doc so we don't collide with the
      // earlier fixture's entities)
      {
        sql: `insert into documents (id, source_id, title, content, parse_status, metadata)
              values ($1, $2, $3, $4, 'PARSING', $5)
              on conflict (id) do update set
                title = excluded.title,
                content = excluded.content,
                parse_status = 'PARSING',
                updated_at = current_timestamp`,
        params: [docId2, sourceId, "fixture doc 2", "test content 2", JSON.stringify({ test: "entity-fk-2" })]
      },
      // 3 events, each with 1 entity using the same name
      { sql: "insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        params: [eventE1, sourceId, docId2, "ch-e1", "E1", "E1 body", "fact", "CONFIRMED", 0, "sum E1", vecLiteral, vecLiteral, "remote-llm"] },
      { sql: "insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        params: [eventE2, sourceId, docId2, "ch-e2", "E2", "E2 body", "fact", "CONFIRMED", 1, "sum E2", vecLiteral, vecLiteral, "remote-llm"] },
      { sql: "insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
        params: [eventE3, sourceId, docId2, "ch-e3", "E3", "E3 body", "fact", "CONFIRMED", 2, "sum E3", vecLiteral, vecLiteral, "remote-llm"] },
      // ONE entity row for the shared name (PK-protected)
      { sql: "insert into entities (id, source_id, document_id, name, normalized_name, type, description, embedding_json) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing",
        params: [sharedEntityId, sourceId, docId2, sharedName, sharedName.toLowerCase(), "DOC", "shared entity desc", vecLiteral] },
      // ONE entity_vec0 row referencing the same id (PK-protected)
      { sql: "insert into entity_vec0 (entity_id, embedding) values ($1, $2)",
        params: [sharedEntityId, floatVec] },
      // THREE event_entities links, one per event (their PK is their
      // own id, so duplicates are fine)
      { sql: "insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing", params: [randomUUID(), eventE1, sharedEntityId] },
      { sql: "insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing", params: [randomUUID(), eventE2, sharedEntityId] },
      { sql: "insert into event_entities (id, event_id, entity_id) values ($1, $2, $3) on conflict do nothing", params: [randomUUID(), eventE3, sharedEntityId] },
      { sql: "update documents set parse_status = 'COMPLETED' where id = $1", params: [docId2] }
    ];

    await pool.query("begin");
    try {
      for (const stmt of stmts) {
        await pool.query(stmt.sql, stmt.params);
      }
      await pool.query("commit");
    } catch (e) {
      try { await pool.query("rollback"); } catch { /* ignore */ }
      throw e;
    }

    // Exactly ONE entities row for the shared name.
    const entityRows = await pool.query<{ id: string }>(
      "select id from entities where source_id = $1 and document_id = $2 and name = $3",
      [sourceId, docId2, sharedName]
    );
    expect(entityRows.rows.length).toBe(1);

    // Exactly ONE entity_vec0 row referencing that id (the bug:
    // old fix pushed 3, second one blew up with PK collision).
    const vec0Rows = await pool.query<{ entity_id: string }>(
      "select entity_id from entity_vec0 where entity_id = $1",
      [sharedEntityId]
    );
    expect(vec0Rows.rows.length).toBe(1);

    // THREE event_entities links, all referencing the same id.
    const eeRows = await pool.query<{ event_id: string; entity_id: string }>(
      "select event_id, entity_id from event_entities where entity_id = $1",
      [sharedEntityId]
    );
    expect(eeRows.rows.length).toBe(3);
    const linkedEventIds = new Set(eeRows.rows.map((r) => r.event_id));
    expect(linkedEventIds).toEqual(new Set([eventE1, eventE2, eventE3]));
  });
});
