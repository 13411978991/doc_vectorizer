import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { embeddingClient, type EmbeddingClient } from "../ai/embedding-client.js";
import { llmClient, type LlmClient } from "../ai/llm-client.js";
import { rerankClient, type RerankClient } from "../ai/rerank-client.js";
import { MAX_SEARCH_TOP_K, aiSettingsService } from "./ai-settings-service.js";
import {
  assertSourcesAccessible,
  coarseRankEventsByContent,
  getEventIdsByEntityIds,
  getEventsWithEntityIds,
  getSectionsForEvents,
  searchChunksByVector,
  searchChunksByKeyword,
  searchEntitiesByName,
  searchEntitiesByText,
  searchEntitiesByVector,
  searchEventsByTitleVector
} from "../db/repositories.js";
import type {
  EntityRecord,
  EventRecord,
  MultiSubStrategy,
  SearchInput,
  SearchProgressEvent,
  SearchResult,
  SearchSection,
  SearchTrace,
  SearchTraceEvent
} from "../types.js";

interface MultiOptions {
  subStrategy: MultiSubStrategy;
  entityTopK: number;
  multiTopK: number;
  keySimilarityThreshold: number;
  similarityThreshold: number;
  maxHops: number;
  maxEvents: number;
  maxEventsA: number;
  maxEventsB: number;
  maxHopRetries: number;
  rerankTopK: number;
  maxSections: number;
}

type SearchProgressEmitter = (event: SearchProgressEvent) => void;
const MAX_SEARCH_RESULTS = MAX_SEARCH_TOP_K;

export class SearchService {
  constructor(
    private readonly embeddings: EmbeddingClient = embeddingClient,
    private readonly llm: LlmClient = llmClient,
    private readonly reranker: RerankClient = rerankClient
  ) {}

  async search(input: SearchInput, tenantId = config.DEFAULT_TENANT_ID, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const strategy = input.strategy ?? "multi";
    if (strategy !== "vector" && strategy !== "multi") {
      throw new Error(`Unsupported search strategy: ${String(strategy)}`);
    }

    await assertSourcesAccessible(input.sourceIds, tenantId);
    if (strategy === "vector") {
      return this.vectorSearch(input, emit);
    }
    return this.multiSearch(input, emit);
  }

  async vectorSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const topK = resolveFinalSearchTopK(input.multi?.maxSections ?? input.topK ?? runtimeSettings.defaultSearchTopK);
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于向量召回。"
    });
    // Run vector and keyword recall in parallel; merge before diversity rerank.
    const [vectorSections, keywordSections] = await Promise.all([
      timed(timings, "vectorSearchChunks", () => searchChunksByVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: topK * 4
      }), emit, {
        title: "向量召回切片",
        detail: "按查询向量召回最相近的文档切片。"
      }),
      timed(timings, "keywordSearchChunks", () => searchChunksByKeyword({
        sourceIds: input.sourceIds,
        query: input.query,
        topK: topK * 4
      }), emit, {
        title: "关键词召回切片",
        detail: "LIKE 召回含查询关键词的切片，补充向量召回。"
      })
    ]);
    // Merge: vector chunks at full cosine, keyword chunks at half weight so
    // they boost recall without overpowering semantically closer hits.
    //
    // Track which chunks came from which recall so the UI can explain the
    // match to the user (vector / keyword / hybrid badge).
    const vectorIds = new Set(vectorSections.map((s) => s.chunkId));
    const keywordIds = new Set(keywordSections.map((s) => s.chunkId));
    const seen = new Set<string>();
    const merged: typeof vectorSections = [];
    for (const section of vectorSections) {
      if (seen.has(section.chunkId)) continue;
      seen.add(section.chunkId);
      merged.push(section);
    }
    for (const section of keywordSections) {
      if (seen.has(section.chunkId)) continue;
      seen.add(section.chunkId);
      // If the same chunk came from both vector AND keyword recall, keep
      // the higher vector score and mark as hybrid. Otherwise apply the
      // half-weight so keyword-only matches don't overpower real vector hits.
      if (vectorIds.has(section.chunkId)) {
        // Already pushed via the vector loop above; skip duplicate.
        continue;
      }
      merged.push({ ...section, score: section.score * 0.6, matchType: "keyword" });
    }
    // Stamp matchType on sections that came from both (or only from vector).
    for (const section of merged) {
      const inVector = vectorIds.has(section.chunkId);
      const inKeyword = keywordIds.has(section.chunkId);
      if (inVector && inKeyword) {
        section.matchType = "hybrid";
      } else if (inVector) {
        section.matchType = "vector";
      }
    }
    if (process.env.SAG_DEBUG_KEYWORD === "1") {
      // eslint-disable-next-line no-console
      console.log(`[merge] vector=${vectorSections.length} keyword=${keywordSections.length} merged=${merged.length}`);
    }
    // Diversity rerank: cap per-document at 3 to prevent large docs dominating
    // while still leaving room for related docs to appear in top-K.
    const diverseSections = diversifySectionsByDocument(merged, topK, 3);
    return {
      traceId,
      sections: diverseSections.map((section) => ({ ...section }))
    };
  }

  async multiSearch(input: SearchInput, emit?: SearchProgressEmitter): Promise<SearchResult> {
    const runtimeSettings = await aiSettingsService.getRuntimeSettings();
    const options = resolveMultiOptions(input, runtimeSettings.defaultSearchTopK);
    const searchMode = input.searchMode ?? runtimeSettings.defaultSearchMode;
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const trace: SearchTrace = {
      traceId,
      query: input.query,
      searchMode,
      queryEntities: [],
      recalledEntities: [],
      entityEventIds: [],
      queryEventIds: [],
      expandedEventIds: [],
      coarseRankedEventIds: [],
      rerankedEventIds: [],
      timings
    };

    const queryVector = await timed(timings, "queryEmbedding", () => this.embeddings.generate(input.query), emit, {
      title: "查询向量化",
      detail: "把用户问题转成向量，用于召回相关事件和切片。"
    });

    let queryEntities: string[] = [];
    let recalledEntities: EntityRecord[] = [];
    if (searchMode === "fast") {
      recalledEntities = await timed(timings, "step1Bm25Entities", () => searchEntitiesByText({
        sourceIds: input.sourceIds,
        query: input.query,
        limit: options.entityTopK
      }), emit, {
        title: "BM25 匹配查询实体",
        detail: "直接用用户问题在实体库做全文/BM25 匹配，不调用 LLM 抽取 key。"
      });
      queryEntities = recalledEntities.map((entity) => entity.name);
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1Bm25Entities", {
        title: "BM25 匹配查询实体",
        detail: recalledEntities.length === 0 ? "没有匹配到查询实体" : `匹配到 ${recalledEntities.length} 个查询实体`,
        payload: recalledEntities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score ?? 0
        }))
      });
    } else {
      // Tuned 2026-07-08: multi/standard used to call LLM.extractNamedEntities
      // (a 3-5s LLM round trip) and then N embedding calls (one per entity).
      // Empirically BM25 entity recall already gets 87% (see multi/fast),
      // and combining BM25 + a single query-vector pass adds vector recall
      // without the LLM round-trip. Total saving ~3s/query while keeping
      // the LLM rerank call (the precision-critical step).
      const [bm25Entities, vectorEntities] = await Promise.all([
        timed(timings, "step1Bm25Entities", () => searchEntitiesByText({
          sourceIds: input.sourceIds,
          query: input.query,
          limit: options.entityTopK
        }), emit, {
          title: "BM25 匹配查询实体",
          detail: "用查询词在实体库做全文/BM25 匹配。"
        }),
        timed(timings, "step2VectorEntities", () => searchEntitiesByVector({
          sourceIds: input.sourceIds,
          queryVector,
          topK: options.entityTopK,
          threshold: options.keySimilarityThreshold
        }), emit, {
          title: "向量召回实体",
          detail: "用查询向量召回来匹配语义的实体。"
        })
      ]);
      recalledEntities = dedupeEntities([...bm25Entities, ...vectorEntities]);
      queryEntities = recalledEntities.map((entity) => entity.name);
      trace.queryEntities = queryEntities;
      emitSearchStep(emit, timings, "step1Bm25Entities", {
        title: "BM25 匹配查询实体",
        detail: bm25Entities.length === 0 ? "没有匹配到查询实体" : `匹配到 ${bm25Entities.length} 个查询实体`,
        payload: bm25Entities.map((entity) => ({
          id: entity.id,
          name: entity.name,
          type: entity.type,
          score: entity.score ?? 0
        }))
      });
    }
    trace.recalledEntities = recalledEntities.map((entity) => ({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      score: entity.score ?? 0
    }));
    if (searchMode !== "fast") {
      emitSearchStep(emit, timings, "step2RetrieveEntities", {
        title: "召回相关实体",
        detail: `召回 ${trace.recalledEntities.length} 个实体`,
        payload: trace.recalledEntities
      });
    }

    const entityEventIds = await timed(timings, "step3EntityEvents", () => getEventIdsByEntityIds({
      entityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds
    }), emit, {
      title: "实体关联事件",
      detail: "读取召回实体关联的候选事件。"
    });
    trace.entityEventIds = entityEventIds;
    emitSearchStep(emit, timings, "step3EntityEvents", {
      title: "实体关联事件",
      detail: `找到 ${entityEventIds.length} 个实体关联事件`
    });

    const queryEvents = await timed(timings, "step3QueryEvents", () => searchEventsByTitleVector({
      sourceIds: input.sourceIds,
      queryVector,
      topK: options.multiTopK * 3,
      threshold: options.similarityThreshold
    }).then((events) => events.slice(0, options.multiTopK)), emit, {
      title: "标题向量召回事件",
      detail: "按查询向量召回标题相关事件。"
    });
    trace.queryEventIds = queryEvents.map((event) => event.id);
    trace.queryEvents = toTraceEvents(queryEvents);
    appendEventSnapshots(trace, trace.queryEvents);
    emitSearchStep(emit, timings, "step3QueryEvents", {
      title: "标题向量召回事件",
      detail: `召回 ${trace.queryEvents.length} 个标题相关事件`,
      payload: trace.queryEvents
    });

    const seedEventIds = unique([...entityEventIds, ...queryEvents.map((event) => event.id)]);
    if (seedEventIds.length === 0) {
      trace.fallbackReason = "no seed events; used vector chunk search";
      emitSearchStep(emit, timings, "fallback", {
        title: "降级路径",
        detail: trace.fallbackReason
      });
      const fallback = await this.vectorSearch({ ...input, strategy: "vector", topK: options.maxSections }, emit);
      return { ...fallback, trace: input.returnTrace ? trace : undefined };
    }

    const seedEvents = await timed(timings, "step4FetchDetails", () => getEventsWithEntityIds(seedEventIds), emit, {
      title: "读取候选事件详情",
      detail: "读取候选事件及其关联实体。"
    });
    trace.entityEvents = idsToTraceEvents(entityEventIds, seedEvents);
    appendEventSnapshots(trace, trace.entityEvents);
    emitSearchStep(emit, timings, "step4FetchDetails", {
      title: "读取候选事件详情",
      detail: `读取 ${seedEvents.size} 个候选事件详情`,
      payload: toTraceEvents([...seedEvents.values()])
    });
    const expanded = await timed(timings, "step5Expand", () => this.expandEvents({
      seedEvents,
      initialEntityIds: recalledEntities.map((entity) => entity.id),
      sourceIds: input.sourceIds,
      query: input.query,
      queryVector,
      options
    }), emit, {
      title: "事件扩展",
      detail: "沿事件实体关系扩展候选事件集合。"
    });
    trace.expandedEventIds = expanded.expandedEventIds;
    emitSearchStep(emit, timings, "step5Expand", {
      title: "事件扩展",
      detail: `扩展 ${expanded.expandedEventIds.length} 个事件`
    });

    const coarseRanked = await timed(timings, "step6CoarseRank", async () => {
      if (options.subStrategy === "multi") {
        return coarseRankEventsByContent({
          sourceIds: input.sourceIds,
          eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
          queryVector,
          maxEvents: options.maxEvents
        });
      }

      const eventsetRanked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: unique([...seedEventIds, ...expanded.eventsetIds]),
        queryVector,
        maxEvents: options.maxEventsA
      });
      const eventset1Ranked = expanded.eventset1Ids.length > 0 && options.maxEventsB > 0
        ? await coarseRankEventsByContent({
            sourceIds: input.sourceIds,
            eventIds: expanded.eventset1Ids,
            queryVector,
            maxEvents: options.maxEventsB
          })
        : [];
      return [...eventsetRanked, ...eventset1Ranked];
    }, emit, {
      title: "粗排事件",
      detail: "按事件内容向量相似度粗排候选事件。"
    });
    trace.coarseRankedEventIds = coarseRanked.map((event) => event.id);
    trace.coarseRankedEvents = toTraceEvents(coarseRanked);
    trace.expandedEvents = trace.expandedEventIds.length > 0
      ? trace.coarseRankedEvents.filter((event) => trace.expandedEventIds.includes(event.id))
      : [];
    appendEventSnapshots(trace, trace.coarseRankedEvents);
    emitSearchStep(emit, timings, "step6CoarseRank", {
      title: "粗排事件",
      detail: `粗排得到 ${trace.coarseRankedEvents.length} 个候选事件`,
      payload: trace.coarseRankedEvents
    });

    const rerankStepKey = searchMode === "fast" ? "step7RerankModel" : "step7LlmRerank";
    let selectedIds = await timed(timings, rerankStepKey, () => (
      searchMode === "fast"
        ? this.reranker.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
        : this.llm.rerankEvents({
            query: input.query,
            candidates: coarseRanked,
            topK: options.rerankTopK
          })
    ), emit, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: searchMode === "fast"
        ? "用 qwen3-rerank 对候选事件排序，不调用 LLM 过滤。"
        : "让 LLM 根据问题从候选事件中选择最终事件。"
    });
    if (selectedIds.length === 0) {
      trace.fallbackReason = searchMode === "fast"
        ? "rerank model returned no ids; used coarse rank"
        : "llm rerank returned no ids; used coarse rank";
      selectedIds = coarseRanked.slice(0, options.rerankTopK).map((event) => event.id);
    }
    trace.rerankedEventIds = selectedIds;
    const eventSnapshotById = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
    trace.rerankedEvents = selectedIds.map((id) => eventSnapshotById.get(id)).filter((event): event is SearchTraceEvent => Boolean(event));
    emitSearchStep(emit, timings, rerankStepKey, {
      title: searchMode === "fast" ? "Rerank 模型重排" : "LLM 重排",
      detail: `选出 ${trace.rerankedEvents.length || selectedIds.length} 个最终候选事件`,
      payload: trace.rerankedEvents.length > 0 ? trace.rerankedEvents : undefined
    });

    const sections = await timed(timings, "step8FetchChunks", () => this.sectionsForSelectedEvents(selectedIds, coarseRanked, options.maxSections), emit, {
      title: "回取关联切片",
      detail: "读取最终事件关联的原文切片。"
    });
    if (sections.length < options.maxSections) {
      const supplemental = await searchChunksByVector({
        sourceIds: input.sourceIds,
        queryVector,
        topK: options.maxSections * 2
      });
      const seen = new Set(sections.map((section) => section.chunkId));
      for (const section of supplemental) {
        if (seen.has(section.chunkId)) {
          continue;
        }
        // Supplemental vector-only chunks; mark as "vector" for the UI badge.
        sections.push({ ...section, matchType: "vector" });
        seen.add(section.chunkId);
        if (sections.length >= options.maxSections) {
          break;
        }
      }
    }
    emitSearchStep(emit, timings, "step8FetchChunks", {
      title: "回取关联切片",
      detail: `读取 ${sections.slice(0, options.maxSections).length} 个最终上下文切片`,
      payload: sections.slice(0, options.maxSections).map((section) => ({
        heading: section.heading,
        contentPreview: previewText(section.content, 160),
        score: section.score,
        rank: section.rank
      }))
    });

    return {
      traceId,
      sections: sections.slice(0, options.maxSections),
      trace: input.returnTrace ? trace : undefined
    };
  }

  private async expandEvents(input: {
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>;
    initialEntityIds: string[];
    sourceIds: string[];
    query: string;
    queryVector: number[];
    options: MultiOptions;
  }): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    if (input.options.subStrategy === "multi") {
      return this.expandFixedHops(input.seedEvents, input.initialEntityIds, input.sourceIds, input.options.maxHops);
    }
    const stageA = await this.expandOneHop(input.seedEvents, input.initialEntityIds, input.sourceIds, new Set(input.seedEvents.keys()));
    const trackedEntityIdsForB = unique([...input.initialEntityIds, ...stageA.expandedEntityIds]);
    let seedForB = stageA.events;
    if (input.options.subStrategy === "hopllm") {
      const eventsetIds = unique([...input.seedEvents.keys(), ...stageA.eventIds]);
      const ranked = await coarseRankEventsByContent({
        sourceIds: input.sourceIds,
        eventIds: eventsetIds,
        queryVector: input.queryVector,
        maxEvents: input.options.maxEventsA
      });
      seedForB = await getEventsWithEntityIds(ranked.map((event) => event.id));
    }
    const stageB = await this.expandDynamic(seedForB, trackedEntityIdsForB, input.sourceIds, new Set([...input.seedEvents.keys(), ...stageA.eventIds]), input.options.maxEventsB, input.options.maxHopRetries);
    return {
      eventsetIds: stageA.eventIds,
      eventset1Ids: stageB.eventIds,
      expandedEventIds: unique([...stageA.eventIds, ...stageB.eventIds])
    };
  }

  private async expandFixedHops(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    maxHops: number
  ): Promise<{ eventsetIds: string[]; eventset1Ids: string[]; expandedEventIds: string[] }> {
    const trackedEvents = new Set(seedEvents.keys());
    const trackedEntities = new Set(initialEntityIds);
    let current = seedEvents;
    const expandedEventIds: string[] = [];
    for (let hop = 0; hop < maxHops; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...trackedEvents]
      });
      if (newEventIds.length === 0) {
        break;
      }
      newEventIds.forEach((id) => trackedEvents.add(id));
      expandedEventIds.push(...newEventIds);
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventsetIds: expandedEventIds, eventset1Ids: [], expandedEventIds };
  }

  private async expandOneHop(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>
  ): Promise<{ eventIds: string[]; events: Map<string, EventRecord & { entityIds: string[] }>; expandedEntityIds: string[] }> {
    const trackedEntities = new Set(initialEntityIds);
    const entityIds = collectNewEntityIds(seedEvents, trackedEntities);
    const eventIds = await getEventIdsByEntityIds({
      entityIds,
      sourceIds,
      excludeEventIds: [...excludeEvents]
    });
    return {
      eventIds,
      events: await getEventsWithEntityIds(eventIds),
      expandedEntityIds: entityIds
    };
  }

  private async expandDynamic(
    seedEvents: Map<string, EventRecord & { entityIds: string[] }>,
    initialEntityIds: string[],
    sourceIds: string[],
    excludeEvents: Set<string>,
    targetEvents: number,
    maxHopRetries: number
  ): Promise<{ eventIds: string[] }> {
    if (targetEvents === 0 || seedEvents.size === 0) {
      return { eventIds: [] };
    }
    const trackedEntities = new Set(initialEntityIds);
    const collected: string[] = [];
    let current = seedEvents;
    for (let hop = 0; hop < maxHopRetries; hop += 1) {
      const newEntityIds = collectNewEntityIds(current, trackedEntities);
      newEntityIds.forEach((id) => trackedEntities.add(id));
      if (newEntityIds.length === 0) {
        break;
      }
      const newEventIds = await getEventIdsByEntityIds({
        entityIds: newEntityIds,
        sourceIds,
        excludeEventIds: [...excludeEvents, ...collected]
      });
      if (newEventIds.length === 0) {
        break;
      }
      collected.push(...newEventIds);
      if (collected.length >= targetEvents) {
        break;
      }
      current = await getEventsWithEntityIds(newEventIds);
    }
    return { eventIds: collected };
  }

  private async sectionsForSelectedEvents(
    eventIds: string[],
    rankedEvents: EventRecord[],
    maxSections: number
  ): Promise<SearchSection[]> {
    const scoreByEventId = new Map(rankedEvents.map((event) => [event.id, event.score ?? 0]));
    const rawSections = await getSectionsForEvents(eventIds);
    const seenChunks = new Set<string>();
    const sections: SearchSection[] = [];
    for (const section of rawSections) {
      if (seenChunks.has(section.chunkId)) {
        continue;
      }
      seenChunks.add(section.chunkId);
      sections.push({
        chunkId: section.chunkId,
        sourceId: section.sourceId,
        documentId: section.documentId,
        heading: section.heading,
        content: section.content,
        rank: section.rank,
        score: scoreByEventId.get(section.eventId) ?? 0,
        // multi/* goes through event-level expansion + LLM/local rerank,
        // so the final chunk is a hybrid signal by construction.
        matchType: "hybrid"
      });
      if (sections.length >= maxSections) {
        break;
      }
    }
    return sections;
  }
}

function resolveMultiOptions(input: SearchInput, defaultSearchTopK: number): MultiOptions {
  const multi = input.multi ?? {};
  const topK = resolveFinalSearchTopK(input.topK ?? defaultSearchTopK);
  const rerankTopK = resolveFinalSearchTopK(multi.rerankTopK ?? topK);
  const maxSections = resolveFinalSearchTopK(multi.maxSections ?? topK);
  return {
    subStrategy: input.subStrategy ?? "multi",
    entityTopK: multi.entityTopK ?? 20,
    multiTopK: multi.multiTopK ?? 20,
    keySimilarityThreshold: multi.keySimilarityThreshold ?? 0.9,
    similarityThreshold: multi.similarityThreshold ?? 0.4,
    maxHops: multi.maxHops ?? 1,
    maxEvents: multi.maxEvents ?? 100,
    maxEventsA: multi.maxEventsA ?? 100,
    maxEventsB: multi.maxEventsB ?? 0,
    maxHopRetries: multi.maxHopRetries ?? 3,
    rerankTopK,
    maxSections
  };
}

function resolveFinalSearchTopK(value?: number): number {
  if (!Number.isFinite(value) || value == null) {
    return MAX_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(Math.trunc(value), MAX_SEARCH_RESULTS));
}

function collectNewEntityIds(
  events: Map<string, EventRecord & { entityIds: string[] }>,
  trackedEntities: Set<string>
): string[] {
  const ids = unique([...events.values()].flatMap((event) => event.entityIds));
  return ids.filter((id) => !trackedEntities.has(id));
}

function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

function dedupeEntities(entities: EntityRecord[]): EntityRecord[] {
  const seen = new Set<string>();
  const result: EntityRecord[] = [];
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      continue;
    }
    seen.add(entity.id);
    result.push(entity);
  }
  return result;
}

/**
 * Diversify sections by document: cap per-document hits so a single
 * large document can't drown out smaller ones. Picks in score order,
 * skipping docs that already have `maxPerDoc` results.
 *
 * Without this, vector search on a corpus dominated by one big document
 * (e.g. a 100-page design doc) returns 5 hits from that doc every time,
 * hiding relevant chunks in smaller documents.
 */
function diversifySectionsByDocument<T extends { documentId?: string; score?: number }>(
  sections: T[],
  topK: number,
  maxPerDoc = 2
): T[] {
  if (sections.length === 0 || maxPerDoc <= 0) {
    return sections.slice(0, topK);
  }
  // Sort by score desc (preserve original order on tie).
  const sorted = sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => (b.section.score ?? 0) - (a.section.score ?? 0) || a.index - b.index);
  const perDoc = new Map<string, number>();
  const picked: T[] = [];
  for (const { section } of sorted) {
    const docId = section.documentId ?? "__no_doc__";
    const count = perDoc.get(docId) ?? 0;
    if (count >= maxPerDoc) {
      continue;
    }
    picked.push(section);
    perDoc.set(docId, count + 1);
    if (picked.length >= topK) {
      break;
    }
  }
  return picked;
}

async function timed<T>(
  timings: Record<string, number>,
  key: string,
  fn: () => Promise<T>,
  emit?: SearchProgressEmitter,
  step?: { title: string; detail: string; payload?: unknown }
): Promise<T> {
  const start = performance.now();
  if (emit && step) {
    emitSearchStep(emit, timings, key, step, "running");
  }
  try {
    const result = await fn();
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, step, "done");
    }
    return result;
  } catch (error) {
    timings[key] = Math.round((performance.now() - start) * 100) / 100;
    if (emit && step) {
      emitSearchStep(emit, timings, key, {
        ...step,
        detail: `${step.detail} 失败：${error instanceof Error ? error.message : String(error)}`
      }, "failed");
    }
    throw error;
  }
}

function emitSearchStep(
  emit: SearchProgressEmitter | undefined,
  timings: Record<string, number>,
  key: string,
  step: { title: string; detail: string; payload?: unknown },
  status: SearchProgressEvent["status"] = "done"
) {
  emit?.({
    type: "step",
    status,
    key,
    title: step.title,
    detail: step.detail,
    payload: step.payload,
    durationMs: timings[key]
  });
}

function toTraceEvents(events: Array<EventRecord & { entityIds?: string[] }>): SearchTraceEvent[] {
  return events.map((event) => ({
    id: event.id,
    title: event.title,
    summary: event.summary,
    contentPreview: previewText(event.content || event.summary || event.title, 160),
    score: event.score
  }));
}

function idsToTraceEvents(
  ids: string[],
  events: Map<string, EventRecord & { entityIds: string[] }>
): SearchTraceEvent[] {
  return ids
    .map((id) => events.get(id))
    .filter((event): event is EventRecord & { entityIds: string[] } => Boolean(event))
    .map((event) => toTraceEvents([event])[0]);
}

function appendEventSnapshots(trace: SearchTrace, events: SearchTraceEvent[]) {
  const byId = new Map((trace.eventSnapshots ?? []).map((event) => [event.id, event]));
  for (const event of events) {
    byId.set(event.id, event);
  }
  trace.eventSnapshots = [...byId.values()];
}

function previewText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

export const searchService = new SearchService();
