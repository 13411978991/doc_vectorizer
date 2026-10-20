export type SearchStrategy = "vector" | "multi";
export type SearchMode = "standard" | "fast";
export type MultiSubStrategy = "multi" | "multi1" | "hopllm";
export type ChunkingMode = "heading_strict" | "token";

export interface SearchInput {
  query: string;
  sourceIds: string[];
  strategy?: SearchStrategy;
  searchMode?: SearchMode;
  subStrategy?: MultiSubStrategy;
  topK?: number;
  returnTrace?: boolean;
  multi?: {
    entityTopK?: number;
    multiTopK?: number;
    keySimilarityThreshold?: number;
    similarityThreshold?: number;
    maxHops?: number;
    maxEvents?: number;
    maxEventsA?: number;
    maxEventsB?: number;
    maxHopRetries?: number;
    rerankTopK?: number;
    maxSections?: number;
  };
}

export interface SearchSection {
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank: number;
  score: number;
  /**
   * Why this chunk was recalled. Helps the UI explain the match to the user:
   * - "vector" — semantic similarity (cosine on embedding_json) only
   * - "keyword" — exact-token match (heading or content LIKE) only
   * - "hybrid" — both vector and keyword recall placed it in the merged set
   *             (default for multi/* results since they go through
   *             event-level expansion before chunk fetch)
   */
  matchType?: "vector" | "keyword" | "hybrid";
}

export interface SearchTrace {
  traceId: string;
  query: string;
  searchMode: SearchMode;
  queryEntities: string[];
  recalledEntities: Array<{ id: string; name: string; type: string; score: number }>;
  entityEventIds: string[];
  entityEvents?: SearchTraceEvent[];
  queryEventIds: string[];
  queryEvents?: SearchTraceEvent[];
  expandedEventIds: string[];
  expandedEvents?: SearchTraceEvent[];
  coarseRankedEventIds: string[];
  coarseRankedEvents?: SearchTraceEvent[];
  rerankedEventIds: string[];
  rerankedEvents?: SearchTraceEvent[];
  eventSnapshots?: SearchTraceEvent[];
  fallbackReason?: string;
  timings: Record<string, number>;
}

export interface SearchTraceEvent {
  id: string;
  title: string;
  summary: string;
  contentPreview: string;
  score?: number;
}

export interface SearchProgressEvent {
  type: "step";
  status: "running" | "done" | "failed";
  key: string;
  title: string;
  detail: string;
  payload?: unknown;
  durationMs?: number;
}

export interface SearchResult {
  sections: SearchSection[];
  traceId: string;
  trace?: SearchTrace;
}

export interface ProjectStatsRecord {
  documentCount: number;
  chunkCount: number;
  eventCount: number;
  entityCount: number;
}

export interface ProjectGraphEntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  eventCount: number;
}

export interface ProjectGraphEventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  title: string;
  rank: number;
  entityIds: string[];
}

export interface ProjectGraphRecord {
  entities: ProjectGraphEntityRecord[];
  events: ProjectGraphEventRecord[];
  edges: Array<{
    entityId: string;
    eventId: string;
  }>;
}

export interface IngestDocumentInput {
  sourceId?: string;
  /**
   * Optional pre-existing document id. When set, the ingest pipeline
   * reuses this id instead of minting a new one — used by
   * maintenance scripts that want to re-extract entities for an
   * already-stored document without creating a duplicate row.
   * When omitted (the normal ingest path) a fresh UUID is generated.
   */
  documentId?: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  extract?: boolean;
  waitForCompletion?: boolean;
  chunking?: {
    mode?: ChunkingMode;
    maxTokens?: number;
    overlapTokens?: number;
  };
  /**
   * Abort signal. When signalled (e.g. the user paused the watched
   * folder) the ingest pipeline checks at every major step and throws
   * an AbortError so the caller's caller can mark the manifest as
   * cancelled instead of failed.
   */
  signal?: AbortSignal;
  /**
   * P-Tier2-#13 — per-stage progress callback. The watcher passes a
   * callback that updates IngestQueue's `currentStage` / `currentPercent`
   * so the Web UI can show "currently processing foo.xlsx, embedding
   * chunks 78/120" instead of just "1 file in flight".
   */
  onProgress?: (update: { stage?: string; progress?: number }) => void;
}

export interface IngestDocumentResult {
  sourceId: string;
  documentId: string;
  chunkCount: number;
  eventCount: number;
  taskId: string;
  traceId: string;
  status?: "COMPLETED" | "PARTIAL_SUCCESS" | "FAILED";
  failedChunkCount?: number;
}

export type IngestProgressStage =
  | "QUEUED"
  | "READING"
  | "PARSING"
  | "CHUNKING"
  | "EMBEDDING_CHUNKS"
  | "EXTRACTING_EVENTS"
  | "EMBEDDING_EVENTS"
  | "WRITING_GRAPH"
  | "COMPLETED"
  | "PARTIAL_SUCCESS"
  | "FAILED";

export interface IngestProgressUpdate {
  stage: IngestProgressStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
}

export interface ExtractedEvent {
  title: string;
  summary: string;
  content: string;
  category?: string;
  keywords: string[];
  priority?: string;
  status?: string;
  references: string[];
  entities: ExtractedEntity[];
  // Which pipeline actually produced this event. Set by
  // OpenAICompatibleLlmClient.extractEventsFromChunk; absent on
  // legacy events ingested before migration 017.
  extractionSource?: "remote-llm" | "regex-fallback";
}

export interface ExtractedEntity {
  type: string;
  name: string;
  description: string;
}

export interface SourceRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  metadata: Record<string, unknown>;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
}

export interface EventRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  chunkId?: string | null;
  title: string;
  summary: string;
  content: string;
  rank: number;
  score?: number;
  entities?: EntityRecord[];
  entityCount?: number;
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
  // Mirrors events.extraction_source. NULL for legacy rows.
  extractionSource?: "remote-llm" | "regex-fallback" | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  score?: number;
  embedding?: EmbeddingPreview | null;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  title: string;
  status: string;
  parseStatus: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  // Sprint 13+: name of the source this document lives under.
  sourceName?: string;
  // Migration 017 (2026-09-28): number of events on this document whose
  // extraction_source = 'regex-fallback'. Surfaced in the UI as
  // `fallback *N` so the operator can spot ingestions where the LLM
  // endpoint was unreachable / misconfigured and the local regex
  // pipeline took over. 0 means "all events came from the LLM" or
  // "no events extracted yet". Optional for legacy callers.
  fallbackEventCount?: number;
}

export interface ChunkRecord {
  id: string;
  sourceId: string;
  documentId?: string | null;
  heading?: string | null;
  content: string;
  rawContent?: string | null;
  rank: number;
  references: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  embedding?: EmbeddingPreview | null;
}

export interface EntityWithEventsRecord extends EntityRecord {
  description?: string | null;
  eventCount: number;
}

export interface EventDetailRecord {
  event: EventRecord;
  entities: EntityRecord[];
  document?: DocumentRecord | null;
  source?: SourceRecord | null;
  chunk?: {
    chunkId: string;
    sourceId?: string;
    documentId?: string | null;
    heading?: string;
    content: string;
    rank?: number;
  };
}

export interface EntityDetailRecord {
  entity: EntityWithEventsRecord;
  events: EventRecord[];
  source?: SourceRecord | null;
}

export interface McpSessionRecord {
  id: string;
  tenantId: string;
  title: string;
  status: string;
  model?: string | null;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type McpMessageRole = "user" | "assistant" | "tool" | "system";

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: McpMessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface McpToolCallRecord {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  durationMs?: number | null;
  error?: string | null;
  createdAt: string;
}

// Embedding provider — only the two real options. The historical
// "local" value pointed at a SHA256-hash pseudo embedding (distinct
// value count: 4) that broke semantic search silently. It was removed
// 2026-10-13 so the operator can no longer hit the dogshit path by
// accident — the schema now rejects "local" and the runtime throws
// a clear error if the DB somehow still has the legacy value.
export type EmbeddingProvider = "api" | "local-bge";

// `api` — OpenAI-compatible HTTP endpoint (existing behaviour).
// `local` — bundled GGUF loaded in-process via node-llama-cpp.
// Equivalent to embedding_provider but kept as a separate axis so the
// two pipelines can be toggled independently (e.g. local-bge for
// embedding + remote LLM for extraction). See migrations/016.
export type LlmProvider = "api" | "local";

export interface AiProviderSettingsRecord {
  id: "global";
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingApiKey?: string | null;
  embeddingLocalModelPath?: string | null;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey?: string | null;
  // Path to a GGUF file relative to process.resourcesPath (packaged
  // builds) or repo-root (dev). Resolved at request time by
  // LocalLlmClient. Empty string means "no model chosen yet".
  llmLocalModelPath: string;
  // Context window in tokens. 4096 default fits the SAG extraction
  // prompt (~700 input + ~600 output) with headroom while keeping
  // the KV cache small on CPU.
  llmLocalContextSize: number;
  // Wall-clock budget for one chat/completions call. The ai-settings
  // service previously ignored this DB column and always fell back to
  // the env default, which is why a WebUI tweak never seemed to take
  // effect. See sag_xlsx-LLM超时诊断-20260828.md.
  llmTimeoutMs: number;
  // Plan B (2026-09-19): NER model selection. Path is relative to
  // `<exeDir>/resources/models/` in packaged builds (e.g.
  // "models/bert-base-chinese-ner") or repo-root in dev. Empty string
  // means "no NER model configured yet" — the runtime refuses to
  // start. See src/api/server.ts startHttpServer.
  nerModel: string;
  // Maximum tokens fed to the NER pipeline per chunk. Defaults to 512
  // and clamped to [64, 1024] — the chunker caps chunks at 1024 and
  // bert-base-chinese-ner's accuracy degrades past 512.
  nerMaxTokens: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublicAiProviderSettings {
  id: "global";
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  embeddingLocalModelPath: string | null;
  embeddingLocalModelLoaded: boolean;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  llmLocalModelPath: string | null;
  // Mirrors `embeddingLocalModelLoaded`: true when the local-llm
  // client has successfully loaded the GGUF and can answer requests.
  // The Web UI uses this to decide whether to show "preheat model"
  // vs "reload model" vs the success tick.
  llmLocalModelLoaded: boolean;
  // Display name of the loaded GGUF (file basename, no extension).
  // Useful for the UI to show "Qwen2.5-3B-Instruct (Q4_K_M)" next
  // to the warmup button instead of just a path. Null until loaded.
  llmLocalModelLabel: string | null;
  // Plan B (2026-09-19): NER model fields. Same shape as the
  // llmLocalModel* fields above — null when not configured, a
  // truthy string after the operator picks a model from the catalog.
  // The UI uses `nerModelLoaded` to decide whether to show
  // "Download NER" vs "Reload NER" vs the success tick.
  nerModel: string | null;
  nerMaxTokens: number;
  nerModelLoaded: boolean;
  nerModelLabel: string | null;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  updatedAt: string;
}
