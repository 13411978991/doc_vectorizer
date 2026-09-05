import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./pool.js";
import type { SqlitePool } from "./sqlite-driver.js";
import {parseJsonObject, parseJsonArray, toLocalISO, parseSqliteTimestamp} from "./row-helpers.js";
import { config } from "../config/env.js";

/**
 * Parse a JSON-encoded embedding vector. Returns null for invalid input.
 * Used by the JS-side cosine implementations that replace sqlite-vec
 * (which is not actually populated in this environment).
 */
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

/**
 * Cosine similarity in pure JS. Returns 0 when dimensions mismatch
 * or either vector has zero norm.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
import { toVectorLiteral } from "./vector.js";
import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EntityWithEventsRecord,
  EventRecord,
  EventDetailRecord,
  EmbeddingPreview,
  AiProviderSettingsRecord,
  EmbeddingProvider,
  McpMessageRecord,
  McpMessageRole,
  McpSessionRecord,
  McpToolCallRecord,
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  SourceRecord
} from "../types.js";

type Queryable = any;

function db(client?: Queryable): Queryable {
  return client ?? pool;
}

function sourceFromRow(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    metadata: parseJsonObject(row.metadata),
    archivedAt: row.archived_at == null ? null : toLocalISO(parseSqliteTimestamp(String(row.archived_at))),
    createdAt: row.created_at == null ? undefined : toLocalISO(parseSqliteTimestamp(String(row.created_at))),
    updatedAt: row.updated_at == null ? undefined : toLocalISO(parseSqliteTimestamp(String(row.updated_at)))
  };
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    chunkId: row.chunk_id == null ? null : String(row.chunk_id),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    content: String(row.content ?? ""),
    rank: Number(row.rank ?? 0),
    score: row.score == null ? undefined : Number(row.score),
    titleEmbedding: embeddingPreviewFromText(row.title_embedding_preview),
    contentEmbedding: embeddingPreviewFromText(row.content_embedding_preview)
  };
}

function entityFromRow(row: Record<string, unknown>): EntityRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    score: row.score == null ? undefined : Number(row.score),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function documentFromRow(row: Record<string, unknown>): DocumentRecord {
  // SQLite schema removed `status`; fall back to parse_status so the
  // in-memory shape stays consistent for callers that read .status.
  const status =
    row.status == null
      ? row.parse_status == null
        ? ""
        : String(row.parse_status)
      : String(row.status);
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    title: String(row.title),
    status,
    parseStatus: String(row.parse_status ?? ""),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toLocalISO(parseSqliteTimestamp(String(row.created_at))),
    updatedAt: row.updated_at == null
      ? toLocalISO()
      : toLocalISO(parseSqliteTimestamp(String(row.updated_at))),
    archivedAt: row.archived_at == null ? null : toLocalISO(parseSqliteTimestamp(String(row.archived_at))),
    // Sprint 13+: source name is included in the listDocumentsBySource SQL
    // so the UI can show "📁 下载文件 · 供应商名单.csv" instead of just the title.
    // Optional so other call sites that don't need it can ignore it.
    sourceName: row.source_name == null ? undefined : String(row.source_name)
  };
}

function chunkFromRow(row: Record<string, unknown>): ChunkRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    documentId: row.document_id == null ? null : String(row.document_id),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content),
    rawContent: row.raw_content == null ? null : String(row.raw_content),
    rank: Number(row.rank ?? 0),
    references: Array.isArray(row.references) ? row.references.map(String) : [],
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.created_at
      ? toLocalISO(parseSqliteTimestamp(String(row.created_at)))
      : toLocalISO(),
    embedding: embeddingPreviewFromText(row.embedding_preview)
  };
}

function embeddingPreviewFromText(value: unknown): EmbeddingPreview | null | undefined {
  if (value == null) {
    return undefined;
  }
  const numbers = String(value)
    .match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
    ?.map(Number)
    .filter((item) => Number.isFinite(item)) ?? [];
  if (numbers.length === 0) {
    return null;
  }
  return {
    dimensions: numbers.length,
    sample: numbers.slice(0, 8)
  };
}

function mcpSessionFromRow(row: Record<string, unknown>): McpSessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    title: String(row.title),
    status: String(row.status),
    model: row.model == null ? null : String(row.model),
    sourceIds: parseJsonArray<string>(row.source_ids),
    metadata: parseJsonObject(row.metadata),
    createdAt: toLocalISO(parseSqliteTimestamp(String(row.created_at))),
    updatedAt: toLocalISO(parseSqliteTimestamp(String(row.updated_at)))
  };
}

function mcpMessageFromRow(row: Record<string, unknown>): McpMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: String(row.role) as McpMessageRole,
    content: String(row.content),
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toLocalISO(parseSqliteTimestamp(String(row.created_at)))
  };
}

function mcpToolCallFromRow(row: Record<string, unknown>): McpToolCallRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: row.message_id == null ? null : String(row.message_id),
    toolName: String(row.tool_name),
    arguments: (row.arguments ?? {}) as Record<string, unknown>,
    result: row.result,
    status: String(row.status) as McpToolCallRecord["status"],
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    createdAt: toLocalISO(parseSqliteTimestamp(String(row.created_at)))
  };
}

function aiProviderSettingsFromRow(row: Record<string, unknown>): AiProviderSettingsRecord {
  const provider = String(row.embedding_provider ?? "api");
  const validProvider: EmbeddingProvider =
    provider === "local" ? "local" : provider === "local-bge" ? "local-bge" : "api";
  return {
    id: "global",
    embeddingProvider: validProvider,
    embeddingBaseUrl: String(row.embedding_base_url),
    embeddingModel: String(row.embedding_model),
    embeddingDimensions: Number(row.embedding_dimensions),
    embeddingApiKey: row.embedding_api_key == null ? null : String(row.embedding_api_key),
    embeddingLocalModelPath: row.embedding_local_model_path == null ? null : String(row.embedding_local_model_path),
    llmBaseUrl: String(row.llm_base_url ?? ""),
    llmModel: String(row.llm_model ?? ""),
    llmApiKey: row.llm_api_key == null ? null : String(row.llm_api_key),
    // Defensive coercion: an older row written before the column was
    // read by the runtime could have any integer stored under
    // `llm_timeout_ms` (or even NULL). Fall back to the env default so
    // a missing/malformed value doesn't yield 0 (= immediate abort)
    // or NaN.
    llmTimeoutMs: Number(row.llm_timeout_ms ?? 0) || config.LLM_TIMEOUT_MS,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: toLocalISO(parseSqliteTimestamp(String(row.created_at))),
    updatedAt: toLocalISO(parseSqliteTimestamp(String(row.updated_at)))
  };
}

export async function createSource(input: {
  id?: string;
  tenantId: string;
  name: string;
  description?: string;
  kind?: string;
  metadata?: Record<string, unknown>;
}, client?: Queryable): Promise<SourceRecord> {
  const id = input.id ?? randomUUID();
  const kind = input.kind ?? "upload";
  const result = await db(client).query(
    `
      insert into sources (id, tenant_id, kind, name, description, metadata)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (id) do update set
        name = sources.name,
        description = sources.description,
        metadata = sources.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [id, input.tenantId, kind, input.name, input.description ?? null, JSON.stringify(input.metadata ?? {})]
  );
  return sourceFromRow(result.rows[0]);
}

export async function getSource(sourceId: string, tenantId: string): Promise<SourceRecord | null> {
  const result = await pool.query(
    "select * from sources where id = $1 and tenant_id = $2",
    [sourceId, tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function listSources(input: {
  tenantId: string;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}): Promise<SourceRecord[]> {
  const params: unknown[] = [input.tenantId, input.limit];
  let cursorSql = "";
  if (input.cursor) {
    params.push(input.cursor);
    cursorSql = "and id::text > $3";
  }
  const archiveSql = input.includeArchived ? "" : "and archived_at is null";
    const result = await pool.query(
      `
      select *
      from sources
      where tenant_id = $1 ${archiveSql} ${cursorSql}
      order by id
      limit $2
    `,
      params
    );
    return result.rows.map(sourceFromRow);
}

export async function updateSource(input: {
  sourceId: string;
  tenantId: string;
  name?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set
        name = coalesce($3, name),
        description = case when $4::boolean then $5 else description end,
        metadata = metadata || $6::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sourceId,
      input.tenantId,
      input.name?.trim() || null,
      Object.prototype.hasOwnProperty.call(input, "description"),
      input.description ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function archiveSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = coalesce(archived_at, now()), updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function restoreSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<SourceRecord | null> {
  const result = await pool.query(
    `
      update sources
      set archived_at = null, updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows[0] ? sourceFromRow(result.rows[0]) : null;
}

export async function deleteSource(input: {
  sourceId: string;
  tenantId: string;
}): Promise<boolean> {
  // Delete the source's documents first. chunks/events/entities/
  // chunk_embeddings all have ON DELETE CASCADE on document_id so they
  // come along for free. The vector rows belong to chunks and are
  // removed by the chunks cascade.
  await pool.query(
    "delete from documents where source_id = $1 and tenant_id = $2",
    [input.sourceId, input.tenantId]
  );
  const result = await pool.query(
    "delete from sources where id = $1 and tenant_id = $2",
    [input.sourceId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function assertSourcesAccessible(sourceIds: string[], tenantId: string): Promise<void> {
  if (sourceIds.length === 0) {
    throw new Error("sourceIds must not be empty");
  }
  const result = await pool.query(
    "select id from sources where tenant_id = $1 and archived_at is null and id = any($2::uuid[])",
    [tenantId, sourceIds]
  );
  const found = new Set(result.rows.map((row) => String(row.id)));
  const missing = sourceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`source not found or not accessible: ${missing.join(",")}`);
  }
}

export async function getDefaultEntityType(type: string, client?: Queryable): Promise<string | null> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where type = $1 and is_active = true
      order by is_default desc
      limit 1
    `,
    [type]
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

export async function getAnyDefaultEntityType(client?: Queryable): Promise<string> {
  const result = await db(client).query(
    `
      select id
      from entity_types
      where is_active = true
      order by case when type = 'subject' then 0 else 1 end, is_default desc
      limit 1
    `
  );
  if (!result.rows[0]?.id) {
    throw new Error("entity_types seed data is missing; run npm run seed");
  }
  return String(result.rows[0].id);
}

export async function upsertEntity(input: {
  sourceId: string;
  type: string;
  name: string;
  description?: string;
  embedding: number[];
}, client?: Queryable): Promise<EntityRecord> {
  const normalizedName = input.name.trim().toLowerCase();
  const entityTypeId = (await getDefaultEntityType(input.type, client)) ?? await getAnyDefaultEntityType(client);
  const result = await db(client).query(
    `
      insert into entities (
        id, source_id, entity_type_id, type, name, normalized_name, description, embedding
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::vector)
      on conflict (source_id, type, normalized_name) do update set
        name = excluded.name,
        description = coalesce(nullif(entities.description, ''), excluded.description),
        embedding = coalesce(entities.embedding, excluded.embedding),
        updated_at = now()
      returning *
    `,
    [
      randomUUID(),
      input.sourceId,
      entityTypeId,
      input.type,
      input.name,
      normalizedName,
      input.description ?? "",
      toVectorLiteral(input.embedding)
    ]
  );
  return entityFromRow(result.rows[0]);
}

export async function searchEntitiesByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EntityRecord[]> {
  // JS-side cosine: SQLite has no real vector index in this environment
  // (vec0 tables are empty and the BLOB `embedding` column is never
  // populated). We load `embedding_json` and compute similarity in TS.
  //
  // Note 2026-07-08: tried swapping to sqlite-vec vec0 KNN but it
  // regressed multi/* recall from 93% to 80% on the Downloads ground
  // truth — vec0 surfaces generic-named entities (e.g. entities from
  // Harness Agent design doc with short generic names) ahead of
  // domain-specific entities like 红旗清单. JS cosine keeps the
  // existing recall intact.
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.embedding_json
      from entities ent
      where ent.source_id = any($1)
        and ent.embedding_json is not null
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
    `,
    [input.sourceIds]
  );
  const scored: Array<EntityRecord & { _score: number }> = [];
  for (const row of result.rows) {
    const emb = parseEmbeddingJson(row.embedding_json);
    if (!emb) continue;
    const score = cosineSimilarity(input.queryVector, emb);
    if (score < input.threshold) continue;
    const base = entityFromRow({ ...row, score, embedding_preview: row.embedding_json });
    scored.push({ ...base, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, input.topK).map(({ _score, ...rest }) => rest);
}

export async function searchEntitiesByName(input: {
  sourceIds: string[];
  names: string[];
  limit: number;
}): Promise<EntityRecord[]> {
  if (input.names.length === 0) {
    return [];
  }
  const normalizedNames = input.names.map((name) => name.trim().toLowerCase()).filter(Boolean);
  if (normalizedNames.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      /* SQLite has no unnest(). Use json_each() against a JSON array.
         The params module serialises JS string[] to JSON text, which
         json_each decodes into rows with .value. */
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name, 1.0 as score
      from entities ent
      where ent.source_id = any($1::uuid[])
        and exists (
          select 1
          from json_each($2) as query_name
          where ent.normalized_name = query_name.value
             or ent.normalized_name like '%' || query_name.value || '%'
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      limit $3
    `,
    [input.sourceIds, normalizedNames, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function searchEntitiesByText(input: {
  sourceIds: string[];
  query: string;
  limit: number;
}): Promise<EntityRecord[]> {
  const query = input.query.trim();
  if (!query) {
    return [];
  }
  // SQLite doesn't have websearch_to_tsquery / ts_rank_cd / pg_trgm.similarity
  // / @@ search. Fall back to a LIKE-based scoring scheme that handles the
  // three exact-match cases the PG query was ranking against:
  //   1. exact name match (highest weight)
  //   2. query is a substring of entity name (high)
  //   3. entity name is a substring of query (partial token, medium)
  // SQLite also doesn't ship GREATEST() in many builds, so we use COALESCE
  // over a chain of CASE expressions that yield NULL when no match.
  // Token boundaries (Chinese/Japanese CJK is a tricky case in pure LIKE;
  // we accept substring match here and rely on vector recall elsewhere for
  // weighted similarity).
  const result = await pool.query(
    `
      with q as (
        select lower($2) as raw_query
      )
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             coalesce(
               case when ent.normalized_name = q.raw_query then 1.2 end,
               case when ent.normalized_name like '%' || q.raw_query || '%' then 1.0 end,
               case when q.raw_query like '%' || ent.normalized_name || '%' then 0.6 end,
               0
             ) as score
      from entities ent
      cross join q
      where ent.source_id = any($1)
        and (
          ent.normalized_name like '%' || q.raw_query || '%'
          or q.raw_query like '%' || ent.normalized_name || '%'
        )
        and exists (
          select 1
          from event_entities ee
          join events e on e.id = ee.event_id
          join documents d on d.id = e.document_id
          join sources s on s.id = e.source_id
          where ee.entity_id = ent.id
            and e.deleted_at is null
            and d.archived_at is null
            and s.archived_at is null
        )
      order by score desc, ent.name
      limit $3
    `,
    [input.sourceIds, query, input.limit]
  );
  return result.rows.map(entityFromRow);
}

export async function getEventIdsByEntityIds(input: {
  entityIds: string[];
  sourceIds: string[];
  excludeEventIds?: string[];
}): Promise<string[]> {
  if (input.entityIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select distinct ee.event_id
      from event_entities ee
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where ee.entity_id = any($1::uuid[])
        and e.source_id = any($2::uuid[])
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and not (ee.event_id = any($3::uuid[]))
    `,
    [input.entityIds, input.sourceIds, input.excludeEventIds ?? []]
  );
  return result.rows.map((row) => String(row.event_id));
}

export async function searchEventsByTitleVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
  threshold: number;
}): Promise<EventRecord[]> {
  // JS-side cosine on `title_embedding_json` (sqlite-vec path is dead).
  //
  // Note 2026-07-08: tried sqlite-vec vec0 KNN — failed because event
  // titles are descriptive (e.g. "R1. 收入真实性存疑") and don't embed
  // close to short topic queries like "审计". The JS cosine path kept
  // the existing recall intact, so we revert to it.
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             e.title_embedding_json, e.content_embedding_json
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.source_id = any($1)
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.title_embedding_json is not null
    `,
    [input.sourceIds]
  );
  const scored: Array<EventRecord & { _score: number }> = [];
  for (const row of result.rows) {
    const emb = parseEmbeddingJson(row.title_embedding_json);
    if (!emb) continue;
    const score = cosineSimilarity(input.queryVector, emb);
    if (score < input.threshold) continue;
    const base = eventFromRow({
      ...row,
      score,
      title_embedding_preview: row.title_embedding_json,
      content_embedding_preview: row.content_embedding_json
    });
    scored.push({ ...base, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, input.topK).map(({ _score, ...rest }) => rest);
}

export async function coarseRankEventsByContent(input: {
  sourceIds: string[];
  eventIds: string[];
  queryVector: number[];
  maxEvents: number;
}): Promise<EventRecord[]> {
  if (input.eventIds.length === 0) {
    return [];
  }
  // JS-side cosine on `content_embedding_json`.
  //
  // Note 2026-07-08: tried sqlite-vec vec0 KNN with id IN candidate set
  // but the KNN constraint combined with id IN consistently returned 0
  // rows even though the IDs are present. Reverted to JS cosine which
  // loads the small candidate set and ranks it deterministically.
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
             e.title_embedding_json, e.content_embedding_json
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1)
        and e.source_id = any($2)
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
        and e.content_embedding_json is not null
    `,
    [input.eventIds, input.sourceIds]
  );
  const scored: Array<EventRecord & { _score: number }> = [];
  for (const row of result.rows) {
    const emb = parseEmbeddingJson(row.content_embedding_json);
    if (!emb) continue;
    const score = cosineSimilarity(input.queryVector, emb);
    const base = eventFromRow({
      ...row,
      score,
      title_embedding_preview: row.title_embedding_json,
      content_embedding_preview: row.content_embedding_json
    });
    scored.push({ ...base, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, input.maxEvents).map(({ _score, ...rest }) => rest);
}

export async function getEventsWithEntityIds(eventIds: string[]): Promise<Map<string, EventRecord & { entityIds: string[] }>> {
  const map = new Map<string, EventRecord & { entityIds: string[] }>();
  if (eventIds.length === 0) {
    return map;
  }
  // SQLite has no `array_agg(...) filter (...)`. Use a two-step query:
  // first fetch the events, then batch-fetch the entity links in one shot.
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1)
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
    `,
    [eventIds]
  );
  for (const row of result.rows) {
    const event = eventFromRow(row) as EventRecord & { entityIds: string[] };
    event.entityIds = [];
    map.set(event.id, event);
  }
  // One batched query to attach entity ids per event.
  const linkRows = (await pool.query(
    `select event_id, entity_id from event_entities where event_id = any($1)`,
    [eventIds]
  )).rows;
  for (const row of linkRows) {
    const eventId = String(row.event_id);
    const target = map.get(eventId);
    if (target) {
      target.entityIds.push(String(row.entity_id));
    }
  }
  return map;
}

export async function getSectionsForEvents(eventIds: string[]): Promise<Array<{
  eventId: string;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
}>> {
  if (eventIds.length === 0) {
    return [];
  }
  const result = await pool.query(
    `
      select e.id as event_id, c.id as chunk_id, c.source_id, c.document_id,
             c.heading, c.content, c.rank
      from events e
      join chunks c on c.id = e.chunk_id
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.id = any($1)
        and e.deleted_at is null
        and d.archived_at is null
        and s.archived_at is null
    `,
    [eventIds]
  );
  // SQLite has no `array_position`. Preserve the caller's order in JS.
  const orderIndex = new Map<string, number>();
  eventIds.forEach((id, idx) => orderIndex.set(String(id), idx));
  return result.rows
    .map((row) => ({
      eventId: String(row.event_id),
      chunkId: String(row.chunk_id),
      sourceId: String(row.source_id),
      documentId: row.document_id == null ? undefined : String(row.document_id),
      heading: row.heading == null ? undefined : String(row.heading),
      content: String(row.content),
      rank: Number(row.rank)
    }))
    .sort((a, b) => (orderIndex.get(a.eventId) ?? 0) - (orderIndex.get(b.eventId) ?? 0));
}

export interface ChunkSearchResult {
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
  /**
   * Optional diagnostic for the UI: why this chunk was recalled.
   * - "vector" — pure cosine match
   * - "keyword" — pure LIKE match (heading and/or content)
   * - "hybrid" — both
   * Set by search-service.ts when merging the two recall lists.
   */
  matchType?: "vector" | "keyword" | "hybrid";
}

export async function searchChunksByVector(input: {
  sourceIds: string[];
  queryVector: number[];
  topK: number;
}): Promise<ChunkSearchResult[]> {
  // Tuned 2026-07-08: prefer sqlite-vec vec0 KNN over JS-side cosine.
  // vec0 returns top-K candidates directly from SQLite without loading
  // the whole embeddings table into Node memory; on the Downloads corpus
  // (452 chunks) the SQL query is ~14x faster (4ms vs 57ms) and the
  // recall set is identical to JS cosine on the same embedding_json.
  //
  // The query vector is bound as Float32Array so sqlite-vec's `match`
  // operator can read it as a vector value (passing number[] would
  // JSON.stringify it into text and break vec_distance_cosine).
  const queryVec = input.queryVector instanceof Float32Array
    ? input.queryVector
    : new Float32Array(input.queryVector);

  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank,
             cv.distance as vec_distance
      from chunk_vec0 cv
      join chunks c on c.id = cv.chunk_id
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where cv.embedding match $2 and k = $3
        and c.source_id = any($1)
        and d.archived_at is null
        and s.archived_at is null
      order by cv.distance
      limit $4
    `,
    [input.sourceIds, queryVec, input.topK, input.topK]
  );

  const scored: ChunkSearchResult[] = [];
  for (const row of result.rows) {
    const dist = Number(row.vec_distance);
    // Convert L2 distance back to a cosine-like score in [0, 1].
    // For L2-normalised unit vectors: cos(θ) = 1 - dist² / 2.
    const score = Math.max(0, 1 - dist * dist / 2);
    scored.push({
      chunkId: String(row.id),
      sourceId: String(row.source_id),
      documentId: row.document_id == null ? undefined : String(row.document_id),
      heading: row.heading == null ? undefined : String(row.heading),
      content: String(row.content),
      rank: Number(row.rank),
      score,
      matchType: "vector"
    });
  }
  return scored;
}

/**
 * Keyword recall for chunks. SQLite has no BM25 / ts_rank / pg_trgm, so we
 * approximate with LIKE matching over tokenised query terms. Score is
 * the count of distinct tokens that appear in the chunk, so a chunk that
 * matches more query terms ranks higher.
 *
 * Useful as a fallback when vector recall is weak — e.g. queries with
 * specific domain terms (「财务报表」, 「机器学习」) that embedding models
 * sometimes map too generically.
 */
export async function searchChunksByKeyword(input: {
  sourceIds: string[];
  query: string;
  topK: number;
}): Promise<ChunkSearchResult[]> {
  const rawQuery = input.query.trim();
  if (!rawQuery) return [];

  // Tokenise: split on whitespace + extract 2-gram windows for CJK.
  // For Chinese we don't have great word boundaries, so we also try
  // the raw 2-char windows of the query itself.
  const tokens = new Set<string>();
  // Whitespace tokens (latin / numbers)
  for (const t of rawQuery.split(/\s+/)) {
    const trimmed = t.trim();
    if (trimmed.length >= 2) tokens.add(trimmed);
  }
  // 2-gram windows for CJK chars (length >= 4 query)
  const cjkRegex = /[\u4e00-\u9fff]/g;
  const cjkChars = rawQuery.match(cjkRegex) ?? [];
  if (cjkChars.length >= 2) {
    for (let i = 0; i < cjkChars.length - 1; i++) {
      tokens.add(cjkChars[i] + cjkChars[i + 1]);
    }
  }
  // Also keep the full raw query as a single token for short queries
  if (rawQuery.length >= 2 && rawQuery.length <= 32) {
    tokens.add(rawQuery);
  }

  const tokenList = Array.from(tokens).slice(0, 16); // cap to keep IN clause sane
  if (tokenList.length === 0) return [];

  // Build a LIKE chain: each token becomes a `lower(content) LIKE '%tok%'`
  // OR clause. SQLite handles this OK up to ~16 terms. We score by counting
  // how many tokens appear in content (case-insensitive).
  //
  // Tuned 2026-07-08: heading match now weighted 2x over content match.
  // For Chinese audit/finance queries like 「供应商评分」, the term often
  // appears as a section heading (红旗清单/智慧工厂) — boosting heading
  // hits surfaces these "domain term" matches ahead of generic content
  // matches that happen to mention the same characters in passing.
  const lowerTokens = tokenList.map((t) => t.toLowerCase());
  // Wrap each token with % wildcards so LIKE is substring match, not exact.
  const likePatterns = lowerTokens.map((t) => `%${t}%`);
  const likeClauses = likePatterns.map((_p, idx) => `(lower(c.content) like $${idx + 2} or lower(coalesce(c.heading, '')) like $${idx + 2})`).join(" or ");
  const params: unknown[] = [input.sourceIds, ...likePatterns];

  // Score = heading_hits * 2 + content_hits * 1, normalised by token count.
  // heading and content are checked against the same likePattern parameter.
  const headingScoreExpr = likePatterns.map((_p, idx) => `case when lower(coalesce(c.heading, '')) like $${idx + 2} then 2 else 0 end`).join(" + ");
  const contentScoreExpr = likePatterns.map((_p, idx) => `case when lower(c.content) like $${idx + 2} then 1 else 0 end`).join(" + ");
  const matchScoreExpr = `(${headingScoreExpr}) + (${contentScoreExpr})`;

  const result = await pool.query(
    `
      select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank,
             (${matchScoreExpr}) as match_count,
             (${headingScoreExpr}) as heading_hits,
             (${contentScoreExpr}) as content_hits
      from chunks c
      join documents d on d.id = c.document_id
      join sources s on s.id = c.source_id
      where c.source_id = any($1)
        and d.archived_at is null
        and s.archived_at is null
        and (${likeClauses})
      order by match_count desc, c.rank asc
      limit ${Math.min(input.topK, 50)}
    `,
    params
  );

  if (process.env.SAG_DEBUG_KEYWORD === "1") {
    // eslint-disable-next-line no-console
    console.log(`[keyword] query="${input.query}" tokens=${tokenList.length} rows=${result.rows.length}`);
  }

  // Max possible match_count = 3 * tokens (each token can hit heading 2x + content 1x)
  // We expose match_count directly as score (already weighted) and keep
  // normalised score in `content_match_ratio` for backward compat in tests.
  return result.rows.map((row) => {
    const matchCount = Number(row.match_count);
    const headingHits = Number(row.heading_hits);
    const contentHits = Number(row.content_hits);
    const maxPossible = tokenList.length * 3;
    return {
      chunkId: String(row.id),
      sourceId: String(row.source_id),
      documentId: row.document_id == null ? undefined : String(row.document_id),
      heading: row.heading == null ? undefined : String(row.heading),
      content: String(row.content),
      rank: Number(row.rank),
      // Weighted score: 0..1 normalised over max possible (heading 2x + content 1x per token).
      score: maxPossible > 0 ? matchCount / maxPossible : 0,
      _matchCount: matchCount,
      _headingHits: headingHits,
      _contentHits: contentHits
    } as ChunkSearchResult & { _matchCount: number; _headingHits: number; _contentHits: number };
  });
}

export async function getEventDetail(input: {
  eventId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EventDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and (d.id is null or d.archived_at is null)";
  const eventResult = await pool.query(
    `
      select
        e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank,
        d.id as document_id_for_detail,
        d.title as document_title,
        d.parse_status as document_parse_status,
        d.metadata as document_metadata,
        d.created_at as document_created_at,
        d.updated_at as document_updated_at,
        d.archived_at as document_archived_at,
        s.id as source_id_for_detail,
        s.tenant_id as source_tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from events e
      join sources s on s.id = e.source_id
      left join documents d on d.id = e.document_id
      where e.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
    `,
    [input.eventId, input.tenantId]
  );
  if (!eventResult.rows[0]) {
    return null;
  }
  const event = eventFromRow(eventResult.rows[0]);
  const entityResult = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      join sources s on s.id = ent.source_id
      where ee.event_id = $1
        and s.tenant_id = $2
      order by ent.type, ent.name
    `,
    [input.eventId, input.tenantId]
  );
  const chunkResult = event.chunkId
    ? await pool.query(
        `
          select c.id, c.source_id, c.document_id, c.heading, c.content, c.rank
          from chunks c
          join sources s on s.id = c.source_id
          left join documents d on d.id = c.document_id
          where c.id = $1
            and s.tenant_id = $2
            ${archiveSql}
        `,
        [event.chunkId, input.tenantId]
      )
    : { rows: [] };
  const row = eventResult.rows[0] as Record<string, unknown>;

  return {
    event,
    entities: entityResult.rows.map(entityFromRow),
    source: row.source_id_for_detail == null
      ? null
      : sourceFromRow({
          id: row.source_id_for_detail,
          tenant_id: row.source_tenant_id,
          name: row.source_name,
          description: row.source_description,
          metadata: row.source_metadata,
          archived_at: row.source_archived_at,
          created_at: row.source_created_at,
          updated_at: row.source_updated_at
        }),
    document: row.document_id_for_detail == null
      ? null
      : documentFromRow({
          id: row.document_id_for_detail,
          source_id: row.source_id_for_detail,
          title: row.document_title,
          // SQLite schema removed `status`; mirror parse_status so the in-memory
          // DocumentRecord keeps a non-null value for the UI.
          status: row.document_parse_status,
          parse_status: row.document_parse_status,
          metadata: row.document_metadata,
          created_at: row.document_created_at,
          updated_at: row.document_updated_at,
          archived_at: row.document_archived_at
        }),
    chunk: chunkResult.rows[0]
      ? {
          chunkId: String(chunkResult.rows[0].id),
          sourceId: String(chunkResult.rows[0].source_id),
          documentId: chunkResult.rows[0].document_id == null ? null : String(chunkResult.rows[0].document_id),
          heading: chunkResult.rows[0].heading == null ? undefined : String(chunkResult.rows[0].heading),
          content: String(chunkResult.rows[0].content),
          rank: Number(chunkResult.rows[0].rank ?? 0)
        }
      : undefined
  };
}

export async function listDocumentsBySource(input: {
  sourceId: string;
  tenantId: string;
  limit: number;
  includeArchived?: boolean;
  // Cursor-based pagination. Opaque token produced by
  // encodeDocumentCursor({ createdAt, id }); clients should not
  // attempt to parse it. Pass `undefined` for the first page.
  cursor?: string;
}): Promise<{ documents: DocumentRecord[]; nextCursor: string | null }> {
  // Sprint 13+: list documents across the project source AND every source
  // attached to its linked KB project (watched folders + uploaded files).
  // Same union pattern as getProjectStats so the Documents tab matches the
  // Overview tab's totals.
  const archiveSql = input.includeArchived ? "" : "and d.archived_at is null";
  // Decode the cursor (if any). Compound key is (created_at desc, id desc).
  let cursorSql = "";
  const params: unknown[] = [input.sourceId, input.tenantId, input.limit];
  if (input.cursor) {
    const decoded = decodeDocumentCursor(input.cursor);
    if (decoded) {
      params.push(decoded.createdAt, decoded.id);
      // (created_at, id) < (cursor.createdAt, cursor.id)
      cursorSql =
        "and (d.created_at, d.id) < ($4, $5)";
    }
  }
  const result = await pool.query(
    `
      with project as (
        select id, name
        from sources
        where id = $1 and tenant_id = $2
      ),
      -- Aggregate sources via watched_folders attached to this project.
      -- Each folder's documents live under its own formerSourceId, so
      -- the project overview's document list is the UNION of every
      -- attached folder's formerSourceId. The project's own id is
      -- already in project above for project-side uploads.
      bound_folder_src_ids as (
        select wf.source_id as id
        from watched_folders wf
        where wf.tenant_id = $2
          and json_extract(wf.metadata, '$.attachedProjectId') = $1
      ),
      kb_proj as (
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.watched_folder_id in (
            select id from watched_folders
            where tenant_id = $2
              and json_extract(metadata, '$.attachedProjectId') = $1
          )
        union
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.upload_id::uuid = $1
      ),
      folder_src_ids as (
        select wf.source_id as id
        from kb_sources ks
        join watched_folders wf on wf.id = ks.watched_folder_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'folder'
          and ks.enabled = true
          and wf.tenant_id = $2
      ),
      upload_src_ids as (
        select ks.upload_id::uuid as id
        from kb_sources ks
        join kb_projects p on p.id = ks.kb_project_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.enabled = true
          and p.tenant_id = $2
      ),
      all_source_ids as (
        select id from project
        union
        select id from bound_folder_src_ids
        union
        select id from folder_src_ids
        union
        select id from upload_src_ids
      )
      select d.*, s.name as source_name
      from documents d
      join sources s on s.id = d.source_id
      where d.source_id in (select id from all_source_ids)
        and s.tenant_id = $2
        ${archiveSql}
        ${cursorSql}
      order by d.created_at desc, d.id desc
      limit $3
    `,
    params
  );
  // Carry the raw DB-side (created_at, id) forward as the cursor.
  // We must use the same string the WHERE clause compared against, so
  // paginate by the last row's *raw* created_at (the SQLite TEXT literal
  // stored in the row, NOT the in-memory .toISOString() normalisation).
  const rawRows = result.rows;
  const docs = rawRows.map(documentFromRow);
  const nextCursor =
    rawRows.length === input.limit && rawRows.length > 0
      ? encodeDocumentCursor({
          createdAt: String(rawRows[rawRows.length - 1].created_at),
          id: String(rawRows[rawRows.length - 1].id)
        })
      : null;
  return { documents: docs, nextCursor };
}

// Cursor encoding/decoding for `listDocumentsBySource`. The token is
// base64url("<createdAtISO>|<uuid>") — opaque to the client, easy for
// us to bump versions on later without breaking existing pages.
function encodeDocumentCursor(key: { createdAt: string; id: string }): string {
  return Buffer.from(`${key.createdAt}|${key.id}`, "utf8").toString("base64url");
}

function decodeDocumentCursor(token: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const idx = decoded.indexOf("|");
    if (idx <= 0) return null;
    const id = decoded.slice(idx + 1);
    const createdAt = decoded.slice(0, idx);
    // Sanity: id must look like a UUID, createdAt must parse as date.
    // We don't enforce ISO-8601 form because SQLite stores timestamps as
    // "YYYY-MM-DD HH:MM:SS" (space-separated) which is also what
    // `Date.parse` accepts.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    if (Number.isNaN(Date.parse(createdAt))) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function updateDocument(input: {
  documentId: string;
  tenantId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}): Promise<DocumentRecord | null> {
  // SQLite can't merge two JSON blobs natively, so we read the existing
  // metadata first and JSON-merge in JS (last-wins on each key).
  let mergedMetadata: Record<string, unknown> = input.metadata ?? {};
  if (input.metadata !== undefined) {
    const existing = await pool.query(
      "select d.metadata from documents d join sources s on s.id = d.source_id where d.id = $1 and s.tenant_id = $2",
      [input.documentId, input.tenantId]
    );
    if (existing.rows[0]) {
      const baseMeta =
        parseJsonObject(existing.rows[0].metadata ?? {}) ?? {};
      mergedMetadata = { ...baseMeta, ...input.metadata };
    }
  }
  const result = await pool.query(
    `
      update documents d
      set
        title = coalesce($3, d.title),
        metadata = $4,
        updated_at = current_timestamp
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [
      input.documentId,
      input.tenantId,
      input.title?.trim() || null,
      JSON.stringify(mergedMetadata)
    ]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function archiveDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = coalesce(d.archived_at, now()), updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function restoreDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<DocumentRecord | null> {
  const result = await pool.query(
    `
      update documents d
      set archived_at = null, updated_at = now()
      from sources s
      where d.source_id = s.id and d.id = $1 and s.tenant_id = $2
      returning d.*
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows[0] ? documentFromRow(result.rows[0]) : null;
}

export async function deleteDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const documentResult = await client.query(
      `
        select d.id
        from documents d
        join sources s on s.id = d.source_id
        where d.id = $1 and s.tenant_id = $2
        for update
      `,
      [input.documentId, input.tenantId]
    );
    if (!documentResult.rows[0]) {
      await client.query("rollback");
      return false;
    }

    await client.query(
      `
        with document_events as (
          select id
          from events
          where document_id = $1
        ),
        candidate_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join document_events de on de.id = ee.event_id
        ),
        shared_entities as (
          select distinct ee.entity_id
          from event_entities ee
          join events e on e.id = ee.event_id
          where ee.entity_id in (select entity_id from candidate_entities)
            and (e.document_id is distinct from $1)
        )
        delete from entities
        where id in (select entity_id from candidate_entities)
          and id not in (select entity_id from shared_entities)
      `,
      [input.documentId]
    );

    await client.query(
      `
        delete from documents
        where id = $1
          and source_id in (select id from sources where tenant_id = $2)
      `,
      [input.documentId, input.tenantId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectStats(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectStatsRecord> {
  const result = await pool.query(
    `
      with project as (
        select id, name
        from sources
        where id = $1 and tenant_id = $2
      ),
      -- Aggregate sources via watched_folders.source_id: every folder whose
      -- source_id points at this project contributes its documents/chunks/
      -- events/entities. This covers the "attach existing folders" use-case
      -- (folders data stays on their original source; we just rewrite
      -- watched_folders.source_id to point at the project).
      -- Aggregate sources via watched_folders attached to this project.
      -- Each folder keeps its own formerSourceId (the source it was
      -- created against) and never gives up ownership of its documents,
      -- so the project's stats/documents/chunks/entities must be the
      -- UNION of every attached folder's formerSourceId. The project's
      -- own id is included in project above, so the union below picks
      -- up project-side uploads too.
      bound_folder_src_ids as (
        select wf.source_id as id
        from watched_folders wf
        where wf.tenant_id = $2
          and json_extract(wf.metadata, '$.attachedProjectId') = $1
      ),
      kb_proj as (
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.watched_folder_id in (
            select id from watched_folders
            where tenant_id = $2
              and json_extract(metadata, '$.attachedProjectId') = $1
          )
        union
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.upload_id::uuid = $1
      ),
      folder_src_ids as (
        select wf.source_id as id
        from kb_sources ks
        join watched_folders wf on wf.id = ks.watched_folder_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'folder'
          and ks.enabled = true
          and wf.tenant_id = $2
      ),
      upload_src_ids as (
        select ks.upload_id::uuid as id
        from kb_sources ks
        join kb_projects p on p.id = ks.kb_project_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.enabled = true
          and p.tenant_id = $2
      ),
      all_source_ids as (
        select id from project
        union
        select id from bound_folder_src_ids
        union
        select id from folder_src_ids
        union
        select id from upload_src_ids
      )
      select
        (select count(*)
           from documents d
          where d.archived_at is null
            and d.source_id in (select id from all_source_ids))::int as document_count,
        (select count(*)
           from chunks c
          where c.source_id in (select id from all_source_ids)
            and exists (
              select 1 from documents d
              where d.id = c.document_id
                and d.archived_at is null
            ))::int as chunk_count,
        (select count(*)
           from events e
          where e.deleted_at is null
            and e.source_id in (select id from all_source_ids)
            and exists (
              select 1 from documents d
              where d.id = e.document_id
                and d.archived_at is null
            ))::int as event_count,
        (select count(distinct ent.id)
           from entities ent
          where ent.source_id in (select id from all_source_ids))::int as entity_count
    `,
    [input.sourceId, input.tenantId]
  );
  const row = result.rows[0];
  return {
    documentCount: Number(row?.document_count ?? 0),
    chunkCount: Number(row?.chunk_count ?? 0),
    eventCount: Number(row?.event_count ?? 0),
    entityCount: Number(row?.entity_count ?? 0)
  };
}

export async function getProjectGraph(input: {
  sourceId: string;
  tenantId: string;
}): Promise<ProjectGraphRecord> {
  // Sprint 15: like getProjectStats / listDocumentsBySource, this now reads
  // across the project source + every source attached to its linked KB
  // project. The original `ent.source_id = $1` filter would only return
  // entities from the audit project's own source.
  //
  // Strategy: pull entities via a subquery against the union source_ids
  // (re-using the same CTE pattern as getProjectStats), then build the
  // event + edge map only from those entities. We avoid needing the
  // subquery in the second query by passing the entityIds back through.
  const entitiesResult = await pool.query(
    `
      with project as (
        select id, name
        from sources
        where id = $1 and tenant_id = $2
      ),
      bound_folder_src_ids as (
        select wf.source_id as id
        from watched_folders wf
        where wf.tenant_id = $2
          and json_extract(wf.metadata, '$.attachedProjectId') = $1
      ),
      kb_proj as (
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.watched_folder_id in (
            select id from watched_folders
            where tenant_id = $2
              and json_extract(metadata, '$.attachedProjectId') = $1
          )
        union
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.upload_id::uuid = $1
      ),
      folder_src_ids as (
        select wf.source_id as id
        from kb_sources ks
        join watched_folders wf on wf.id = ks.watched_folder_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'folder'
          and ks.enabled = true
          and wf.tenant_id = $2
      ),
      upload_src_ids as (
        select ks.upload_id::uuid as id
        from kb_sources ks
        join kb_projects p on p.id = ks.kb_project_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.enabled = true
          and p.tenant_id = $2
      ),
      all_source_ids as (
        select id from project
        union
        select id from bound_folder_src_ids
        union
        select id from folder_src_ids
        union
        select id from upload_src_ids
      )
      -- LEFT JOIN entities → events so isolated entities (no event link)
      -- still show as standalone nodes. Without this, projects whose
      -- event→entity relations have been cleaned up (e.g. via
      -- migration 005) render an empty graph even when entities exist.
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        count(distinct e.id)::int as event_count
      from entities ent
      left join event_entities ee on ee.entity_id = ent.id
      left join events e on e.id = ee.event_id
      left join documents d on d.id = e.document_id
      inner join sources s on s.id = ent.source_id
      where ent.source_id in (select id from all_source_ids)
        and s.tenant_id = $2
        and (d.id is null or d.archived_at is null)
        and (e.id is null or e.deleted_at is null)
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.sourceId, input.tenantId]
  );

  const entities: ProjectGraphEntityRecord[] = entitiesResult.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.type),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    eventCount: Number(row.event_count ?? 0)
  }));

  // No early return: queries below are independent. Isolated entities
  // (no event links) will still surface as standalone nodes, paired with
  // whatever events do exist for the project.

  const entityIds = entities.map((entity) => entity.id);
  const eventsResult = await pool.query(
    `
      with project as (
        select id, name
        from sources
        where id = $1 and tenant_id = $2
      ),
      bound_folder_src_ids as (
        select wf.source_id as id
        from watched_folders wf
        where wf.tenant_id = $2
          and json_extract(wf.metadata, '$.attachedProjectId') = $1
      ),
      kb_proj as (
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.watched_folder_id in (
            select id from watched_folders
            where tenant_id = $2
              and json_extract(metadata, '$.attachedProjectId') = $1
          )
        union
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.upload_id::uuid = $1
      ),
      folder_src_ids as (
        select wf.source_id as id
        from kb_sources ks
        join watched_folders wf on wf.id = ks.watched_folder_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'folder'
          and ks.enabled = true
          and wf.tenant_id = $2
      ),
      upload_src_ids as (
        select ks.upload_id::uuid as id
        from kb_sources ks
        join kb_projects p on p.id = ks.kb_project_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.enabled = true
          and p.tenant_id = $2
      ),
      all_source_ids as (
        select id from project
        union
        select id from bound_folder_src_ids
        union
        select id from folder_src_ids
        union
        select id from upload_src_ids
      )
      select
        e.id,
        e.source_id,
        e.document_id,
        e.title,
        e.rank,
        coalesce(
          (select json_group_array(ee2.entity_id)
             from event_entities ee2
             join entities ent2 on ent2.id = ee2.entity_id
            where ee2.event_id = e.id
              and ee2.entity_id in (select value from json_each($3))),
          '[]'
        ) as entity_ids
      from events e
      join documents d on d.id = e.document_id
      join sources s on s.id = e.source_id
      where e.source_id in (select id from all_source_ids)
        and s.tenant_id = $2
        and d.archived_at is null
        and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [input.sourceId, input.tenantId, entityIds]
  );

  const events: ProjectGraphEventRecord[] = eventsResult.rows.map((row) => {
    // entity_ids comes back from SQLite as a JSON array string; decode so
    // callers receive a plain string[] (Postgres-style behaviour).
    let entityIds: string[] = [];
    const raw = row.entity_ids;
    if (Array.isArray(raw)) {
      entityIds = raw.map(String);
    } else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) entityIds = parsed.map(String);
      } catch {
        entityIds = [];
      }
    }
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      documentId: row.document_id == null ? null : String(row.document_id),
      title: String(row.title),
      rank: Number(row.rank ?? 0),
      entityIds
    };
  });
  const edges = events.flatMap((event) => event.entityIds.map((entityId) => ({
    entityId,
    eventId: event.id
  })));

  return { entities, events, edges };
}

// Sprint 15: resolve the audit project source + every source attached to
// its linked KB project (watched folders + uploaded files). Returned as
// a flat list of source ids. Used by the MCP sessions route so that
// sessions referencing the watched folder also surface under the audit
// project. The CTE matches the one in getProjectStats / getProjectGraph /
// listDocumentsBySource — if you change the join shape, change all four.
export async function getLinkedSourceIds(input: {
  sourceId: string;
  tenantId: string;
}): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `
      with project as (
        select id, name
        from sources
        where id = $1 and tenant_id = $2
      ),
      bound_folder_src_ids as (
        select wf.source_id as id
        from watched_folders wf
        where wf.tenant_id = $2
          and json_extract(wf.metadata, '$.attachedProjectId') = $1
      ),
      kb_proj as (
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.watched_folder_id in (
            select id from watched_folders
            where tenant_id = $2
              and json_extract(metadata, '$.attachedProjectId') = $1
          )
        union
        select distinct p.id
        from kb_projects p
        join kb_sources ks on ks.kb_project_id = p.id
        where ks.enabled = true
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.upload_id::uuid = $1
      ),
      folder_src_ids as (
        select wf.source_id as id
        from kb_sources ks
        join watched_folders wf on wf.id = ks.watched_folder_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'folder'
          and ks.enabled = true
          and wf.tenant_id = $2
      ),
      upload_src_ids as (
        select ks.upload_id::uuid as id
        from kb_sources ks
        join kb_projects p on p.id = ks.kb_project_id
        where ks.kb_project_id in (select id from kb_proj)
          and ks.source_type = 'upload'
          and ks.upload_id is not null
          and ks.enabled = true
          and p.tenant_id = $2
      )
      select id::text from project
      union
      select id::text from bound_folder_src_ids
      union
      select id::text from folder_src_ids
      union
      select id::text from upload_src_ids
    `,
    [input.sourceId, input.tenantId]
  );
  return result.rows.map((row) => row.id);
}

export async function getDocumentDetail(input: {
  documentId: string;
  tenantId: string;
}): Promise<(DocumentRecord & { source: SourceRecord }) | null> {
  const result = await pool.query(
    `
      select d.*, s.id as source_id_for_source, s.tenant_id, s.name as source_name,
             s.description as source_description, s.metadata as source_metadata
      from documents d
      join sources s on s.id = d.source_id
      where d.id = $1 and s.tenant_id = $2
    `,
    [input.documentId, input.tenantId]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    ...documentFromRow(row),
    source: {
      id: String(row.source_id),
      tenantId: String(row.tenant_id),
      name: String(row.source_name),
      description: row.source_description == null ? null : String(row.source_description),
      metadata: (row.source_metadata ?? {}) as Record<string, unknown>
    }
  };
}

export async function listChunksByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<ChunkRecord[]> {
  const result = await pool.query(
    `
      select c.id, c.document_id, c.source_id, c.rank, c.heading, c.content,
             c.raw_content, c.token_count, c.metadata,
             ce.embedding_json as embedding_preview
      from chunks c
      join sources s on s.id = c.source_id
      left join chunk_embeddings ce on ce.chunk_id = c.id
      where c.document_id = $1 and s.tenant_id = $2
      order by c.rank, c.id
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map(chunkFromRow);
}

export async function listEventsByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<Array<EventRecord & { entityCount: number; entities: EntityRecord[] }>> {
  const result = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary,
             e.content, e.rank,
             e.title_embedding_json as title_embedding_preview,
             e.content_embedding_json as content_embedding_preview,
             count(distinct ee.entity_id) as entity_count
      from events e
      join sources s on s.id = e.source_id
      left join event_entities ee on ee.event_id = e.id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by e.id
      order by e.rank, e.id
    `,
    [input.documentId, input.tenantId]
  );
  const events = result.rows.map((row) => ({
    ...eventFromRow(row),
    entityCount: Number(row.entity_count ?? 0),
    entities: [] as EntityRecord[]
  }));
  if (events.length === 0) {
    return events;
  }
  // Stitch entities per event (SQLite has no jsonb_agg). One batched
  // JOIN keeps it cheap even when the doc has many events.
  const eventIds = events.map((event) => event.id);
  const placeholders = eventIds.map(() => "?").join(",");
  const entityRows = (await pool.query(
    `
      select ee.event_id,
             ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.embedding_json as embedding_preview
      from event_entities ee
      join entities ent on ent.id = ee.entity_id
      where ee.event_id in (${placeholders})
    `,
    eventIds
  )).rows;
  const byEvent = new Map<string, EntityRecord[]>();
  for (const row of entityRows) {
    const eventId = String(row.event_id);
    const list = byEvent.get(eventId) ?? [];
    list.push(entityFromRow(row));
    byEvent.set(eventId, list);
  }
  return events.map((event) => ({
    ...event,
    entities: byEvent.get(event.id) ?? []
  }));
}

export async function listEntitiesByDocument(input: {
  documentId: string;
  tenantId: string;
}): Promise<EntityWithEventsRecord[]> {
  const result = await pool.query(
    `
      select ent.id, ent.source_id, ent.type, ent.name, ent.normalized_name,
             ent.description, ent.embedding_json as embedding_preview,
             count(distinct ee.event_id) as event_count
      from entities ent
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      where e.document_id = $1 and s.tenant_id = $2 and e.deleted_at is null
      group by ent.id
      order by event_count desc, ent.type, ent.name
    `,
    [input.documentId, input.tenantId]
  );
  return result.rows.map((row) => ({
    ...entityFromRow(row),
    description: row.description == null ? null : String(row.description),
    eventCount: Number(row.event_count ?? 0)
  }));
}

export async function getEntityDetail(input: {
  entityId: string;
  tenantId: string;
  includeArchived?: boolean;
}): Promise<EntityDetailRecord | null> {
  const archiveSql = input.includeArchived
    ? ""
    : "and s.archived_at is null and d.archived_at is null";
  const entityResult = await pool.query(
    `
      select
        ent.id,
        ent.source_id,
        ent.type,
        ent.name,
        ent.normalized_name,
        ent.description,
        count(distinct ee.event_id)::int as event_count,
        s.tenant_id,
        s.name as source_name,
        s.description as source_description,
        s.metadata as source_metadata,
        s.archived_at as source_archived_at,
        s.created_at as source_created_at,
        s.updated_at as source_updated_at
      from entities ent
      join sources s on s.id = ent.source_id
      join event_entities ee on ee.entity_id = ent.id
      join events e on e.id = ee.event_id
      join documents d on d.id = e.document_id
      where ent.id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      group by ent.id, s.id
    `,
    [input.entityId, input.tenantId]
  );
  const entityRow = entityResult.rows[0];
  if (!entityRow) {
    return null;
  }
  const eventsResult = await pool.query(
    `
      select e.id, e.source_id, e.document_id, e.chunk_id, e.title, e.summary, e.content, e.rank
      from event_entities ee
      join events e on e.id = ee.event_id
      join sources s on s.id = e.source_id
      join documents d on d.id = e.document_id
      where ee.entity_id = $1
        and s.tenant_id = $2
        and e.deleted_at is null
        ${archiveSql}
      order by e.rank, e.id
    `,
    [input.entityId, input.tenantId]
  );
  return {
    entity: {
      ...entityFromRow(entityRow),
      description: entityRow.description == null ? null : String(entityRow.description),
      eventCount: Number(entityRow.event_count ?? 0)
    },
    events: eventsResult.rows.map(eventFromRow),
    source: sourceFromRow({
      id: entityRow.source_id,
      tenant_id: entityRow.tenant_id,
      name: entityRow.source_name,
      description: entityRow.source_description,
      metadata: entityRow.source_metadata,
      archived_at: entityRow.source_archived_at,
      created_at: entityRow.source_created_at,
      updated_at: entityRow.source_updated_at
    })
  };
}

export async function getAiProviderSettings(): Promise<AiProviderSettingsRecord | null> {
  const result = await pool.query("select * from ai_provider_settings where id = 'global'");
  return result.rows[0] ? aiProviderSettingsFromRow(result.rows[0]) : null;
}

export async function upsertAiProviderSettings(input: {
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  preserveEmbeddingApiKey?: boolean;
  embeddingLocalModelPath?: string | null;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  preserveLlmApiKey?: boolean;
  metadata?: Record<string, unknown>;
}): Promise<AiProviderSettingsRecord> {
  const result = await pool.query(
    `
      insert into ai_provider_settings (
        id,
        embedding_provider,
        embedding_base_url,
        embedding_model,
        embedding_dimensions,
        embedding_api_key,
        embedding_local_model_path,
        llm_base_url,
        llm_model,
        llm_api_key,
        llm_timeout_ms,
        llm_max_retries,
        metadata
      )
      values (
        'global',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12::jsonb
      )
      on conflict (id) do update set
        embedding_provider = excluded.embedding_provider,
        embedding_base_url = excluded.embedding_base_url,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding_api_key = case
          when $13::boolean then ai_provider_settings.embedding_api_key
          else excluded.embedding_api_key
        end,
        embedding_local_model_path = excluded.embedding_local_model_path,
        llm_base_url = excluded.llm_base_url,
        llm_model = excluded.llm_model,
        llm_api_key = case
          when $14::boolean then ai_provider_settings.llm_api_key
          else excluded.llm_api_key
        end,
        metadata = ai_provider_settings.metadata || excluded.metadata,
        updated_at = now()
      returning *
    `,
    [
      input.embeddingProvider,
      input.embeddingBaseUrl,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embeddingApiKey ?? null,
      input.embeddingLocalModelPath ?? null,
      input.llmBaseUrl,
      input.llmModel,
      input.llmApiKey ?? null,
      config.LLM_TIMEOUT_MS,
      config.LLM_MAX_RETRIES,
      JSON.stringify(input.metadata ?? {}),
      input.preserveEmbeddingApiKey ?? false,
      input.preserveLlmApiKey ?? false
    ]
  );
  return aiProviderSettingsFromRow(result.rows[0]);
}

export async function createMcpSession(input: {
  tenantId: string;
  title: string;
  model?: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord> {
  const result = await pool.query(
    `
      insert into mcp_sessions (id, tenant_id, title, model, source_ids, metadata)
      values ($1, $2, $3, $4, $5::uuid[], $6::jsonb)
      returning *
    `,
    [
      randomUUID(),
      input.tenantId,
      input.title,
      input.model ?? null,
      input.sourceIds ?? [],
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return mcpSessionFromRow(result.rows[0]);
}

export async function listMcpSessions(input: {
  tenantId: string;
  limit: number;
  // Sprint 15: accept an array of source_ids. The route /api/projects/:id/mcp/sessions
  // resolves the audit project + its linked KB sources (folder + upload) and
  // passes the union. We use the overlaps operator (&&) so a session that
  // mentions ANY of the linked sources shows up — the old contains operator
  // (@>) required the session to list every project source, which is rare.
  // SQLite note: source_ids is a JSON text column (not a native array), so we
  // pull all sessions for the tenant and filter for source overlap in JS.
  // The result set is bounded by `limit` so this is cheap.
  sourceIds?: string[];
}): Promise<McpSessionRecord[]> {
  const filterIds = input.sourceIds && input.sourceIds.length > 0 ? input.sourceIds : null;
  const result = await pool.query(
    `
      select *
      from mcp_sessions
      where tenant_id = $1
      order by updated_at desc, id
      limit $2
    `,
    [input.tenantId, input.limit]
  );
  const rows = result.rows.map(mcpSessionFromRow);
  if (!filterIds) {
    return rows;
  }
  const filterSet = new Set(filterIds);
  return rows.filter((session) => session.sourceIds.some((id) => filterSet.has(id)));
}

export async function getMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    "select * from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function updateMcpSessionTitle(input: {
  sessionId: string;
  tenantId: string;
  title: string;
  metadata?: Record<string, unknown>;
}): Promise<McpSessionRecord | null> {
  const result = await pool.query(
    `
      update mcp_sessions
      set
        title = $3,
        metadata = metadata || $4::jsonb,
        updated_at = now()
      where id = $1 and tenant_id = $2
      returning *
    `,
    [
      input.sessionId,
      input.tenantId,
      input.title.trim(),
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return result.rows[0] ? mcpSessionFromRow(result.rows[0]) : null;
}

export async function clearMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query(
      "select id from mcp_sessions where id = $1 and tenant_id = $2 for update",
      [input.sessionId, input.tenantId]
    );
    if (!sessionResult.rows[0]) {
      await client.query("rollback");
      return false;
    }
    await client.query("delete from mcp_tool_calls where session_id = $1", [input.sessionId]);
    await client.query("delete from mcp_messages where session_id = $1", [input.sessionId]);
    await client.query(
      "update mcp_sessions set updated_at = now() where id = $1",
      [input.sessionId]
    );
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteMcpSession(input: {
  sessionId: string;
  tenantId: string;
}): Promise<boolean> {
  const result = await pool.query(
    "delete from mcp_sessions where id = $1 and tenant_id = $2",
    [input.sessionId, input.tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addMcpMessage(input: {
  sessionId: string;
  role: McpMessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<McpMessageRecord> {
  const result = await pool.query(
    `
      insert into mcp_messages (id, session_id, role, content, metadata)
      values ($1, $2, $3, $4, $5::jsonb)
      returning *
    `,
    [randomUUID(), input.sessionId, input.role, input.content, JSON.stringify(input.metadata ?? {})]
  );
  await touchMcpSession(input.sessionId);
  return mcpMessageFromRow(result.rows[0]);
}

export async function addMcpToolCall(input: {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
}): Promise<McpToolCallRecord> {
  const queryResult = await pool.query(
    `
      insert into mcp_tool_calls (
        id, session_id, message_id, tool_name, arguments, result, status, duration_ms, error
      )
      values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
      returning *
    `,
    [
      randomUUID(),
      input.sessionId,
      input.messageId ?? null,
      input.toolName,
      JSON.stringify(input.arguments),
      JSON.stringify(input.result ?? null),
      input.status,
      input.durationMs ?? null,
      input.error ?? null
    ]
  );
  await touchMcpSession(input.sessionId);
  return mcpToolCallFromRow(queryResult.rows[0]);
}

export async function getMcpSessionDetail(input: {
  sessionId: string;
  tenantId: string;
}): Promise<{
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
} | null> {
  const session = await getMcpSession(input);
  if (!session) {
    return null;
  }
  const [messagesResult, callsResult] = await Promise.all([
    pool.query(
      "select * from mcp_messages where session_id = $1 order by created_at, id",
      [input.sessionId]
    ),
    pool.query(
      "select * from mcp_tool_calls where session_id = $1 order by created_at, id",
      [input.sessionId]
    )
  ]);
  return {
    session,
    messages: messagesResult.rows.map(mcpMessageFromRow),
    toolCalls: callsResult.rows.map(mcpToolCallFromRow)
  };
}

async function touchMcpSession(sessionId: string): Promise<void> {
  await pool.query(
    "update mcp_sessions set updated_at = now() where id = $1",
    [sessionId]
  );
}
