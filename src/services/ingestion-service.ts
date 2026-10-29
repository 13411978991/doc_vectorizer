import { randomUUID } from "node:crypto";
import path from "node:path";
import { isSqlitePool, pool } from "../db/pool.js";
import { toVectorLiteral } from "../db/vector.js";
import { createSource, upsertEntity } from "../db/repositories.js";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { chunkMarkdown, type ChunkDraft } from "../ingestion/chunking/markdown.js";
import { extractEventsFromChunk } from "../ingestion/extract/extractor.js";
import { dbWriteWorkerPool } from "./db-write-worker-pool.js";
import type { ExtractedEntity, ExtractedEvent, IngestDocumentInput, IngestDocumentResult, IngestProgressUpdate } from "../types.js";
import { logger } from "../observability/logger.js";
import { aiSettingsService } from "./ai-settings-service.js";
import { getRuntimePerformanceSettings } from "./performance-settings-service.js";

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
import { EMBEDDING_INPUT_MAX_CHARS } from "../config/tuning-constants.js";

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
 * P-Tier3-#T3a — shared state passed to the three extracted helpers
 * (`runDbWriteCleanup`, `lookupEntityCache`, `buildWriteBatch`) so the
 * parent `ingestDocument` body stays a linear timeline of phases.
 * Keeping the parameters in one struct means each helper signature
 * only changes when the struct's shape changes — call sites stay
 * call-site-compatible across the refactor.
 */
type WriteBatchContext = {
  documentId: string;
  sourceId: string;
  title: string;
  /** Sanitised full document body (sentinels + UNC paths stripped). */
  documentContent: string;
  /** Raw metadata JSON (chunking options, traceId, etc.) to persist
   *  alongside the documents row. Already serialised to a string. */
  documentMetadataJson: string;
  sanitisedSections: Array<{
    id: string;
    heading: string;
    content: string;
    rawContent: string;
    orderIndex: number;
    tokenCount?: number;
  }>;
  sanitisedChunks: ChunkDraft[];
  sectionEmbeddings: number[][];
  chunkEmbeddings: number[][];
  preparedEvents: PreparedEvent[];
  failedChunkCount: number;
  embeddingModelLabel: string;
  signal?: AbortSignal;
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
    // Reuse a pre-existing document id when the caller passes one
    // (re-extract scripts). Otherwise mint a fresh UUID.
    const documentId = input.documentId ?? randomUUID();
    const extract = input.extract ?? true;
    // Capped at 4 — see config/env.ts. Keep the env value so log lines
    // and event payloads reflect the configured limit; this stage just
    // applies the max-4 ceiling so we don't accidentally fan out beyond
    // what the LLM endpoint can handle.
    const ingestConcurrency = Math.min(getRuntimePerformanceSettings().ingestConcurrency, 4);
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

    // Event extraction (LLM) runs CONCURRENTLY with the embedding
    // stages — it only needs the chunk TEXT, never the vectors.
    //
    // Serialising them was a trap: a big workbook produced 2,295
    // chunks, and the (single-threaded) embedding stage needed ~97
    // minutes. The LLM calls therefore started 1.5 hours late, the
    // operator saw "no traffic to the LLM API" for the whole run, and
    // pausing the folder in the meantime aborted the ingest right
    // before eventPrep — so the extraction never ran at all. Running
    // the two in parallel means the LLM sees traffic within seconds
    // and the wall-clock cost becomes max(embedding, extraction)
    // instead of embedding + extraction.
    let eventPrepPromise: Promise<{ preparedEvents: PreparedEvent[]; failedChunks: number }> | null = null;
    let eventPrepTimer: ReturnType<typeof stageTimer> | null = null;
    if (extract && chunking.chunks.length > 0) {
      // Bail BEFORE paying for the LLM if the user just paused.
      if (input.signal?.aborted) {
        throw new IngestAbortError("ingest aborted before eventPrep");
      }
      eventPrepTimer = stageTimer("eventPrep");
      eventPrepPromise = this.prepareEvents({
        input,
        chunks: chunking.chunks,
        onProgress,
        concurrency: ingestConcurrency,
        signal: input.signal
      });
      // If the embedding stage throws first, this promise would be
      // left unhandled → attach a sink so Node doesn't report an
      // unhandled rejection. The real result is awaited below.
      eventPrepPromise.catch(() => undefined);
    }

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
    if (eventPrepPromise) {
      try {
        eventPrepResult = await eventPrepPromise;
      } catch (error) {
        // An abort must still abort the whole ingest.
        if (error instanceof IngestAbortError) throw error;
        logger.warn(
          { error: (error as Error).message },
          "ingest: event preparation failed — continuing without events"
        );
      }
      if (eventPrepTimer) {
        stageResults.push(
          eventPrepTimer.stop({ events: eventPrepResult.preparedEvents.length })
        );
      }
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
    // P-Worker — Move the long dbWrite transaction off the main
    // thread. The previous implementation ran 200+ synchronous
    // better-sqlite3 INSERT/UPDATE statements on the main thread,
    // which blocked Fastify's HTTP event loop for 100-300ms at a
    // time. The db-write-worker child process owns its own SQLite
    // connection, runs the whole batch inside one transaction
    // (single WAL fsync), and only reports results back to the
    // main process over IPC. The single SELECT we still need
    // (entity cache lookup) runs on the main process because it's
    // a single bulk read that the worker pool can issue alongside
    // the write batch.
    const client = await pool.connect();
    // P-Worker-Phase1 — collect the per-document cleanup DELETEs into
    // the same writeStatements array the worker will execute inside
    // one transaction. Previously these 6 sync SQLite calls ran on
    // the main thread (each 50-200ms on a busy DB → 1.2s of HTTP
    // freeze per re-ingest). Now they piggy-back on the worker batch
    // and only cost 1 fsync instead of 6.
    const writeStatements: Array<{ sql: string; params: unknown[] }> = [];
    try {
      // P9 strip: before we let any chunk hit the DB we strip
      // diagnostic sentinel lines (<!--SAG_SKIPPED_SHEET ...-->) that
      // the Python xlsx extractor emits for detail-report sheets +
      // UNC network-share paths so neither gets embedded nor fed
      // back into the LLM. Safe to apply to all formats; non-xlsx
      // content simply doesn't carry those tokens.
      const sanitisedSections = chunking.sections.map((s) => ({
        ...s,
        content: stripChunkContent(s.content),
        rawContent: stripChunkContent(s.rawContent)
      }));
      const sanitisedChunks = chunking.chunks.map((c) => ({
        ...c,
        content: stripChunkContent(c.content),
        rawContent: stripChunkContent(c.rawContent)
      }));

      // P-Tier3-#T3a — the three phases that used to live inline
      // (cleanup → cache → build batch) are now helpers. See
      // `runDbWriteCleanup`, `lookupEntityCache`, `buildWriteBatch`
      // for the implementation. The split keeps the call site
      // readable as a linear timeline while letting each phase be
      // unit-tested or profiled in isolation if needed.
      this.runDbWriteCleanup({
        documentId,
        signal: input.signal,
        writeStatements
      });

      const entityCache = await this.lookupEntityCache({
        ctx: {
          documentId,
          sourceId: source.id,
          title: input.title,
          documentContent: stripChunkContent(input.content),
          documentMetadataJson: JSON.stringify({
            ...(input.metadata ?? {}),
            chunking: chunkingOptions
          }),
          sanitisedSections,
          sanitisedChunks,
          sectionEmbeddings,
          chunkEmbeddings,
          preparedEvents,
          failedChunkCount,
          embeddingModelLabel,
          signal: input.signal
        },
        client
      });

      // Structured log mirrors the inline implementation: surface
      // the entity-resolution phase as its own timer so the
      // "stage=ingest" log line shows it broken out.
      logger.info(
        { stage: "entityResolution", entities: entityCache.size },
        "eventPrep: sub-stages"
      );

      await this.buildWriteBatch({
        ctx: {
          documentId,
          sourceId: source.id,
          title: input.title,
          documentContent: stripChunkContent(input.content),
          documentMetadataJson: JSON.stringify({
            ...(input.metadata ?? {}),
            chunking: chunkingOptions
          }),
          sanitisedSections,
          sanitisedChunks,
          sectionEmbeddings,
          chunkEmbeddings,
          preparedEvents,
          failedChunkCount,
          embeddingModelLabel,
          signal: input.signal
        },
        writeStatements,
        entityCache,
        client,
        onProgress
      });

      // Final abort check before we hand the batch to the worker.
      // Building the writeStatements array is pure CPU + memory —
      // no sync I/O — so the chance of an abort arriving during it
      // is small. But a long `console.log("[entity-debug]", ...)` per
      // entity in the loop above (the entity-cache-miss branch
      // emits one) can add up on a 100+ entity file. Bail here so
      // we don't ship a doomed batch over IPC.
      if (input.signal?.aborted) {
        throw new IngestAbortError("ingest aborted before worker batch");
      }

      // ---- Phase 3: hand the whole batch to the worker (or fallback) ----
      onProgress?.({
        stage: "WRITING_GRAPH",
        message: "正在完成图谱关系写入",
        progress: 95,
        chunkCount: chunking.chunks.length,
        eventCount: preparedEvents.length,
        totalChunks: chunking.chunks.length
      });

      const batchStart = Date.now();
      const result = await dbWriteWorkerPool.runWriteBatch(
        writeStatements,
        undefined,
        input.signal
      );
      logger.info(
        {
          mode: result.mode,
          statements: writeStatements.length,
          durationMs: result.durationMs,
          stageMs: Date.now() - batchStart
        },
        "dbWrite: completed via worker pool"
      );

      stageResults.push(
        dbWriteTimer.stop({
          chunks: chunking.chunks.length,
          events: preparedEvents.length,
          mode: result.mode
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
      // P-Audit-#9 — the previous `await client.query("rollback")` was
      // a no-op bug: this `client` (acquired via pool.connect() at the
      // top of ingestDocument) is used ONLY for entity-cache SELECTs
      // (see lookupEntityCache + the cache-miss fallback in
      // buildWriteBatch). All DB writes go through the
      // dbWriteWorkerPool.runWriteBatch call, which uses a worker-side
      // better-sqlite3 transaction that auto-rollbacks on throw. So
      // calling rollback on this client is meaningless on SQLite (no
      // transaction was ever begun → silent no-op) and BROKEN on PG
      // (would throw "no transaction in progress" and re-throw here,
      // masking the actual ingest failure as a different error).
      //
      // If the worker batch already started executing, its internal
      // db.transaction() wrapper has already rolled back the partial
      // writes. We only need to release the client and re-throw so the
      // caller can flip the manifest to `failed` and surface the
      // error. The error stack + traceId below give the operator the
      // same context as before.
      logger.error(
        { traceId, error: (error as Error).message, errorStack: (error as Error).stack },
        "document ingest failed"
      );
      throw error;
    } finally {
      client.release();
    }
  }

  // P-Tier3-#T3a — extracted from ingestDocument's "Phase 1: cleanup
  // the previous document rows" block. When the caller reuses an
  // existing documentId (re-extract path), this collects the DELETE
  // statements for chunk_vec0 / chunks / event_title_vec0 / events /
  // entity_vec0 / entities so the worker pool can execute them
  // together with the INSERTs in one fsync instead of paying 6
  // separate sync SQLite round-trips on the main thread.
  //
  // Returns void: mutates `writeStatements` in place so the call site
  // doesn't have to thread the array through a return value. Bails
  // with IngestAbortError when the user pauses mid-flow so the
  // remaining phases don't bother constructing a doomed batch.
  private runDbWriteCleanup(input: {
    documentId: string;
    signal?: AbortSignal;
    writeStatements: Array<{ sql: string; params: unknown[] }>;
  }): void {
    if (!input.documentId) return;
    if (input.signal?.aborted) {
      throw new IngestAbortError("ingest aborted before chunk cleanup");
    }
    // The vec0 deletes are SQLite-only — they reference virtual
    // tables that don't exist on the PG schema. The driver guards
    // every push site with isSqlitePool() so a PG build never
    // emits the statement in the first place.
    //
    // P-Tier3-#T3a bugfix: the original `delete from
    // event_title_vec0 where chunk_id in (...)` referenced a column
    // that DOES NOT EXIST on that virtual table (its PK is
    // `event_id`, not `chunk_id`). The bug was silent in production
    // because the dev install never hit the re-ingest path
    // (existing rows are `synced`, not `pending`); the T3d reaper
    // finally surfaced it. Fixed to use `event_id in (select id
    // from events where document_id = ?)`. The same shape applies
    // to `entity_vec0` — the previous code used `rowid` but the
    // vec0 primary key is `entity_id`, so use that directly.
    if (isSqlitePool()) {
      input.writeStatements.push({
        sql: `delete from chunk_vec0 where chunk_id in (select id from chunks where document_id = $1)`,
        params: [input.documentId]
      });
    }
    input.writeStatements.push({
      sql: `delete from chunks where document_id = $1`,
      params: [input.documentId]
    });
    if (isSqlitePool()) {
      input.writeStatements.push({
        sql: `delete from event_title_vec0 where event_id in (select id from events where document_id = $1)`,
        params: [input.documentId]
      });
      input.writeStatements.push({
        sql: `delete from event_content_vec0 where event_id in (select id from events where document_id = $1)`,
        params: [input.documentId]
      });
    }
    input.writeStatements.push({
      sql: `delete from events where document_id = $1`,
      params: [input.documentId]
    });
    if (isSqlitePool()) {
      input.writeStatements.push({
        sql: `delete from entity_vec0 where entity_id in (select id from entities where document_id = $1)`,
        params: [input.documentId]
      });
    }
    input.writeStatements.push({
      sql: `delete from entities where document_id = $1`,
      params: [input.documentId]
    });
  }

  // P-Tier3-#T3a — extracted from ingestDocument's "Phase 1: read-side
  // state" block. Builds the entity name → id cache with ONE bulk
  // SELECT instead of N per-entity SELECTs. The cache is consumed
  // during event_entities insert; cache misses fall back to a per-row
  // lookup at that point (see buildWriteBatch).
  //
  // Why we still run this on the main process: the worker is
  // single-threaded and we want the write batch to enter it ASAP;
  // the SELECT hits the same WAL reader the writer will contend
  // with, so running it on main means a busy main thread can't
  // starve the worker. It IS a sync SQLite call though, so the
  // signal check inside is required for clean pause behaviour.
  private async lookupEntityCache(input: {
    ctx: WriteBatchContext;
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ name: string; id: string }> }> };
  }): Promise<Map<string, string>> {
    const entityCache = new Map<string, string>();
    if (input.ctx.signal?.aborted) {
      throw new IngestAbortError("ingest aborted before entity bulk lookup");
    }
    // Abort check before the entity bulk SELECT. Same rationale as
    // the comment on `runDbWriteCleanup`: a sync SQLite call right
    // before a pause should bail out before we pay for it.
    if (input.ctx.signal?.aborted) {
      throw new IngestAbortError("ingest aborted before entity bulk lookup");
    }
    const allKeys: string[] = [];
    for (const prepared of input.ctx.preparedEvents) {
      for (const entity of prepared.entities) {
        allKeys.push(entity.name);
      }
    }
    if (allKeys.length === 0) {
      return entityCache;
    }
    // Dedupe — an entity can appear in many events but only needs
    // one cache entry. SQLite IN clause is positional, so expand
    // placeholders manually. better-sqlite3 doesn't accept
    // Postgres-style array literals.
    const uniqueKeys = Array.from(new Set(allKeys));
    const placeholders = uniqueKeys.map(() => "?").join(",");
    const bulkLookup = await input.client.query(
      `select name, id from entities where source_id=? and document_id=? and name in (${placeholders})`,
      [input.ctx.sourceId, input.ctx.documentId, ...uniqueKeys]
    );
    for (const row of bulkLookup.rows) {
      entityCache.set(row.name, row.id);
    }
    return entityCache;
  }

  // P-Tier3-#T3a — extracted from ingestDocument's "Phase 2: collect
  // every write statement" block. Pushes every INSERT / UPDATE we
  // need into `writeStatements` so the worker pool can ship the
  // whole batch in one transaction. Splits into five sub-phases:
  //   2a. documents upsert
  //   2b. section chunks + section chunk_embeddings + chunk_state
  //   2c. body chunks + body chunk_embeddings + chunk_state
  //   2d. events + vec0 + entities + event_entities (with entity
  //       cache miss fallback to per-row lookup)
  //   2e. final documents status flip
  //
  // Returns nothing: mutates writeStatements in place. Emits the
  // WRITING_GRAPH progress update so the UI sees the phase advance
  // before the IPC roundtrip.
  private async buildWriteBatch(input: {
    ctx: WriteBatchContext;
    writeStatements: Array<{ sql: string; params: unknown[] }>;
    entityCache: Map<string, string>;
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }> };
    onProgress?: (update: IngestProgressUpdate) => void;
  }): Promise<void> {
    const { ctx, writeStatements, entityCache, onProgress, client } = input;
    // 2a. documents upsert
    writeStatements.push({
      sql: `
        insert into documents (id, source_id, title, content, parse_status, metadata)
        values ($1, $2, $3, $4, 'PARSING', $5)
        on conflict (id) do update set
          title = excluded.title,
          content = excluded.content,
          parse_status = 'PARSING',
          metadata = excluded.metadata,
          updated_at = current_timestamp
      `,
      params: [
        ctx.documentId,
        ctx.sourceId,
        ctx.title,
        ctx.documentContent,
        ctx.documentMetadataJson
      ]
    });
    onProgress?.({
      stage: "WRITING_GRAPH",
      message: "正在写入文档记录",
      progress: 24,
      chunkCount: ctx.sanitisedChunks.length,
      eventCount: ctx.preparedEvents.length,
      totalChunks: ctx.sanitisedChunks.length
    });

    // 2b. section chunks + section chunk_embeddings + chunk_state flip
    for (const [idx, section] of ctx.sanitisedSections.entries()) {
      const sectionEmbedding = ctx.sectionEmbeddings[idx];
      writeStatements.push({
        sql: `
          insert into chunks (
            id, source_id, document_id, rank, heading, content,
            raw_content, token_count, metadata, chunk_state
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        `,
        params: [
          `section-${section.id}`,
          ctx.sourceId,
          ctx.documentId,
          Math.trunc(section.orderIndex * 1000),
          section.heading,
          section.content,
          section.rawContent,
          section.tokenCount ?? 0,
          JSON.stringify({ kind: "section", originalId: section.id })
        ]
      });
      if (sectionEmbedding) {
        writeStatements.push({
          sql: `
            insert into chunk_embeddings (chunk_id, model, embedding_json)
            values ($1, $2, $3)
            on conflict (chunk_id) do update set embedding_json = excluded.embedding_json
          `,
          params: [
            `section-${section.id}`,
            ctx.embeddingModelLabel,
            toVectorLiteral(sectionEmbedding)
          ]
        });
        if (isSqlitePool()) {
          writeStatements.push({
            sql: `insert into chunk_vec0 (chunk_id, embedding) values ($1, $2)`,
            params: [`section-${section.id}`, new Float32Array(sectionEmbedding)]
          });
        }
        writeStatements.push({
          sql: `update chunks set chunk_state = 'embedded' where id = $1`,
          params: [`section-${section.id}`]
        });
      }
    }

    // 2c. body chunks + body chunk_embeddings + chunk_state flip
    for (const [index, chunk] of ctx.sanitisedChunks.entries()) {
      writeStatements.push({
        sql: `
          insert into chunks (
            id, source_id, document_id, rank, heading, content,
            raw_content, token_count, metadata, chunk_state
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        `,
        params: [
          chunk.id,
          ctx.sourceId,
          ctx.documentId,
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
      });
      writeStatements.push({
        sql: `
          insert into chunk_embeddings (chunk_id, model, embedding_json)
          values ($1, $2, $3)
          on conflict (chunk_id) do update set embedding_json = excluded.embedding_json
        `,
        params: [
          chunk.id,
          ctx.embeddingModelLabel,
          toVectorLiteral(ctx.chunkEmbeddings[index])
        ]
      });
      if (isSqlitePool()) {
        writeStatements.push({
          sql: `insert into chunk_vec0 (chunk_id, embedding) values ($1, $2)`,
          params: [chunk.id, new Float32Array(ctx.chunkEmbeddings[index])]
        });
      }
      writeStatements.push({
        sql: `update chunks set chunk_state = 'embedded' where id = $1`,
        params: [chunk.id]
      });
    }

    // 2d. events + event_title_vec0 + event_content_vec0 + entities
    const tEventInsert = Date.now();
    for (const prepared of ctx.preparedEvents) {
      writeStatements.push({
        sql: `insert into events (id, source_id, document_id, chunk_id, title, content, category, status, rank, summary, title_embedding_json, content_embedding_json, extraction_source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        params: [
          prepared.eventId,
          ctx.sourceId,
          ctx.documentId,
          prepared.chunk.id,
          prepared.event.title,
          prepared.event.content,
          prepared.event.category ?? "fact",
          prepared.event.status ?? "CONFIRMED",
          prepared.rank,
          prepared.event.summary,
          toVectorLiteral(prepared.titleEmbedding),
          toVectorLiteral(prepared.contentEmbedding),
          prepared.event.extractionSource ?? "remote-llm"
        ]
      });
      if (isSqlitePool()) {
        writeStatements.push({
          sql: `insert into event_title_vec0 (event_id, embedding) values ($1, $2)`,
          params: [prepared.eventId, new Float32Array(prepared.titleEmbedding)]
        });
        writeStatements.push({
          sql: `insert into event_content_vec0 (event_id, embedding) values ($1, $2)`,
          params: [prepared.eventId, new Float32Array(prepared.contentEmbedding)]
        });
      }
      for (const entity of prepared.entities) {
        // P-Debug-Log — gated behind SAG_DEBUG=1 (production skip).
        if (process.env.SAG_DEBUG === "1") {
          // eslint-disable-next-line no-console
          console.log(
            "[entity-debug]",
            JSON.stringify({
              entityName: entity.name,
              entityType: entity.type,
              sourceId: ctx.sourceId,
              documentId: ctx.documentId,
              eventId: prepared.eventId,
              eventTitle: prepared.event.title
            })
          );
        }
        // Resolve the entity id from the cache (entities seen in a
        // PREVIOUS document). On miss we mint a fresh UUID up front
        // and reuse it for the entities row, the entity_vec0 row, and
        // the event_entities row in this loop — so the three INSERTs
        // are all consistent without ever needing to SELECT what
        // hasn't been written yet.
        //
        // Previous implementation (pre-2026-10-12) pushed a different
        // randomUUID() to entity_vec0 from the one used for entities,
        // AND fell back to a `select id from entities where name=?`
        // after pushing the entities INSERT to writeStatements. That
        // fallback could NEVER find the row — the entities INSERT
        // hadn't been executed yet (it was still in the array waiting
        // for the worker batch to commit). Every fresh entity name
        // logged "[entity-debug] ERROR: entity not found after
        // insert!" and silently dropped its event_entities link. The
        // T3d pending-orphan reaper finally surfaced this on the
        // 盈旺精密 TB re-ingest. Fixed by capturing the id at INSERT
        // time and threading it into the cache for the rest of the
        // batch.
        //
        // isFirstOccurrence: the entity INSERT and entity_vec0 INSERT
        // are PK-constrained (entities.id text primary key, vec0 PK
        // is entity_id), so they must be emitted at most ONCE per
        // entity name in this batch. The event_entities link INSERT
        // (PK is its own id) still runs for every (event, entity)
        // pair — multiple events can legitimately share one entity.
        const isFirstOccurrence = !entityCache.has(entity.name);
        let resolvedId: string | undefined = entityCache.get(entity.name);
        if (!resolvedId) {
          if (ctx.signal?.aborted) {
            throw new IngestAbortError("ingest aborted during entity resolution");
          }
          resolvedId = randomUUID();
          entityCache.set(entity.name, resolvedId);
        }
        if (isFirstOccurrence) {
          writeStatements.push({
            sql: `insert into entities (id, source_id, document_id, name, normalized_name, type, description, embedding_json)
             values ($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict do nothing`,
            params: [
              resolvedId,
              ctx.sourceId,
              ctx.documentId,
              entity.name,
              entity.name.toLowerCase().trim(),
              entity.type,
              entity.description,
              toVectorLiteral(entity.entityEmbedding)
            ]
          });
          if (isSqlitePool()) {
            writeStatements.push({
              sql: `insert into entity_vec0 (entity_id, embedding) values ($1, $2)`,
              params: [resolvedId, new Float32Array(entity.entityEmbedding)]
            });
          }
        }
        writeStatements.push({
          sql: `insert into event_entities (id, event_id, entity_id) values ($1,$2,$3) on conflict do nothing`,
          params: [randomUUID(), prepared.eventId, resolvedId]
        });
      }
    }
    const eventInsertMs = Date.now() - tEventInsert;
    logger.info(
      { stage: "eventInsert", ms: eventInsertMs, events: ctx.preparedEvents.length },
      "eventPrep: sub-stages"
    );

    // 2e. final status update — flip parse_status from PARSING to
    // COMPLETED/PARTIAL_SUCCESS once every chunk + event row has
    // been written. The worker pool will run this LAST inside the
    // single transaction.
    const finalStatus = ctx.failedChunkCount > 0 ? "PARTIAL_SUCCESS" : "COMPLETED";
    writeStatements.push({
      sql: "update documents set parse_status = $1, updated_at = now() where id = $2",
      params: [finalStatus, ctx.documentId]
    });
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

    // 2. 事件 / 实体 / 关系向量化
    //
    // 这三组文本彼此独立，之前却是"每个条目一次请求"（事件 2 条文本、
    // 实体 1 条、关系 1 条），而且三组还串行执行。于是一份 9 事件 +
    // 6 实体 + 6 关系的文档要发 21 次独立请求，每次都要排在向量 worker
    // 的串行队列后面等上一批 64 条跑完（~100s）——实测 3 个切片的文档
    // 光 eventPrep 就花了 17 分钟（eventEmbedding/entityEmbedding/
    // relationEmbedding 各自 90~100s，而真正要算的向量只有几十条）。
    //
    // 现在改成"每组一次批量请求 + 三组并行发出"：一次文档只占用
    // ⌈文本数 / EMBEDDING_WORKER_REQUEST_BATCH⌉ 个 worker 批次，
    // 21 次串行队列等待变成 1~2 次。
    throwIfAborted();
    const t2 = Date.now();
    const entityInputs = dedupeEntityEmbeddingInputs(eventInputs.flatMap((item) => item.event.entities));
    const relationInputs: RelationEmbeddingInput[] = eventInputs.flatMap((item) => (
      item.event.entities.map((entity) => ({
        eventId: item.eventId,
        eventTitle: item.event.title,
        entity
      }))
    ));

    // 2a. 事件向量（每个事件 2 条文本：标题、标题+正文）
    const eventTexts: string[] = [];
    for (const eventInput of eventInputs) {
      eventTexts.push(capForEmbedding(eventInput.event.title));
      eventTexts.push(capForEmbedding(`${eventInput.event.title}\n\n${eventInput.event.content}`));
    }
    // 2b. 实体向量（实体名）
    const entityTexts = entityInputs.map((item) => capForEmbedding(item.entity.name));
    // 2c. 关系向量（实体描述或"事件标题 + 实体名"）
    const relationTexts = relationInputs.map((item) =>
      capForEmbedding(item.entity.description || `${item.eventTitle} ${item.entity.name}`)
    );

    input.onProgress?.({
      stage: "EMBEDDING_EVENTS",
      message: `正在批量生成事件 / 实体 / 关系向量（${eventTexts.length + entityTexts.length + relationTexts.length} 条文本）`,
      progress: progressForCompleted(0, Math.max(eventTexts.length + entityTexts.length + relationTexts.length, 1), 74, 92),
      chunkCount: input.chunks.length,
      eventCount: eventInputs.length,
      totalChunks: input.chunks.length
    });

    // 三组互不依赖，一次性并发发出；向量 worker 内部会按
    // EMBEDDING_WORKER_REQUEST_BATCH 自行拆批。
    const [eventVectors, entityVectors, relationVectors] = await Promise.all([
      eventTexts.length > 0 ? this.embeddings.batchGenerate(eventTexts) : Promise.resolve([]),
      entityTexts.length > 0 ? this.embeddings.batchGenerate(entityTexts) : Promise.resolve([]),
      relationTexts.length > 0 ? this.embeddings.batchGenerate(relationTexts) : Promise.resolve([])
    ]);
    stages.eventEmbedding = Date.now() - t2;
    throwIfAborted();

    const entityEmbeddings = new Map<string, number[]>();
    entityInputs.forEach((inputItem, index) => {
      const vector = entityVectors[index];
      if (vector) entityEmbeddings.set(inputItem.key, vector);
    });
    stages.entityEmbedding = Date.now() - t2;
    throwIfAborted();

    const relationEmbeddings = new Map<string, number[]>();
    relationInputs.forEach((inputItem, index) => {
      const vector = relationVectors[index];
      if (vector) relationEmbeddings.set(relationEmbeddingKey(inputItem.eventId, inputItem.entity), vector);
    });
    stages.relationEmbedding = Date.now() - t2;
    throwIfAborted();

    const eventEmbeddingInputs: EventEmbeddingInput[] = eventInputs.map((eventInput, index) => ({
      ...eventInput,
      titleEmbedding: eventVectors[index * 2],
      contentEmbedding: eventVectors[index * 2 + 1]
    }));

    input.onProgress?.({
      stage: "EMBEDDING_EVENTS",
      message: `已完成事件 / 实体 / 关系向量（${eventInputs.length} 事件、${entityInputs.length} 实体、${relationInputs.length} 关系）`,
      progress: progressForCompleted(
        eventInputs.length + entityInputs.length + relationInputs.length,
        Math.max(eventInputs.length + entityInputs.length + relationInputs.length, 1),
        74,
        92
      ),
      chunkCount: input.chunks.length,
      eventCount: eventInputs.length,
      totalChunks: input.chunks.length
    });

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

/**
 * P9 strip: drop diagnostic sentinel lines + UNC paths from any
 * chunk content before it lands in `chunks.content` (which is
 * embedded AND fed back into the LLM).
 *
 *   - `<!--SAG_SKIPPED_SHEET code=... label=...-->` is emitted by
 *     scripts/extract-office.py for detail-report sheets + sheets
 *     exceeding the row/col cap. The sheet name and reason are
 *     already surfaced separately to the manifest metadata; the
 *     inline version was embedding/leaking the network share path.
 *   - UNC and absolute Windows paths (`\\server\share\...`,
 *     `C:\foo\bar`, `D:\...`) — none of those belong in retrieval
 *     chunks. We strip just the path token, keeping surrounding
 *     punctuation and surrounding words intact.
 *
 * This is intentionally a pure text transform — no schema migration
 * required, runs in <1 ms for a 50k-character chunk, and is
 * idempotent (re-running on already-clean content is a no-op).
 */
export function stripChunkContent(content: string): string {
  if (!content) return content;
  const SAG_SHEET_SENTINEL = /<!--\s*SAG_SKIPPED_SHEET\b[^>]*-->\s*\n?/g;
  // Match UNC paths and Windows drive-letter paths in one go.
  const UNC_OR_DRIVE_PATH =
    /(?:\\\\[^\s/:*?"<>|\r\n]+(?:[\\/][^\s/:*?"<>|\r\n]+)*|[A-Za-z]:\\[^\s/:*?"<>|\r\n]+)/g;
  return content
    .replace(SAG_SHEET_SENTINEL, "")
    .replace(UNC_OR_DRIVE_PATH, "[redacted-path]");
}
