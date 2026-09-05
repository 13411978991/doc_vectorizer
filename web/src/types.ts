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
  source?: SourceRecord;
  // Sprint 13+: name of the source this document lives under
  // (audit project direct, watched folder displayName, or upload file name).
  sourceName?: string;
}

export interface EmbeddingPreview {
  dimensions: number;
  sample: number[];
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
  entityCount?: number;
  entities?: EntityRecord[];
  titleEmbedding?: EmbeddingPreview | null;
  contentEmbedding?: EmbeddingPreview | null;
}

export interface EntityRecord {
  id: string;
  sourceId: string;
  type: string;
  name: string;
  normalizedName: string;
  description?: string | null;
  eventCount?: number;
  score?: number;
  embedding?: EmbeddingPreview | null;
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
  entity: EntityRecord & { eventCount: number };
  events: EventRecord[];
  source?: SourceRecord | null;
}

export interface SearchResult {
  traceId: string;
  sections: Array<{
    chunkId: string;
    sourceId: string;
    documentId?: string;
    heading?: string;
    content: string;
    rank: number;
    score: number;
    /**
     * Optional badge shown next to the score. Tells the user whether the
     * chunk was recalled via vector similarity, exact keyword match, or
     * both ("hybrid"). Set by the backend search service.
     */
    matchType?: "vector" | "keyword" | "hybrid";
  }>;
  trace?: Record<string, unknown>;
}

export type SearchMode = "standard" | "fast";
export type ChunkingMode = "heading_strict" | "token";

export interface SearchProgressEvent {
  type: "step";
  status: "running" | "done" | "failed";
  key: string;
  title: string;
  detail: string;
  payload?: unknown;
  durationMs?: number;
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

export type SearchStreamEvent =
  | SearchProgressEvent
  | { type: "done"; result: SearchResult }
  | { type: "error"; message: string };

export interface ModelCallLogRecord {
  sequence: number;
  id: string;
  kind: "llm" | "embedding";
  operation: string;
  status: "SUCCEEDED" | "FAILED";
  createdAt: string;
  durationMs: number;
  request: unknown;
  response?: unknown;
  error?: string;
}

export type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export type UploadJobStage =
  | "QUEUED"
  | "READING"
  | "PARSING"
  | "CHUNKING"
  | "EMBEDDING_CHUNKS"
  | "EXTRACTING_EVENTS"
  | "EMBEDDING_EVENTS"
  | "WRITING_GRAPH"
  | "COMPLETED"
  | "FAILED";

export interface UploadJobRecord {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: UploadJobStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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

export interface McpMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool" | "system";
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

export interface McpSessionDetail {
  session: McpSessionRecord;
  messages: McpMessageRecord[];
  toolCalls: McpToolCallRecord[];
}

export type McpStreamEvent =
  | { type: "stage"; label: string; detail?: string }
  | { type: "message"; message: McpMessageRecord }
  | { type: "assistant_delta"; delta: string }
  | { type: "tool_start"; toolName: string; arguments: Record<string, unknown> }
  | { type: "search_progress"; event: SearchProgressEvent }
  | { type: "tool_end"; toolCall: McpToolCallRecord }
  | { type: "done"; detail: McpSessionDetail }
  | { type: "error"; message: string };

export type EmbeddingProvider = "api" | "local" | "local-bge";

export interface PublicAiProviderSettings {
  id: "global";
  embeddingProvider: EmbeddingProvider;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hasEmbeddingApiKey: boolean;
  embeddingLocalModelPath: string | null;
  embeddingLocalModelLoaded: boolean;
  // LLM fields were missing from this type for a while, which made
  // the Settings panel render without a Base URL/Model input. The
  // server has always returned these (ai-settings-service.toPublicSettings),
  // so the web UI was throwing the data away. Keep them in sync.
  llmBaseUrl: string;
  llmModel: string;
  hasLlmApiKey: boolean;
  defaultSearchMode: SearchMode;
  defaultSearchTopK: number;
  defaultChunkingMode: ChunkingMode;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  updatedAt: string;
}

export interface PublicMcpSettings {
  toolTimeoutMs: number;
  clientConfigs: Array<{
    id: string;
    title: string;
    description: string;
    config: Record<string, unknown>;
  }>;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    example: Record<string, unknown>;
  }>;
}

// === Watched Folders (Sprint 3) ===
export interface WatchedFolderRecord {
  id: string;
  tenantId: string;
  path: string;
  displayName: string;
  sourceId: string | null;
  enabled: boolean;
  recursive: boolean;
  filetypeFilter: FiletypeFilter;
  metadata: Record<string, unknown>;
  lastScanAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Latest health snapshot from the watcher manager. Populated by the
   * backend's `/api/watched-folders` decorate path. We model the
   * stoppedReason as a closed union so the UI can render "watcher
   * paused: ..." with a meaningful explanation rather than a generic
   * "stopped".
   */
  watcherHealth?: WatcherHealth | null;
  watcherRunning?: boolean;
  lastRunStats?: {
    added: number;
    updated: number;
    deleted: number;
    failed: number;
  };
  /**
   * Live ingest-queue progress. Populated by the watched-folders
   * decorate endpoint; the detail view polls it on a 5 s / 10 s
   * cadence depending on whether files are pending.
   */
  queueProgress?: QueueProgress | null;
}

export interface WatcherHealth {
  consecutiveFailures: number;
  lastError?: string;
  lastOkAt?: number;
  stoppedReason?: "preflight-failed" | "healthcheck-failed" | "user";
}

export interface FiletypeFilter {
  /**
   * Whitelist (lowercase, with leading dot). `undefined` / empty =
   * accept all supported types. The legacy blacklist field was
   * removed in v2 — operators express "exclude everything except X"
   * by setting the whitelist to `X`.
   */
  whitelist?: string[];
  maxBytes?: number;
}

/** Default whitelist shown in the watched-folder creation wizard. */
export const DEFAULT_OFFICE_WHITELIST: string[] = [
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx"
];

export interface FileManifestRecord {
  id: string;
  folderId: string;
  relPath: string;
  mtimeMs: number | null;
  inode: number | null;
  sizeBytes: number | null;
  sha1: string | null;
  status: "pending" | "syncing" | "synced" | "partial" | "failed" | "deleted";
  documentId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  // Wall-clock timing for the most-recent sync attempt. Populated
  // by sync-orchestrator; both fields are null until the orchestrator
  // writes them (rows ingested before migration 011 stay null and
  // the UI shows "—" for them).
  lastSyncStartedAt: string | null;
  lastSyncDurationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncRunRecord {
  id: string;
  folderId: string;
  startedAt: string;
  finishedAt: string | null;
  // `completed_with_errors` means the scan ran end-to-end but at least one
  // file failed to ingest. It's a "mostly green" badge — the user gets a
  // small ×N counter and a retry CTA, not a red "the task crashed" warning.
  status: "running" | "completed" | "completed_with_errors" | "failed";
  trigger: "manual" | "scan" | "event" | "startup";
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesFailed: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Live progress snapshot from GET /api/watched-folders/:id/queue.
 * Mirrors the backend `QueueProgress` shape so the UI can render
 * a real progress bar. `percent === -1` means "indeterminate" (the
 * orchestrator hasn't discovered how many files there are yet).
 */
export interface QueueProgress {
  folderId: string;
  scanning: boolean;
  pending: number;
  active: number;
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  lastError: string | null;
  total: number;
  percent: number;
  done: number;
  idle: boolean;
}

/**
 * Pagination envelope for manifest + sync-runs endpoints. `nextCursor`
 * is null on the last page; `total` is omitted (0) when the caller
 * sets `includeTotal=false` (faster subsequent pages).
 */
export interface ManifestPage {
  manifest: FileManifestRecord[];
  nextCursor: string | null;
  total: number;
  limit: number;
}

export interface RunsPage {
  runs: SyncRunRecord[];
  nextCursor: string | null;
  prevOffset: number | null;
  total: number;
  limit: number;
  offset: number;
}

export interface WatchedFolderListItem extends WatchedFolderRecord {
  lastRunStatus: "running" | "completed" | "failed" | null;
  lastRunAt: string | null;
  totalFilesSynced: number;
}


/** Lightweight KB project summary returned from the archive endpoint. */
export interface KbArchiveProject {
  id: string;
  name: string;
}

/** Lightweight KB source summary returned from the archive endpoint. */
export interface KbArchiveSource {
  id: string;
  type: string;
}

/** Result of POST /api/audit/procedures/:id/archive. */
export interface KbArchiveResult {
  procedure: { id: string; name: string; status: string };
  kbProject: KbArchiveProject;
  kbSource: KbArchiveSource;
  archivedAt: string;
}

/** Phase 3 Block 3 metadata fields the backend writes into procedure.metadata. */
export interface ProcedureKbArchiveReference {
  kb_archived_kb_project_id: string;
  kb_archived_kb_source_id: string;
  kb_archived_at: string;
  kb_archived_by?: string;
  kb_archived_title?: string;
  /** Phase 5 Block 5B: IDs of related archived cases referenced during the archive. */
  kb_referenced_cases?: string[];
}

/** Phase 5 Block 5B: lightweight record describing a previously archived case. */
export interface ArchivedCaseRecord {
  procedureId: string;
  title: string;
  category: string | null;
  quantifiedImpact: number | null;
  currency: string | null;
  findingsCount: number;
  analysisCount: number;
  archivedAt: string;
  archivedBy: string | null;
  createdBy: string | null;
}



