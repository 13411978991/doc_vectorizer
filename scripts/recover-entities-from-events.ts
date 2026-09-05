/**
 * Recovery: rebuild `entities` and `event_entities` from `events` content.
 *
 * Why this exists: the reembed-all script used `delete from entities` and
 * SQLite's `ON DELETE CASCADE` then wiped `event_entities` (its
 * entity_id FK points at entities.id). Both are now empty.
 *
 * Strategy:
 *   - For each event, scan its title/content/summary for entity candidates
 *     by matching against coarse regex patterns.
 *   - For each candidate, insert a row into entities (skipping duplicates
 *     by `source_id + normalized_name`).
 *   - Insert into event_entities to restore the relations.
 *
 * The recovered entities are a *coarse* approximation of the originals.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const DB_PATH = "/home/admin/.openclaw/workspace/SAG/data/sag.db";

interface EventRow {
  id: string;
  source_id: string;
  document_id: string | null;
  title: string;
  content: string | null;
  summary: string | null;
}

// Heuristic patterns
const COMPANY_RE = /[\u4e00-\u9fff]{2,12}(?:公司|科技|集团|银行|控股|投资|有限|股份|企业|实业|电子|网络|信息|数据|资本)/g;
const PRODUCT_RE = /[\u4e00-\u9fff]{2,12}(?:平台|系统|产品|服务|方案|应用|工具|模块|引擎|框架)/g;
const PERSON_RE = /[\u4e00-\u9fff]{2,4}(?:先生|女士|总监|经理|总裁|CEO|CTO|CFO)/g;
const DOCUMENT_RE = /[\u4e00-\u9fffA-Za-z0-9]{2,30}(?:报告|报告书|清单|方案|合同|书|白皮书|文档|汇总|对比)/g;

const PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: "company", re: COMPANY_RE },
  { type: "product", re: PRODUCT_RE },
  { type: "person", re: PERSON_RE },
  { type: "document", re: DOCUMENT_RE }
];

function extractEntities(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const { type, re } of PATTERNS) {
    const matches = text.match(re);
    if (!matches) continue;
    for (const m of matches) {
      const trimmed = m.trim();
      if (trimmed.length < 2) continue;
      if (!found.has(trimmed)) found.set(trimmed, type);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");

  const events = db
    .prepare(
      `select id, source_id, document_id, title, content, summary
       from events where deleted_at is null`
    )
    .all() as EventRow[];

  console.log(`[recover] ${events.length} events to scan`);

  // Valid source_ids — skip events whose source_id doesn't exist in sources
  const validSourceIds = new Set<string>(
    (db.prepare(`select id from sources`).all() as Array<{ id: string }>).map((r) => r.id)
  );
  console.log(`[recover] valid source_ids: ${validSourceIds.size}`);

  // Valid document_ids
  const validDocIds = new Set<string>(
    (db.prepare(`select id from documents`).all() as Array<{ id: string }>).map((r) => r.id)
  );

  // Pre-warm entity cache
  const entityByKey = new Map<string, string>();
  for (const row of db
    .prepare(`select id, source_id, normalized_name from entities`)
    .all() as Array<{ id: string; source_id: string; normalized_name: string }>) {
    entityByKey.set(`${row.source_id}::${row.normalized_name}`, row.id);
  }
  console.log(`[recover] pre-existing entities: ${entityByKey.size}`);

  const insertEntity = db.prepare(
    `insert into entities (id, source_id, document_id, entity_type_id, name, normalized_name, type, metadata, description, embedding_json)
     values (?, ?, ?, ?, ?, ?, ?, '{}', null, null)`
  );
  const findEntity = db.prepare(
    `select id from entities where source_id = ? and normalized_name = ? limit 1`
  );
  const linkEntity = db.prepare(
    `insert into event_entities (id, event_id, entity_id) values (?, ?, ?)`
  );

  let entityCount = 0;
  let relationCount = 0;
  let skippedNoSource = 0;

  const ensureEntity = (
    name: string,
    type: string,
    sourceId: string,
    documentId: string | null
  ): string | null => {
    // If source_id is not valid, use NULL — entity can exist without a source
    const safeSourceId = validSourceIds.has(sourceId) ? sourceId : null;
    const normalized = name.toLowerCase().replace(/\s+/g, "").trim();
    const key = `${safeSourceId ?? "null"}::${normalized}`;
    let id = entityByKey.get(key);
    if (id) return id;
    const existing = safeSourceId
      ? (findEntity.get(safeSourceId, normalized) as { id: string } | undefined)
      : undefined;
    if (existing) {
      entityByKey.set(key, existing.id);
      return existing.id;
    }
    id = `ent-${randomUUID()}`;
    insertEntity.run(
      id,
      safeSourceId,
      documentId && validDocIds.has(documentId) ? documentId : null,
      null,
      name,
      normalized,
      type
    );
    entityByKey.set(key, id);
    entityCount += 1;
    return id;
  };

  const tx = db.transaction(() => {
    for (const ev of events) {
      // Skip events whose source_id doesn't exist in sources table
      if (!validSourceIds.has(ev.source_id)) {
        skippedNoSource += 1;
        continue;
      }
      const blob = `${ev.title}\n${ev.content ?? ""}\n${ev.summary ?? ""}`;
      const found = extractEntities(blob);
      for (const [name, etype] of found) {
        const entityId = ensureEntity(name, etype, ev.source_id, ev.document_id);
        if (!entityId) continue;
        linkEntity.run(`ee-${randomUUID()}`, ev.id, entityId);
        relationCount += 1;
      }
    }
  });
  tx();

  const stats = db.prepare(
    `select (select count(*) from entities) as entities,
            (select count(*) from event_entities) as relations`
  ).get() as { entities: number; relations: number };

  console.log(`[recover] inserted entities:        ${entityCount}`);
  console.log(`[recover] inserted relations:       ${relationCount}`);
  console.log(`[recover] skipped (no source):      ${skippedNoSource}`);
  console.log(`[recover] entities total:           ${stats.entities}`);
  console.log(`[recover] event_entities total:     ${stats.relations}`);
  console.log(`[recover] DONE`);
}

main().catch((err: unknown) => {
  console.error("[recover] FAILED:", err);
  process.exit(1);
});
