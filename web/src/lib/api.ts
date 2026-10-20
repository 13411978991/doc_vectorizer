import type {
  ChunkRecord,
  DocumentRecord,
  EntityRecord,
  EntityDetailRecord,
  EmbeddingProvider,
  EventDetailRecord,
  EventRecord,
  FileManifestRecord,
  FiletypeFilter,
  JobsOverview,
  ManifestPage,
  McpSessionDetail,
  McpSessionRecord,
  McpStreamEvent,
  ModelCallLogRecord,
  PerformanceBounds,
  PerformanceProfile,
  ProjectGraphRecord,
  ProjectStatsRecord,
  PublicAiProviderSettings,
  PublicMcpSettings,
  PublicPerformanceSettings,
  ChunkingMode,
  QueueProgress,
  RunsPage,
  SearchMode,
  SearchStreamEvent,
  SearchResult,
  SourceRecord,
  SyncRunRecord,
  UploadJobRecord,
  WatchedFolderListItem,
  WatchedFolderRecord,
  KbArchiveResult,
} from "../types";

function safeParseJson(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers
  });
  const text = await response.text();
  const data = safeParseJson(text);
  if (!response.ok) {
    const message = data?.error?.message ?? `请求失败：${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

/**
 * Connection-probe result. Mirrors the backend's structured response from
 * `/api/test-connection`. We model it as a discriminated union on `ok`
 * so callers can render success / failure with full type-narrowing.
 */
export interface ConnectionProbe {
  ok: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

/**
 * Sub-probe for the LLM extraction endpoint (2026-09-28). Mirrors the
 * embedding ConnectionProbe shape but has no `dimensions` (LLM chat
 * completions don't return vectors). The Settings panel renders one
 * row per sub-probe so the operator can tell at a glance whether the
 * LLM endpoint is reachable even when embedding is fine.
 */
export interface LlmConnectionProbe {
  ok: boolean;
  provider: "remote-llm";
  baseUrl: string;
  model: string;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

export const api = {
  async listProjects(includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ projects: SourceRecord[] }>(`/api/projects${query}`);
  },

  async createProject(input: { name: string; description?: string | null }) {
    return request<{ project: SourceRecord }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async updateProject(projectId: string, input: { name?: string; description?: string | null }) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/archive`, {
      method: "POST"
    });
  },

  async restoreProject(projectId: string) {
    return request<{ project: SourceRecord }>(`/api/projects/${projectId}/restore`, {
      method: "POST"
    });
  },

  async deleteProject(projectId: string) {
    return request<{ deleted: boolean }>(`/api/projects/${projectId}?permanent=true`, {
      method: "DELETE"
    });
  },

  async listDocuments(projectId: string, includeArchived = false) {
    const query = includeArchived ? "?includeArchived=true" : "";
    return request<{ documents: DocumentRecord[] }>(`/api/projects/${projectId}/documents${query}`);
  },

  async getProjectStats(projectId: string) {
    return request<{ stats: ProjectStatsRecord }>(`/api/projects/${projectId}/stats`);
  },

  async getProjectGraph(projectId: string) {
    return request<{ graph: ProjectGraphRecord }>(`/api/projects/${projectId}/graph`);
  },

  async getDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`);
  },

  async listChunks(documentId: string) {
    return request<{ chunks: ChunkRecord[] }>(`/api/documents/${documentId}/chunks`);
  },

  async listEvents(documentId: string) {
    return request<{ events: EventRecord[] }>(`/api/documents/${documentId}/events`);
  },

  async listEntities(documentId: string) {
    return request<{ entities: EntityRecord[] }>(`/api/documents/${documentId}/entities`);
  },

  async updateDocument(documentId: string, input: { title?: string }) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async archiveDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/archive`, {
      method: "POST"
    });
  },

  async restoreDocument(documentId: string) {
    return request<{ document: DocumentRecord }>(`/api/documents/${documentId}/restore`, {
      method: "POST"
    });
  },

  async deleteDocument(documentId: string) {
    return request<{ deleted: boolean }>(`/api/documents/${documentId}?permanent=true`, {
      method: "DELETE"
    });
  },

  async getEvent(eventId: string) {
    return request<EventDetailRecord>(`/api/events/${eventId}`);
  },

  async getEntity(entityId: string) {
    return request<EntityDetailRecord>(`/api/entities/${entityId}`);
  },

  async uploadDocument(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{
      sourceId: string;
      documentId: string;
      chunkCount: number;
      eventCount: number;
      document: DocumentRecord | null;
    }>("/api/documents/upload", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async createUploadJob(input: {
    sourceId?: string;
    title?: string;
    fileName: string;
    content: string;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }) {
    return request<{ job: UploadJobRecord }>("/api/documents/upload/jobs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getUploadJob(jobId: string) {
    return request<{ job: UploadJobRecord }>(`/api/documents/upload/jobs/${jobId}`);
  },

  async convertFile(fileName: string, contentBase64: string): Promise<{ markdown: string }> {
    return request<{ markdown: string }>("/api/convert", {
      method: "POST",
      body: JSON.stringify({ fileName, content: contentBase64 })
    });
  },

  async listModelCallLogs(afterSequence = 0) {
    return request<{
      logs: ModelCallLogRecord[];
      latestSequence: number;
    }>(`/api/model-call-logs?after=${encodeURIComponent(String(afterSequence))}`);
  },

  async search(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
  }) {
    return request<SearchResult>("/api/search", {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK
      })
    });
  },

  async streamSearch(input: {
    query: string;
    sourceIds: string[];
    searchMode?: SearchMode;
    topK?: number;
  }, onEvent: (event: SearchStreamEvent) => void) {
    const response = await fetch("/api/search/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: input.query,
        sourceIds: input.sourceIds,
        strategy: "multi",
        searchMode: input.searchMode ?? "fast",
        returnTrace: true,
        topK: input.topK
      })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }
    await readSseStream(response, onEvent);
  },

  async listMcpSessions(projectId?: string) {
    if (projectId) {
      return request<{ sessions: McpSessionRecord[] }>(`/api/projects/${projectId}/mcp/sessions`);
    }
    return request<{ sessions: McpSessionRecord[] }>("/api/mcp/sessions");
  },

  async createMcpSession(input: { title?: string; sourceIds?: string[] }) {
    return request<{ session: McpSessionRecord }>("/api/mcp/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async getMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}`);
  },

  async clearMcpSession(sessionId: string) {
    return request<McpSessionDetail>(`/api/mcp/sessions/${sessionId}/clear`, {
      method: "POST"
    });
  },

  async deleteMcpSession(sessionId: string) {
    return request<{ deleted: boolean }>(`/api/mcp/sessions/${sessionId}`, {
      method: "DELETE"
    });
  },

  async sendMcpMessage(sessionId: string, content: string) {
    return request<{
      detail: McpSessionDetail;
    }>(`/api/mcp/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content })
    });
  },

  async streamMcpMessage(
    sessionId: string,
    content: string,
    onEvent: (event: McpStreamEvent) => void,
    options: { signal?: AbortSignal } = {}
  ) {
    const response = await fetch(`/api/mcp/sessions/${sessionId}/messages/stream`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content })
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
    }

    await readSseStream(response, onEvent);
  },

  async getAiSettings() {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai");
  },

  async getMcpSettings() {
    return request<{ settings: PublicMcpSettings }>("/api/settings/mcp");
  },

  async updateAiSettings(input: {
    embeddingProvider?: EmbeddingProvider;
    embeddingBaseUrl: string;
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingApiKey?: string;
    clearEmbeddingApiKey?: boolean;
    embeddingLocalModelPath?: string;
    clearEmbeddingLocalModelPath?: boolean;
    // LLM extraction provider: 'api' (remote chat/completions) or
    // 'local' (ONNX NER + heuristic). Migration 016 added the
    // column; the Settings panel now exposes a toggle (see
    // SettingsInput.llmProvider in App.tsx). Optional so callers
    // that don't care about LLM (e.g. embedding-only flows) can
    // omit it without TS errors.
    llmProvider?: "api" | "local";
    llmBaseUrl: string;
    llmModel: string;
    llmApiKey?: string;
    clearLlmApiKey?: boolean;
    llmLocalModelPath?: string;
    clearLlmLocalModelPath?: boolean;
    llmLocalContextSize?: number;
    nerModel?: string;
    nerMaxTokens?: number;
    clearNerModel?: boolean;
    defaultSearchMode: SearchMode;
    defaultSearchTopK: number;
    defaultChunkingMode: ChunkingMode;
    chunkTokenLimit: number;
    chunkOverlapTokens: number;
  }) {
    return request<{ settings: PublicAiProviderSettings }>("/api/settings/ai", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },

  // === Performance settings (stage 1 productization) ===
  async getPerformanceSettings() {
    return request<{ settings: PublicPerformanceSettings; bounds: PerformanceBounds }>(
      "/api/settings/performance"
    );
  },
  async updatePerformanceSettings(input: {
    profile: PerformanceProfile;
    overrides?: Partial<Omit<PublicPerformanceSettings, "profile" | "fromDatabase" | "updatedAt">>;
  }) {
    return request<{ settings: PublicPerformanceSettings }>("/api/settings/performance", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  async resetPerformanceSettings() {
    return request<{ settings: PublicPerformanceSettings }>(
      "/api/settings/performance/reset",
      { method: "POST" }
    );
  },

  // === Real-time jobs panel (stage 1 productization) ===
  async getJobsOverview() {
    return request<JobsOverview>("/api/jobs/overview");
  },
  async skipManifestRow(folderId: string, relPath: string) {
    return request<{ ok: boolean; folderId: string; relPath: string; status: string }>(
      `/api/jobs/manifest/${folderId}/skip`,
      { method: "POST", body: JSON.stringify({ relPath }) }
    );
  },
  async retryManifestRow(folderId: string, relPath: string) {
    return request<{
      ok: boolean;
      folderId: string;
      relPath: string;
      enqueued: number;
      missing: string[];
    }>(`/api/jobs/manifest/${folderId}/retry`, {
      method: "POST",
      body: JSON.stringify({ relPath })
    });
  },
  async retryAllFailed(input: { folderId?: string } = {}) {
    return request<{
      ok: boolean;
      totalEnqueued: number;
      totalMissing: number;
      perFolder: Array<{ folderId: string; enqueued: number; missing: number }>;
    }>("/api/jobs/retry-failed", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  // === Watched Folders (Sprint 3) ===
  async listWatchedFolders() {
    return request<{ folders: WatchedFolderListItem[] }>("/api/watched-folders");
  },

  async attachFoldersToProject(projectId: string, folderIds: string[]) {
    return request<{
      attached: number;
    }>(`/api/projects/${projectId}/folders`, {
      method: "POST",
      body: JSON.stringify({ folderIds })
    });
  },
  async detachFoldersFromProject(projectId: string, folderIds: string[]) {
    return request<{
      detached: number;
    }>(`/api/projects/${projectId}/folders`, {
      method: "DELETE",
      body: JSON.stringify({ folderIds })
    });
  },

  async getWatchedFolder(id: string) {
    return request<{ folder: WatchedFolderRecord; recentRuns: SyncRunRecord[] }>(`/api/watched-folders/${id}`);
  },

  async getMergeDataReady() {
    return request<{ ready: boolean; dbPath: string; reason: string | null }>(
      `/api/watched-folders/merge-data-ready`
    );
  },

  async mergeDataFolder(input?: { displayName?: string }) {
    return request<{
      result: {
        folderId: string;
        newSourceId: string;
        mergedDbPath: string;
        documents: { inserted: number; updated: number; skipped: number };
        chunks: number;
        events: number;
        entities: number;
        eventEntities: number;
      };
    }>(`/api/watched-folders/merge-data`, {
      method: "POST",
      body: JSON.stringify(input ?? {})
    });
  },

  async createWatchedFolder(input: {
    path: string;
    displayName?: string;
    recursive?: boolean;
    filetypeFilter?: FiletypeFilter;
    metadata?: Record<string, unknown>;
    sourceId?: string;
  }) {
    return request<{ folder: WatchedFolderRecord }>("/api/watched-folders", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async updateWatchedFolder(id: string, input: {
    displayName?: string;
    enabled?: boolean;
    recursive?: boolean;
    filetypeFilter?: FiletypeFilter;
    metadata?: Record<string, unknown>;
  }) {
    return request<{ folder: WatchedFolderRecord }>(`/api/watched-folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteWatchedFolder(id: string) {
    return request<{ deleted: boolean }>(`/api/watched-folders/${id}`, {
      method: "DELETE"
    });
  },

  async triggerFolderSync(id: string) {
    return request<{ status: string; folderId: string }>(`/api/watched-folders/${id}/sync`, {
      method: "POST",
      body: "{}"
    });
  },

  // Returns a Response-like object so callers can branch on status (409 etc).
  // request() throws on non-ok, but the inline Sync button needs to distinguish
  // 409 "already running" from other failures without a try/catch in App.tsx.
  async syncWatchedFolder(id: string): Promise<{ ok: boolean; status: number; statusText: string }> {
    const r = await fetch(`/api/watched-folders/${id}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    return { ok: r.ok, status: r.status, statusText: r.statusText };
  },

  async pauseWatchedFolder(id: string) {
    return request<{ folder: WatchedFolderRecord }>(`/api/watched-folders/${id}/pause`, {
      method: "POST"
    });
  },

  async resumeWatchedFolder(id: string) {
    return request<{ folder: WatchedFolderRecord }>(`/api/watched-folders/${id}/resume`, {
      method: "POST"
    });
  },

  async getWatchedFolderRuns(
    id: string,
    limit = 50,
    page?: { cursor?: string; offset?: number; includeTotal?: boolean }
  ) {
    const qs = new URLSearchParams();
    qs.set("limit", String(limit));
    if (page?.cursor) qs.set("cursor", page.cursor);
    if (page?.offset != null) qs.set("offset", String(page.offset));
    if (page?.includeTotal === false) qs.set("includeTotal", "false");
    return request<RunsPage>(`/api/watched-folders/${id}/runs?${qs.toString()}`);
  },

  async getWatchedFolderManifest(
    id: string,
    options:
      | string
      | {
          status?: string;
          limit?: number;
          cursor?: string;
          offset?: number;
          sort?: "recent" | "path";
          includeTotal?: boolean;
        } = {}
  ) {
    // Legacy single-arg form (status string) still works.
    const opts = typeof options === "string" ? { status: options } : options;
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.offset != null) qs.set("offset", String(opts.offset));
    if (opts.sort) qs.set("sort", opts.sort);
    if (opts.includeTotal === false) qs.set("includeTotal", "false");
    return request<ManifestPage>(
      `/api/watched-folders/${id}/manifest${qs.toString() ? "?" + qs.toString() : ""}`
    );
  },

  async getWatchedFolderQueue(id: string) {
    return request<{ progress: QueueProgress }>(
      `/api/watched-folders/${id}/queue`
    );
  },

  // Retry a single failed file. We try the modern query-string route
  // first; if the server returns 404 (which is the case for older sag.exe
  // builds that only know the path-style /files/:relPath/retry alias),
  // we transparently fall back to that path. The fallback is what makes
  // "stale tab after upgrade" silently work.
  async retryWatchedFolderFile(id: string, relPath: string) {
    const qs = new URLSearchParams({ relPath });
    const modernUrl = `/api/watched-folders/${id}/retry-file?${qs.toString()}`;
    const legacyUrl = `/api/watched-folders/${id}/files/${encodeURI(relPath)}/retry`;
    const headers: HeadersInit = { "Content-Type": "application/json" };
    try {
      const response = await fetch(modernUrl, {
        method: "POST",
        headers,
        body: "{}"
      });
      if (response.ok) {
        return (await response.json()) as {
          folderId: string;
          relPath: string;
          previousStatus: string;
          wasFailed: boolean;
          enqueued: number;
          skipped: number;
          missing: string[];
        };
      }
      if (response.status !== 404) {
        // Anything other than 404 is a real error — surface it.
        const text = await response.text();
        const data = safeParseJson(text);
        throw new Error(data?.error?.message ?? `请求失败：${response.status}`);
      }
      // 404 → fall through to legacy path.
    } catch (error) {
      // Network error on the modern call: bail rather than silently
      // double-call. The WebUI surfaces this to the user.
      if (error instanceof TypeError) {
        throw error;
      }
      throw error;
    }
    // Legacy path-style retry. We don't share the `request` helper here
    // because we need the raw 404 → fallback flow described above.
    const legacyResp = await fetch(legacyUrl, {
      method: "POST",
      headers,
      body: "{}"
    });
    if (!legacyResp.ok) {
      const text = await legacyResp.text();
      const data = safeParseJson(text);
      throw new Error(data?.error?.message ?? `请求失败：${legacyResp.status}`);
    }
    return (await legacyResp.json()) as {
      folderId: string;
      relPath: string;
      previousStatus: string;
      wasFailed: boolean;
      enqueued: number;
      skipped: number;
      missing: string[];
    };
  },

  // Bulk-retry every manifest row currently in `failed` state. Returns
  // the same shape the per-file retry does but aggregated.
  async retryAllFailedWatchedFolderFiles(id: string) {
    return request<{
      folderId: string;
      total: number;
      enqueued: number;
      skipped: number;
      missing: string[];
    }>(`/api/watched-folders/${id}/retry-failed`, {
      method: "POST"
    });
  },

  // === KB Projects (知识库) ===
  async listKbProjects() {
    return request<{ projects: Array<{
      id: string; tenantId: string; name: string;
      description: string | null; metadata: Record<string, unknown>;
      createdAt?: string; updatedAt?: string;
      sourceCount: number;
    }> }>("/api/kb-projects");
  },

  async getKbProject(id: string) {
    // The web UI passes "project" IDs that may live in either `kb_projects`
    // (the legacy KB-only table) or `sources` (the unified projects table
    // created when projects were folded back into a single source row).
    // Both `/api/kb-projects/:id` and `/api/projects/:id` exist; the latter
    // is the canonical location, but the former has the richer response
    // shape (sources list). We try both and merge into the KB response
    // shape, so existing call-sites can keep working regardless of which
    // table the project lives in.
    try {
      return await request<{
        project: {
          id: string; tenantId: string; name: string; description: string | null;
          metadata: Record<string, unknown>;
          createdAt?: string; updatedAt?: string;
          cachedDocumentsCount?: number; cachedChunksCount?: number; cachedEntitiesCount?: number;
          cachedUploadDocumentsCount?: number; cachedUploadChunksCount?: number; cachedUploadEntitiesCount?: number;
          cachedUpdatedAt?: string | null;
        };
        sources: Array<{
          id: string; kbProjectId: string; sourceType: "folder" | "upload"; name: string;
          watchedFolderId: string | null; uploadId: string | null;
          enabled: boolean; status: string; lastSyncAt: string | null;
          metadata: Record<string, unknown>;
          createdAt?: string; updatedAt?: string;
          folderPath?: string; folderDisplayName?: string;
          fileName?: string | null; fileSize?: number | null; fileExtension?: string | null;
        }>;
      }>(`/api/kb-projects/${id}`);
    } catch {
      // Fallback: try the projects namespace. The /api/projects/:id handler
      // returns { project: SourceRecord } only, so we synthesize an empty
      // sources list — callers that actually need sources already work via
      // the kb-projects branch on a real KB project.
      const r = await request<{ project: {
        id: string; name: string; description: string | null; tenantId: string;
        metadata: Record<string, unknown>;
        createdAt?: string; updatedAt?: string;
      } }>(`/api/projects/${id}`);
      return {
        project: {
          id: r.project.id,
          tenantId: r.project.tenantId,
          name: r.project.name,
          description: r.project.description,
          metadata: r.project.metadata ?? {},
          createdAt: r.project.createdAt,
          updatedAt: r.project.updatedAt
        },
        sources: []
      };
    }
  },

  async ensureKbUploadSource(kbProjectId: string) {
    return request<{ sourceId: string; isNew: boolean }>(
      `/api/kb-projects/${kbProjectId}/ensure-upload-source`,
      { method: "POST" }
    );
  },

  async createKbProject(input: { name: string; description?: string | null; metadata?: Record<string, unknown> }) {
    return request<{ project: { id: string; name: string } }>("/api/kb-projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async updateKbProject(id: string, input: { name?: string; description?: string | null; metadata?: Record<string, unknown> }) {
    return request<{ project: { id: string; name: string } }>(`/api/kb-projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteKbProject(id: string) {
    return request<{ deleted: boolean }>(`/api/kb-projects/${id}`, { method: "DELETE" });
  },

  async addKbSource(kbProjectId: string, input: {
    source_type: "folder" | "upload";
    name: string;
    watched_folder_id?: string;
    upload_id?: string;
    enabled?: boolean;
    file_name?: string;
    file_size?: number;
    file_extension?: string;
  }) {
    return request<{ source: { id: string; name: string } }>(`/api/kb-projects/${kbProjectId}/sources`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async removeKbSource(kbProjectId: string, sourceId: string) {
    return request<{ deleted: boolean }>(`/api/kb-projects/${kbProjectId}/sources/${sourceId}`, { method: "DELETE" });
  },

  async listKbAvailableFolders() {
    return request<{ folders: Array<{
      id: string; sourceId: string; displayName: string; path: string;
      enabled: boolean; recursive: boolean; lastScanAt: string | null;
    }> }>("/api/kb-projects/available-folders");
  },

  async getServerInfo() {
    return request<{ httpHost: string; httpPort: number; mcpHttpPort: number }>("/api/server/info");
  },

  /**
   * Local BGE embedding model helpers. These power the dedicated
   * "Local model" card in Settings — probe validates a directory on
   * disk, warmup forces an eager pre-load, test runs a single probe
   * embedding so the user can sanity-check their setup.
   */
  async getLocalModelCatalog() {
    return request<{
      catalog: Array<{
        id: string;
        label: string;
        repo: string;
        dim: number;
        sizeHintMB: number;
        speed: "fast" | "medium" | "slow";
        sagCompatible: boolean;
        notes: string;
      }>;
      defaultLocalModelPath: string;
      supportedDimensions: number[];
    }>("/api/settings/embedding/local-model/catalog");
  },

  /**
   * List BGE model directories currently installed in the models dir.
   * UI uses this to render per-row "已下载" / "点击下载" badges.
   */
  async listInstalledLocalModels() {
    return request<{
      installed: Array<{ id: string; path: string; ready: boolean; reason?: string }>;
      modelsDir: string;
    }>("/api/settings/embedding/local-model/installed");
  },

  /**
   * Subscribe to a catalog BGE (ONNX) download — multi-file, mirrors
   * `subscribeLlmDownload` but emits per-file events. Returns an
   * unsubscribe function.
   *
   * SSE event shapes:
   *   start       { modelId, path, mirror, files }
   *   file_start  { file, index, total }
   *   progress    { file, fileBytes, totalBytes, totalSize, percent, speedBps }
   *   file_done   { file, fileBytes?, tookMs?, ok? }
   *   done        { path, tookMs, files: [{ file, ok, bytes, tookMs, error? }] }
   *   error       { message, files? }
   */
  subscribeBgeDownload(
    modelId: string,
    onEvent: (event:
      | { type: "start"; modelId: string; path: string; mirror: string; files: string[] }
      | { type: "file_start"; file: string; index: number; total: number }
      | { type: "progress"; file: string; fileBytes: number; totalBytes: number; totalSize: number; percent: number; speedBps: number }
      | { type: "file_done"; file: string; fileBytes?: number; tookMs?: number; ok?: boolean }
      | { type: "paused"; file: string; index: number; total: number; partialBytes: number; downloadedBytes: number; totalSize: number; percent: number }
      | { type: "done"; path: string; tookMs: number; files: Array<{ file: string; ok: boolean; bytes: number; tookMs: number; error?: string }> }
      | { type: "error"; message: string; files?: Array<{ file: string; ok: boolean; bytes: number; tookMs: number; error?: string }> }
    ) => void
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/settings/embedding/local-model/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId }),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          let message = `download failed: HTTP ${response.status}`;
          try {
            const j = await response.json();
            if (j?.error) message = j.error;
          } catch { /* not JSON */ }
          onEvent({ type: "error", message });
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const dispatch = (raw: string) => {
          // SSE block: "event: <type>\ndata: <json>\n\n"
          const lines = raw.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) return;
          try {
            const parsed = JSON.parse(data);
            onEvent({ type: event, ...parsed } as never);
          } catch {
            /* skip non-JSON */
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (block.trim()) dispatch(block);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        onEvent({ type: "error", message: (err as Error).message });
      }
    })();
    return () => controller.abort();
  },

  cancelBgeDownload(modelId: string) {
    return request<{ ok: boolean; error?: string }>(
      "/api/settings/embedding/local-model/download/cancel",
      { method: "POST", body: JSON.stringify({ modelId }) }
    );
  },

  pauseBgeDownload(modelId: string) {
    return request<{ ok: boolean; alreadyPaused?: boolean; error?: string }>(
      "/api/settings/embedding/local-model/download/pause",
      { method: "POST", body: JSON.stringify({ modelId }) }
    );
  },

  resumeBgeDownload(modelId: string) {
    return request<{ ok: boolean; alreadyRunning?: boolean; error?: string }>(
      "/api/settings/embedding/local-model/download/resume",
      { method: "POST", body: JSON.stringify({ modelId }) }
    );
  },

  async probeLocalModel(modelPath: string) {
    const params = new URLSearchParams({ path: modelPath });
    return request<{
      path: string;
      ready: boolean;
      files: string[];
      missing?: string[];
      reason?: string;
    }>(`/api/settings/embedding/local-model/probe?${params.toString()}`);
  },

  async warmupLocalModel(modelPath: string) {
    return request<{ ok: boolean; tookMs: number; error?: string }>(
      "/api/settings/embedding/local-model/warmup",
      { method: "POST", body: JSON.stringify({ modelPath }) }
    );
  },

  async testLocalModel(modelPath: string, text: string) {
    return request<{ ok: boolean; tookMs: number; dim?: number; sample?: number[]; error?: string }>(
      "/api/settings/embedding/local-model/test",
      { method: "POST", body: JSON.stringify({ modelPath, text }) }
    );
  },

  /**
   * Local-LLM (GGUF) provider helpers — mirror of the embedding
   * local-model endpoints above but for the chat/extraction pipeline.
   * The Web UI surfaces them through the "LLM (event extraction /
   * Q&A)" card, with a provider toggle (`api` | `local`).
   *
   * Catalog entries come from the backend's LOCAL_LLM_CATALOG
   * (see src/api/settings-routes.ts). The Web UI never hard-codes
   * model ids so the catalog stays the single source of truth.
   */
  async getLocalLlmCatalog() {
    return request<{
      catalog: Array<{
        id: string;
        label: string;
        repo: string;
        filename: string;
        sizeHintMB: number;
        contextSize: number;
        speed: "fast" | "medium" | "slow";
        sagCompatible: boolean;
        mirrors: string[];
        notes: string;
        recommended?: boolean;
        heavyOnLaptop?: boolean;
      }>;
      defaultLocalModelPath: string;
      defaultContextSize: number;
      modelsDir: string;
    }>("/api/settings/llm/local-model/catalog");
  },

  /**
   * List GGUF files currently present in `<resourcesPath>/models/`.
   * The Web UI merges this with the catalog to render the "已下载"
   * badge and to decide whether clicking a row should fill the path
   * (installed) or trigger a download (not installed).
   */
  async getInstalledLlmModels() {
    return request<{
      dir: string;
      installed: Array<{
        id: string;
        filename: string;
        path: string;
        sizeBytes: number;
        mtime: string;
        label?: string;
        sizeHintMB?: number;
        sagCompatible?: boolean;
        complete: boolean;
      }>;
    }>("/api/settings/llm/local-model/installed");
  },

  async probeLocalLlm(modelPath: string) {
    const params = new URLSearchParams({ path: modelPath });
    return request<{
      path: string;
      resolved: string;
      ready: boolean;
      isGguf: boolean;
      sizeBytes: number | null;
      loaded: { path: string; label: string; loadedAt: string } | null;
      reason?: string;
    }>(`/api/settings/llm/local-model/probe?${params.toString()}`);
  },

  async warmupLocalLlm(modelPath: string, contextSize: number, forceReload = false) {
    return request<{ ok: boolean; tookMs: number; loaded?: { path: string; label: string; loadedAt: string }; threads?: number; error?: string }>(
      "/api/settings/llm/local-model/warmup",
      { method: "POST", body: JSON.stringify({ modelPath, contextSize, forceReload }) }
    );
  },

  async disposeLocalLlm() {
    return request<{ ok: boolean; error?: string }>(
      "/api/settings/llm/local-model/dispose",
      { method: "POST" }
    );
  },

  async testLocalLlm(modelPath: string, text: string) {
    return request<{
      ok: boolean;
      tookMs: number;
      eventCount?: number;
      entityCount?: number;
      entities?: Array<{ type: string; name: string; description: string }>;
      title?: string | null;
      summary?: string | null;
      error?: string;
    }>(
      "/api/settings/llm/local-model/test",
      { method: "POST", body: JSON.stringify({ modelPath, text }) }
    );
  },

  /**
   * Probe the configured embedding endpoint. The backend always returns
   * a structured body (either `{ embedding: ConnectionProbe }`); the
   * HTTP status code distinguishes "API is reachable and key is valid"
   * (200) from "API reachable but probe failed" (503). We branch on
   * `probe.ok` rather than the HTTP status so callers see the same
   * shape regardless of outcome.
   *
   * We deliberately don't reuse `request()` here: 503 is a legitimate
   * result we want to surface, not an exception.
   */
  async testConnection(): Promise<{
    embedding: ConnectionProbe;
    llm: LlmConnectionProbe | null;
  }> {
    const response = await fetch("/api/test-connection", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    const data = safeParseJson(text) as {
      embedding?: ConnectionProbe;
      llm?: LlmConnectionProbe;
    } | null;
    // The UI splits this into two rows (embedding + LLM); if the
    // backend is on the old single-probe shape we still want to
    // return SOMETHING so the existing call sites don't break.
    const embedding: ConnectionProbe = data?.embedding ?? {
      ok: false,
      provider: "?",
      baseUrl: "?",
      model: "?",
      dimensions: 0,
      latencyMs: 0,
      httpStatus: response.status,
      error: text.slice(0, 300) || `请求失败：${response.status}`
    };
    return { embedding, llm: data?.llm ?? null };
  },

  /**
   * Probe the LLM endpoint with a draft config the operator hasn't
   * saved yet. The backend's POST /api/test-connection/llm accepts
   * { llmBaseUrl, llmModel, llmApiKey, llmTimeoutMs } and runs the
   * same 1-token chat/completions ping as the saved-config path,
   * returning the LlmConnectionProbe. Used by the LLM "测试连接"
   * button so the operator gets immediate feedback as they type.
   */
  async testLlmConnection(input: {
    llmBaseUrl?: string;
    llmModel?: string;
    llmApiKey?: string;
  }): Promise<LlmConnectionProbe> {
    const response = await fetch("/api/test-connection/llm", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });
    const text = await response.text();
    const data = safeParseJson(text) as { llm?: LlmConnectionProbe } | null;
    return data?.llm ?? {
      ok: false,
      provider: "remote-llm",
      baseUrl: input.llmBaseUrl ?? "",
      model: input.llmModel ?? "",
      latencyMs: 0,
      httpStatus: response.status,
      error: text.slice(0, 300) || `请求失败：${response.status}`
    };
  },

  /**
   * Subscribe to a catalog GGUF download. Returns an unsubscribe
   * function. The onEvent callback receives discriminated-union events:
   *
   *   { type: "start", modelId, path, mirror, filename, sizeHintMB }
   *   { type: "progress", downloadedBytes, totalBytes?, percent, speedBps, etaSec? }
   *   { type: "done", path, sizeBytes, tookMs, mirror }
   *   { type: "error", message, code? }
   *
   * Implementation: POST /api/settings/llm/local-model/download with
   * `{ modelId }` and parse the SSE response via the shared
   * readSseStream helper. We use fetch (not EventSource) because the
   * endpoint needs a JSON body — EventSource is GET-only.
   */
  subscribeLlmDownload(
    modelId: string,
    onEvent: (
      event:
        | { type: "start"; modelId: string; path: string; mirror: string; filename: string; sizeHintMB: number; resumedFromBytes?: number }
        | { type: "progress"; downloadedBytes: number; totalBytes?: number; percent: number; speedBps: number; etaSec?: number | null }
        | { type: "paused"; downloadedBytes: number; totalBytes?: number; percent: number }
        | { type: "mirror-switch"; mirror: string; index: number; total: number; reason: string }
        | { type: "done"; path: string; sizeBytes: number; tookMs: number; mirror: string }
        | { type: "error"; message: string; code?: number; tried?: string[] }
    ) => void
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/settings/llm/local-model/download", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({ modelId }),
          signal: controller.signal
        });
        if (!response.ok && response.status !== 200) {
          // 409 means another download is in progress; surface that.
          const text = await response.text();
          let payload: { error?: string } = {};
          try {
            payload = JSON.parse(text);
          } catch {
            /* swallow */
          }
          onEvent({ type: "error", message: payload.error ?? `HTTP ${response.status}` });
          return;
        }
        await readSseStream<{
          modelId?: string;
          path?: string;
          mirror?: string;
          filename?: string;
          sizeHintMB?: number;
          downloadedBytes?: number;
          totalBytes?: number;
          percent?: number;
          speedBps?: number;
          etaSec?: number | null;
          sizeBytes?: number;
          tookMs?: number;
          message?: string;
          code?: number;
        }>(response, (raw) => {
          if (typeof raw.path === "string" && typeof raw.sizeBytes === "number" && typeof raw.tookMs === "number") {
            onEvent({
              type: "done",
              path: raw.path,
              sizeBytes: raw.sizeBytes,
              tookMs: raw.tookMs,
              mirror: raw.mirror ?? ""
            });
          } else if (typeof raw.message === "string" && (raw.code !== undefined || raw.message === "cancelled")) {
            onEvent({ type: "error", message: raw.message, code: raw.code });
          } else if (
            typeof raw.downloadedBytes === "number" &&
            typeof raw.percent === "number" &&
            raw.speedBps === undefined &&
            raw.tookMs === undefined
          ) {
            // paused event — same shape as progress but no speedBps /
            // etaSec. We disambiguate via the absence of those fields.
            onEvent({
              type: "paused",
              downloadedBytes: raw.downloadedBytes,
              totalBytes: raw.totalBytes,
              percent: raw.percent
            });
          } else if (typeof raw.downloadedBytes === "number") {
            onEvent({
              type: "progress",
              downloadedBytes: raw.downloadedBytes,
              totalBytes: raw.totalBytes,
              percent: raw.percent ?? 0,
              speedBps: raw.speedBps ?? 0,
              etaSec: raw.etaSec ?? null
            });
          } else if (typeof raw.modelId === "string" && typeof raw.path === "string") {
            onEvent({
              type: "start",
              modelId: raw.modelId,
              path: raw.path,
              mirror: raw.mirror ?? "",
              filename: raw.filename ?? "",
              sizeHintMB: raw.sizeHintMB ?? 0
            });
          }
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // user cancelled — server will surface the cancellation as
          // an "error" event with `message: "cancelled"`.
          return;
        }
        onEvent({ type: "error", message: (err as Error).message });
      }
    })();
    return () => controller.abort();
  },

  /**
   * Cancel an in-flight GGUF download. No-op if none is active for
   * that id. The SSE stream the caller subscribed to will then emit
   * an `{ type: "error", message: "cancelled" }` event before closing.
   */
  async cancelLlmDownload(modelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch("/api/settings/llm/local-model/download/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId })
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      return data;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /** Pause an in-flight GGUF download — preserves partial bytes on disk. */
  async pauseLlmDownload(modelId: string): Promise<{ ok: boolean; alreadyPaused?: boolean; error?: string }> {
    try {
      const response = await fetch("/api/settings/llm/local-model/download/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId })
      });
      const data = (await response.json()) as { ok: boolean; alreadyPaused?: boolean; error?: string };
      return data;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /** Resume a paused GGUF download — backend re-spawns curl with `-C -`. */
  async resumeLlmDownload(modelId: string): Promise<{ ok: boolean; alreadyRunning?: boolean; error?: string }> {
    try {
      const response = await fetch("/api/settings/llm/local-model/download/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId })
      });
      const data = (await response.json()) as { ok: boolean; alreadyRunning?: boolean; error?: string };
      return data;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  /**
   * Plan B (2026-09-19): ONNX NER model helpers. The NER pipeline
   * replaces the LLM extraction path; these methods wrap the
   * `/api/settings/ner/*` endpoints so the Settings panel can drive
   * catalog browsing, multi-file SSE download, warmup / dispose
   * exactly like the embedding section above.
   */
  async getNerCatalog(): Promise<{
    items: Array<{
      id: string;
      label: string;
      repo: string;
      modelType: "bert" | "roberta";
      sizeHintMB: number;
      f1Score: number;
      files: string[];
      mirrors: string[];
      notes: string;
      recommended?: boolean;
      installed: boolean;
      installedPath?: string;
    }>;
  }> {
    return request("/api/settings/ner/catalog");
  },

  async getInstalledNer(): Promise<{
    models: Array<{
      id: string;
      label: string;
      path: string;
      absolutePath: string;
      catalogEntry: unknown;
    }>;
  }> {
    return request("/api/settings/ner/installed");
  },

  async probeNer(modelPath: string): Promise<{
    path: string;
    resolved: string;
    ready: boolean;
    missing?: string[];
    files?: string[];
    reason?: string;
  }> {
    const params = new URLSearchParams({ path: modelPath });
    return request(`/api/settings/ner/probe?${params.toString()}`);
  },

  async warmupNer(modelPath: string): Promise<{ ok: boolean; tookMs: number; error?: string }> {
    return request<{ ok: boolean; tookMs: number; error?: string }>(
      "/api/settings/ner/warmup",
      { method: "POST", body: JSON.stringify({ modelPath }) }
    );
  },

  async disposeNer(): Promise<{ ok: boolean; error?: string }> {
    return request<{ ok: boolean; error?: string }>(
      "/api/settings/ner/dispose",
      { method: "POST" }
    );
  },

  /**
   * Subscribe to a catalog NER (ONNX) download. Returns an
   * unsubscribe function. The onEvent callback receives a
   * discriminated-union event stream:
   *
   *   { type: "start", modelId, path, mirror, files }
   *   { type: "file_start", file, index, total }
   *   { type: "progress", file, fileBytes, totalBytes, totalSize, percent, speedBps }
   *   { type: "file_done", file, fileBytes?, tookMs?, ok? }
   *   { type: "done", path, tookMs, files: [...] }
   *   { type: "error", message, files? }
   *
   * Implementation: POST /api/settings/ner/download with `{ modelId }`
   * and parse the SSE response. We use fetch (not EventSource) because
   * the endpoint needs a JSON body.
   */
  subscribeNerDownload(
    modelId: string,
    onEvent: (event:
      | { type: "start"; modelId: string; path: string; mirror: string; files: string[] }
      | { type: "file_start"; file: string; index: number; total: number }
      | { type: "progress"; file: string; fileBytes: number; totalBytes: number; totalSize: number; percent: number; speedBps: number }
      | { type: "file_done"; file: string; fileBytes?: number; tookMs?: number; ok?: boolean }
      | { type: "done"; path: string; tookMs: number; files: Array<{ file: string; ok: boolean; bytes: number; tookMs: number; error?: string }> }
      | { type: "error"; message: string; files?: Array<{ file: string; ok: boolean; bytes: number; tookMs: number; error?: string }> }
    ) => void
  ): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/settings/ner/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelId }),
          signal: controller.signal
        });
        if (!response.ok || !response.body) {
          let message = `download failed: HTTP ${response.status}`;
          try {
            const j = await response.json();
            if (j?.error) message = j.error;
          } catch { /* not JSON */ }
          onEvent({ type: "error", message });
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const dispatch = (raw: string) => {
          const lines = raw.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) return;
          try {
            const parsed = JSON.parse(data);
            onEvent({ type: event, ...parsed } as never);
          } catch {
            /* skip non-JSON */
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (block.trim()) dispatch(block);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        onEvent({ type: "error", message: (err as Error).message });
      }
    })();
    return () => controller.abort();
  },

  async cancelNerDownload(modelId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await fetch("/api/settings/ner/download/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId })
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      return data;
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  async testNer(text: string): Promise<{
    entities: Array<{ entity: string; word: string; score: number }>;
    tookMs: number;
    error?: string;
  }> {
    try {
      const response = await fetch("/api/settings/ner/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = (await response.json()) as {
        entities: Array<{ entity: string; word: string; score: number }>;
        tookMs: number;
        error?: string;
      };
      return data;
    } catch (err) {
      return { entities: [], tookMs: 0, error: (err as Error).message };
    }
  }
};

async function readSseStream<T>(response: Response, onEvent: (event: T) => void) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      onEvent(JSON.parse(dataLine.slice(6)) as T);
    }
  }
  if (buffer.trim()) {
    const dataLine = buffer.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) {
      onEvent(JSON.parse(dataLine.slice(6)) as T);
    }
  }
}
