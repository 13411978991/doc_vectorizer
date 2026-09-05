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
  ManifestPage,
  McpSessionDetail,
  McpSessionRecord,
  McpStreamEvent,
  ModelCallLogRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  PublicAiProviderSettings,
  PublicMcpSettings,
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
    llmBaseUrl: string;
    llmModel: string;
    llmApiKey?: string;
    clearLlmApiKey?: boolean;
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
  async testConnection(): Promise<ConnectionProbe> {
    const response = await fetch("/api/test-connection", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    const data = safeParseJson(text) as { embedding?: ConnectionProbe } | null;
    if (!data?.embedding) {
      // Truly unexpected — backend returned something we can't parse.
      // Surface a synthetic probe so the UI can render an error toast.
      return {
        ok: false,
        provider: "?",
        baseUrl: "?",
        model: "?",
        dimensions: 0,
        latencyMs: 0,
        httpStatus: response.status,
        error: text.slice(0, 300) || `请求失败：${response.status}`
      };
    }
    // Annotate with the HTTP status if the backend didn't include one,
    // so the UI can show "503" without needing to read it separately.
    return {
      httpStatus: response.status,
      ...data.embedding
    };
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
