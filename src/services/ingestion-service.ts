import { randomUUID } from "node:crypto";
import path from "node:path";
import { pool } from "../db/pool.js";
import { toVectorLiteral } from "../db/vector.js";
import { createSource, upsertEntity } from "../db/repositories.js";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { chunkMarkdown, type ChunkDraft } from "../ingestion/chunking/markdown.js";
import { extractEventsFromChunk } from "../ingestion/extract/extractor.js";
import type { ExtractedEntity, ExtractedEvent, IngestDocumentInput, IngestDocumentResult, IngestProgressUpdate } from "../types.js";
import { logger } from "../observability/logger.js";
import { aiSettingsService } from "./ai-settings-service.js";

type ExtractedChunkEvents = {
  chunk: ChunkDraft;
  events: ExtractedEvent[];
};

/**
 * Hard character cap on any single text fed to an embedding call. The
 * chunker is supposed to keep chunks ≤ chunkTokenLimit (1024), and the
 * tokenizer-based `truncateToTokenLimit` in src/ai/embedding-client.ts
 * defends the local BGE path against tensors that exceed its 512-token
 * position window. This is the third layer: even if both upstream
 * guards somehow let a giant string through, we clip it here at the call
 * site so onnxruntime never sees a shape that crashes the process.
 *
 * 8000 chars ≈ ~2000 CJK tokens or ~4000 English tokens — comfortably
 * above BGE's 512 but well below onnxruntime's "broadcast axis != 1"
 * failure threshold for malformed inputs. The actual ONNX safety check
 * is `truncateToTokenLimit`; this is the safety net.
 */
const EMBEDDING_INPUT_MAX_CHARS = 8_000;

export function capForEmbedding(input: string): string {
  if (input.length <= EMBEDDING_INPUT_MAX_CHARS) return input;
  return input.slice(0, EMBEDDING_INPUT_MAX_CHARS);
}

type EventInput = {
  chunk: ChunkDraft;
  event: ExtractedEvent;
  eventId: string;
  rank: number;
};

type EventEmbeddingInput = EventInput & {
  titleEmbedding: number[];
  contentEmbedding: number[];
};

type EntityEmbeddingInput = {
  key: string;
  entity: ExtractedEntity;
};

type RelationEmbeddingInput = {
  eventId: string;
  eventTitle: string;
  entity: ExtractedEntity;
};

type PreparedEvent = EventEmbeddingInput & {
  entities: Array<ExtractedEntity & {
    entityEmbedding: number[];
    relationEmbedding: number[];
  }>;
};

/**
 * IngestAbortError — thrown when an ingestDocument call is interrupted
 * by an AbortSignal (typically because the user paused the watched
 * folder). Distinct from a regular error so callers can decide not to
 * bump "failed" counters and to leave the manifest as `pending` (so a
 * future resume + re-scan can retry).
 */
export class IngestAbortError extends Error {
  readonly name = "IngestAbortError";
  readonly isAbort = true;
}

export class IngestionService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient
  ) {}

  async ingestDocument(
    input: IngestDocumentInput,
    tenantId = config.DEFAULT_TENANT_ID,
    onProgress?: (update: IngestProgressUpdate) => void
  ): Promise<IngestDocumentResult> {
    // Per-stage timing. Each stage records a wall-clock millisecond
    // delta so the watcher can log "ingest done, chunking=45ms
    // chunkEmbed=1800ms eventExtract=2100ms eventEmbed=12000ms
    // dbWrite=400ms total=17345ms" and pinpoint which phase is the
    // bottleneck. Lives here (not in sync-orchestrator) because
    // every entry point (watcher, webui, MCP) goes through
    // ingestDocument, so a single instrument covers all of them.
    const stageTimer = (label: string) => {
      const t = Date.now();
      return { stop: (extra?: Record<string, unknown>) => ({
        label,
        ms: Date.now() - t,
        ...(extra ?? {})
      }) };
    };
    const stageResults: Array<{ label: string; ms: number; meta?: Record<string, unknown> }> = [];

    const traceId = randomUUID();
    const taskId = randomUUID();
    const documentId = randomUUID();
    const extract = input.extract ?? true;
    // Capped at 4 — see config/env.ts. Keep the env value so log lines
    // and event payloads reflect the configured limit; this stage just
    // applies the max-4 ceiling so we don't accidentally fan out beyond
    // what the LLM endpoint can handle.
    const ingestConcurrency = Math.min(config.INGEST_CONCURRENCY, 4);
    const ingestStart = Date.now();
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    // Persist the model id alongside each chunk embedding so future
    // dimension migrations can detect mixed-dim rows. Use the
    // embedding path / model id from runtime settings, but prefer
    // the explicit "bge-large-zh-v1.5" path-basename when the
    // provider is local-bge (that's what was actually loaded).
    const embeddingModelLabel =
      runtimeSettings.embeddingProvider === "local-bge"
        ? `local-bge:${path.basename(runtimeSettings.embeddingLocalModelPath)}`
        : runtimeSettings.embeddingModel;
    const chunkingOptions = {
      mode: input.chunking?.mode ?? runtimeSettings.defaultChunkingMode,
      maxTokens: input.chunking?.maxTokens ?? runtimeSettings.chunkTokenLimit,
      overlapTokens: input.chunking?.overlapTokens ?? runtimeSettings.chunkOverlapTokens
    };

    onProgress?.({
      stage: "PARSING",
      message: "正在解析文档内容",
      progress: 8
    });
    const sourceCreateTimer = stageTimer("createSource");
    const source = await createSource({
      id: input.sourceId,
      tenantId,
      name: input.title,
      description: "Created by SAG ingestDocument",
      metadata: { ...(input.metadata ?? {}), traceId, chunking: chunkingOptions }
    });
    stageResults.push(sourceCreateTimer.stop());

    const chunkingTimer = stageTimer("chunking");
    const chunking = chunkMarkdown(input.content, chunkingOptions);
    stageResults.push(
      chunkingTimer.stop({
        chunks: chunking.chunks.length,
        sections: chunking.sections.length
      })
    );
    onProgress?.({
      stage: "CHUNKING",
      message: `已生成 ${chunking.chunks.length} 个切片`,
      progress: 18,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });

    onProgress?.({
      stage: "EMBEDDING_CHUNKS",
      message: "正在生成切片向量",
      progress: 35,
      chunkCount: chunking.chunks.length,
      totalChunks: chunking.chunks.length
    });
    const chunkEmbedTimer = stageTimer("chunkEmbedding");
    const chunkEmbeddings = await this.embeddings.batchGenerate(
      chunking.chunks.map((chunk) => capForEmbedding(`${chunk.heading}\n${chunk.content}`))
    );
    stageResults.push(
      chunkEmbedTimer.stop({
        inputs: chunking.chunks.length,
        vectors: chunkEmbeddings.length
      })
    );
    // Sections get their own embeddings too — section chunks are inserted
    // into the same `chunks` table and need embeddings for search recall.
    // Empty documents often have zero sections; guard the API call.
    const sectionEmbedTimer = stageTimer("sectionEmbedding");
    const sectionEmbeddings = chunking.sections.length > 0
      ? await this.embeddings.batchGenerate(
          chunking.sections.map((section) => capForEmbedding(`${section.heading}\n${section.content}`))
        )
      : [];
    stageResults.push(
      sectionEmbedTimer.stop({
        inputs: chunking.sections.length,
        vectors: sectionEmbeddings.length
      })
    );

    let eventPrepResult: { preparedEvents: PreparedEvent[]; failedChunks: number } = { preparedEvents: [], failedChunks: 0 };
    if (extract) {
      // Abort check between embedding and event prep. Event prep kicks
      // off an LLM call (or local-rule fallback) that takes several
      // seconds for a typical file — we want to bail before paying for
      // it if the user just paused the folder.
      if (input.signal?.aborted) {
        throw new IngestAbortError("ingest aborted before eventPrep");
      }
      const prepTimer = stageTimer("eventPrep");
      eventPrepResult = await this.prepareEvents({
        input,
        chunks: chunking.chunks,
        onProgress,
        concurrency: ingestConcurrency,
        signal: input.signal
      });
      stageResults.push(prepTimer.stop({ events: eventPrepResult.preparedEvents.length }));
    }
    const preparedEvents = eventPrepResult.preparedEvents;
    const failedChunkCount = eventPrepResult.failedChunks;

    // Abort check between event prep and DB write. By this point
    // events + embeddings are computed in memory; throwing here
    // prevents any DB rows from being created.
    if (input.signal?.aborted) {
      throw new IngestAbortError("ingest aborted before dbWrite");
    }

    const dbWriteTimer = stageTimer("dbWrite");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
          insert into documents (id, source_id, title, content, parse_status, metadata)
          values ($1, $2, $3, $4, 'PARSING', $5)
        `,
        [documentId, source.id, input.title, input.content, JSON.stringify({ ...(input.metadata ?? {}), chunking: chunkingOptions })]
      );
      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在写入文档记录",
        progress: 24,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });

      // SQLite schema doesn't have document_sections, source_chunks (in PG),
      // events, event_entities, or entity_types. Map what we can onto the
      // SQLite-native tables (chunks, chunk_embeddings) so search + retrieval
      // still work, and skip the rest.
      // Section chunks are inserted with chunk_state='pending'; the
      // background embedding-worker (src/workers/embedding-worker.ts)
      // claims them and flips to 'embedded' once the vector lands in
      // chunk_embeddings. On ingestDocument success the in-process
      // embed still runs inline (immediate write below), so the chunk
      // is 'embedded' by the time the watcher sees the row — but if
      // that inline embed crashes, the next embedding-worker sweep
      // will pick up the orphan chunk and finish the job instead of
      // re-running the whole file.
      for (const [idx, section] of chunking.sections.entries()) {
        const sectionEmbedding = sectionEmbeddings[idx];
        await client.query(
          `
            insert into chunks (
              id, source_id, document_id, rank, heading, content,
              raw_content, token_count, metadata, chunk_state
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
          `,
          [
            `section-${section.id}`,
            source.id,
            documentId,
            Math.trunc(section.orderIndex * 1000),
            section.heading,
            section.content,
            section.rawContent,
            section.tokenCount ?? 0,
            JSON.stringify({ kind: "section", originalId: section.id })
          ]
        );
        // Section chunks also need an embedding for search recall. Without
        // this, exactly 50% of `chunks` rows are silently unsearchable.
        if (sectionEmbedding) {
          await client.query(
            `
              insert into chunk_embeddings (chunk_id, model, embedding_json)
              values ($1, $2, $3)
              on conflict (chunk_id) do update set embedding_json = excluded.embedding_json
            `,
            [
              `section-${section.id}`,
              embeddingModelLabel,
              toVectorLiteral(sectionEmbedding)
            ]
          );
          // Mark this section's chunk as embedded. The inline
          // embed-and-flip below is what makes ingestDocument succeed
          // synchronously; the embedding-worker is only there to mop
          // up chunks that crash between insert and embed.
          await client.query(
            `update chunks set chunk_state = 'embedded' where id = $1`,
            [`section-${section.id}`]
          );
        }
      }

      for (const [index, chunk] of chunking.chunks.entries()) {
        await client.query(
          `
            insert into chunks (
              id, source_id, document_id, rank, heading, content,
              raw_content, token_count, metadata, chunk_state
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
          `,
          [
            chunk.id,
            source.id,
            documentId,
            chunk.rank,
            chunk.heading,
            chunk.content,
            chunk.rawContent,
            0,
            JSON.stringify({
              source_type: "ARTICLE",
              references: chunk.sectionIds ?? []
            })
          ]
        );

        // Persist the chunk embedding as a JSON preview in chunk_embeddings.
        // The vec virtual table built on top of chunk_embeddings handles
        // cosine distance at query time. SQLite schema uses `chunk_id` as
        // the PK (one embedding per chunk), so we upsert on chunk_id.
        await client.query(
          `
            insert into chunk_embeddings (chunk_id, model, embedding_json)
            values ($1, $2, $3)
            on conflict (chunk_id) do update set embedding_json = excluded.embedding_json
          `,
          [
            chunk.id,
            embeddingModelLabel,
            toVectorLiteral(chunkEmbeddings[index])
          ]
        );
        await client.query(
          `update chunks set chunk_state = 'embedded' where id = $1`,
          [chunk.id]
        );
      }

      // Persist events, entities, and the event↔entity relations.
      // This mirrors the PG path; the `preparedEvents` list carries everything
      // needed (embeddings already computed in prepareEvents above).
      // Entity lookup cache: a single file's ingest typically has 50-200
      // entities (e.g. 36 events × ~5 entities per event). Each entity
      // used to trigger an extra `SELECT id FROM entities WHERE ...`
      // round-trip after the INSERT, which was the dominant cost in
      // eventPrep for dense files like 访问记录.xlsx (28s of 84s). We
      // now batch: collect every entity key, do ONE select, build a
      // Map, and only re-query on a true cache miss (new entities
      // added since the bulk select, e.g. from concurrent ingest).
      const tEntityResolution = Date.now();
      const entityCache = new Map<string, string>();
      {
        const allKeys: string[] = [];
        for (const prepared of preparedEvents) {
          for (const entity of prepared.entities) {
            allKeys.push(entity.name);
          }
        }
        if (allKeys.length > 0) {
          // Build a SQLite-friendly IN clause. better-sqlite3 doesn't
          // accept Postgres-style array literals, so we expand the
          // placeholders manually. The dedupe happens in
          // `dedupeEntityEmbeddingInputs` upstream; this list still
          // has duplicates (each entity can appear in multiple events
          // and we want one cache entry per unique name).
          const uniqueKeys = Array.from(new Set(allKeys));
          const placeholders = uniqueKeys.map(() => "?").join(",");
          const bulkLookup = await client.query(
            `select name, id from entities where source_id=? and document_id=? and name in (${placeholders})`,
            [source.id, documentId, ...uniqueKeys]
          );
          for (const row of bulkLookup.rows) {
            entityCache.set(row.name, row.id);
          }
        }
      }

      // 5. 事件 INSERT（events 表）
      const tEventInsert = Date.now();
      for (const prepared of preparedEvents) {
        await client.query(
          `insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            prepared.eventId,
            source.id,
            documentId,
            prepared.chunk.id,
            prepared.event.title,
            prepared.event.content,
            prepared.event.category ?? "fact",
            prepared.event.status ?? "CONFIRMED",
            prepared.rank,
            prepared.event.summary,
            toVectorLiteral(prepared.titleEmbedding),
            toVectorLiteral(prepared.contentEmbedding)
          ]
        );

        for (const entity of prepared.entities) {
          const entityId = randomUUID();
          console.log(
            "[entity-debug]",
            JSON.stringify({
              entityName: entity.name,
              entityType: entity.type,
              sourceId: source.id,
              documentId,
              eventId: prepared.eventId,
              eventTitle: prepared.event.title,
            })
          );
          await client.query(
            `insert into entities (id, source_id, document_id, name, normalized_name, type, description, embedding_json)
             values ($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict do nothing`,
            [
              entityId,
              source.id,
              documentId,
              entity.name,
              entity.name.toLowerCase().trim(),
              entity.type,
              entity.description,
              toVectorLiteral(entity.entityEmbedding)
            ]
          );
          // Look up the entity id from the cache populated above. The
          // INSERT above is `ON CONFLICT DO NOTHING` so a duplicate
          // name silently keeps the original row id — we must use that
          // id (not the randomUUID we generated) when building the
          // event↔entity relation. Falls back to a per-row SELECT only
          // on a true cache miss (very rare: only if the bulk SELECT
          // happened before another concurrent ingest inserted the
          // same entity name).
          let resolvedId: string | undefined = entityCache.get(entity.name);
          if (!resolvedId) {
            const lookup = await client.query(
              `select id from entities where source_id=? and document_id=? and name=? limit 1`,
              [source.id, documentId, entity.name]
            );
            if (lookup.rows.length > 0) {
              resolvedId = lookup.rows[0].id;
              entityCache.set(entity.name, resolvedId!);
            }
          }
          if (resolvedId !== undefined) {
            await client.query(
              `insert into event_entities (id, event_id, entity_id) values ($1,$2,$3) on conflict do nothing`,
              [randomUUID(), prepared.eventId, resolvedId]
            );
          } else {
            console.error("[entity-debug] ERROR: entity not found after insert!");
          }
        }
      }
      const eventInsertMs = Date.now() - tEventInsert;
      logger.info({ stage: "eventInsert", ms: eventInsertMs, events: preparedEvents.length }, "eventPrep: sub-stages");
      const entityResolutionMs = Date.now() - tEntityResolution;
      logger.info({ stage: "entityResolution", ms: entityResolutionMs, entities: entityCache.size }, "eventPrep: sub-stages");

      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在完成图谱关系写入",
        progress: 95,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      const finalStatus = failedChunkCount > 0 ? 'PARTIAL_SUCCESS' : 'COMPLETED';
      await client.query(
        "update documents set parse_status = $1, updated_at = now() where id = $2",
        [finalStatus, documentId]
      );
      await client.query("commit");

      stageResults.push(
        dbWriteTimer.stop({
          chunks: chunking.chunks.length,
          events: preparedEvents.length
        })
      );
      // Emit per-stage timings + total as a structured log line so
      // sd-out.log shows exactly which phase dominates per file.
      // The watcher logs this at the same level so a single grep
      // "stage=ingest" surfaces the whole breakdown.
      const totalMs = Date.now() - ingestStart;
      logger.info(
        {
          traceId,
          documentId,
          sourceId: source.id,
          chunkCount: chunking.chunks.length,
          eventCount: preparedEvents.length,
          totalMs,
          stages: Object.fromEntries(
            stageResults.map((s) => [
              s.label,
              { ms: s.ms, ...(s.meta ?? {}) }
            ])
          )
        },
        "ingest: stage timings"
      );
      logger.info({ traceId, documentId, chunkCount: chunking.chunks.length, eventCount: preparedEvents.length }, "document ingested");
      onProgress?.({
        stage: failedChunkCount > 0 ? "PARTIAL_SUCCESS" : "COMPLETED",
        message: failedChunkCount > 0
          ? `部分完成：${chunking.chunks.length} 个切片中，${failedChunkCount} 个切片事件抽取失败，其余已入库`
          : `处理完成：${chunking.chunks.length} 个切片，${preparedEvents.length} 个事件`,
        progress: 100,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });
      return {
        sourceId: source.id,
        documentId,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        taskId,
        traceId,
        status: failedChunkCount > 0 ? "PARTIAL_SUCCESS" : "COMPLETED",
        failedChunkCount
      };
    } catch (error) {
      await client.query("rollback");
      logger.error({ traceId, error }, "document ingest failed");
      throw error;
    } finally {
      client.release();
    }
  }

  private async prepareEvents(input: {
    input: IngestDocumentInput;
    chunks: ChunkDraft[];
    concurrency: number;
    onProgress?: (update: IngestProgressUpdate) => void;
    signal?: AbortSignal;
  }): Promise<{ preparedEvents: PreparedEvent[]; failedChunks: number }> {
    const throwIfAborted = () => {
      if (input.signal?.aborted) {
        throw new IngestAbortError("prepareEvents aborted by signal");
      }
    };
    const stages: Record<string, number> = {};
    let extractedChunks = 0;
    let extractedEventCount = 0;

    // 1. 事件抽取（LLM API 或本地规则）
    throwIfAborted();
    const t1 = Date.now();
    let failedChunks = 0;
    const extracted = await mapWithConcurrency(input.chunks, input.concurrency, async (chunk) => {
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `正在并行抽取事件（并发 ${input.concurrency}），已完成 ${extractedChunks}/${input.chunks.length} 个切片`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      let events: ExtractedEvent[] = [];
      try {
        events = await extractEventsFromChunk({
          llm: this.llm,
          documentTitle: input.input.title,
          heading: chunk.heading,
          content: chunk.content,
          references: chunk.sectionIds
        });
      } catch (error) {
        failedChunks += 1;
        logger.warn(
          { documentTitle: input.input.title, chunkHeading: chunk.heading, error: (error as Error).message },
          "prepareEvents: chunk event extraction failed — continuing with remaining chunks"
        );
      }
      extractedChunks += 1;
      extractedEventCount += events.length;
      input.onProgress?.({
        stage: "EXTRACTING_EVENTS",
        message: `已完成 ${extractedChunks}/${input.chunks.length} 个切片事件抽取${failedChunks > 0 ? `（${failedChunks} 个切片失败）` : ""}`,
        progress: progressForCompleted(extractedChunks, input.chunks.length, 48, 74),
        chunkCount: input.chunks.length,
        eventCount: extractedEventCount,
        currentChunk: extractedChunks,
        totalChunks: input.chunks.length
      });
      return { chunk, events } satisfies ExtractedChunkEvents;
    });
    stages.extractEvents = Date.now() - t1;
    throwIfAborted();

    const eventInputs: EventInput[] = extracted
      .flatMap((item) => item.events.map((event) => ({ chunk: item.chunk, event })))
      .map((item, rank) => ({
        ...item,
        eventId: randomUUID(),
        rank
      }));

    // 2. 事件向量化（标题 + 内容）
    throwIfAborted();
    const t2 = Date.now();
    let embeddedEvents = 0;
    const eventEmbeddingInputs = await mapWithConcurrency(eventInputs, input.concurrency, async (eventInput) => {
      const [titleEmbedding, contentEmbedding] = await this.embeddings.batchGenerate([
        capForEmbedding(eventInput.event.title),
        capForEmbedding(`${eventInput.event.title}\n\n${eventInput.event.content}`)
      ]);
      embeddedEvents += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成事件向量（并发 ${input.concurrency}），已完成 ${embeddedEvents}/${eventInputs.length} 个事件`,
        progress: progressForCompleted(embeddedEvents, Math.max(eventInputs.length, 1), 74, 82),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return {
        ...eventInput,
        titleEmbedding,
        contentEmbedding
      } satisfies EventEmbeddingInput;
    });
    stages.eventEmbedding = Date.now() - t2;
    throwIfAborted();

    const entityInputs = dedupeEntityEmbeddingInputs(eventInputs.flatMap((item) => item.event.entities));
    // 3. 实体向量化
    const t3 = Date.now();
    let embeddedEntities = 0;
    const entityEmbeddingEntries = await mapWithConcurrency(entityInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(capForEmbedding(inputItem.entity.name));
      embeddedEntities += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成实体向量（并发 ${input.concurrency}），已完成 ${embeddedEntities}/${entityInputs.length} 个实体`,
        progress: progressForCompleted(embeddedEntities, Math.max(entityInputs.length, 1), 82, 88),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [inputItem.key, embedding] as const;
    });
    const entityEmbeddings = new Map(entityEmbeddingEntries);
    stages.entityEmbedding = Date.now() - t3;
    throwIfAborted();

    const relationInputs: RelationEmbeddingInput[] = eventInputs.flatMap((item) => (
      item.event.entities.map((entity) => ({
        eventId: item.eventId,
        eventTitle: item.event.title,
        entity
      }))
    ));
    // 4. 关系向量化
    const t4 = Date.now();
    let embeddedRelations = 0;
    const relationEmbeddingEntries = await mapWithConcurrency(relationInputs, input.concurrency, async (inputItem) => {
      const embedding = await this.embeddings.generate(capForEmbedding(inputItem.entity.description || `${inputItem.eventTitle} ${inputItem.entity.name}`));
      embeddedRelations += 1;
      input.onProgress?.({
        stage: "EMBEDDING_EVENTS",
        message: `正在并行生成关系向量（并发 ${input.concurrency}），已完成 ${embeddedRelations}/${relationInputs.length} 条关系`,
        progress: progressForCompleted(embeddedRelations, Math.max(relationInputs.length, 1), 88, 92),
        chunkCount: input.chunks.length,
        eventCount: eventInputs.length,
        totalChunks: input.chunks.length
      });
      return [relationEmbeddingKey(inputItem.eventId, inputItem.entity), embedding] as const;
    });
    const relationEmbeddings = new Map(relationEmbeddingEntries);
    stages.relationEmbedding = Date.now() - t4;
    throwIfAborted();

    logger.info({
      title: input.input.title,
      events: eventInputs.length,
      entities: entityInputs.length,
      relations: relationInputs.length,
      stages,
    }, "eventPrep: sub-stages");

    return {
      failedChunks,
      preparedEvents: eventEmbeddingInputs.map((eventInput) => ({
        ...eventInput,
        entities: eventInput.event.entities.map((entity) => {
          const entityEmbedding = entityEmbeddings.get(entityEmbeddingKey(entity));
          const relationEmbedding = relationEmbeddings.get(relationEmbeddingKey(eventInput.eventId, entity));
          if (!entityEmbedding || !relationEmbedding) {
            throw new Error("实体或关系向量生成不完整");
          }
          return {
            ...entity,
            entityEmbedding,
            relationEmbedding
          };
        })
      }))
    };
  }
}

export const ingestionService = new IngestionService();

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function dedupeEntityEmbeddingInputs(entities: ExtractedEntity[]): EntityEmbeddingInput[] {
  const map = new Map<string, EntityEmbeddingInput>();
  for (const entity of entities) {
    const key = entityEmbeddingKey(entity);
    if (!map.has(key)) {
      map.set(key, { key, entity });
    }
  }
  return [...map.values()];
}

function entityEmbeddingKey(entity: ExtractedEntity): string {
  return `${entity.type.trim().toLowerCase()}\u0000${entity.name.trim().toLowerCase()}`;
}

function relationEmbeddingKey(eventId: string, entity: ExtractedEntity): string {
  return `${eventId}\u0000${entityEmbeddingKey(entity)}\u0000${entity.description.trim().toLowerCase()}`;
}

function progressForCompleted(completed: number, total: number, start: number, end: number): number {
  if (total <= 0) {
    return end;
  }
  return Math.min(end, Math.round(start + (completed / total) * (end - start)));
}
