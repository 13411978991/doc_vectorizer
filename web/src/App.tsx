import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Archive,
  ArchiveRestore,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  Upload,
  X,
  Zap
} from "lucide-react";
import { api, type ConnectionProbe } from "./lib/api";
import { cn, formatDate, shortId } from "./lib/utils";
import type {
  ChunkRecord,
  DocumentRecord,
  EmbeddingPreview,
  EntityDetailRecord,
  EntityRecord,
  EventDetailRecord,
  EventRecord,
  McpSessionDetail,
  McpSessionRecord,
  McpMessageRecord,
  McpStreamEvent,
  McpToolCallRecord,
  ModelCallLogRecord,
  ProjectGraphRecord,
  ProjectStatsRecord,
  ChunkingMode,
  PublicAiProviderSettings,
  PublicMcpSettings,
  SearchMode,
  SearchResult,
  SearchStreamEvent,
  SourceRecord,
  UploadJobRecord,
  WatchedFolderListItem,
  WatchedFolderRecord
} from "./types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { ProjectGraphFlow } from "./components/ProjectGraphFlow";
import { WatchedFoldersWorkspace } from "./pages/WatchedFolders";
import { I18nProvider, useI18n, useLanguageController, type LanguagePreference, type SupportedLanguage } from "./i18n";

type WorkspaceView = "chat" | "documents" | "graph" | "mcp" | "settings" | "watchedFolders" | "projectDetail";
type ResultView = "overview" | "chunks" | "events" | "entities" | "search";
type ContextPanelMode = "process" | "logs";
type ProcessStepStatus = "running" | "done" | "failed";
type ProcessStep = {
  id: string;
  title: string;
  status: ProcessStepStatus;
  detail?: string;
  payload?: unknown;
  durationMs?: number | null;
};
type RunningMcpSearch = {
  id: string;
  toolName: string;
  query: string;
  searchMode?: string;
};
type AnswerCitation = {
  index: number;
  chunkId: string;
  sourceId: string;
  documentId?: string;
  heading?: string;
  content: string;
  rank?: number;
  score?: number;
  query?: string;
};
type DetailDrawer =
  | { type: "event"; detail: EventDetailRecord }
  | { type: "entity"; detail: EntityDetailRecord }
  | { type: "citation"; citation: AnswerCitation }
  | null;

const MODEL_LOGS_STORAGE_KEY = "sag:model-call-logs:v1";
const MODEL_LOG_CURSOR_STORAGE_KEY = "sag:model-call-log-cursor:v1";
const MAX_BROWSER_MODEL_LOGS = 200;
const DOCUMENT_RESULT_PAGE_SIZE = 10;
const DEFAULT_SEARCH_QUERY_ZH = "基于当前项目资料检索";
const DEFAULT_SEARCH_QUERY_EN = "Search current project documents";

export default function App() {
  const i18n = useLanguageController();
  return (
    <I18nProvider value={i18n}>
      <AppErrorBoundary>
        <AppShell />
      </AppErrorBoundary>
    </I18nProvider>
  );
}

// Catches uncaught render / lifecycle errors and shows a recovery UI
// instead of leaving the page in a broken "details error" state.
// Without this, any thrown error inside a child component unmounts the
// whole tree and the user sees a blank page until they reload.
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to dev console; production builds still show the recovery
    // card so the user can reload without losing their workflow.
    // eslint-disable-next-line no-console
    console.error("AppErrorBoundary caught:", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  reload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      const message = this.state.error.message || String(this.state.error);
      return (
        <div className="flex min-h-screen items-center justify-center bg-card p-6 text-foreground">
          <div className="w-full max-w-md rounded-lg border border-red-200 bg-red-50 p-5 shadow-sm">
            <div className="flex items-center gap-2 text-red-700">
              <AlertCircle className="h-5 w-5" />
              <h2 className="text-base font-semibold">页面出错了 / Page error</h2>
            </div>
            <p className="mt-2 text-sm text-red-700">
              渲染时遇到未处理的异常。可以点击"重试"恢复，或"刷新页面"重置全部状态。
            </p>
            <pre className="mt-3 max-h-40 overflow-auto rounded bg-red-100/60 p-2 text-xs text-red-900 whitespace-pre-wrap break-words">
              {message}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={this.reset}>重试</Button>
              <Button size="sm" onClick={this.reload}>刷新页面</Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function AppShell() {
  const { language, preference: languagePreference, setPreference: setLanguagePreference, t } = useI18n();
  const [projects, setProjects] = useState<SourceRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [projectStats, setProjectStats] = useState<ProjectStatsRecord | null>(null);
  const [projectGraph, setProjectGraph] = useState<ProjectGraphRecord | null>(null);
  const [kbRefreshKey, setKbRefreshKey] = useState(0);
  // User-initiated document selection. When true, the periodic
  // loadProjectWorkspace refresh will not auto-pick a fallback document
  // even if the currently selected id is missing from the new response
  // (which can happen if the backend paginates, the document was just
  // archived, or ordering changed). The user's click wins until they
  // explicitly pick something else.
  const userSelectedDocumentRef = useRef<boolean>(false);
  const [selectedProjectId, setSelectedProjectIdRaw] = useState("");
  // Wrap the project setter so any project switch resets the
  // user-document-selection flag — the new project should auto-pick
  // the first document on its own, not inherit the previous project's
  // user-pinned id.
  const setSelectedProjectId = useCallback((id: string) => {
    userSelectedDocumentRef.current = false;
    setSelectedProjectIdRaw(id);
  }, []);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [entities, setEntities] = useState<EntityRecord[]>([]);
  const [sessionsByProjectId, setSessionsByProjectId] = useState<Record<string, McpSessionRecord[]>>({});
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set());
  const [mcpDetail, setMcpDetail] = useState<McpSessionDetail | null>(null);
  const [aiSettings, setAiSettings] = useState<PublicAiProviderSettings | null>(null);
  const [mcpSettings, setMcpSettings] = useState<PublicMcpSettings | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("documents");
  const [resultView, setResultView] = useState<ResultView>("overview");
  const [contextPanelMode, setContextPanelMode] = useState<ContextPanelMode>("process");
  const [drawer, setDrawer] = useState<DetailDrawer>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [kbProjects, setKbProjects] = useState<Array<{ id: string; name: string; description: string | null; sourceCount: number }>>([]);
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null);
  const [kbDetail, setKbDetail] = useState<{
    project: {
      id: string; name: string; description: string | null;
      cachedDocumentsCount?: number; cachedChunksCount?: number; cachedEntitiesCount?: number;
      cachedUpdatedAt?: string | null;
    };
    sources: Array<{ id: string; name: string; sourceType: "folder" | "upload"; folderDisplayName?: string; folderPath?: string; enabled: boolean; watchedFolderId?: string | null }>;
    /** sources-model project id (the real "汇集功能" project). The KB project
     *  id is separate; folder attach needs to be routed through this one. */
    sourcesProjectId?: string;
  } | null>(null);
  const [kbDrawerOpen, setKbDrawerOpen] = useState(false);
  const [showArchivedDocuments, setShowArchivedDocuments] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [status, setStatus] = useState(() => t("正在加载 SAG...", "Loading SAG..."));
  const [error, setError] = useState("");
  const [uploadJobs, setUploadJobs] = useState<UploadJobRecord[]>([]);
  const [isUploadQueueExpanded, setIsUploadQueueExpanded] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [syncingFolderId, setSyncingFolderId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState(() => t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN));
  const [searchMode, setSearchMode] = useState<SearchMode>("fast");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [processSteps, setProcessSteps] = useState<ProcessStep[]>([]);
  const [modelLogs, setModelLogs] = useState<ModelCallLogRecord[]>(() => loadStoredModelLogs());
  const [modelLogCursor, setModelLogCursor] = useState(() => loadStoredModelLogCursor());
  const [isSearching, setIsSearching] = useState(false);
  const [mcpInput, setMcpInput] = useState("");
  const [isMcpRunning, setIsMcpRunning] = useState(false);
  const [pendingUserMessage, setPendingUserMessage] = useState("");
  const [streamingAssistantText, setStreamingAssistantText] = useState("");
  const [runningMcpSearches, setRunningMcpSearches] = useState<RunningMcpSearch[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchStartedAtRef = useRef<number | null>(null);
  const refreshedUploadJobsRef = useRef<Set<string>>(new Set());
  const modelLogCursorRef = useRef(modelLogCursor);
  const pendingSessionIdRef = useRef<string | null>(null);
  const mcpAbortControllerRef = useRef<AbortController | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  const visibleDocuments = useMemo(
    () => documents.filter((document) => showArchivedDocuments || !document.archivedAt),
    [documents, showArchivedDocuments]
  );

  const hasActiveUploads = useMemo(
    () => uploadJobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING"),
    [uploadJobs]
  );

  useEffect(() => {
    if (hasActiveUploads) {
      setIsUploadQueueExpanded(true);
      return;
    }
    if (uploadJobs.length > 0) {
      setIsUploadQueueExpanded(false);
    }
  }, [hasActiveUploads, uploadJobs.length]);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    setSearchQuery((current) => {
      if (current === DEFAULT_SEARCH_QUERY_ZH || current === DEFAULT_SEARCH_QUERY_EN) {
        return t(DEFAULT_SEARCH_QUERY_ZH, DEFAULT_SEARCH_QUERY_EN);
      }
      return current;
    });
  }, [language, t]);

  useEffect(() => {
    if (aiSettings?.defaultSearchMode) {
      setSearchMode(aiSettings.defaultSearchMode);
    }
  }, [aiSettings?.defaultSearchMode]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setExpandedProjectIds((current) => {
      if (current.has(selectedProjectId)) return current;
      const next = new Set(current);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    modelLogCursorRef.current = modelLogCursor;
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursor));
  }, [modelLogCursor]);

  useEffect(() => {
    persistModelLogs(modelLogs);
  }, [modelLogs]);

  useEffect(() => {
    void loadProjects();
  }, [showArchivedProjects]);

  useEffect(() => {
    void loadKbProjects();
    void loadWatchedFolders();
  }, []);

  async function loadKbProjects() {
    try {
      const r = await api.listKbProjects();
      setKbProjects(r.projects);
    } catch (err) {
      console.error("loadKbProjects failed:", err);
    }
  }

  const [watchedFolders, setWatchedFolders] = useState<WatchedFolderListItem[]>([]);
  const [selectedWatchedId, setSelectedWatchedId] = useState<string | null>(null);
  // Bumps each time the user asks to create a new watcher; passed as a
  // `key` so the workspace remounts in the wizard view.
  const [watchedNewRequest, setWatchedNewRequest] = useState(0);

  function openCreateWatcherWizard() {
    setSelectedWatchedId(null);
    setWorkspaceView("watchedFolders");
    setWatchedNewRequest((value) => value + 1);
  }

  async function loadWatchedFolders() {
    try {
      const r = await api.listWatchedFolders();
      setWatchedFolders(r.folders);
    } catch (err) {
      console.error("loadWatchedFolders failed:", err);
    }
  }

  async function loadKbDetail(id: string, sourcesProjectId?: string) {
    try {
      const r = await api.getKbProject(id);
      setKbDetail({ project: r.project, sources: r.sources, sourcesProjectId });
    } catch (err) {
      console.error("loadKbDetail failed:", err);
      setKbDetail(null);
    }
  }

  useEffect(() => {
    if (!selectedProjectId) {
      setDocuments([]);
      setSelectedDocumentId("");
      setSelectedDocument(null);
      // Reset the user-selection flag so the next project auto-picks
      // the first document again (rather than waiting for an
      // explicit click).
      userSelectedDocumentRef.current = false;
      setProjectStats(null);
      setProjectGraph(null);
      setMcpDetail(null);
      return;
    }
    void loadProjectWorkspace(selectedProjectId);
  }, [selectedProjectId, showArchivedDocuments]);

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null);
      setChunks([]);
      setEvents([]);
      setEntities([]);
      return;
    }
    void loadDocumentWorkspace(selectedDocumentId);
  }, [selectedDocumentId]);

  useEffect(() => {
    const activeJobs = uploadJobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
    if (activeJobs.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void pollUploadJobs(activeJobs.map((job) => job.id));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [uploadJobs]);

  useEffect(() => {
    if (contextPanelMode !== "logs" && !hasActiveUploads && !isSearching && !isMcpRunning) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void syncModelLogs();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [contextPanelMode, hasActiveUploads, isSearching, isMcpRunning]);

  // Poll the document list every 5s while a project is selected. This is the
  // round-trip that lets the watched-folders watcher show up in the UI without
  // a manual page refresh — backend ingests complete asynchronously and the
  // frontend otherwise has no way to know a new document exists.
  useEffect(() => {
    if (!selectedProjectId) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void loadProjectWorkspace(selectedProjectId);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedProjectId, showArchivedDocuments]);

  async function bootstrap() {
    try {
      setError("");
      const [projectsResponse, settingsResponse, mcpSettingsResponse] = await Promise.all([
        api.listProjects(showArchivedProjects),
        api.getAiSettings(),
        api.getMcpSettings()
      ]);
      setProjects(projectsResponse.projects);
      void refreshSessionsForProjects(projectsResponse.projects.map((project) => project.id));
      setAiSettings(settingsResponse.settings);
      setMcpSettings(mcpSettingsResponse.settings);
      const firstActiveProject = projectsResponse.projects.find((project) => !project.archivedAt);
      if (firstActiveProject) {
        setSelectedProjectId(firstActiveProject.id);
      } else {
        setStatus(t("请先创建项目", "Create a project first"));
      }
      await syncModelLogs();
    } catch (err) {
      setError(getErrorMessage(err));
      setStatus(t("加载失败", "Failed to load"));
    }
  }

  async function loadProjects() {
    try {
      const response = await api.listProjects(showArchivedProjects);
      setProjects(response.projects);
      void refreshSessionsForProjects(response.projects.map((project) => project.id));
      if (selectedProjectId && !response.projects.some((project) => project.id === selectedProjectId)) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadProjectWorkspace(projectId: string) {
    try {
      setError("");
      const [documentsResponse, sessionsResponse, statsResponse, graphResponse] = await Promise.all([
        api.listDocuments(projectId, showArchivedDocuments),
        api.listMcpSessions(projectId),
        api.getProjectStats(projectId),
        api.getProjectGraph(projectId)
      ]);
      setDocuments(documentsResponse.documents);
      setSessionsByProjectId((current) => ({
        ...current,
        [projectId]: sessionsResponse.sessions
      }));
      setProjectStats(statsResponse.stats);
      setProjectGraph(graphResponse.graph);
      // Selection policy: respect the user's click. If the user has
      // explicitly picked a document, do not steal focus even if that
      // id happens to be missing from the latest response (it might
      // be paginated, just archived, or in the middle of being
      // re-synced). Only auto-pick the first document when the user
      // has not yet chosen anything.
      if (userSelectedDocumentRef.current) {
        // Trust the user. Even if the selected id is not in the new
        // list, we keep it — the workspace loader will just not find
        // chunks for it and the user can switch to another doc.
        // No state change here.
      } else if (documentsResponse.documents[0] && !selectedDocumentId) {
        setSelectedDocumentId(documentsResponse.documents[0].id);
      } else if (!documentsResponse.documents[0]) {
        setSelectedDocumentId("");
      }
      const preferredSessionId = pendingSessionIdRef.current;
      const sessionToOpen = preferredSessionId && sessionsResponse.sessions.some((session) => session.id === preferredSessionId)
        ? preferredSessionId
        : sessionsResponse.sessions[0]?.id;
      pendingSessionIdRef.current = null;
      if (sessionToOpen) {
        await loadMcpSession(sessionToOpen);
      } else {
        setMcpDetail(null);
      }
      setStatus(t("就绪", "Ready"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function loadDocumentWorkspace(documentId: string) {
    try {
      setError("");
      const [documentResponse, chunksResponse, eventsResponse, entitiesResponse] = await Promise.all([
        api.getDocument(documentId),
        api.listChunks(documentId),
        api.listEvents(documentId),
        api.listEntities(documentId)
      ]);
      setSelectedDocument(documentResponse.document);
      setChunks(chunksResponse.chunks);
      setEvents(eventsResponse.events);
      setEntities(entitiesResponse.entities);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function pollUploadJobs(jobIds: string[]) {
    try {
      const responses = await Promise.all(jobIds.map((jobId) => api.getUploadJob(jobId)));
      const latestJobs = responses.map((response) => response.job);
      setUploadJobs((current) => current.map((job) => latestJobs.find((latest) => latest.id === job.id) ?? job));
      await syncModelLogs();
      const completedJobs = latestJobs.filter((job) => job.status === "COMPLETED" && job.documentId);
      for (const job of completedJobs) {
        if (refreshedUploadJobsRef.current.has(job.id)) {
          continue;
        }
        refreshedUploadJobsRef.current.add(job.id);
        if (selectedProjectId) {
          await loadProjectWorkspace(selectedProjectId);
        }
        if (job.documentId) {
          // Pin the just-uploaded document — treat it as a user
          // selection so the next 5s refresh doesn't yank the focus.
          userSelectedDocumentRef.current = true;
          setSelectedDocumentId(job.documentId);
          setResultView("overview");
        }
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function syncModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence < modelLogCursorRef.current) {
        modelLogCursorRef.current = 0;
        setModelLogCursor(0);
        setModelLogs([]);
        if (response.latestSequence === 0) {
          return;
        }
        const freshResponse = await api.listModelCallLogs(0);
        if (freshResponse.logs.length > 0) {
          setModelLogs(freshResponse.logs.slice(-MAX_BROWSER_MODEL_LOGS));
        }
        modelLogCursorRef.current = freshResponse.latestSequence;
        setModelLogCursor(freshResponse.latestSequence);
        return;
      }
      if (response.logs.length > 0) {
        setModelLogs((current) => mergeModelLogs(current, response.logs));
      }
      if (response.latestSequence > modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model logs", err);
    }
  }

  function setActivityPanelMode(mode: ContextPanelMode) {
    setContextPanelMode(mode);
    if (mode === "logs") {
      void syncModelLogs();
    }
  }

  async function refreshSessionsForProjects(projectIds: string[]) {
    const uniqueProjectIds = [...new Set(projectIds.filter(Boolean))];
    if (uniqueProjectIds.length === 0) {
      setSessionsByProjectId({});
      return;
    }
    try {
      const entries = await Promise.all(uniqueProjectIds.map(async (projectId) => {
        const response = await api.listMcpSessions(projectId);
        return [projectId, response.sessions] as const;
      }));
      setSessionsByProjectId((current) => {
        const next = { ...current };
        for (const [projectId, projectSessions] of entries) {
          next[projectId] = projectSessions;
        }
        return next;
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function clearModelLogs() {
    try {
      const response = await api.listModelCallLogs(modelLogCursorRef.current);
      if (response.latestSequence !== modelLogCursorRef.current) {
        modelLogCursorRef.current = response.latestSequence;
        setModelLogCursor(response.latestSequence);
      }
    } catch (err) {
      console.warn("Failed to sync model log cursor before clearing", err);
    }
    setModelLogs([]);
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
    window.localStorage.setItem(MODEL_LOG_CURSOR_STORAGE_KEY, String(modelLogCursorRef.current));
    setStatus(t("已清空浏览器缓存中的原始日志", "Raw logs in browser cache have been cleared"));
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) return false;
    try {
      setError("");
      const response = await api.createProject({ name });
      setNewProjectName("");
      await loadProjects();
      setSelectedProjectId(response.project.id);
      setWorkspaceView("chat");
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function renameProject(project: SourceRecord, name: string) {
    const nextName = name.trim();
    if (!nextName || nextName === project.name) return false;
    setError("");
    try {
      await api.updateProject(project.id, { name: nextName });
      await loadProjects();
      setStatus(t(`已重命名项目为「${nextName}」。`, `Project renamed to "${nextName}".`));
      return true;
    } catch (err) {
      setError(getErrorMessage(err));
      return false;
    }
  }

  async function archiveOrRestoreProject(project: SourceRecord) {
    const confirmText = project.archivedAt
      ? t(`恢复项目「${project.name}」？`, `Restore project "${project.name}"?`)
      : t(`归档项目「${project.name}」？`, `Archive project "${project.name}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (project.archivedAt) {
        await api.restoreProject(project.id);
      } else {
        await api.archiveProject(project.id);
      }
      await loadProjects();
      if (!project.archivedAt && selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteProject(project: SourceRecord) {
    const confirmed = window.confirm(t(
      `永久删除项目「${project.name}」？\n\n这会级联删除该项目下的文档、切片、事件、实体和相关关系，且不可恢复。`,
      `Permanently delete project "${project.name}"?\n\nThis will cascade delete documents, chunks, events, entities, and relations under this project. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除项目。", "Permanent project deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteProject(project.id);
      // Optimistically drop the deleted project so the sidebar refreshes
      // instantly instead of waiting for the round-trip fetch. The
      // follow-up loadProjects() reconciles any drift (e.g. cascade
      // counts on aggregate pages).
      setProjects((current) => current.filter((entry) => entry.id !== project.id));
      await loadProjects();
      if (selectedProjectId === project.id) {
        setSelectedProjectId("");
      }
      setStatus(t(`已永久删除项目「${project.name}」。`, `Project "${project.name}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function renameDocument(document: DocumentRecord) {
    const title = window.prompt(t("请输入新的文档名称", "Enter a new document name"), document.title)?.trim();
    if (!title || title === document.title) return;
    try {
      await api.updateDocument(document.id, { title });
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        await loadDocumentWorkspace(document.id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function archiveOrRestoreDocument(document: DocumentRecord) {
    const confirmText = document.archivedAt
      ? t(`恢复文档「${document.title}」？`, `Restore document "${document.title}"?`)
      : t(`归档文档「${document.title}」？`, `Archive document "${document.title}"?`);
    if (!window.confirm(confirmText)) return;
    try {
      if (document.archivedAt) {
        await api.restoreDocument(document.id);
      } else {
        await api.archiveDocument(document.id);
      }
      await loadProjectWorkspace(document.sourceId);
      if (!document.archivedAt && selectedDocumentId === document.id) {
        setSelectedDocumentId("");
        // The selected document was just archived (or the user was
        // viewing a different one that got archived), so the next
        // refresh should auto-pick the first remaining document.
        userSelectedDocumentRef.current = false;
      }
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function permanentlyDeleteDocument(document: DocumentRecord) {
    const confirmed = window.confirm(t(
      `永久删除文档「${document.title}」？\n\n这会删除相关切片、事件、实体关系，且不可恢复。`,
      `Permanently delete document "${document.title}"?\n\nThis will delete related chunks, event relations, and entity relations. This action cannot be undone.`
    ));
    if (!confirmed) {
      setError("");
      setStatus(t("已取消永久删除文档。", "Permanent document deletion canceled."));
      return;
    }
    try {
      setError("");
      await api.deleteDocument(document.id);
      await loadProjectWorkspace(document.sourceId);
      if (selectedDocumentId === document.id) {
        setSelectedDocumentId("");
        // Pinned document was just deleted — let the next refresh
        // auto-pick the first remaining document.
        userSelectedDocumentRef.current = false;
      }
      setStatus(t(`已永久删除文档「${document.title}」。`, `Document "${document.title}" has been permanently deleted.`));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  const CONVERTIBLE_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".xls", ".csv", ".png", ".jpg", ".jpeg"]);
  const DIRECT_EXTENSIONS = new Set([".md", ".txt"]);
  const ALL_UPLOAD_EXTENSIONS = new Set([...CONVERTIBLE_EXTENSIONS, ...DIRECT_EXTENSIONS]);

  async function handleUploadFiles(files: File[]) {
    if (!selectedProjectId) {
      setError(t("请先创建或选择项目，再添加文档。", "Create or select a project before adding documents."));
      return;
    }
    if (files.length === 0) {
      return;
    }
    const invalidFile = files.find((file) => {
      const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
      return !ALL_UPLOAD_EXTENSIONS.has(extension) || file.size === 0 || file.size > 5 * 1024 * 1024;
    });
    if (invalidFile) {
      setError(t(
        `文件「${invalidFile.name}」不符合要求：支持 .md/.txt/.pdf/.docx/.xlsx/.csv/.png/.jpg，单个文件不超过 5MB。`,
        `File "${invalidFile.name}" is invalid: supported types are .md/.txt/.pdf/.docx/.xlsx/.csv/.png/.jpg up to 5 MB.`
      ));
      return;
    }
    try {
      setError("");
      setStatus(t(`已提交 ${files.length} 个文档处理任务`, `${files.length} document processing job(s) submitted`));
      for (const file of files) {
        const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
        const isConvertible = CONVERTIBLE_EXTENSIONS.has(extension);

        setStatus(t(`正在读取：${file.name}`, `Reading: ${file.name}`));
        let content: string;
        let finalFileName: string;

        if (isConvertible) {
          // Convert to markdown via backend API
          setStatus(t(`正在转换：${file.name} → .md`, `Converting: ${file.name} → .md`));
          const arrayBuffer = await file.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");
          const converted = await api.convertFile(file.name, base64);
          content = converted.markdown;
          finalFileName = `${file.name.replace(/\.[^.]+$/, "")}.md`;
        } else {
          content = await file.text();
          finalFileName = file.name;
        }

        const response = await api.createUploadJob({
          sourceId: selectedProjectId,
          title: finalFileName.replace(/\.[^.]+$/, ""),
          fileName: finalFileName,
          content
        });
        refreshedUploadJobsRef.current.delete(response.job.id);
        setUploadJobs((current) => [response.job, ...current].slice(0, 20));
      }
      setStatus(t("文档正在处理中", "Documents are being processed"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  function resetProcess(title: string, detail?: string) {
    setContextPanelMode("process");
    setProcessSteps([{
      id: makeStepId("start"),
      title,
      detail,
      status: "running"
    }]);
  }

  function addProcessStep(step: Omit<ProcessStep, "id"> & { id?: string }) {
    setProcessSteps((current) => [...current, {
      id: step.id ?? makeStepId("step"),
      title: step.title,
      detail: step.detail,
      status: step.status,
      payload: step.payload,
      durationMs: step.durationMs
    }]);
  }

  function upsertProcessStep(step: ProcessStep) {
    setProcessSteps((current) => {
      const existingIndex = current.findIndex((item) => item.id === step.id);
      if (existingIndex === -1) {
        return [...current, step];
      }
      return current.map((item, index) => {
        if (index !== existingIndex) return item;
        return {
          ...item,
          title: step.title,
          detail: step.detail,
          status: step.status,
          payload: step.payload ?? item.payload,
          durationMs: step.durationMs ?? item.durationMs
        };
      });
    });
  }

  function finishRunningSteps() {
    setProcessSteps((current) => current.map((step) => (
      step.status === "running" ? { ...step, status: "done" } : step
    )));
  }

  function appendMessageToDetail(message: McpMessageRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== message.sessionId) return current;
      if (current.messages.some((item) => item.id === message.id)) return current;
      return {
        ...current,
        messages: [...current.messages, message]
      };
    });
  }

  function appendToolCallToDetail(toolCall: McpToolCallRecord) {
    setMcpDetail((current) => {
      if (!current || current.session.id !== toolCall.sessionId) return current;
      if (current.toolCalls.some((item) => item.id === toolCall.id)) return current;
      return {
        ...current,
        toolCalls: [...current.toolCalls, toolCall]
      };
    });
  }

  function handleMcpStreamEvent(event: McpStreamEvent) {
    if (event.type === "stage") {
      return;
    }
    if (event.type === "message") {
      appendMessageToDetail(event.message);
      if (event.message.role === "user") {
        setPendingUserMessage("");
      }
      if (event.message.role === "assistant") {
        setStreamingAssistantText("");
      }
      return;
    }
    if (event.type === "assistant_delta") {
      setStreamingAssistantText((current) => current + event.delta);
      return;
    }
    if (event.type === "tool_start") {
      if (event.toolName === "sag_search") {
        setRunningMcpSearches((current) => [
          ...current,
          buildRunningMcpSearch(event.toolName, event.arguments, language)
        ]);
        resetProcess(t("MCP 搜索语句", "MCP search query"), getMcpSearchQuery(event.arguments, language));
        addProcessStep({
          id: "mcp-sag-search-running",
          title: t("SAG 检索执行中", "SAG retrieval is running"),
          detail: t(
            "MCP 工具已发起 sag_search，正在实时接收 SAG 内部检索阶段。",
            "The MCP tool has started sag_search and is receiving SAG internal retrieval stages in real time."
          ),
          status: "running",
          payload: event.arguments
        });
      }
      return;
    }
    if (event.type === "search_progress") {
      upsertProcessStep({
        id: `search-${event.event.key}`,
        title: event.event.title,
        detail: event.event.detail,
        status: event.event.status,
        payload: event.event.payload,
        durationMs: event.event.durationMs
      });
      return;
    }
    if (event.type === "tool_end") {
      appendToolCallToDetail(event.toolCall);
      if (event.toolCall.toolName === "sag_search") {
        if (event.toolCall.status === "FAILED") {
          setProcessSteps([{
            id: makeStepId("sag-search-failed"),
            title: t("SAG 检索失败", "SAG retrieval failed"),
            detail: event.toolCall.error ?? t("工具返回失败", "Tool returned a failure"),
            status: "failed"
          }]);
          return;
        }
        const parsed = parseToolResponse(event.toolCall.result);
        const trace = extractSearchTrace(parsed);
        if (trace) {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            ...buildTraceProcessSteps(trace, t("SAG 检索链路", "SAG retrieval trace"), language),
            ...buildMcpSearchResultSteps(parsed, language)
          ]);
        } else {
          setProcessSteps([
            buildMcpSearchQueryStep(event.toolCall, language),
            {
              id: makeStepId("sag-search-no-trace"),
              title: t("SAG 检索链路", "SAG retrieval trace"),
              detail: t("工具返回了检索结果，但没有返回 trace 字段。", "The tool returned retrieval results but did not include a trace field."),
              status: "failed",
              payload: parsed
            }
          ]);
        }
      }
      return;
    }
    if (event.type === "done") {
      if (event.detail) {
        setMcpDetail(event.detail);
      }
      finishRunningSteps();
      setStatus(t("对话完成", "Conversation complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("执行失败", "Execution failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  function handleSearchStreamEvent(event: SearchStreamEvent) {
    if (event.type === "step") {
      upsertProcessStep({
        id: `search-${event.key}`,
        title: event.title,
        detail: event.detail,
        status: event.status,
        payload: event.payload,
        durationMs: event.durationMs
      });
      return;
    }
    if (event.type === "done") {
      setSearchResult(event.result);
      finishRunningSteps();
      addProcessStep({
        id: "search-complete",
        title: t("检索完成", "Search complete"),
        detail: t(`返回 ${event.result.sections.length} 个切片结果`, `${event.result.sections.length} chunk result(s) returned`),
        status: "done",
        payload: {
          traceId: event.result.traceId,
          sections: event.result.sections.map((section) => ({
            heading: section.heading,
            contentPreview: section.content.slice(0, 160),
            score: section.score,
            rank: section.rank
          }))
        },
        durationMs: searchStartedAtRef.current == null
          ? undefined
          : Math.round(performance.now() - searchStartedAtRef.current)
      });
      setStatus(t("检索完成", "Search complete"));
      return;
    }
    if (event.type === "error") {
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: event.message,
        status: "failed"
      });
      setError(event.message);
    }
  }

  async function runSearch() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    if (!searchQuery.trim()) {
      setError(t("请输入检索问题。", "Enter a search question."));
      return;
    }
    setIsSearching(true);
    setSearchResult(null);
    searchStartedAtRef.current = performance.now();
    resetProcess(t("开始检索", "Start search"), searchQuery.trim());
    try {
      setError("");
      await api.streamSearch({
        query: searchQuery.trim(),
        sourceIds: [selectedProjectId],
        searchMode
      }, handleSearchStreamEvent);
      await syncModelLogs();
    } catch (err) {
      await syncModelLogs();
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("检索失败", "Search failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      setIsSearching(false);
    }
  }

  async function createMcpSession() {
    if (!selectedProjectId) {
      setError(t("请先选择项目。", "Select a project first."));
      return;
    }
    const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
    const sessionsResponse = await api.listMcpSessions(selectedProjectId);
    setSessionsByProjectId((current) => ({
      ...current,
      [selectedProjectId]: sessionsResponse.sessions
    }));
    await loadMcpSession(response.session.id);
    setWorkspaceView("chat");
  }

  async function loadMcpSession(sessionId: string) {
    const detail = await api.getMcpSession(sessionId);
    setMcpDetail(detail);
  }

  async function clearCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    if (!window.confirm(t(
      "清空当前对话记录？\n\n这会删除该会话里的消息和工具调用记录，但会保留会话本身。",
      "Clear the current conversation history?\n\nThis will delete messages and tool call records in this session, while keeping the session itself."
    ))) {
      return;
    }
    try {
      setError("");
      const detail = await api.clearMcpSession(mcpDetail.session.id);
      setMcpDetail(detail);
      setProcessSteps([]);
      setSearchResult(null);
      setStatus(t("对话记录已清空", "Conversation history cleared"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function deleteCurrentMcpSession() {
    if (!mcpDetail) {
      setError(t("请先选择对话。", "Select a conversation first."));
      return;
    }
    if (!window.confirm(t(
      `删除对话「${mcpDetail.session.title}」？\n\n这会永久删除该会话、消息和工具调用记录，且不可恢复。`,
      `Delete conversation "${mcpDetail.session.title}"?\n\nThis will permanently delete the session, messages, and tool call records. This action cannot be undone.`
    ))) {
      return;
    }
    try {
      setError("");
      const deletedSessionId = mcpDetail.session.id;
      await api.deleteMcpSession(deletedSessionId);
      const sessionsResponse = await api.listMcpSessions(selectedProjectId || undefined);
      if (selectedProjectId) {
        setSessionsByProjectId((current) => ({
          ...current,
          [selectedProjectId]: sessionsResponse.sessions
        }));
      }
      const nextSession = sessionsResponse.sessions.find((session) => session.id !== deletedSessionId) ?? null;
      if (nextSession) {
        await loadMcpSession(nextSession.id);
      } else {
        setMcpDetail(null);
      }
      setProcessSteps([]);
      setSearchResult(null);
      setStatus(t("对话已删除", "Conversation deleted"));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function sendMcpMessage() {
    const content = mcpInput.trim();
    if (!content || !selectedProjectId) return;
    let sessionId = mcpDetail?.session.id;
    const abortController = new AbortController();
    mcpAbortControllerRef.current = abortController;
    setIsMcpRunning(true);
    setPendingUserMessage(content);
    setStreamingAssistantText("");
    setRunningMcpSearches([]);
    setMcpInput("");
    setContextPanelMode("process");
    setProcessSteps([]);
    try {
      setError("");
      if (!sessionId) {
        const response = await api.createMcpSession({ sourceIds: [selectedProjectId] });
        sessionId = response.session.id;
        const sessionsResponse = await api.listMcpSessions(selectedProjectId);
        setSessionsByProjectId((current) => ({
          ...current,
          [selectedProjectId]: sessionsResponse.sessions
        }));
        await loadMcpSession(sessionId);
      }
      await api.streamMcpMessage(sessionId, content, handleMcpStreamEvent, { signal: abortController.signal });
      await syncModelLogs();
      await refreshSessionsForProjects([selectedProjectId]);
    } catch (err) {
      await syncModelLogs();
      if (isAbortError(err)) {
        setStatus(t("已停止生成", "Generation stopped"));
        if (sessionId) {
          await loadMcpSession(sessionId);
          await refreshSessionsForProjects([selectedProjectId]);
        }
        addProcessStep({
          title: t("已停止", "Stopped"),
          detail: t("你手动停止了本轮 MCP 对话。", "You manually stopped this MCP conversation turn."),
          status: "done"
        });
        return;
      }
      setError(getErrorMessage(err));
      addProcessStep({
        title: t("对话失败", "Conversation failed"),
        detail: getErrorMessage(err),
        status: "failed"
      });
    } finally {
      if (mcpAbortControllerRef.current === abortController) {
        mcpAbortControllerRef.current = null;
      }
      setPendingUserMessage("");
      setStreamingAssistantText("");
      setIsMcpRunning(false);
    }
  }

  function stopMcpMessage() {
    if (!isMcpRunning) return;
    setStatus(t("正在停止生成...", "Stopping generation..."));
    mcpAbortControllerRef.current?.abort();
  }

  async function openEventDetail(eventId: string) {
    try {
      setDrawer({ type: "event", detail: await api.getEvent(eventId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function openEntityDetail(entityId: string) {
    try {
      setDrawer({ type: "entity", detail: await api.getEntity(entityId) });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function saveAiSettings(input: SettingsInput) {
    setIsSavingSettings(true);
    setSaveStatus(null);
    try {
      setError("");
      const response = await api.updateAiSettings(input);
      setAiSettings(response.settings);
      setSaveStatus({ kind: "success", message: t("设置已保存", "Settings saved") });
    } catch (err) {
      const msg = getErrorMessage(err);
      setSaveStatus({ kind: "error", message: msg });
      setError(msg);
    } finally {
      setIsSavingSettings(false);
    }
  }

  function toggleSettings() {
    setWorkspaceView((current) => current === "settings" ? "chat" : "settings");
  }

  function toggleProjectExpanded(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function selectProjectSession(projectId: string, sessionId: string) {
    setWorkspaceView("chat");
    setExpandedProjectIds((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
    if (selectedProjectId !== projectId) {
      pendingSessionIdRef.current = sessionId;
      setSelectedProjectId(projectId);
      return;
    }
    pendingSessionIdRef.current = null;
    await loadMcpSession(sessionId);
  }

  const showActivityPanel = workspaceView === "chat";

  return (
    <div className={cn(
      "grid h-dvh min-h-0 grid-cols-[minmax(188px,220px)_minmax(0,1fr)] overflow-hidden bg-card text-foreground",
      "lg:grid-cols-[268px_minmax(0,1fr)]"
    )}>
      <ProjectRail
        projects={projects}
        selectedProjectId={selectedProjectId}
        sessionsByProjectId={sessionsByProjectId}
        expandedProjectIds={expandedProjectIds}
        selectedSessionId={mcpDetail?.session.id ?? ""}
        isSessionBusy={isMcpRunning}
        isSettingsOpen={workspaceView === "settings"}
        showArchived={showArchivedProjects}
        newProjectName={newProjectName}
        onNewProjectNameChange={setNewProjectName}
        onCreateProject={createProject}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId);
          setSelectedWatchedId(null);
          setWorkspaceView("projectDetail");
        }}
        onToggleProjectExpanded={toggleProjectExpanded}
        onRenameProject={renameProject}
        onArchiveOrRestoreProject={(project) => { void archiveOrRestoreProject(project); }}
        onDeleteProject={(project) => { void permanentlyDeleteProject(project); }}
        onToggleArchived={setShowArchivedProjects}
        onOpenSettings={toggleSettings}
        onCreateSession={() => void createMcpSession()}
        onSelectProjectSession={(projectId, sessionId) => void selectProjectSession(projectId, sessionId)}
        watchedFolders={watchedFolders}
        selectedWatchedId={selectedWatchedId}
        watchedFoldersListActive={workspaceView === "watchedFolders" && selectedWatchedId === null}
        onOpenWatchedFoldersList={() => {
          // Land on the list view with no folder pre-selected. We reset
          // watchedNewRequest so the wizard "new" mode does not stay
          // armed after the user leaves a creation flow.
          setSelectedWatchedId(null);
          setWatchedNewRequest(0);
          setWorkspaceView("watchedFolders");
        }}
        onSelectWatched={(id) => {
          if (!id) {
            openCreateWatcherWizard();
            return;
          }
          // Data source click → always go to WatchedFolders management.
          setSelectedWatchedId(id);
          setSelectedProjectId("");
          setWorkspaceView("watchedFolders");
        }}
        onOpenCreateWatcherWizard={openCreateWatcherWizard}
        onOpenKbForProject={async (projectId) => {
          let kbProjectId = projectId;
          try {
            const r = await api.getKbProject(projectId);
            setKbDetail({ project: r.project, sources: r.sources });
          } catch {
            const project = projects.find((p) => p.id === projectId);
            if (!project) return;
            let existing = kbProjects.find((k) => k.name === project.name);
            if (!existing) {
              try {
                const created = await api.createKbProject({ name: project.name, description: null });
                existing = { id: created.project.id, name: created.project.name, description: null, sourceCount: 0 };
                await loadKbProjects();
              } catch (createErr) {
                await loadKbProjects();
                existing = kbProjects.find((k) => k.name === project.name);
                if (!existing) {
                  alert("无法访问 KB 项目: " + String(createErr));
                  return;
                }
              }
            }
            kbProjectId = existing.id;
            const detail = await api.getKbProject(existing.id);
            setKbDetail({ project: detail.project, sources: detail.sources, sourcesProjectId: project.id });
          }
          setSelectedKbId(kbProjectId);
          setKbDrawerOpen(true);
        }}
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-border px-4 py-2 md:px-6">
          {workspaceView === "settings" ? null : (
            <div className="flex items-center gap-3">
              <div className="text-sm font-medium text-muted-foreground">{t("本地文档检索", "Local Document Search")}</div>
              <span className="text-xs text-muted-foreground">/</span>
              {selectedProjectId ? (
                <div className="flex items-center gap-1.5 text-sm font-semibold text-blue-700">
                  <FolderOpen className="h-4 w-4" />
                  {projects.find((p) => p.id === selectedProjectId)?.name ?? t("项目", "Project")}
                </div>
              ) : selectedWatchedId ? (
                <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-700">
                  <Folder className="h-4 w-4" />
                  {watchedFolders.find((f) => f.id === selectedWatchedId)?.displayName ?? t("监听文件夹", "Watched Folder")}
                </div>
              ) : null}
            </div>
          )}
        </header>

        {error ? (
          <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 md:px-6">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 truncate">{friendlyError(error)}</span>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-red-200 bg-white/60 px-2 py-0.5 text-xs font-medium text-red-700 transition-colors hover:bg-white"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </button>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
              className="shrink-0 rounded p-0.5 text-red-500 transition-colors hover:bg-red-100 hover:text-red-700"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div className={cn(
          "grid min-h-0 flex-1",
          showActivityPanel ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]" : "grid-cols-1"
        )}>
          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border">
            {workspaceView === "settings" ? (
              <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
                <SettingsPanel
                  settings={aiSettings}
                  isSaving={isSavingSettings}
                  saveStatus={saveStatus}
                  language={language}
                  languagePreference={languagePreference}
                  onLanguagePreferenceChange={setLanguagePreference}
                  onSave={(input) => void saveAiSettings(input)}
                />
              </section>
            ) : workspaceView === "projectDetail" ? (
              <ProjectDetail
                project={selectedProject}
                documents={visibleDocuments}
                selectedDocumentId={selectedDocumentId}
                selectedDocument={selectedDocument}
                chunks={chunks}
                events={events}
                entities={entities}
                projectStats={projectStats}
                kbRefreshKey={kbRefreshKey}
                projectGraph={projectGraph}
                resultView={resultView}
                showArchivedDocuments={showArchivedDocuments}
                hasActiveUploads={hasActiveUploads}
                uploadJobs={uploadJobs}
                isUploadQueueExpanded={isUploadQueueExpanded}
                searchQuery={searchQuery}
                searchMode={searchMode}
                searchResult={searchResult}
                isSearching={isSearching}
                fileInputRef={fileInputRef}
                mcpSettings={mcpSettings}
                watchedFolders={watchedFolders}
                onKbRefresh={() => void loadKbProjects()}
                onWatchedFoldersRefresh={() => void loadWatchedFolders()}
                onArchiveOrRestoreProject={(p) => void archiveOrRestoreProject(p)}
                onDeleteProject={(p) => void permanentlyDeleteProject(p)}
                onUploadFiles={(files) => void handleUploadFiles(files)}
                onToggleUploadQueue={() => setIsUploadQueueExpanded((current) => !current)}
                onSelectDocument={(id) => {
                  // Mark as user-initiated so the next 5s workspace
                  // refresh doesn't yank the focus back to the first
                  // document if the new response doesn't include this id.
                  userSelectedDocumentRef.current = true;
                  setSelectedDocumentId(id);
                }}
                onRenameDocument={(document) => void renameDocument(document)}
                onArchiveOrRestoreDocument={(document) => void archiveOrRestoreDocument(document)}
                onDeleteDocument={(document) => void permanentlyDeleteDocument(document)}
                onSetResultView={setResultView}
                onToggleArchivedDocuments={setShowArchivedDocuments}
                onSearchQueryChange={setSearchQuery}
                onSearchModeChange={setSearchMode}
                onSearch={() => void runSearch()}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
                onOpenKbDrawer={async () => {
                  if (!selectedProjectId) return;
                  // 尝试加载 KB project
                  let kbProjectId = selectedProjectId;
                  try {
                    const r = await api.getKbProject(selectedProjectId);
                    setKbDetail({ project: r.project, sources: r.sources, sourcesProjectId: selectedProjectId });
                  } catch {
                    // 加载失败：要么不存在，要么名重复。
                    // 先查找现有同名 KB project
                    const project = projects.find((p) => p.id === selectedProjectId);
                    if (!project) return;
                    let existing = kbProjects.find((k) => k.name === project.name);
                    if (!existing) {
                      // 名也不存在 → 尝试创建
                      try {
                        const created = await api.createKbProject({ name: project.name, description: null });
                        existing = { id: created.project.id, name: created.project.name, description: null, sourceCount: 0 };
                        await loadKbProjects();
                      } catch (createErr) {
                        // 409 Conflict (名重复) → 重试查询
                        await loadKbProjects();
                        existing = kbProjects.find((k) => k.name === project.name);
                        if (!existing) return;
                      }
                    }
                    kbProjectId = existing.id;
                    const detail = await api.getKbProject(existing.id);
                    setKbDetail({ project: detail.project, sources: detail.sources, sourcesProjectId: selectedProjectId });
                  }
                  setSelectedKbId(kbProjectId);
                  setKbDrawerOpen(true);
                }}
              />
            ) : workspaceView === "documents" ? (
              <ProjectDocumentsWorkspace
                project={selectedProject}
                documents={visibleDocuments}
                selectedDocumentId={selectedDocumentId}
                selectedDocument={selectedDocument}
                chunks={chunks}
                events={events}
                entities={entities}
                projectStats={projectStats}
                resultView={resultView}
                showArchivedDocuments={showArchivedDocuments}
                hasActiveUploads={hasActiveUploads}
                uploadJobs={uploadJobs}
                isUploadQueueExpanded={isUploadQueueExpanded}
                searchQuery={searchQuery}
                searchMode={searchMode}
                searchResult={searchResult}
                isSearching={isSearching}
                fileInputRef={fileInputRef}
                onUploadFiles={(files) => void handleUploadFiles(files)}
                onToggleUploadQueue={() => setIsUploadQueueExpanded((current) => !current)}
                onSelectDocument={(id) => {
                  userSelectedDocumentRef.current = true;
                  setSelectedDocumentId(id);
                }}
                onRenameDocument={(document) => void renameDocument(document)}
                onArchiveOrRestoreDocument={(document) => void archiveOrRestoreDocument(document)}
                onDeleteDocument={(document) => void permanentlyDeleteDocument(document)}
                onSetResultView={setResultView}
                onToggleArchivedDocuments={setShowArchivedDocuments}
                onSearchQueryChange={setSearchQuery}
                onSearchModeChange={setSearchMode}
                onSearch={() => void runSearch()}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
              />
            ) : workspaceView === "graph" ? (
              <ProjectGraphWorkspace
                project={selectedProject}
                graph={projectGraph}
                onOpenEvent={(eventId) => void openEventDetail(eventId)}
                onOpenEntity={(entityId) => void openEntityDetail(entityId)}
              />
            ) : workspaceView === "mcp" ? (
              <ProjectMcpWorkspace
                project={selectedProject}
                settings={mcpSettings}
              />
            ) : workspaceView === "watchedFolders" ? (
              <WatchedFoldersWorkspace
              key={`watched-${watchedNewRequest}`}
              selectedWatchedId={selectedWatchedId}
              sourceId={selectedProjectId || undefined}
              openInNewMode={watchedNewRequest > 0 && selectedWatchedId === null}
              onBack={() => setSelectedWatchedId(null)}
              onFoldersChanged={() => void loadWatchedFolders()}
            />
            ) : (
              <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
                <div>
                  <div className="mb-2 text-2xl">📚</div>
                  <div>{t("从左侧选一个 Project、Watched Folder 查看详情", "Select a Project or Watched Folder from the sidebar to view details")}</div>
                </div>
              </div>
            )}
          </main>

          {showActivityPanel ? (
            <ActivityPanel
              className="hidden lg:flex"
              mode={contextPanelMode}
              processSteps={processSteps}
              modelLogs={modelLogs}
              onSetMode={setActivityPanelMode}
              onRefreshModelLogs={() => void syncModelLogs()}
              onClearModelLogs={() => void clearModelLogs()}
            />
          ) : null}
        </div>
      </div>

      {drawer ? (
        <DetailDrawer
          drawer={drawer}
          onClose={() => setDrawer(null)}
          onOpenEvent={(eventId) => void openEventDetail(eventId)}
          onOpenEntity={(entityId) => void openEntityDetail(entityId)}
        />
      ) : null}

      {kbDrawerOpen ? (
        <KbDrawer
          detail={kbDetail}
          selectedKbId={selectedKbId}
          onClose={() => { setKbDrawerOpen(false); setSelectedKbId(null); }}
          onRefresh={async () => {
            await loadKbProjects();
            if (selectedKbId) await loadKbDetail(selectedKbId, kbDetail?.sourcesProjectId);
            // Adding/removing a KB source changes the project's stats and
            // graph (document/chunk/entity counts, entity nodes). Pull
            // them fresh so the project overview reflects the change
            // without the user having to switch projects and back.
            if (selectedProjectId) await loadProjectWorkspace(selectedProjectId);
          }}
          onFoldersChanged={() => void loadWatchedFolders()}
          onDelete={async (id) => {
            if (!confirm(t("删除该知识库？会移除所有 source 关联。", "Delete this KB? This removes all source associations."))) return;
            try {
              await api.deleteKbProject(id);
              setKbDrawerOpen(false);
              setSelectedKbId(null);
              setKbDetail(null);
              await loadKbProjects();
              setStatus(t(`已删除知识库「${kbProjects.find((p) => p.id === id)?.name ?? id}」。`, `KB project "${kbProjects.find((p) => p.id === id)?.name ?? id}" has been deleted.`));
            } catch (err) {
              setError(getErrorMessage(err));
            }
          }}
          onCopyMcpConfig={(kbId) => {
            const cfg = {
              command: "npx",
              args: ["tsx", "/home/admin/.openclaw/workspace/SAG/src/mcp/server.ts"],
              env: {
                DATABASE_URL: "postgres://sag_lite:***@localhost:5432/sag_lite",
                DEFAULT_TENANT_ID: "default",
                SAG_MCP_KB_PROJECT_ID: kbId
              }
            };
            void navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
            alert(t("已复制到剪贴板", "Copied to clipboard"));
          }}
        />
      ) : null}

    </div>
  );
}

function ProjectRail(props: {
  projects: SourceRecord[];
  selectedProjectId: string;
  sessionsByProjectId: Record<string, McpSessionRecord[]>;
  expandedProjectIds: Set<string>;
  selectedSessionId: string;
  isSessionBusy: boolean;
  isSettingsOpen: boolean;
  showArchived: boolean;
  newProjectName: string;
  onNewProjectNameChange: (value: string) => void;
  onCreateProject: () => Promise<boolean>;
  onSelectProject: (projectId: string) => void;
  onToggleProjectExpanded: (projectId: string) => void;
  onRenameProject: (project: SourceRecord, name: string) => Promise<boolean>;
  onArchiveOrRestoreProject: (project: SourceRecord) => void;
  onDeleteProject: (project: SourceRecord) => void;
  onToggleArchived: (value: boolean) => void;
  onOpenSettings: () => void;
  onCreateSession: () => void;
  onSelectProjectSession: (projectId: string, sessionId: string) => void;
  watchedFolders?: Array<{ id: string; displayName: string; path: string; enabled: boolean; lastScanAt: string | null }>;
  selectedWatchedId?: string | null;
  watchedFoldersListActive?: boolean;
  onSelectWatched?: (id?: string) => void;
  onOpenWatchedFoldersList?: () => void;
  onOpenCreateWatcherWizard?: () => void;
  onOpenKbForProject?: (projectId: string) => void;
}) {
  const { t } = useI18n();
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [createProjectDialogOpen, setCreateProjectDialogOpen] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [renameProjectTarget, setRenameProjectTarget] = useState<SourceRecord | null>(null);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [dataSourcesCollapsed, setDataSourcesCollapsed] = useState(false);
  const [autoSourcesCollapsed, setAutoSourcesCollapsed] = useState(true);
  // Auto-created sources (one per watched folder) are grouped under a hidden
  // collapsible rail so the main project list only shows manual projects.
  const autoProjects = props.projects.filter(
    (p) => (p.metadata as Record<string, unknown> | undefined)?.createdVia === "watcher"
  );
  const manualProjects = props.projects.filter(
    (p) => (p.metadata as Record<string, unknown> | undefined)?.createdVia !== "watcher"
  );
  const [renameProjectName, setRenameProjectName] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const canCreateProject = props.newProjectName.trim().length > 0 && !isCreatingProject;
  const canRenameProject = Boolean(renameProjectTarget)
    && renameProjectName.trim().length > 0
    && renameProjectName.trim() !== renameProjectTarget?.name
    && !isRenamingProject;

  function openCreateProjectDialog() {
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(true);
  }

  function closeCreateProjectDialog() {
    if (isCreatingProject) return;
    props.onNewProjectNameChange("");
    setCreateProjectDialogOpen(false);
  }

  function openRenameProjectDialog(project: SourceRecord) {
    setCreateProjectDialogOpen(false);
    setRenameProjectTarget(project);
    setRenameProjectName(project.name);
  }

  function closeRenameProjectDialog() {
    if (isRenamingProject) return;
    setRenameProjectTarget(null);
    setRenameProjectName("");
  }

  async function submitCreateProject() {
    if (!canCreateProject) return;
    setIsCreatingProject(true);
    try {
      const created = await props.onCreateProject();
      if (created) {
        setCreateProjectDialogOpen(false);
      }
    } finally {
      setIsCreatingProject(false);
    }
  }

  async function submitRenameProject() {
    if (!renameProjectTarget || !canRenameProject) return;
    setIsRenamingProject(true);
    try {
      const renamed = await props.onRenameProject(renameProjectTarget, renameProjectName);
      if (renamed) {
        setRenameProjectTarget(null);
        setRenameProjectName("");
      }
    } finally {
      setIsRenamingProject(false);
    }
  }

  return (
    <>
      <aside className="relative z-10 flex min-h-0 flex-col overflow-y-auto border-r border-border bg-muted/40">
        <div className="border-b border-border p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <MessageSquare className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">本地文档检索</div>
                <div className="truncate text-xs text-muted-foreground">{t("自动化文件检索工作台", "Automated document retrieval workbench")}</div>
              </div>
            </div>
            <Button
              variant={props.isSettingsOpen ? "secondary" : "ghost"}
              size="icon"
              className="h-8 w-8 shrink-0"
              title={t("全局设置", "Global settings")}
              aria-label={t("全局设置", "Global settings")}
              onClick={props.onOpenSettings}
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="mx-3 mt-3 rounded-md border border-purple-200 bg-purple-50/40 p-2" data-testid="projects-section">
          <div className="flex items-center justify-between mb-1.5">
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-semibold text-purple-700 hover:text-purple-900 transition-colors"
              onClick={() => setProjectsCollapsed((v) => !v)}
              title={projectsCollapsed ? t("展开项目", "Expand projects") : t("收起项目", "Collapse projects")}
            >
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !projectsCollapsed && "rotate-90")} />
              📁 {t("项目", "Projects")}
            </button>
            {!projectsCollapsed && (
              <button
                type="button"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-purple-700 hover:bg-purple-100"
                title={t("新建项目", "New project")}
                aria-label={t("新建项目", "New project")}
                onClick={openCreateProjectDialog}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

        {!projectsCollapsed && (
        <div className="sidebar-scroll space-y-1 max-h-[40vh] overflow-y-auto pr-1">
          {manualProjects.length === 0 ? (
            <div className="px-2 py-2 text-xs text-purple-700/70">
              {t("📁 暂无项目。点 + 创建", "📁 No projects yet. Click + to create")}
            </div>
          ) : manualProjects.map((project) => {
          const selected = project.id === props.selectedProjectId;
          const archived = !!project.archivedAt;
          return (
            <button
              key={project.id}
              type="button"
              data-testid={`project-${project.id}`}
              className={cn(
                "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-purple-100/60",
                selected && "bg-purple-100 border-l-2 border-purple-500 pl-1.5"
              )}
              onClick={() => props.onSelectProject(project.id)}
            >
              <Folder className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-purple-900">{project.name}</span>
                  {archived ? (
                    <span className="text-[9px] px-1 py-0 rounded bg-muted text-muted-foreground">
                      {t("归档", "Archived")}
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[10px] text-purple-600/70">
                  {shortId(project.id)}
                </span>
              </span>
            </button>
          );
          })}

          {autoProjects.length > 0 ? (
            <div className="mt-1 rounded-md border border-purple-200/70 bg-purple-50/30">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium text-purple-600/80 hover:text-purple-800 transition-colors"
                onClick={() => setAutoSourcesCollapsed((v) => !v)}
                title={autoSourcesCollapsed
                  ? t("展开自动数据源", "Expand auto data sources")
                  : t("收起自动数据源", "Collapse auto data sources")}
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform", !autoSourcesCollapsed && "rotate-90")} />
                {t("自动数据源", "Auto data sources")} ({autoProjects.length})
              </button>
              {!autoSourcesCollapsed && (
                <div className="space-y-0.5 px-1 pb-1">
                  {autoProjects.map((project) => {
                    const selected = project.id === props.selectedProjectId;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        data-testid={`project-${project.id}`}
                        className={cn(
                          "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-purple-100/60",
                          selected && "bg-purple-100 border-l-2 border-purple-500 pl-1.5"
                        )}
                        onClick={() => props.onSelectProject(project.id)}
                      >
                        <Folder className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-400" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-purple-800/80">{project.name}</span>
                          <span className="block truncate text-[10px] text-purple-600/60">
                            {shortId(project.id)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
        </div>
        )}
        </div>

        {/* Phase 4 fix 3: Watched Folders section (blue) */}
        <div className="border-t border-border px-3 pt-3 pb-3">
          {/* Watched Folders — 蓝色 = 数据源 */}
          <div className="rounded-md border border-blue-200 bg-blue-50/40 p-2">
            <div className="flex items-center justify-between mb-1.5">
              <button
                type="button"
                className="flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 transition-colors"
                onClick={() => setDataSourcesCollapsed((v) => !v)}
                title={dataSourcesCollapsed ? t("展开数据源", "Expand data sources") : t("收起数据源", "Collapse data sources")}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", !dataSourcesCollapsed && "rotate-90")} />
                📁 {t("数据源", "Data sources")}
              </button>
              {!dataSourcesCollapsed && (
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    data-testid="open-watched-folders-list"
                    className={cn(
                      "flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors",
                      props.watchedFoldersListActive
                        ? "bg-blue-100 text-blue-900"
                        : "text-blue-700 hover:bg-blue-100"
                    )}
                    title={t("查看所有监听文件夹", "Open watched folders list")}
                    onClick={() => props.onOpenWatchedFoldersList?.()}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t("列表", "List")}
                  </button>
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-blue-700 hover:bg-blue-100"
                    title={t("添加文件夹", "Add folder")}
                    onClick={() => props.onSelectWatched?.()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
            {!dataSourcesCollapsed && (<div className="sidebar-scroll max-h-[40vh] overflow-y-auto pr-1 space-y-1">
              {(props.watchedFolders ?? []).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`watched-folder-${f.id}`}
                  className={cn(
                    "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-blue-100/60",
                    props.selectedWatchedId === f.id && "bg-blue-100 border-l-2 border-blue-500 pl-1.5"
                  )}
                  onClick={() => props.onSelectWatched?.(f.id)}
                >
                  <Folder className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-blue-900">{f.displayName}</span>
                    <span className="block truncate text-[10px] text-blue-600/70">
                      <span className="font-mono">{f.path}</span>
                      <span> · </span>
                      <span className={f.enabled ? "text-blue-700" : "text-muted-foreground"}>
                        {f.enabled ? t("● 运行中", "● running") : t("○ 已停用", "○ paused")}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
              {(props.watchedFolders ?? []).length === 0 ? (
                <div className="px-2 py-2 text-xs text-blue-700/70">
                  {t("📁 暂无监听文件夹。点 + 添加", "📁 No watched folders. Click + to add")}
                </div>
              ) : null}
            </div>)}
          </div>

          </div>
      </aside>

      {createProjectDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="create-project-title">
            <div id="create-project-title" className="text-sm font-semibold">{t("新建项目", "New project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入项目名称后创建，文档和对话都会归属到这个项目。", "Enter a project name. Documents and chats will belong to this project.")}</p>
            <p className="mt-1 text-[11px] text-muted-foreground/80">{t("命名参考：审计年度+被审单位+事项，如「2025 年报审计 · 华东分公司」。", "Naming tip: audit year + entity + subject, e.g. \"FY2025 audit · East division\".")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={props.newProjectName}
              onChange={(event) => props.onNewProjectNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeCreateProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCreateProject();
                }
              }}
              placeholder={t("如：2025 年报审计 · 华东分公司", "e.g. FY2025 audit · East division")}
              disabled={isCreatingProject}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeCreateProjectDialog} disabled={isCreatingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitCreateProject()} disabled={!canCreateProject}>
                {isCreatingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {renameProjectTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation">
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg" role="dialog" aria-modal="true" aria-labelledby="rename-project-title">
            <div id="rename-project-title" className="text-sm font-semibold">{t("重命名项目", "Rename project")}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t("输入新的项目名称。", "Enter a new project name.")}</p>
            <Input
              autoFocus
              className="mt-4"
              value={renameProjectName}
              onChange={(event) => setRenameProjectName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeRenameProjectDialog();
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRenameProject();
                }
              }}
              placeholder={t("项目名称", "Project name")}
              disabled={isRenamingProject}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeRenameProjectDialog} disabled={isRenamingProject}>
                {t("取消", "Cancel")}
              </Button>
              <Button size="sm" onClick={() => void submitRenameProject()} disabled={!canRenameProject}>
                {isRenamingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t("确定", "Confirm")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ProjectMenuItem({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "block w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      role="menuitem"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function MainWorkspaceTabs(props: {
  view: WorkspaceView;
  onChange: (view: Exclude<WorkspaceView, "settings">) => void;
}) {
  const { t } = useI18n();
  const tabs: Array<{ value: Exclude<WorkspaceView, "settings">; label: string }> = [
    { value: "documents", label: t("文档", "Documents") },
    { value: "graph", label: t("图谱", "Graph") },
    { value: "mcp", label: "MCP" },
    { value: "watchedFolders", label: t("监听", "Watched") },
  ];
  return (
    <div className="grid w-full min-w-0 max-w-[28rem] grid-cols-6 rounded-md border border-border p-1 sm:w-auto sm:min-w-[28rem]">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          className={cn(
            "rounded px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
            props.view === tab.value && "bg-accent text-foreground"
          )}
          onClick={() => props.onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ConversationWorkspace(props: {
  project: SourceRecord | null;
  detail: McpSessionDetail | null;
  input: string;
  isRunning: boolean;
  pendingUserMessage: string;
  streamingAssistantText: string;
  runningMcpSearches: RunningMcpSearch[];
  onInputChange: (value: string) => void;
  onClearSession: () => void;
  onDeleteSession: () => void;
  onOpenCitation: (citation: AnswerCitation) => void;
  onStop: () => void;
  onSend: () => void;
}) {
  const { t } = useI18n();
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [props.detail?.messages.length, props.pendingUserMessage, props.streamingAssistantText, props.isRunning, props.runningMcpSearches.length]);

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目是文档、切片、事件、实体和 MCP 对话的共同归属。", "A project contains documents, chunks, events, entities, and MCP chats.")} />
      </section>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:flex-nowrap md:items-center md:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{props.detail?.session.title ?? t("新对话", "New chat")}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {props.detail ? `${formatModelName(props.detail.session.model, t)} · ${shortId(props.detail.session.id)}` : t("新建会话后开始测试 MCP 工具", "Create a chat to test MCP tools")}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={props.onClearSession} disabled={!props.detail || props.isRunning}>
            <RotateCcw className="h-4 w-4" />
            {t("清空记录", "Clear history")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onDeleteSession} disabled={!props.detail || props.isRunning}>
            <Trash2 className="h-4 w-4" />
            {t("删除对话", "Delete chat")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {!props.detail || props.detail.messages.length === 0 ? (
            <EmptyState title={t("还没有对话", "No conversation yet")} description={t("输入问题后，系统会通过 MCP 工具检索当前项目资料。", "Ask a question and the system will retrieve current project documents through MCP tools.")} />
          ) : props.detail.messages.map((message) => {
            const citations = getMessageCitations(message);
            return (
              <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[86%] rounded-lg px-3 py-2 text-sm leading-6",
                  message.role === "user" ? "bg-primary text-primary-foreground" : "border border-border bg-muted/35"
                )}>
                  <div className="mb-1 flex items-center gap-2 text-xs opacity-70">
                    {formatMessageRole(message.role, t)}
                    <span>{formatDate(message.createdAt)}</span>
                  </div>
                  <MarkdownMessage
                    content={formatMessageContent(message.content, t)}
                    citations={citations}
                    onOpenCitation={props.onOpenCitation}
                  />
                  {message.role === "assistant" && citations.length > 0 ? (
                    <CitationStrip citations={citations} onOpenCitation={props.onOpenCitation} />
                  ) : null}
                </div>
              </div>
            );
          })}

          {props.pendingUserMessage ? (
            <div className="flex justify-end">
              <div className="max-w-[86%] rounded-lg bg-primary px-3 py-2 text-sm leading-6 text-primary-foreground">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("用户", "User")}</div>
                <MarkdownMessage content={props.pendingUserMessage} />
              </div>
            </div>
          ) : null}

          {props.isRunning ? (
            <div className="flex justify-start">
              <RunningMcpSearchPanel searches={props.runningMcpSearches} />
            </div>
          ) : null}

          {props.streamingAssistantText ? (
            <div className="flex justify-start">
              <div className="max-w-[86%] rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm leading-6">
                <div className="mb-1 flex items-center gap-2 text-xs opacity-70">{t("助手", "Assistant")}</div>
                <MarkdownMessage content={formatMessageContent(props.streamingAssistantText, t)} />
              </div>
            </div>
          ) : null}

          <div ref={scrollAnchorRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-card px-4 py-1.5 md:px-6">
        <div className="mx-auto flex max-w-3xl gap-2 rounded-lg border border-border p-2">
          <Textarea
            className="h-10 min-h-10 flex-1 border-0 focus-visible:ring-0"
            value={props.input}
            onChange={(event) => props.onInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!props.isRunning && props.input.trim()) {
                  props.onSend();
                }
              }
            }}
            placeholder={t("基于当前项目资料提问...", "Ask about the current project documents...")}
          />
          <Button
            className="self-end"
            variant={props.isRunning ? "destructive" : "default"}
            onClick={props.isRunning ? props.onStop : props.onSend}
            disabled={!props.isRunning && !props.input.trim()}
          >
            {props.isRunning ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {props.isRunning ? t("停止", "Stop") : t("发送", "Send")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function RunningMcpSearchPanel(props: { searches: RunningMcpSearch[] }) {
  const { t } = useI18n();
  const searchCount = props.searches.length;
  return (
    <div className="max-w-[86%] rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm leading-6">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span className="font-medium text-foreground">{t("正在使用 MCP 检索", "Using MCP retrieval")}</span>
        <Badge className="border-border bg-card text-muted-foreground">{t(`${searchCount} 次搜索`, `${searchCount} search(es)`)}</Badge>
      </div>
      {searchCount === 0 ? (
        <div className="text-sm text-muted-foreground">{t("正在分析问题，等待 MCP 搜索语句...", "Analyzing the question and waiting for MCP search queries...")}</div>
      ) : (
        <div className="space-y-1.5">
          {props.searches.map((search, index) => (
            <div key={search.id} className="rounded-md border border-border bg-card/70 px-2.5 py-1.5">
              <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                <span className="shrink-0 text-xs font-medium text-muted-foreground">
                  {t(`搜索 ${index + 1}：`, `Search ${index + 1}:`)}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm text-foreground">
                  {search.query}
                </span>
              </div>
              {search.searchMode ? (
                <div className="mt-1 text-xs text-muted-foreground">{t("模式", "Mode")}：{search.searchMode}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CitationStrip(props: { citations: AnswerCitation[]; onOpenCitation: (citation: AnswerCitation) => void }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 border-t border-border pt-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{t("引用原文", "Source citations")}</div>
      <div className="flex flex-wrap gap-1.5">
        {props.citations.map((citation) => (
          <button
            key={`${citation.index}-${citation.chunkId}`}
            type="button"
            className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-card px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => props.onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProjectDocumentsWorkspace(props: {
  project: SourceRecord | null;
  documents: DocumentRecord[];
  selectedDocumentId: string;
  selectedDocument: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
  projectStats: ProjectStatsRecord | null;
  resultView: ResultView;
  showArchivedDocuments: boolean;
  hasActiveUploads: boolean;
  uploadJobs: UploadJobRecord[];
  isUploadQueueExpanded: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  searchResult: SearchResult | null;
  isSearching: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onUploadFiles: (files: File[]) => void;
  onToggleUploadQueue: () => void;
  onSelectDocument: (documentId: string) => void;
  onRenameDocument: (document: DocumentRecord) => void;
  onArchiveOrRestoreDocument: (document: DocumentRecord) => void;
  onDeleteDocument: (document: DocumentRecord) => void;
  onSetResultView: (view: ResultView) => void;
  onToggleArchivedDocuments: (value: boolean) => void;
  onSearchQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { language, t } = useI18n();
  const [resultTitleQuery, setResultTitleQuery] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const searchableResultView = props.resultView === "chunks" || props.resultView === "events" || props.resultView === "entities";
  const normalizedResultTitleQuery = normalizeKeyword(resultTitleQuery);
  const filteredChunks = useMemo(
    () => filterByKeyword(props.chunks, normalizedResultTitleQuery, (chunk) => chunk.heading || t("未命名切片", "Untitled chunk")),
    [normalizedResultTitleQuery, props.chunks]
  );
  const filteredEvents = useMemo(
    () => filterByKeyword(props.events, normalizedResultTitleQuery, (event) => event.title),
    [normalizedResultTitleQuery, props.events]
  );
  const filteredEntities = useMemo(
    () => filterByKeyword(props.entities, normalizedResultTitleQuery, (entity) => entity.name),
    [normalizedResultTitleQuery, props.entities]
  );
  const activeResultCount = props.resultView === "chunks"
    ? filteredChunks.length
    : props.resultView === "events"
      ? filteredEvents.length
      : props.resultView === "entities"
        ? filteredEntities.length
        : 0;
  const activeTotalCount = props.resultView === "chunks"
    ? props.chunks.length
    : props.resultView === "events"
      ? props.events.length
      : props.resultView === "entities"
        ? props.entities.length
        : 0;
  const resultPageCount = Math.max(1, Math.ceil(activeResultCount / DOCUMENT_RESULT_PAGE_SIZE));
  const currentResultPage = Math.min(resultPage, resultPageCount);
  const paginatedChunks = useMemo(
    () => paginateItems(filteredChunks, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredChunks]
  );
  const paginatedEvents = useMemo(
    () => paginateItems(filteredEvents, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEvents]
  );
  const paginatedEntities = useMemo(
    () => paginateItems(filteredEntities, currentResultPage, DOCUMENT_RESULT_PAGE_SIZE),
    [currentResultPage, filteredEntities]
  );

  useEffect(() => {
    setResultPage(1);
  }, [normalizedResultTitleQuery, props.resultView, props.selectedDocumentId]);

  useEffect(() => {
    if (resultPage > resultPageCount) {
      setResultPage(resultPageCount);
    }
  }, [resultPage, resultPageCount]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{t("项目文档", "Project documents")}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {props.project?.name ?? t("请选择项目", "Select a project")}
            {props.selectedDocument ? ` · ${props.selectedDocument.title}` : ""}
          </p>
        </div>
        {props.project ? (
          <Button size="sm" onClick={() => props.fileInputRef.current?.click()}>
            {props.hasActiveUploads ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {t("添加文档", "Add document")}
          </Button>
        ) : null}
      </div>

      <input
        ref={props.fileInputRef}
        type="file"
        className="hidden"
        multiple
        accept=".md,.txt,.pdf,.docx,.xlsx,.xls,.csv,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,image/png,image/jpeg"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = "";
          props.onUploadFiles(files);
        }}
      />

      {!props.project ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState title={t("没有项目", "No project")} description={t("创建项目后，才能上传文档并查看处理结果。", "Create a project before uploading documents and viewing processing results.")} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto border-r border-border p-4 scrollbar-thin">
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Metric label={t("文档", "Documents")} value={props.projectStats?.documentCount ?? props.documents.length} />
              <Metric label={t("切片", "Chunks")} value={props.projectStats?.chunkCount ?? props.chunks.length} />
              <Metric label={t("事件", "Events")} value={props.projectStats?.eventCount ?? props.events.length} />
              <Metric label={t("实体", "Entities")} value={props.projectStats?.entityCount ?? props.entities.length} />
            </div>

            {props.uploadJobs.length > 0 ? (
              <UploadJobsPanel
                jobs={props.uploadJobs}
                expanded={props.isUploadQueueExpanded}
                onToggle={props.onToggleUploadQueue}
              />
            ) : null}

            <PanelSection
              title={t("文档", "Documents")}
              action={(
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={props.showArchivedDocuments}
                    onChange={(event) => props.onToggleArchivedDocuments(event.target.checked)}
                  />
                  {t("归档", "Archived")}
                </label>
              )}
            >
              {props.documents.length === 0 ? (
                <EmptyLine text={t("当前项目还没有文档。", "The current project has no documents yet.")} />
              ) : props.documents.map((document) => (
                <div key={document.id} className={cn("rounded-md border border-border", document.id === props.selectedDocumentId && "bg-accent")}>
                  <button
                    className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm"
                    onClick={() => props.onSelectDocument(document.id)}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{document.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {document.sourceName ? `${document.sourceName} · ` : ""}{document.archivedAt ? t("已归档", "Archived") : `${document.parseStatus} · ${formatDate(document.createdAt)}`}
                      </span>
                    </span>
                  </button>
                  {document.id === props.selectedDocumentId ? (
                    <div className="flex flex-wrap gap-1 px-3 pb-2">
                      <MiniButton onClick={() => props.onRenameDocument(document)}>{t("重命名", "Rename")}</MiniButton>
                      <MiniButton onClick={() => props.onArchiveOrRestoreDocument(document)}>
                        {document.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
                      </MiniButton>
                      <MiniButton danger onClick={() => props.onDeleteDocument(document)}>{t("永久删除", "Delete forever")}</MiniButton>
                    </div>
                  ) : null}
                </div>
              ))}
            </PanelSection>
          </div>

          <div className="min-h-0 overflow-y-auto p-4 scrollbar-thin md:p-6">
            <div className="flex flex-wrap gap-2">
              {(["overview", "chunks", "events", "entities", "search"] as ResultView[]).map((view) => (
                <button
                  key={view}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                    props.resultView === view && "bg-accent text-foreground"
                  )}
                  onClick={() => props.onSetResultView(view)}
                >
                  {resultViewLabel(view, language)}
                </button>
              ))}
            </div>

            <div className="mt-4">
              {searchableResultView ? (
                <ResultTitleSearch
                  label={resultViewLabel(props.resultView, language)}
                  query={resultTitleQuery}
                  totalCount={activeTotalCount}
                  matchedCount={activeResultCount}
                  onQueryChange={setResultTitleQuery}
                  onClear={() => setResultTitleQuery("")}
                />
              ) : null}
              {props.resultView === "overview" ? (
                <OverviewPanel document={props.selectedDocument} chunks={props.chunks} events={props.events} entities={props.entities} />
              ) : null}
              {props.resultView === "chunks" ? <ChunksPanel chunks={paginatedChunks} hasFilter={Boolean(normalizedResultTitleQuery)} /> : null}
              {props.resultView === "events" ? (
                <EventsPanel events={paginatedEvents} hasFilter={Boolean(normalizedResultTitleQuery)} onOpenEvent={props.onOpenEvent} onOpenEntity={props.onOpenEntity} />
              ) : null}
              {props.resultView === "entities" ? (
                <EntitiesPanel entities={paginatedEntities} hasFilter={Boolean(normalizedResultTitleQuery)} onOpenEntity={props.onOpenEntity} />
              ) : null}
              {searchableResultView && activeResultCount > DOCUMENT_RESULT_PAGE_SIZE ? (
                <PaginationControls
                  className="mt-4"
                  page={currentResultPage}
                  pageSize={DOCUMENT_RESULT_PAGE_SIZE}
                  totalCount={activeResultCount}
                  onPageChange={setResultPage}
                />
              ) : null}
              {props.resultView === "search" ? (
                <SearchPanel
                  query={props.searchQuery}
                  searchMode={props.searchMode}
                  result={props.searchResult}
                  isSearching={props.isSearching}
                  onQueryChange={props.onSearchQueryChange}
                  onSearchModeChange={props.onSearchModeChange}
                  onSearch={props.onSearch}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectGraphWorkspace(props: {
  project: SourceRecord | null;
  graph: ProjectGraphRecord | null;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t, language } = useI18n();
  const graph = props.graph;

  if (!props.project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先创建项目", "Create a project first")} description={t("项目里有文档、事件和实体后，图谱会在这里显示。", "The graph appears after the project has documents, events, and entities.")} />
      </section>
    );
  }

  // Allow rendering standalone entity nodes when events are missing.
  // The Graph tab is most useful when *anything* is visible — isolated
  // entities still help users understand what was extracted.
  if (!graph || graph.entities.length === 0) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("暂无图谱数据", "No graph data yet")} description={t("上传并完成提取后，可以查看实体、事件和关系。", "Upload documents and finish extraction to view entities, events, and relations.")} />
      </section>
    );
  }
  if (graph.events.length === 0) {
    return (
      <section className="flex h-full min-h-0 flex-col px-6 py-6">
        <div className="mb-3 flex items-center gap-2 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>
            {t(
              "已提取实体，但事件提取暂未完成（数据修复进行中）。",
              "Entities extracted. Event extraction is still pending (data backfill in progress)."
            )}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <ProjectGraphFlow
            graph={graph}
            language={language}
            onOpenEvent={props.onOpenEvent}
            onOpenEntity={props.onOpenEntity}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 p-2 md:p-4">
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <ProjectGraphFlow
          graph={graph}
          language={language}
          onOpenEvent={props.onOpenEvent}
          onOpenEntity={props.onOpenEntity}
        />
      </div>
    </section>
  );
}

function ActivityPanel(props: {
  className?: string;
  mode: ContextPanelMode;
  processSteps: ProcessStep[];
  modelLogs: ModelCallLogRecord[];
  onSetMode: (mode: ContextPanelMode) => void;
  onRefreshModelLogs: () => void;
  onClearModelLogs: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className={cn("flex min-h-0 flex-col bg-card", props.className)}>
      <div className="border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{contextPanelModeLabel(props.mode, t)}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">{t("搜索链路与模型原始调用", "Search trace and raw model calls")}</p>
        </div>
        <div className="mt-3 grid grid-cols-2 rounded-md border border-border p-1">
          {(["process", "logs"] as ContextPanelMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={cn(
                "rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                props.mode === mode && "bg-accent text-foreground"
              )}
              onClick={() => props.onSetMode(mode)}
            >
              {contextPanelModeLabel(mode, t)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {props.mode === "logs" ? (
          <RawLogsPanel
            logs={props.modelLogs}
            onRefresh={props.onRefreshModelLogs}
            onClear={props.onClearModelLogs}
          />
        ) : (
          <ProcessPanel steps={props.processSteps} />
        )}
      </div>
    </aside>
  );
}

function ProcessPanel({ steps }: { steps: ProcessStep[] }) {
  const { t } = useI18n();
  if (steps.length === 0) {
    return <EmptyState title={t("还没有搜索过程", "No search trace yet")} description={t("每次对话或检索都会清空这里，并展示新的执行链路。", "Each chat or search clears this panel and shows the latest execution trace.")} />;
  }

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <Card key={step.id} className={cn(step.status === "failed" && "border-red-200 bg-red-50/60")}>
          <CardContent className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="truncate text-sm font-semibold">{step.title}</div>
                </div>
                {step.detail ? (
                  <div className="mt-1 pl-7 text-xs leading-5 text-muted-foreground">{step.detail}</div>
                ) : null}
              </div>
              <Badge className={processStatusClassName(step.status)}>
                {step.status === "running" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                {processStatusLabel(step.status, t)}
              </Badge>
            </div>
            {step.durationMs != null ? (
              <div className="pl-7 text-xs text-muted-foreground">{t(`耗时：${step.durationMs} 毫秒`, `Duration: ${step.durationMs} ms`)}</div>
            ) : null}
            {step.payload !== undefined ? (
              <div className="pl-7">
                <JsonBlock title={t("数据", "Data")} value={step.payload} compact />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RawLogsPanel(props: {
  logs: ModelCallLogRecord[];
  onRefresh: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const latestLogs = [...props.logs].sort((a, b) => b.sequence - a.sequence);
  const llmLogCount = props.logs.filter((log) => log.kind === "llm").length;
  const embeddingLogCount = props.logs.filter((log) => log.kind === "embedding").length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs text-muted-foreground">
          <div>{t(`浏览器缓存 ${props.logs.length} 条`, `Browser cache: ${props.logs.length} item(s)`)}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge className="border-border bg-muted text-muted-foreground">LLM {llmLogCount}</Badge>
            <Badge className="border-border bg-muted text-muted-foreground">Embedding {embeddingLogCount}</Badge>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={props.onRefresh}>
            {t("同步日志", "Sync logs")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onClear} disabled={props.logs.length === 0}>
            <Trash2 className="h-4 w-4" />
            {t("删除日志", "Delete logs")}
          </Button>
        </div>
      </div>
      {latestLogs.length === 0 ? (
        <EmptyState title={t("暂无原始日志", "No raw logs yet")} description={t("上传、检索或对话触发 LLM / Embedding 后会显示原始请求和返回。", "Raw requests and responses appear after upload, search, or chat triggers LLM / Embedding calls.")} />
      ) : latestLogs.map((log) => (
        <Card key={log.id} className={cn(log.status === "FAILED" && "border-red-200 bg-red-50/60")}>
          <CardContent className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge>{log.kind === "llm" ? "LLM" : "Embedding"}</Badge>
                  <div className="truncate text-sm font-semibold">{log.operation}</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  #{log.sequence} · {formatDate(log.createdAt)} · {log.durationMs} {t("毫秒", "ms")}
                </div>
              </div>
              <Badge className={log.status === "FAILED" ? "border-red-200 bg-red-50 text-red-700" : ""}>
                {log.status === "FAILED" ? t("失败", "Failed") : t("成功", "Succeeded")}
              </Badge>
            </div>
            <JsonBlock title={t("请求", "Request")} value={log.request} compact preserveRaw />
            {log.response !== undefined ? <JsonBlock title={t("返回", "Response")} value={log.response} compact preserveRaw /> : null}
            {log.error ? (
              <div className="rounded-md bg-red-50 p-2 text-xs leading-5 text-red-700">{log.error}</div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function UploadJobsPanel({ jobs, expanded, onToggle }: {
  jobs: UploadJobRecord[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const activeCount = jobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING").length;
  const completedCount = jobs.filter((job) => job.status === "COMPLETED").length;
  const failedCount = jobs.filter((job) => job.status === "FAILED").length;
  const latestJob = jobs[0];
  return (
    <section className="mb-4">
      <button
        type="button"
        className="mb-2 flex w-full items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-accent"
        onClick={onToggle}
      >
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{t("处理队列", "Processing queue")}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {activeCount > 0
              ? t(`${activeCount} 个任务处理中`, `${activeCount} job(s) processing`)
              : t(`已收起：完成 ${completedCount}，失败 ${failedCount}`, `Collapsed: ${completedCount} completed, ${failedCount} failed`)}
            {latestJob ? t(` · 最近：${latestJob.title || latestJob.fileName}`, ` · Latest: ${latestJob.title || latestJob.fileName}`) : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          <Badge>{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</Badge>
        </div>
      </button>
      {expanded ? (
        <div className="space-y-2">
          {jobs.map((job) => (
            <Card key={job.id} className={cn(job.status === "FAILED" && "border-red-200 bg-red-50/60")}>
              <CardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{job.title || job.fileName}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">{job.fileName}</div>
                  </div>
                  <Badge className={job.status === "FAILED" ? "border-red-200 bg-red-50 text-red-700" : ""}>
                    {uploadStatusLabel(job.status, t)}
                  </Badge>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-all",
                      job.status === "FAILED" && "bg-red-500"
                    )}
                    style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }}
                  />
                </div>
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="min-w-0 truncate">{uploadStageLabel(job.stage, t)} · {job.message}</span>
                  <span className="shrink-0">{Math.round(job.progress)}%</span>
                </div>
                {job.totalChunks ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`切片进度：${job.currentChunk ?? 0}/${job.totalChunks}`, `Chunk progress: ${job.currentChunk ?? 0}/${job.totalChunks}`)}
                  </div>
                ) : null}
                {job.status === "COMPLETED" ? (
                  <div className="text-xs text-muted-foreground">
                    {t(`已生成 ${job.chunkCount ?? 0} 个切片，${job.eventCount ?? 0} 个事件`, `Generated ${job.chunkCount ?? 0} chunk(s), ${job.eventCount ?? 0} event(s)`)}
                  </div>
                ) : null}
                {job.error ? (
                  <div className="text-xs text-red-700">{job.error}</div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function OverviewPanel(props: {
  document: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
}) {
  const { t } = useI18n();
  if (!props.document) {
    return <EmptyState title={t("未选择文档", "No document selected")} description={t("选择文档后可查看处理结果。", "Select a document to view processing results.")} />;
  }
  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{props.document.title}</div>
          <div className="text-xs text-muted-foreground">{t("处理状态", "Processing status")}：{props.document.parseStatus}</div>
          <div className="text-xs text-muted-foreground">{t("创建时间", "Created at")}：{formatDate(props.document.createdAt)}</div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-3 gap-2">
        <Metric label={t("切片", "Chunks")} value={props.chunks.length} />
        <Metric label={t("事件", "Events")} value={props.events.length} />
        <Metric label={t("实体", "Entities")} value={props.entities.length} />
      </div>
      <Card>
        <CardContent className="space-y-2">
          <div className="text-sm font-semibold">{t("Embedding 状态", "Embedding status")}</div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label={t("切片向量", "Chunk vectors")} value={props.chunks.filter((chunk) => Boolean(chunk.embedding)).length} />
            <Metric label={t("事件向量", "Event vectors")} value={props.events.filter((event) => Boolean(event.titleEmbedding || event.contentEmbedding)).length} />
            <Metric label={t("实体向量", "Entity vectors")} value={props.entities.filter((entity) => Boolean(entity.embedding)).length} />
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("列表卡片会显示维度和前 8 位样本，用来确认向量已经真实写入数据库。", "List cards show dimensions and the first 8 sample values to confirm vectors were written to the database.")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function ResultTitleSearch(props: {
  label: string;
  query: string;
  totalCount: number;
  matchedCount: number;
  onQueryChange: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="mb-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t(`按${props.label}标题搜索`, `Search ${props.label} titles`)}
          />
        </div>
        {props.query.trim() ? (
          <Button variant="ghost" size="sm" onClick={props.onClear}>{t("清空", "Clear")}</Button>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {props.query.trim()
          ? t(`匹配 ${props.matchedCount}/${props.totalCount}`, `Matched ${props.matchedCount}/${props.totalCount}`)
          : t(`共 ${props.totalCount} 条`, `${props.totalCount} total`)}
      </div>
    </div>
  );
}

function PaginationControls(props: {
  page: number;
  pageSize: number;
  totalCount: number;
  className?: string;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(props.totalCount / props.pageSize));
  const from = props.totalCount === 0 ? 0 : (props.page - 1) * props.pageSize + 1;
  const to = Math.min(props.page * props.pageSize, props.totalCount);
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3", props.className)}>
      <div className="text-xs text-muted-foreground">
        {t(`第 ${props.page}/${pageCount} 页 · ${from}-${to} / ${props.totalCount} 条`, `Page ${props.page}/${pageCount} · ${from}-${to} / ${props.totalCount}`)}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={props.page <= 1}
          onClick={() => props.onPageChange(Math.max(1, props.page - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
          {t("上一页", "Previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={props.page >= pageCount}
          onClick={() => props.onPageChange(Math.min(pageCount, props.page + 1))}
        >
          {t("下一页", "Next")}
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ChunksPanel({ chunks, hasFilter }: { chunks: ChunkRecord[]; hasFilter?: boolean }) {
  const { t } = useI18n();
  if (chunks.length === 0) {
    return hasFilter
      ? <EmptyState title={t("没有匹配的切片", "No matching chunks")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无切片", "No chunks yet")} description={t("文档处理后会在这里展示切片。", "Chunks appear here after document processing.")} />;
  }
  return (
    <div className="space-y-2">
      {chunks.map((chunk) => (
        <Card key={chunk.id}>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-sm font-medium">{chunk.heading || t("未命名切片", "Untitled chunk")}</div>
              <Badge>{t(`排序 ${chunk.rank}`, `Rank ${chunk.rank}`)}</Badge>
            </div>
            <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{chunk.content}</p>
            <EmbeddingPreviewBlock title={t("切片 Embedding", "Chunk Embedding")} preview={chunk.embedding} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EventsPanel(props: {
  events: EventRecord[];
  hasFilter?: boolean;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  if (props.events.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的事件", "No matching events")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无事件", "No events yet")} description={t("开启抽取后，事件会显示关联实体。", "Events and related entities appear after extraction is enabled.")} />;
  }
  return (
    <div className="space-y-2">
      {props.events.map((event) => (
        <Card key={event.id}>
          <CardContent className="space-y-2">
            <button className="w-full text-left text-sm font-semibold hover:underline" onClick={() => props.onOpenEvent(event.id)}>
              {event.title}
            </button>
            <p className="line-clamp-3 text-sm text-muted-foreground">{event.summary || event.content}</p>
            <div className="flex flex-wrap gap-1">
              {(event.entities ?? []).length === 0 ? (
                <Badge>{t(`${event.entityCount ?? 0} 个实体`, `${event.entityCount ?? 0} entities`)}</Badge>
              ) : (event.entities ?? []).map((entity) => (
                <button key={entity.id} onClick={() => props.onOpenEntity(entity.id)}>
                  <Badge>{entity.name}</Badge>
                </button>
              ))}
            </div>
            <div className="grid min-w-0 gap-2">
              <EmbeddingPreviewBlock title={t("标题 Embedding", "Title Embedding")} preview={event.titleEmbedding} />
              <EmbeddingPreviewBlock title={t("内容 Embedding", "Content Embedding")} preview={event.contentEmbedding} />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function EntitiesPanel(props: {
  entities: EntityRecord[];
  hasFilter?: boolean;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  if (props.entities.length === 0) {
    return props.hasFilter
      ? <EmptyState title={t("没有匹配的实体", "No matching entities")} description={t("换一个标题关键字再试。", "Try another title keyword.")} />
      : <EmptyState title={t("暂无实体", "No entities yet")} description={t("事件抽取后会在这里聚合实体。", "Entities are aggregated here after event extraction.")} />;
  }
  return (
    <div className="space-y-2">
      {props.entities.map((entity) => (
        <button key={entity.id} className="w-full min-w-0 max-w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={() => props.onOpenEntity(entity.id)}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{entity.name}</div>
              <div className="text-xs text-muted-foreground">{entity.type}</div>
            </div>
            <Badge>{t(`${entity.eventCount ?? 0} 事件`, `${entity.eventCount ?? 0} events`)}</Badge>
          </div>
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{entity.description || entity.normalizedName}</p>
          <div className="mt-2 min-w-0">
            <EmbeddingPreviewBlock title={t("实体 Embedding", "Entity Embedding")} preview={entity.embedding} />
          </div>
        </button>
      ))}
    </div>
  );
}

function SearchPanel(props: {
  query: string;
  searchMode: SearchMode;
  result: SearchResult | null;
  isSearching: boolean;
  onQueryChange: (value: string) => void;
  onSearchModeChange: (value: SearchMode) => void;
  onSearch: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/25 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Zap className="h-4 w-4" />
          {t("检索模式", "Search mode")}
        </div>
        <div className="flex rounded-md border border-border bg-card p-0.5">
          {([
            { value: "fast" as const, label: t("极速", "Fast") },
            { value: "standard" as const, label: t("标准", "Standard") }
          ]).map((mode) => (
            <button
              key={mode.value}
              className={cn(
                "rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground",
                props.searchMode === mode.value && "bg-foreground text-background hover:text-background"
              )}
              onClick={() => props.onSearchModeChange(mode.value)}
              type="button"
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="basis-full text-xs text-muted-foreground">
          {props.searchMode === "fast"
            ? t("实体全文匹配 + qwen3-rerank，不走 LLM 过滤。", "Entity full-text matching + qwen3-rerank, without LLM filtering.")
            : t("LLM 抽取查询实体 + LLM 重排，适合对比质量。", "LLM extracts query entities + LLM reranking, useful for quality comparison.")}
        </div>
      </div>
      <div className="flex gap-2">
        <Input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder={t("输入检索问题", "Enter a search question")} />
        <Button size="sm" onClick={props.onSearch} disabled={props.isSearching}>
          {props.isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        </Button>
      </div>
      {props.result ? (
        <div className="space-y-2">
          {props.result.sections.map((section) => (
            <Card key={section.chunkId}>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-sm font-medium">{section.heading || t("结果切片", "Result chunk")}</div>
                  <div className="flex items-center gap-1">
                    {section.matchType ? (
                      <Badge
                        className={matchTypeBadgeClass(section.matchType)}
                        title={matchTypeTooltip(section.matchType)}
                      >
                        {matchTypeLabel(section.matchType)}
                      </Badge>
                    ) : null}
                    <Badge>{section.score.toFixed(3)}</Badge>
                  </div>
                </div>
                <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{section.content}</p>
              </CardContent>
            </Card>
          ))}
          <JsonBlock title={t("检索链路", "Search trace")} value={props.result.trace ?? { traceId: props.result.traceId }} compact />
        </div>
      ) : (
        <EmptyState title={t("还没有检索结果", "No search results yet")} description={t("检索范围固定为当前项目。", "The search scope is fixed to the current project.")} />
      )}
    </div>
  );
}

type SettingsInput = {
  embeddingProvider: "api" | "local" | "local-bge";
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
};

const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_CHUNKING_MODE: ChunkingMode = "heading_strict";
const DEFAULT_CHUNK_TOKEN_LIMIT = 1024;
const DEFAULT_CHUNK_OVERLAP_TOKENS = 100;
// Defaults for the LLM panel. The user has standardised on the
// Sunwoda internal LLM gateway; we mirror that here so an empty
// settings row (e.g. after a fresh install) still shows a usable
// Base URL/Model rather than two empty inputs. The server-side
// config falls back to env values, but the form should show what
// the user can expect to hit on first open.
const DEFAULT_LLM_BASE_URL = "https://llm-api.sunwoda.com/v1";
const DEFAULT_LLM_MODEL = "hy-mt2-7b";
const DEFAULT_EMBEDDING_BASE_URL = "https://llm-api.sunwoda.com/v1";
const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding-8b";

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function normalizeChunkingMode(value: unknown): ChunkingMode {
  return value === "token" ? "token" : DEFAULT_CHUNKING_MODE;
}

function SettingsPanel(props: {
  settings: PublicAiProviderSettings | null;
  isSaving: boolean;
  saveStatus: { kind: "success" | "error"; message: string } | null;
  language: SupportedLanguage;
  languagePreference: LanguagePreference;
  onLanguagePreferenceChange: (preference: LanguagePreference) => void;
  onSave: (input: SettingsInput) => void;
}) {
  const { t } = useI18n();
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDimensions, setEmbeddingDimensions] = useState(1024);
  const [embeddingApiKey, setEmbeddingApiKey] = useState("");
  const [embeddingProvider, setEmbeddingProvider] = useState<"api" | "local" | "local-bge">("api");
  const [embeddingLocalModelPath, setEmbeddingLocalModelPath] = useState("");
  const [clearEmbeddingLocalModelPath, setClearEmbeddingLocalModelPath] = useState(false);
  // Single "clear all keys" toggle replaces the old per-key clear
  // checkboxes. When checked, the save handler clears both embedding
  // and LLM keys.
  const [clearAllKeys, setClearAllKeys] = useState(false);
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [defaultSearchMode, setDefaultSearchMode] = useState<SearchMode>("fast");
  const [defaultSearchTopK, setDefaultSearchTopK] = useState(10);
  const [defaultChunkingMode, setDefaultChunkingMode] = useState<ChunkingMode>("heading_strict");
  const [chunkTokenLimit, setChunkTokenLimit] = useState(1024);
  const [chunkOverlapTokens, setChunkOverlapTokens] = useState(100);
  // Server bind info (host/port for HTTP web UI + MCP HTTP transport).
  // Fetched on mount so the "Server" card renders immediately when the
  // user opens Settings. Failures are swallowed — the card just shows
  // "—" placeholders so a single network blip doesn't break Settings.
  const [serverInfo, setServerInfo] = useState<{ httpHost: string; httpPort: number; mcpHttpPort: number } | null>(null);
  // Test connection probe state
  const [connectionProbe, setConnectionProbe] = useState<{ state: "idle" | "running" | "done"; result?: ConnectionProbe }>({ state: "idle" });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.getServerInfo();
        if (!cancelled) setServerInfo(info);
      } catch {
        if (!cancelled) setServerInfo(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!props.settings) return;
    setEmbeddingProvider(props.settings.embeddingProvider ?? "api");
    setEmbeddingBaseUrl(props.settings.embeddingBaseUrl);
    setEmbeddingModel(props.settings.embeddingModel || DEFAULT_EMBEDDING_MODEL);
    setEmbeddingDimensions(props.settings.embeddingDimensions);
    setEmbeddingApiKey("");
    setClearAllKeys(false);
    setEmbeddingLocalModelPath(props.settings.embeddingLocalModelPath ?? "");
    setClearEmbeddingLocalModelPath(false);
    setLlmBaseUrl(props.settings.llmBaseUrl || DEFAULT_LLM_BASE_URL);
    setLlmModel(props.settings.llmModel || DEFAULT_LLM_MODEL);
    setLlmApiKey("");
    setDefaultSearchMode(props.settings.defaultSearchMode);
    setDefaultSearchTopK(boundedInteger(props.settings.defaultSearchTopK, DEFAULT_SEARCH_TOP_K, 1, 50));
    setDefaultChunkingMode(normalizeChunkingMode(props.settings.defaultChunkingMode));
    const normalizedTokenLimit = boundedInteger(props.settings.chunkTokenLimit, DEFAULT_CHUNK_TOKEN_LIMIT, 64, 8192);
    setChunkTokenLimit(normalizedTokenLimit);
    setChunkOverlapTokens(
      boundedInteger(props.settings.chunkOverlapTokens, DEFAULT_CHUNK_OVERLAP_TOKENS, 0, normalizedTokenLimit - 1)
    );
  }, [props.settings]);

  useEffect(() => {
    setChunkOverlapTokens((current) => Math.min(current, Math.max(0, chunkTokenLimit - 1)));
  }, [chunkTokenLimit]);

  if (!props.settings) return <EmptyState title={t("正在加载设置", "Loading settings")} description={t("请稍候。", "Please wait.")} />;

  return (
    <form
      className="mx-auto grid max-w-4xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave({
          embeddingProvider,
          embeddingBaseUrl,
          embeddingModel,
          embeddingDimensions,
          embeddingApiKey,
          clearEmbeddingApiKey: clearAllKeys,
          embeddingLocalModelPath,
          clearEmbeddingLocalModelPath,
          llmBaseUrl,
          llmModel,
          llmApiKey,
          clearLlmApiKey: clearAllKeys,
          defaultSearchMode,
          defaultSearchTopK,
          defaultChunkingMode,
          chunkTokenLimit,
          chunkOverlapTokens
        });
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("全局设置", "Global settings")}</h2>
          <p className="text-xs text-muted-foreground">{t("密钥只显示配置状态，不回显明文。", "Keys only show configuration status and are never echoed in plaintext.")}</p>
        </div>
        <div className="text-xs text-muted-foreground">{t("更新于", "Updated")} {formatDate(props.settings.updatedAt)}</div>
      </div>

      <SettingsCard title={t("界面", "Interface")} badge={props.language === "zh" ? "中文" : "English"}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("界面语言", "Interface language")}</div>
          <div className="flex w-fit rounded-md border border-border bg-card p-0.5">
            {([
              { value: "auto" as const, label: t("自动", "Auto") },
              { value: "zh" as const, label: "中文" },
              { value: "en" as const, label: "English" }
            ]).map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  props.languagePreference === option.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => props.onLanguagePreferenceChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {t(
              `当前显示语言：${props.language === "zh" ? "中文" : "英文"}。自动模式会根据浏览器语言选择。`,
              `Current display language: ${props.language === "zh" ? "Chinese" : "English"}. Auto mode follows the browser language.`
            )}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="AI Provider" badge={props.settings.embeddingProvider === "api" ? "Sunwoda" : props.settings.embeddingProvider === "local-bge" ? "本地 BGE" : "本地"}>
        {/* Embedding section: provider, base URL, model, dimensions */}
        <Field label={t("Embedding 提供方", "Embedding provider")}>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm"
            value={embeddingProvider}
            onChange={(event) => {
              const next = event.target.value as "api" | "local" | "local-bge";
              setEmbeddingProvider(next);
              if (next === "api") {
                setEmbeddingModel(DEFAULT_EMBEDDING_MODEL);
                setEmbeddingBaseUrl(DEFAULT_EMBEDDING_BASE_URL);
              }
            }}
          >
            <option value="api">{t("远程 API", "Remote API")}</option>
            <option value="local">{t("本地 (内置)", "Local (built-in)")}</option>
            <option value="local-bge">{t("本地 BGE", "Local BGE")}</option>
          </select>
        </Field>
        <Field label="Embedding Base URL">
          <Input
            type="url"
            value={embeddingBaseUrl}
            onChange={(event) => setEmbeddingBaseUrl(event.target.value)}
            placeholder="https://llm-api.sunwoda.com/v1"
          />
        </Field>
        <Field label="Embedding 模型">
          <Input
            value={embeddingModel}
            onChange={(event) => setEmbeddingModel(event.target.value)}
            placeholder="qwen3-embedding-8b"
          />
        </Field>
        <Field label={t("Embedding 维度", "Embedding dimensions")}>
          <Input
            type="number"
            min={64}
            max={4096}
            value={embeddingDimensions}
            onChange={(event) => setEmbeddingDimensions(boundedInteger(event.target.value, 1024, 64, 4096))}
          />
        </Field>
        <Field label={t(`Embedding 密钥：${props.settings.hasEmbeddingApiKey ? "已配置" : "未配置"}`, `Embedding key: ${props.settings.hasEmbeddingApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={embeddingApiKey}
            onChange={(event) => {
              setEmbeddingApiKey(event.target.value);
              if (event.target.value.trim()) setClearAllKeys(false);
            }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>
        {embeddingProvider === "local-bge" && (
          <Field label={t("本地模型路径", "Local model path")}>
            <Input
              value={embeddingLocalModelPath}
              onChange={(event) => setEmbeddingLocalModelPath(event.target.value)}
              placeholder="C:\\models\\bge-base-zh-v1.5"
            />
          </Field>
        )}

        {/* LLM section: separate fields for chat / event-extraction. */}
        <div className="md:col-span-2 mt-4 border-t border-border pt-4">
          <div className="text-sm font-medium">{t("LLM（事件抽取 / 问答）", "LLM (event extraction / Q&A)")}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {t(
              "若所有字段留空，服务器将使用环境变量默认值。",
              "If left blank, the server falls back to environment defaults."
            )}
          </p>
        </div>
        <Field label="LLM Base URL">
          <Input
            type="url"
            value={llmBaseUrl}
            onChange={(event) => setLlmBaseUrl(event.target.value)}
            placeholder={DEFAULT_LLM_BASE_URL}
          />
        </Field>
        <Field label="LLM 模型">
          <Input
            value={llmModel}
            onChange={(event) => setLlmModel(event.target.value)}
            placeholder={DEFAULT_LLM_MODEL}
          />
        </Field>
        <Field label={t(`LLM 密钥：${props.settings.hasLlmApiKey ? "已配置" : "未配置"}`, `LLM key: ${props.settings.hasLlmApiKey ? "configured" : "not configured"}`)}>
          <Input
            type="password"
            value={llmApiKey}
            onChange={(event) => {
                setLlmApiKey(event.target.value);
                if (event.target.value.trim()) setClearAllKeys(false);
              }}
            placeholder={t("留空不修改", "Leave blank to keep unchanged")}
          />
        </Field>

        <div className="md:col-span-2 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={connectionProbe.state === "running"}
            onClick={async () => {
              setConnectionProbe({ state: "running" });
              try {
                const result = await api.testConnection();
                setConnectionProbe({ state: "done", result });
              } catch {
                setConnectionProbe({ state: "done", result: { ok: false, provider: "?", baseUrl: "?", model: "?", dimensions: 0, latencyMs: 0, error: "网络请求失败" } });
              }
            }}
          >
            {connectionProbe.state === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {t("测试连接", "Test connection")}
          </Button>
          {connectionProbe.state === "done" && connectionProbe.result && (
            <span className={cn("text-xs", connectionProbe.result.ok ? "text-green-600" : "text-red-600")}>
              {connectionProbe.result.ok
                ? t(`连接成功 — ${connectionProbe.result.latencyMs}ms`, `Connected — ${connectionProbe.result.latencyMs}ms`)
                : t(`连接失败：${connectionProbe.result.error || "未知错误"}`, `Failed: ${connectionProbe.result.error || "unknown error"}`)}
            </span>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title={t("检索", "Search")} badge={defaultSearchMode === "fast" ? t("极速", "Fast") : t("标准", "Standard")}>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认检索模式", "Default search mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-card p-0.5">
            {([
              { value: "fast" as const, label: t("极速模式", "Fast mode"), description: t("实体全文匹配 + qwen3-rerank，不调用 LLM 抽 key 和过滤。", "Entity full-text matching + qwen3-rerank, without LLM key extraction or filtering.") },
              { value: "standard" as const, label: t("标准模式", "Standard mode"), description: t("LLM 抽取查询实体 + LLM 重排，适合质量对比。", "LLM extracts query entities + LLM reranking, useful for quality comparison.") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultSearchMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultSearchMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultSearchMode === "fast"
              ? t("默认使用极速链路：问题直接匹配实体库，最后用 qwen3-rerank 选 top-k。", "Default fast path: match the question directly against the entity store, then use qwen3-rerank to select top-k.")
              : t("默认使用标准链路：先由 LLM 识别查询实体，最后由 LLM 选择候选事件。", "Default standard path: first let the LLM identify query entities, then let the LLM choose candidate events.")}
          </div>
        </div>
        <Field label={t("默认 Top-K", "Default top-k")}>
          <Input
            type="number"
            min={1}
            max={50}
            value={defaultSearchTopK}
            onChange={(event) => setDefaultSearchTopK(Number(event.target.value))}
          />
        </Field>
        <div className="space-y-3 md:col-span-2">
          <div className="text-sm font-medium">{t("默认切片模式", "Default chunking mode")}</div>
          <div className="flex w-fit rounded-md border border-border bg-card p-0.5">
            {([
              { value: "heading_strict" as const, label: t("标题严格", "Heading strict") },
              { value: "token" as const, label: t("Token 强制", "Token window") }
            ]).map((mode) => (
              <button
                key={mode.value}
                type="button"
                className={cn(
                  "rounded px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                  defaultChunkingMode === mode.value && "bg-foreground text-background hover:text-background"
                )}
                onClick={() => setDefaultChunkingMode(mode.value)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            {defaultChunkingMode === "heading_strict"
              ? t("默认与 benchmark 一致：遇到新标题就形成独立切片，不按 token 合并短片段。", "Matches the benchmark default: each heading section becomes an independent chunk without token-based merging.")
              : t("强制按 token 窗口切片，并按 overlap 保留上下文。", "Force token-window chunking and keep context with overlap.")}
          </div>
        </div>
        <Field label={t("Token 数", "Token limit")}>
          <Input
            type="number"
            min={64}
            max={8192}
            value={chunkTokenLimit}
            onChange={(event) => setChunkTokenLimit(Number(event.target.value))}
          />
        </Field>
        <Field label={t("Overlap tokens", "Overlap tokens")}>
          <Input
            type="number"
            min={0}
            max={Math.max(0, chunkTokenLimit - 1)}
            value={chunkOverlapTokens}
            onChange={(event) => setChunkOverlapTokens(Number(event.target.value))}
          />
        </Field>
      </SettingsCard>

      <SettingsCard title={t("服务", "Server")} badge={t("本地优先", "Local-first")}>
        <PanelInfo
          label={t("Web 界面地址", "Web UI URL")}
          value={serverInfo
            ? `${serverInfo.httpHost}:${serverInfo.httpPort}`
            : t("加载中…", "Loading…")}
          multiline
        />
        <PanelInfo
          label={t("MCP HTTP 端口（transport）", "MCP HTTP port (transport)")}
          value={serverInfo ? String(serverInfo.mcpHttpPort) : t("加载中…", "Loading…")}
        />
        <div className="md:col-span-2 text-xs text-muted-foreground">
          {t(
            "把 Web 界面地址发给其他设备的浏览器即可远程访问 SAG；MCP HTTP 端口给 Agent 用 streamable HTTP 协议接入。",
            "Share the Web UI URL with another device's browser for remote SAG access. The MCP HTTP port is for Agents connecting via the streamable HTTP transport."
          )}
        </div>
      </SettingsCard>

      <SettingsCard title={t("危险操作", "Danger zone")} badge={t("谨慎", "Careful")}>
        {(props.settings.hasEmbeddingApiKey || props.settings.hasLlmApiKey) && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={clearAllKeys}
              onChange={(event) => {
                setClearAllKeys(event.target.checked);
                if (event.target.checked) {
                  setEmbeddingApiKey("");
                  setLlmApiKey("");
                }
              }}
            />
            {t("清除所有已保存的密钥", "Clear all saved API keys")}
          </label>
        )}
        {!props.settings.hasEmbeddingApiKey && !props.settings.hasLlmApiKey && (
          <p className="text-xs text-muted-foreground">{t("没有已保存的密钥。", "No saved API keys.")}</p>
        )}
      </SettingsCard>

      <div className="flex justify-between items-center gap-3">
        {props.saveStatus && (
          <span className={cn("text-xs", props.saveStatus.kind === "success" ? "text-green-600" : "text-red-600")}>
            {props.saveStatus.message}
          </span>
        )}
        <Button type="submit" disabled={props.isSaving}>
          {props.isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("保存设置", "Save settings")}
        </Button>
      </div>
    </form>
  );
}

function ProjectMcpWorkspace({ project, settings }: { project: SourceRecord | null; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  if (!project) {
    return (
      <section className="flex min-h-0 flex-1 items-center justify-center px-6">
        <EmptyState title={t("先选择项目", "Select a project first")} description={t("MCP server 会绑定到当前项目，选择项目后可查看对应的接入配置和工具说明。", "The MCP server binds to the current project. Select a project to view integration config and tool details.")} />
      </section>
    );
  }
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="mx-auto grid max-w-4xl gap-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t("项目 MCP", "Project MCP")}</h2>
            <p className="text-xs text-muted-foreground">{t("当前项目 ID 会写入 MCP server 启动配置，工具调用时不再传项目参数。", "The current project ID is written into the MCP server config, so tool calls do not pass project parameters.")}</p>
          </div>
          <Badge>{project.name}</Badge>
        </div>
        <McpSettingsCard project={project} settings={settings} />
      </div>
    </section>
  );
}

function McpSettingsCard({ project, settings }: { project: SourceRecord; settings: PublicMcpSettings | null }) {
  const { t } = useI18n();
  const [expandedToolName, setExpandedToolName] = useState<string | null>(null);

  if (!settings) {
    return (
      <SettingsCard title="MCP" badge={t("加载中", "Loading")}>
        <div className="text-sm text-muted-foreground">{t("正在加载 MCP 信息。", "Loading MCP information.")}</div>
      </SettingsCard>
    );
  }
  const externalClientConfig = settings.clientConfigs.find((clientConfig) => clientConfig.id === "stdio-npm")
    ?? settings.clientConfigs[0]
    ?? null;
  const externalClientConfigValue = externalClientConfig
    ? replaceMcpProjectPlaceholder(externalClientConfig.config, project.id)
    : null;
  return (
    <SettingsCard title="MCP" badge={t("自动可用", "Auto available")}>
      <PanelInfo
        label={t("当前项目", "Current project")}
        value={`${project.name} / ${project.id}`}
        multiline
      />
      <PanelInfo
        label={t("项目绑定", "Project binding")}
        value={t("MCP server 启动时读取 SAG_MCP_SOURCE_ID，所有工具默认只访问这个项目。", "The MCP server reads SAG_MCP_SOURCE_ID at startup, and all tools access only this project by default.")}
        multiline
      />
      <PanelInfo label={t("工具超时", "Tool timeout")} value={t(`${settings.toolTimeoutMs} 毫秒`, `${settings.toolTimeoutMs} ms`)} />
      {externalClientConfig && externalClientConfigValue ? (
        <div className="space-y-3 md:col-span-2">
          <div>
            <div className="text-xs font-medium text-muted-foreground">mcpServers JSON</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("复制给其他 Agent 后会直接绑定当前项目；切换项目后这里会自动换成对应项目 ID。", "Copy this to another agent to bind directly to the current project. Switching projects updates the project ID automatically.")}
            </div>
          </div>
          <CopyableCodeBlock
            label={t("JSON 配置", "JSON config")}
            value={JSON.stringify(externalClientConfigValue, null, 2) ?? ""}
          />
        </div>
      ) : null}
      <div className="md:col-span-2">
        <div className="mb-2 text-xs font-medium text-muted-foreground">{t("可用工具", "Available tools")}</div>
        <div className="grid gap-2">
          {settings.tools.map((tool) => (
            <McpToolCard
              key={tool.name}
              tool={tool}
              expanded={expandedToolName === tool.name}
              onToggle={() => setExpandedToolName((current) => current === tool.name ? null : tool.name)}
            />
          ))}
        </div>
      </div>
    </SettingsCard>
  );
}

function replaceMcpProjectPlaceholder(value: unknown, projectId: string): unknown {
  if (typeof value === "string") {
    return value === "__SAG_LITE_PROJECT_ID__" ? projectId : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceMcpProjectPlaceholder(item, projectId));
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceMcpProjectPlaceholder(item, projectId)])
    );
  }
  return value;
}

function McpToolCard({
  tool,
  expanded,
  onToggle
}: {
  tool: PublicMcpSettings["tools"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("rounded-md border border-border", expanded && "border-foreground/30 bg-muted/20")}>
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <ChevronRight className={cn("mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{tool.name}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">{tool.description}</div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{expanded ? t("收起", "Collapse") : t("展开", "Expand")}</span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border p-3 pt-3">
          <JsonBlock title={t("输入参数 Schema", "Input schema")} value={tool.inputSchema} compact preserveRaw />
          <JsonBlock title={t("调用示例", "Call example")} value={tool.example} compact preserveRaw />
        </div>
      ) : null}
    </div>
  );
}

function CopyableCodeBlock({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          {copied ? t("已复制", "Copied") : t("复制", "Copy")}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5">
        {value}
      </pre>
    </div>
  );
}

function DetailDrawer(props: {
  drawer: Exclude<DetailDrawer, null>;
  onClose: () => void;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const { t } = useI18n();
  const drawer = props.drawer;
  return (
    <div className="fixed inset-0 z-20 bg-black/20" role="presentation" onClick={props.onClose}>
      <aside
        className="absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col border-l border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {drawer.type === "event"
                ? drawer.detail.event.title
                : drawer.type === "entity"
                  ? drawer.detail.entity.name
                  : t(`引用 ${drawer.citation.index}`, `Citation ${drawer.citation.index}`)}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {drawer.type === "event"
                ? t("事件详情", "Event details")
                : drawer.type === "entity"
                  ? t("实体详情", "Entity details")
                  : t("引用原文", "Source citation")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={props.onClose}>{t("关闭", "Close")}</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
          {drawer.type === "event" ? (
            <EventDetailPanel detail={drawer.detail} onOpenEntity={props.onOpenEntity} />
          ) : drawer.type === "entity" ? (
            <EntityDetailPanel detail={drawer.detail} onOpenEvent={props.onOpenEvent} />
          ) : (
            <CitationDetailPanel citation={drawer.citation} />
          )}
        </div>
      </aside>
    </div>
  );
}

function EventDetailPanel({ detail, onOpenEntity }: { detail: EventDetailRecord; onOpenEntity: (entityId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("所属文档", "Source document")} value={detail.document?.title ?? t("未知文档", "Unknown document")} />
      <PanelInfo label={t("事件内容", "Event content")} value={detail.event.content || detail.event.summary} multiline />
      <PanelSection title={t("关联实体", "Related entities")}>
        <div className="flex flex-wrap gap-2">
          {detail.entities.length === 0 ? <EmptyLine text={t("暂无关联实体。", "No related entities.")} /> : detail.entities.map((entity) => (
            <button key={entity.id} onClick={() => onOpenEntity(entity.id)}>
              <Badge>{entity.name}</Badge>
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("关联切片", "Related chunk")}>
        {detail.chunk ? (
          <Card>
            <CardContent>
              <div className="mb-2 text-xs text-muted-foreground">{detail.chunk.heading || t(`排序 ${detail.chunk.rank ?? 0}`, `Rank ${detail.chunk.rank ?? 0}`)}</div>
              <p className="whitespace-pre-wrap text-sm leading-6">{detail.chunk.content}</p>
            </CardContent>
          </Card>
        ) : <EmptyLine text={t("没有关联切片。", "No related chunk.")} />}
      </PanelSection>
    </div>
  );
}

function EntityDetailPanel({ detail, onOpenEvent }: { detail: EntityDetailRecord; onOpenEvent: (eventId: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("类型", "Type")} value={detail.entity.type} />
      <PanelInfo label={t("描述", "Description")} value={detail.entity.description || detail.entity.normalizedName} multiline />
      <PanelSection title={t(`关联事件（${detail.events.length}）`, `Related events (${detail.events.length})`)}>
        <div className="space-y-2">
          {detail.events.length === 0 ? <EmptyLine text={t("暂无关联事件。", "No related events.")} /> : detail.events.map((event) => (
            <button key={event.id} className="w-full rounded-md border border-border p-3 text-left hover:bg-accent" onClick={() => onOpenEvent(event.id)}>
              <div className="text-sm font-medium">{event.title}</div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{event.summary || event.content}</p>
            </button>
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

function CitationDetailPanel({ citation }: { citation: AnswerCitation }) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <PanelInfo label={t("切片标题", "Chunk title")} value={citation.heading || t(`引用 ${citation.index}`, `Citation ${citation.index}`)} />
      <div className="grid grid-cols-2 gap-3">
        <PanelInfo label={t("排序", "Rank")} value={citation.rank == null ? "-" : String(citation.rank)} />
        <PanelInfo label={t("得分", "Score")} value={citation.score == null ? "-" : citation.score.toFixed(4)} />
      </div>
      {citation.query ? <PanelInfo label={t("搜索语句", "Search query")} value={citation.query} multiline /> : null}
      <PanelInfo label={t("切片 ID", "Chunk ID")} value={citation.chunkId} />
      {citation.documentId ? <PanelInfo label={t("文档 ID", "Document ID")} value={citation.documentId} /> : null}
      <PanelSection title={t("原文块", "Original chunk")}>
        <Card>
          <CardContent>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{citation.content}</p>
          </CardContent>
        </Card>
      </PanelSection>
    </div>
  );
}

function SettingsCard({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Badge>{badge}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function PanelSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function PanelInfo({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn("break-words text-sm", multiline && "whitespace-pre-wrap leading-6")}>{value}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/35 px-2 py-2">
      <div className="text-base font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function MiniButton({ children, danger, onClick }: { children: ReactNode; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn(
        "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-card hover:text-foreground",
        danger && "text-red-600 hover:text-red-700"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

function EmbeddingPreviewBlock({ title, preview }: { title: string; preview?: EmbeddingPreview | null }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border bg-muted/30 p-2 text-left">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium text-muted-foreground">{title}</span>
        <Badge className="shrink-0">{preview ? t(`${preview.dimensions} 维`, `${preview.dimensions} dims`) : t("未生成", "Not generated")}</Badge>
      </div>
      {preview ? (
        <code className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          [{preview.sample.map((value) => formatEmbeddingNumber(value)).join(", ")}{preview.dimensions > preview.sample.length ? ", ..." : ""}]
        </code>
      ) : (
        <div className="text-xs text-muted-foreground">{t("数据库中还没有这个向量。", "This vector is not in the database yet.")}</div>
      )}
    </div>
  );
}

function MarkdownMessage({
  content,
  citations = [],
  onOpenCitation
}: {
  content: string;
  citations?: AnswerCitation[];
  onOpenCitation?: (citation: AnswerCitation) => void;
}) {
  const blocks = splitMarkdownCodeBlocks(content);
  return (
    <div className="space-y-2 break-words">
      {blocks.map((block, index) => (
        block.type === "code" ? (
          <pre key={index} className="overflow-auto rounded-md bg-muted p-3 text-xs leading-5 text-foreground">
            <code>{block.content}</code>
          </pre>
        ) : (
          <div key={index} className="space-y-1">
            {renderMarkdownLines(block.content, citations, onOpenCitation)}
          </div>
        )
      ))}
    </div>
  );
}

function splitMarkdownCodeBlocks(content: string): Array<{ type: "text" | "code"; content: string }> {
  const blocks: Array<{ type: "text" | "code"; content: string }> = [];
  const regex = /```[^\n]*\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: content.slice(lastIndex, match.index) });
    }
    blocks.push({ type: "code", content: match[1].trimEnd() });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < content.length) {
    blocks.push({ type: "text", content: content.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: "text", content }];
}

function renderMarkdownLines(content: string, citations: AnswerCitation[] = [], onOpenCitation?: (citation: AnswerCitation) => void) {
  const lines = content.split("\n");
  const nodes: ReactNode[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      nodes.push(<div key={index} className="h-2" />);
      continue;
    }
    if (isMarkdownTableStart(lines, index)) {
      const header = splitMarkdownTableCells(lines[index]);
      const alignments = parseMarkdownTableAlignments(lines[index + 1]);
      const rows: string[][] = [];
      let rowIndex = index + 2;
      while (rowIndex < lines.length && isMarkdownTableRow(lines[rowIndex])) {
        rows.push(splitMarkdownTableCells(lines[rowIndex]));
        rowIndex += 1;
      }
      nodes.push(
        <MarkdownTable
          key={index}
          header={header}
          rows={rows}
          alignments={alignments}
          citations={citations}
          onOpenCitation={onOpenCitation}
        />
      );
      index = rowIndex - 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const className = heading[1].length === 1 ? "text-base font-semibold" : "text-sm font-semibold";
      nodes.push(<div key={index} className={className}>{renderInlineMarkdown(heading[2], citations, onOpenCitation)}</div>);
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      nodes.push(
        <div key={index} className="flex gap-2">
          <span className="text-muted-foreground">•</span>
          <span>{renderInlineMarkdown(unordered[1], citations, onOpenCitation)}</span>
        </div>
      );
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      nodes.push(
        <div key={index} className="flex gap-2">
          <span className="text-muted-foreground">{trimmed.split(".")[0]}.</span>
          <span>{renderInlineMarkdown(ordered[1], citations, onOpenCitation)}</span>
        </div>
      );
      continue;
    }
    nodes.push(<p key={index} className="whitespace-pre-wrap leading-6">{renderInlineMarkdown(line, citations, onOpenCitation)}</p>);
  }
  return nodes;
}

function MarkdownTable(props: {
  header: string[];
  rows: string[][];
  alignments: Array<"left" | "center" | "right">;
  citations?: AnswerCitation[];
  onOpenCitation?: (citation: AnswerCitation) => void;
}) {
  return (
    <div className="my-2 max-w-full overflow-x-auto rounded-md border border-border bg-card/50">
      <table className="w-full table-auto border-collapse text-left text-xs leading-5">
        <thead className="bg-muted/60">
          <tr>
            {props.header.map((cell, index) => (
              <th
                key={`${index}-${cell}`}
                className={cn("border-b border-border px-2 py-1.5 font-semibold", tableAlignClass(props.alignments[index]))}
              >
                {renderInlineMarkdown(cell, props.citations, props.onOpenCitation)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border/70">
              {props.header.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn("break-words px-2 py-1.5 align-top", tableAlignClass(props.alignments[cellIndex]))}
                >
                  {renderInlineMarkdown(row[cellIndex] ?? "", props.citations, props.onOpenCitation)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isMarkdownTableStart(lines: string[], index: number) {
  return isMarkdownTableRow(lines[index]) && isMarkdownTableDivider(lines[index + 1] ?? "");
}

function isMarkdownTableRow(line: string) {
  return splitMarkdownTableCells(line).length >= 2;
}

function isMarkdownTableDivider(line: string) {
  const cells = splitMarkdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableCells(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseMarkdownTableAlignments(line: string): Array<"left" | "center" | "right"> {
  return splitMarkdownTableCells(line).map((cell) => {
    const normalized = cell.replace(/\s+/g, "");
    if (normalized.startsWith(":") && normalized.endsWith(":")) return "center";
    if (normalized.endsWith(":")) return "right";
    return "left";
  });
}

function tableAlignClass(alignment?: "left" | "center" | "right") {
  if (alignment === "center") return "text-center";
  if (alignment === "right") return "text-right";
  return "text-left";
}

function renderInlineMarkdown(
  text: string,
  citations: AnswerCitation[] = [],
  onOpenCitation?: (citation: AnswerCitation) => void
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const citationByIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[(\d{1,2})\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={`${match.index}-code`} className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    } else {
      const citationIndex = Number(match[2]);
      const citation = citationByIndex.get(citationIndex);
      if (citation && onOpenCitation) {
        nodes.push(
          <button
            key={`${match.index}-citation`}
            type="button"
            className="mx-0.5 inline-flex h-5 min-w-5 translate-y-[-1px] items-center justify-center rounded border border-border bg-card px-1 text-[11px] font-semibold text-muted-foreground hover:bg-accent hover:text-foreground"
            title={citation.heading || citation.chunkId}
            onClick={() => onOpenCitation(citation)}
          >
            {citation.index}
          </button>
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function getMessageCitations(message: McpMessageRecord): AnswerCitation[] {
  const value = message.metadata.citations;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeAnswerCitation)
    .filter((citation): citation is AnswerCitation => citation !== null)
    .slice(0, 5);
}

function normalizeAnswerCitation(value: unknown): AnswerCitation | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const index = typeof value.index === "number" ? value.index : Number(value.index);
  const chunkId = typeof value.chunkId === "string" ? value.chunkId : "";
  const sourceId = typeof value.sourceId === "string" ? value.sourceId : "";
  const content = typeof value.content === "string" ? value.content : "";
  if (!Number.isInteger(index) || index <= 0 || !chunkId || !sourceId || !content) {
    return null;
  }
  return {
    index,
    chunkId,
    sourceId,
    documentId: typeof value.documentId === "string" ? value.documentId : undefined,
    heading: typeof value.heading === "string" ? value.heading : undefined,
    content,
    rank: typeof value.rank === "number" ? value.rank : undefined,
    score: typeof value.score === "number" ? value.score : undefined,
    query: typeof value.query === "string" ? value.query : undefined
  };
}

function JsonBlock({ title, value, compact, preserveRaw }: { title: string; value: unknown; compact?: boolean; preserveRaw?: boolean }) {
  const { t } = useI18n();
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const renderedValue = preserveRaw ? content : formatDataContent(content, t);
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className={cn("overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-5", compact ? "max-h-64" : "max-h-96")}>
        {renderedValue}
      </pre>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">{text}</div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function resultViewLabel(view: ResultView, language: SupportedLanguage) {
  if (view === "overview") return language === "en" ? "Overview" : "概览";
  if (view === "chunks") return language === "en" ? "Chunks" : "切片";
  if (view === "events") return language === "en" ? "Events" : "事件";
  if (view === "entities") return language === "en" ? "Entities" : "实体";
  return language === "en" ? "Search" : "检索";
}

function filterByKeyword<T>(items: T[], keyword: string, getTitle: (item: T) => string) {
  if (!keyword) return items;
  return items.filter((item) => normalizeKeyword(getTitle(item)).includes(keyword));
}

function paginateItems<T>(items: T[], page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  return items.slice(offset, offset + pageSize);
}

function normalizeKeyword(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function contextPanelModeLabel(mode: ContextPanelMode, t: (zh: string, en: string) => string) {
  if (mode === "process") return t("搜索过程", "Search trace");
  return t("原始日志", "Raw logs");
}

function loadStoredModelLogs(): ModelCallLogRecord[] {
  try {
    const raw = window.localStorage.getItem(MODEL_LOGS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ModelCallLogRecord[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_BROWSER_MODEL_LOGS) : [];
  } catch {
    return [];
  }
}

function loadStoredModelLogCursor(): number {
  const raw = window.localStorage.getItem(MODEL_LOG_CURSOR_STORAGE_KEY);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function mergeModelLogs(current: ModelCallLogRecord[], incoming: ModelCallLogRecord[]): ModelCallLogRecord[] {
  const byId = new Map<string, ModelCallLogRecord>();
  for (const log of [...current, ...incoming]) {
    byId.set(log.id, log);
  }
  return [...byId.values()]
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-MAX_BROWSER_MODEL_LOGS);
}

function persistModelLogs(logs: ModelCallLogRecord[]) {
  for (const limit of [MAX_BROWSER_MODEL_LOGS, 100, 50, 20]) {
    try {
      window.localStorage.setItem(MODEL_LOGS_STORAGE_KEY, JSON.stringify(logs.slice(-limit)));
      return;
    } catch {
      // localStorage may exceed quota because embedding responses contain full vectors.
    }
  }
  try {
    window.localStorage.removeItem(MODEL_LOGS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; logs are diagnostic-only.
  }
}

function uploadStatusLabel(status: UploadJobRecord["status"], t: (zh: string, en: string) => string) {
  if (status === "QUEUED") return t("排队中", "Queued");
  if (status === "RUNNING") return t("处理中", "Processing");
  if (status === "COMPLETED") return t("完成", "Completed");
  return t("失败", "Failed");
}

function uploadStageLabel(stage: UploadJobRecord["stage"], t: (zh: string, en: string) => string) {
  if (stage === "QUEUED") return t("排队", "Queued");
  if (stage === "READING") return t("读取文件", "Reading file");
  if (stage === "PARSING") return t("解析文档", "Parsing document");
  if (stage === "CHUNKING") return t("生成切片", "Generating chunks");
  if (stage === "EMBEDDING_CHUNKS") return t("切片向量化", "Embedding chunks");
  if (stage === "EXTRACTING_EVENTS") return t("抽取事件", "Extracting events");
  if (stage === "EMBEDDING_EVENTS") return t("事件与实体向量化", "Embedding events and entities");
  if (stage === "WRITING_GRAPH") return t("写入图谱", "Writing graph");
  if (stage === "COMPLETED") return t("处理完成", "Completed");
  return t("处理失败", "Failed");
}

function processStatusLabel(status: ProcessStepStatus, t: (zh: string, en: string) => string) {
  if (status === "running") return t("运行中", "Running");
  if (status === "failed") return t("失败", "Failed");
  return t("完成", "Done");
}

function processStatusClassName(status: ProcessStepStatus) {
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  return "";
}

function makeStepId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function buildSearchProcessSteps(result: SearchResult, language: SupportedLanguage): ProcessStep[] {
  const trace = result.trace ?? { traceId: result.traceId };
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  return [
    {
      id: makeStepId("search-start"),
      title: t("开始检索", "Start search"),
      detail: t(
        `查询：${searchTraceText(trace, "query") ?? "当前问题"}；模式：${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`,
        `Query: ${searchTraceText(trace, "query") ?? "current question"}; mode: ${searchModeLabel(searchTraceText(trace, "searchMode"), language)}`
      ),
      status: "done"
    },
    ...buildTraceProcessSteps(trace, t("检索链路", "Search trace"), language),
    {
      id: makeStepId("search-result"),
      title: t("生成结果", "Generate results"),
      detail: t(`返回 ${result.sections.length} 个切片结果`, `${result.sections.length} chunk result(s) returned`),
      status: "done",
      payload: {
        traceId: result.traceId,
        sections: result.sections.map((section) => ({
          chunkId: section.chunkId,
          heading: section.heading,
          score: section.score,
          rank: section.rank
        }))
      }
    }
  ];
}

function buildTraceProcessSteps(trace: unknown, groupTitle: string, language: SupportedLanguage): ProcessStep[] {
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const record = isPlainRecord(trace) ? trace : {};
  const timings = isPlainRecord(record.timings) ? record.timings : {};
  const orderedSteps: Array<{
    key: string;
    title: string;
    detail: string;
    payload?: unknown;
  }> = [
    {
      key: "queryEmbedding",
      title: t("查询向量化", "Query embedding"),
      detail: t("把用户问题转成向量，用于召回相关事件和切片。", "Convert the user question into a vector for recalling related events and chunks.")
    },
    {
      key: "step1Bm25Entities",
      title: t("BM25 匹配查询实体", "BM25 match query entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step1ExtractEntities",
      title: t("抽取查询实体", "Extract query entities"),
      detail: entitySummary(record.queryEntities, language),
      payload: record.queryEntities
    },
    {
      key: "step2RetrieveEntities",
      title: t("召回相关实体", "Retrieve related entities"),
      detail: countSummary(record.recalledEntities, t("个实体", "entities"), language),
      payload: record.recalledEntities
    },
    {
      key: "step3EntityEvents",
      title: t("实体关联事件", "Entity-linked events"),
      detail: countSummary(record.entityEvents ?? record.entityEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "entityEvents", "entityEventIds")
    },
    {
      key: "step3QueryEvents",
      title: t("标题向量召回事件", "Title-vector event recall"),
      detail: countSummary(record.queryEvents ?? record.queryEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "queryEvents", "queryEventIds")
    },
    {
      key: "step4FetchDetails",
      title: t("读取候选事件详情", "Fetch candidate event details"),
      detail: countSummary(record.eventSnapshots, t("个候选事件", "candidate events"), language),
      payload: record.eventSnapshots
    },
    {
      key: "step5Expand",
      title: t("事件扩展", "Event expansion"),
      detail: countSummary(record.expandedEvents ?? record.expandedEventIds, t("个事件", "events"), language),
      payload: eventPayload(record, "expandedEvents", "expandedEventIds")
    },
    {
      key: "step6CoarseRank",
      title: t("粗排事件", "Coarse-rank events"),
      detail: countSummary(record.coarseRankedEvents ?? record.coarseRankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "coarseRankedEvents", "coarseRankedEventIds")
    },
    {
      key: "step7LlmRerank",
      title: t("LLM 重排", "LLM rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step7RerankModel",
      title: t("Rerank 模型重排", "Rerank model rerank"),
      detail: countSummary(record.rerankedEvents ?? record.rerankedEventIds, t("个候选", "candidates"), language),
      payload: eventPayload(record, "rerankedEvents", "rerankedEventIds")
    },
    {
      key: "step8FetchChunks",
      title: t("回取关联切片", "Fetch related chunks"),
      detail: t("读取最终事件关联的原文切片，作为回答上下文。", "Fetch original chunks linked to the final events as answer context.")
    }
  ];

  const steps: ProcessStep[] = orderedSteps
    .filter((step) => step.key in timings || step.payload !== undefined)
    .map((step) => ({
      id: makeStepId(step.key),
      title: step.title,
      detail: step.detail,
      status: "done" as const,
      durationMs: numberOrNull(timings[step.key]),
      payload: step.payload
    }));

  const fallbackReason = searchTraceText(record, "fallbackReason");
  if (fallbackReason) {
    steps.push({
      id: makeStepId("fallback"),
      title: t("降级路径", "Fallback path"),
      detail: fallbackReason,
      status: "done"
    });
  }

  if (steps.length === 0) {
    steps.push({
      id: makeStepId("trace"),
      title: groupTitle,
      detail: t("工具返回了链路数据，但没有包含可拆解的阶段字段。", "The tool returned trace data but did not include decomposable stage fields."),
      status: "done",
      payload: trace
    });
  }

  return steps;
}

function buildToolProcessPayload(toolCall: McpToolCallRecord, language: SupportedLanguage) {
  return {
    [language === "en" ? "arguments" : "参数"]: toolCall.arguments,
    [language === "en" ? "result" : "结果"]: parseToolResponse(toolCall.result),
    [language === "en" ? "error" : "错误"]: toolCall.error ?? undefined
  };
}

function buildRunningMcpSearch(toolName: string, args: Record<string, unknown>, language: SupportedLanguage): RunningMcpSearch {
  const query = typeof args.query === "string" && args.query.trim()
    ? args.query.trim()
    : language === "en" ? `${toolName} did not provide a query argument` : `${toolName} 未提供 query 参数`;
  const searchMode = typeof args.searchMode === "string" ? searchModeLabel(args.searchMode, language) : undefined;
  return {
    id: makeStepId("running-mcp-search"),
    toolName,
    query,
    searchMode
  };
}

function getMcpSearchQuery(args: Record<string, unknown>, language: SupportedLanguage) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const mode = typeof args.searchMode === "string"
    ? language === "en" ? `; mode: ${searchModeLabel(args.searchMode, language)}` : `；模式：${searchModeLabel(args.searchMode, language)}`
    : "";
  return query
    ? `query: ${query}${mode}`
    : language === "en" ? "MCP called sag_search, but the arguments did not include a query field." : "MCP 调用了 sag_search，但参数里没有 query 字段。";
}

function buildMcpSearchQueryStep(toolCall: McpToolCallRecord, language: SupportedLanguage): ProcessStep {
  const query = typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
  return {
    id: makeStepId("mcp-search-query"),
    title: language === "en" ? "MCP search query" : "MCP 搜索语句",
    detail: getMcpSearchQuery(toolCall.arguments, language),
    status: "done",
    durationMs: toolCall.durationMs,
    payload: {
      query,
      strategy: toolCall.arguments.strategy,
      subStrategy: toolCall.arguments.subStrategy,
      searchMode: toolCall.arguments.searchMode,
      topK: toolCall.arguments.topK,
      returnTrace: toolCall.arguments.returnTrace
    }
  };
}

function buildMcpSearchResultSteps(result: unknown, language: SupportedLanguage): ProcessStep[] {
  if (!isPlainRecord(result) || !Array.isArray(result.sections)) {
    return [];
  }
  return [{
    id: makeStepId("mcp-search-result"),
    title: language === "en" ? "SAG returned chunks" : "SAG 返回切片",
    detail: language === "en" ? `${result.sections.length} chunk result(s) returned` : `返回 ${result.sections.length} 个切片结果`,
    status: "done",
    payload: {
      traceId: result.traceId,
      sections: result.sections.map((section) => {
        if (!isPlainRecord(section)) {
          return section;
        }
        return {
          heading: section.heading,
          contentPreview: typeof section.content === "string" ? section.content.slice(0, 160) : "",
          score: section.score,
          rank: section.rank
        };
      })
    }
  }];
}

function parseToolResponse(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.content)) {
    return value;
  }
  const text = value.content
    .map((item) => isPlainRecord(item) && item.type === "text" ? String(item.text ?? "") : "")
    .filter(Boolean)
    .join("\n");
  if (!text) {
    return value;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractSearchTrace(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  if (isPlainRecord(value.trace)) return value.trace;
  if ("timings" in value || "traceId" in value || "recalledEntities" in value || "queryEventIds" in value) {
    return value;
  }
  return null;
}

function searchTraceText(record: unknown, key: string) {
  if (!isPlainRecord(record)) return null;
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function searchModeLabel(value: string | null, language: SupportedLanguage) {
  if (value === "fast") return language === "en" ? "Fast" : "极速";
  if (value === "standard") return language === "en" ? "Standard" : "标准";
  return language === "en" ? "Default" : "默认";
}

function entitySummary(value: unknown, language: SupportedLanguage) {
  if (Array.isArray(value)) {
    if (value.length === 0) return language === "en" ? "No query entities identified" : "没有识别到查询实体";
    return language === "en" ? `${value.length} query entity/entities identified` : `识别到 ${value.length} 个查询实体`;
  }
  return language === "en" ? "Identify key entities in the user question" : "识别用户问题中的关键实体";
}

function countSummary(value: unknown, unit: string, language: SupportedLanguage) {
  if (Array.isArray(value)) return `${value.length} ${unit}`;
  return language === "en" ? "Waiting for the previous step" : "等待上一步结果";
}

function eventPayload(record: Record<string, unknown>, eventKey: string, idKey: string) {
  const direct = record[eventKey];
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const ids = record[idKey];
  const snapshots = record.eventSnapshots;
  if (!Array.isArray(ids) || !Array.isArray(snapshots)) {
    return undefined;
  }
  const snapshotById = new Map(
    snapshots
      .filter(isPlainRecord)
      .map((event) => [String(event.id ?? ""), event])
  );
  const events = ids
    .map((id) => snapshotById.get(String(id)))
    .filter(Boolean);
  return events.length > 0 ? events : undefined;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function friendlyError(msg: string): string {
  if (/no such table|sqlite-driver|sql:/i.test(msg)) {
    return "Some data is temporarily unavailable. Please retry.";
  }
  return msg;
}

/**
 * Visual styling for the matchType badge on a search result card.
 * - vector  → indigo (semantic match)
 * - keyword → emerald (literal term match)
 * - hybrid  → violet (both signals agreed)
 */
function matchTypeBadgeClass(m: "vector" | "keyword" | "hybrid"): string {
  if (m === "vector") return "border-indigo-200 bg-indigo-50 text-indigo-700";
  if (m === "keyword") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-violet-200 bg-violet-50 text-violet-700";
}

function matchTypeLabel(m: "vector" | "keyword" | "hybrid"): string {
  if (m === "vector") return "语义";
  if (m === "keyword") return "关键词";
  return "混合";
}

function matchTypeTooltip(m: "vector" | "keyword" | "hybrid"): string {
  if (m === "vector") return "召回来源：向量语义匹配（cosine on embedding）";
  if (m === "keyword") return "召回来源：关键词字面匹配（heading/content LIKE）";
  return "召回来源：向量 + 关键词同时命中";
}



function isAbortError(error: unknown) {
  return (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError");
}

function formatModelName(model: string | null | undefined, t: (zh: string, en: string) => string) {
  if (!model) return t("未知模型", "Unknown model");
  if (model === "local-rule-fallback") return t("本地规则回退", "Local rule fallback");
  return model;
}

function formatMessageRole(role: string, t: (zh: string, en: string) => string) {
  if (role === "user") return t("用户", "User");
  if (role === "assistant") return t("助手", "Assistant");
  if (role === "tool") return t("工具", "Tool");
  return t("系统", "System");
}

function formatToolStatus(status: "PENDING" | "SUCCEEDED" | "FAILED", t: (zh: string, en: string) => string) {
  if (status === "SUCCEEDED") return t("成功", "Succeeded");
  if (status === "FAILED") return t("失败", "Failed");
  return t("等待中", "Pending");
}

function formatEmbeddingNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(5) : "0.00000";
}

function formatMessageContent(content: string, t: (zh: string, en: string) => string) {
  return formatDataContent(content, t)
    .replaceAll("sources", t("项目", "projects"))
    .replaceAll("source", t("项目", "project"))
    .replaceAll("Sources", t("项目", "Projects"))
    .replaceAll("Source", t("项目", "Project"))
    .replaceAll("来源", t("项目", "project"))
    .replaceAll("trace", t("检索链路", "trace"))
    .replaceAll(
      "Mock LLM planner completed MCP tool calls.",
      t("模拟 LLM 规划器已完成 MCP 工具调用。", "Mock LLM planner completed MCP tool calls.")
    )
    .replace(
      "当前未配置 LLM_API_KEY，已使用有限 fallback 通过真实 MCP client 测试工具。",
      t(
        "当前未配置 LLM 密钥，已使用有限本地规则回退，并通过真实 MCP 客户端测试工具。",
        "LLM key is not configured. A limited local rule fallback was used to test tools through the real MCP client."
      )
    )
    .replace(
      "当前 fallback 支持列出 sources、检索 search、查询 event。请尝试：列出 sources，并搜索 SAG multi search。",
      t(
        "当前本地规则回退支持列出项目、执行检索、查询事件。请尝试：列出项目，并搜索 SAG 多路检索。",
        "The local fallback supports listing projects, searching, and querying events. Try listing projects and searching SAG multi-search."
      )
    )
    .replace(
      "已通过 MCP 调用 sag_search，并返回检索结果和 trace。",
      t("已通过 MCP 调用 sag_search，并返回检索结果和检索链路。", "Called sag_search through MCP and returned retrieval results and trace.")
    );
}

function formatDataContent(content: string, t: (zh: string, en: string) => string) {
  const project = t("项目", "project");
  const projectList = t("项目列表", "project list");
  const projectIds = t("项目ID列表", "project ID list");
  const projectId = t("项目ID", "project ID");
  return content
    .replaceAll("sourceIds", projectIds)
    .replaceAll("sourceId", projectId)
    .replaceAll("source_id", projectId)
    .replaceAll("sources", projectList)
    .replaceAll("source", project)
    .replaceAll("Sources", projectList)
    .replaceAll("Source", project)
    .replaceAll("projects", projectList)
    .replaceAll("projectIds", projectIds)
    .replaceAll("projectId", projectId)
    .replaceAll("来源", project);
}

function KbDrawer(props: {
  detail: {
    project: {
      id: string; name: string; description: string | null;
      cachedDocumentsCount?: number; cachedChunksCount?: number; cachedEntitiesCount?: number;
      cachedUpdatedAt?: string | null;
    };
    sources: Array<{ id: string; name: string; sourceType: "folder" | "upload"; folderDisplayName?: string; folderPath?: string; enabled: boolean; watchedFolderId?: string | null }>;
    sourcesProjectId?: string;
  } | null;
  selectedKbId: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onCopyMcpConfig: (kbId: string) => void;
  onFoldersChanged?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [removingSourceId, setRemovingSourceId] = useState<string | null>(null);
  const [showNewKbDialog, setShowNewKbDialog] = useState(false);
  const [newKbName, setNewKbName] = useState("");
  const [newKbDesc, setNewKbDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);

  const isCreatingNew = !props.selectedKbId;
  const project = props.detail?.project;

  async function handleCreateKb() {
    if (!newKbName.trim()) return;
    setCreating(true);
    try {
      const r = await api.createKbProject({ name: newKbName, description: newKbDesc || null });
      setShowNewKbDialog(false);
      setNewKbName(""); setNewKbDesc("");
      await props.onRefresh();
      // select the new one
      window.location.reload();
    } catch (err) {
      alert(String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRemoveSource(source: { id: string; name: string; sourceType: "folder" | "upload"; watchedFolderId?: string | null }) {
    if (!props.selectedKbId) return;
    if (!confirm(`从汇集功能项目移除「${source.name}」？`)) return;
    setRemovingSourceId(source.id);
    try {
      if (source.sourceType === "folder" && source.watchedFolderId && props.detail?.sourcesProjectId) {
        // Folder sources live in BOTH the sources model (so documents
        // rebind to former) AND the KB model (so the drawer row is
        // tracked here). Drop both rows on detach.
        await api.detachFoldersFromProject(props.detail.sourcesProjectId, [source.watchedFolderId]);
        await api.removeKbSource(props.selectedKbId, source.id);
      } else {
        // Upload-type sources live in the KB model — keep the old path.
        await api.removeKbSource(props.selectedKbId, source.id);
      }
      await Promise.all([props.onRefresh(), props.onFoldersChanged?.()]);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingSourceId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30" role="presentation">
      <div className="w-full max-w-2xl bg-card shadow-xl flex flex-col overflow-hidden" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary shrink-0" />
              <div className="text-base font-semibold truncate">{project?.name ?? (isCreatingNew ? "新建知识库" : "知识库详情")}</div>
            </div>
            {project?.description && (
              <div className="mt-1 text-xs text-muted-foreground truncate">{project.description}</div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={props.onClose}>
            <span aria-hidden>×</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {isCreatingNew ? (
            <div className="rounded-lg border border-border bg-card p-5">
              <div className="text-sm font-medium mb-3">{t("创建知识库", "Create knowledge base")}</div>
              <Input
                placeholder={t("知识库名称", "KB name")}
                value={newKbName}
                onChange={(e) => setNewKbName(e.target.value)}
                className="mb-2"
              />
              <Input
                placeholder={t("描述（可选）", "Description (optional)")}
                value={newKbDesc}
                onChange={(e) => setNewKbDesc(e.target.value)}
                className="mb-3"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={props.onClose}>{t("取消", "Cancel")}</Button>
                <Button size="sm" disabled={!newKbName.trim() || creating} onClick={() => void handleCreateKb()}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("创建", "Create")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {/* Sources */}
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <div className="text-sm font-medium">📊 Sources ({props.detail?.sources.length ?? 0})</div>
                  <Button variant="secondary" size="sm" onClick={() => setShowAddSource(true)}>
                    <Plus className="h-3.5 w-3.5" /> {t("添加源", "Add source")}
                  </Button>
                </div>
                {!props.detail || props.detail.sources.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("暂无源，点击「添加源」挂载 folder 或上传文件", "No sources. Click 'Add source' to attach folders or upload files.")}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {props.detail.sources.map((s) => (
                      <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="text-lg">{s.sourceType === "folder" ? "📁" : "📄"}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">{s.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {s.sourceType === "folder"
                              ? `${s.folderPath ?? ""} · folder · ${s.enabled ? "启用" : "停用"}`
                              : `upload · ${s.enabled ? "启用" : "停用"}`}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={removingSourceId === s.id}
                          onClick={() => void handleRemoveSource({ id: s.id, name: s.name, sourceType: s.sourceType, watchedFolderId: s.watchedFolderId ?? null })}
                          className="text-red-600 hover:text-red-700"
                        >
                          {removingSourceId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "×"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Stats placeholder */}
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-medium mb-2">📈 {t("使用统计", "Stats")}</div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <div className="rounded-md bg-muted/50 px-2 py-1.5 text-center">
                    <div className="text-lg font-semibold tabular-nums">{(project as { cachedDocumentsCount?: number } | undefined)?.cachedDocumentsCount ?? 0}</div>
                    <div className="text-[10px] text-muted-foreground">{t("文档", "docs")}</div>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5 text-center">
                    <div className="text-lg font-semibold tabular-nums">{(project as { cachedChunksCount?: number } | undefined)?.cachedChunksCount ?? 0}</div>
                    <div className="text-[10px] text-muted-foreground">{t("块", "chunks")}</div>
                  </div>
                  <div className="rounded-md bg-muted/50 px-2 py-1.5 text-center">
                    <div className="text-lg font-semibold tabular-nums">{(project as { cachedEntitiesCount?: number } | undefined)?.cachedEntitiesCount ?? 0}</div>
                    <div className="text-[10px] text-muted-foreground">{t("实体", "entities")}</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("创建于", "Created")}: {new Date().toISOString().slice(0, 10)}
                  {(project as { cachedUpdatedAt?: string | null } | undefined)?.cachedUpdatedAt ? (
                    <> · {t("更新于", "Updated")}: {new Date((project as { cachedUpdatedAt?: string | null }).cachedUpdatedAt!).toISOString().slice(0, 16).replace("T", " ")}</>
                  ) : null}
                </div>
              </div>
            </>
          )}
        </div>

        {!isCreatingNew ? (
          <div className="border-t border-border px-5 py-3 flex justify-between">
            {project ? (
              <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => void props.onDelete(project.id)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> {t("删除知识库", "Delete KB")}
              </Button>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t("未关联 KB 项目", "No KB project linked. Use 'Add source' to start building one.")}
              </div>
            )}
            <Button variant="secondary" size="sm" onClick={props.onClose}>{t("关闭", "Close")}</Button>
          </div>
        ) : null}
      </div>

      {showAddSource && props.selectedKbId ? (
        <AddSourceInline
          kbProjectId={props.selectedKbId}
          sourcesProjectId={(props.detail as unknown as { sourcesProjectId?: string } | null)?.sourcesProjectId}
          onClose={() => setShowAddSource(false)}
          onAdded={async () => {
            setShowAddSource(false);
            await props.onRefresh();
          }}
          onFoldersChanged={() => void props.onFoldersChanged?.()}
        />
      ) : null}
    </div>
  );
}

function AddSourceInline(props: { kbProjectId: string; sourcesProjectId?: string; onClose: () => void; onAdded: () => void; onFoldersChanged?: () => void | Promise<void> }) {
  const { t } = useI18n();
  const [type, setType] = useState<"folder" | "upload">("folder");
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<Array<{ id: string; sourceId: string; displayName: string; path: string }>>([]);
  const [selectedFolder, setSelectedFolder] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedDocId, setUploadedDocId] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploadedFileMeta, setUploadedFileMeta] = useState<{ name: string; size: number; extension: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.listKbAvailableFolders();
        setFolders(r.folders);
        if (r.folders[0]) {
          setSelectedFolder(r.folders[0].id);
          // Prefill the source name from the watched folder's existing
          // display name — the user shouldn't have to retype it.
          setName((prev) => prev.trim() ? prev : r.folders[0].displayName);
        }
      } catch {}
    })();
  }, []);

  async function handleFile(file: File) {
    setUploading(true); setUploadError(""); setUploadedDocId(null); setUploadedFileName(file.name);
    try {
      const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
      const textExts = new Set([".md", ".txt", ".markdown", ".csv"]);
      const convertExts = new Set([".pdf", ".docx", ".xlsx", ".xls"]);
      let content: string;
      if (textExts.has(ext)) {
        content = await file.text();
      } else if (convertExts.has(ext)) {
        const buf = await file.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        const result = await api.convertFile(file.name, b64);
        content = result.markdown;
      } else {
        throw new Error(`不支持的文件类型: ${ext}`);
      }
      // Resolve the per-KB-project upload source (auto-created on first use)
      // so uploaded documents land in their own source instead of being
      // smuggled into the first watched folder's source.
      const { sourceId: uploadSourceId } = await api.ensureKbUploadSource(props.kbProjectId);
      const upload = await api.uploadDocument({ fileName: file.name, content, sourceId: uploadSourceId });
      setUploadedDocId(upload.documentId);
      // Remember file metadata so addKbSource can persist file_name/size/extension.
      setUploadedFileMeta({ name: file.name, size: file.size, extension: ext });
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (type === "folder" && props.sourcesProjectId) {
        // Folder sources go through the new sources-model attach API so that
        // the project (d65db8c0…) is actually rewired in `watched_folders`.
        // We ALSO mirror the link into the KB model so the KB drawer shows
        // the row immediately (the drawer's source list comes from
        // `kb_sources`, not `watched_folders`).
        await api.attachFoldersToProject(props.sourcesProjectId, [selectedFolder]);
        await api.addKbSource(props.kbProjectId, {
          source_type: "folder",
          name,
          watched_folder_id: selectedFolder
        });
      } else {
        // Upload-type sources still go through KB model (no sources-model
        // equivalent yet — uploads are per-project KB bookkeeping).
        await api.addKbSource(props.kbProjectId, {
          source_type: type,
          name,
          watched_folder_id: type === "folder" ? selectedFolder : undefined,
          upload_id: type === "upload" ? uploadedDocId ?? undefined : undefined,
          // Carry file metadata forward for upload-type sources so the
          // overview can render the file name + size without an extra
          // round-trip to GET /documents/:id.
          file_name: type === "upload" ? uploadedFileMeta?.name : undefined,
          file_size: type === "upload" ? uploadedFileMeta?.size : undefined,
          file_extension: type === "upload" ? uploadedFileMeta?.extension : undefined
        });
      }
      props.onAdded();
      await props.onFoldersChanged?.();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = name.trim() && (
    (type === "folder" && selectedFolder) ||
    (type === "upload" && uploadedDocId)
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-lg" role="dialog" aria-modal="true">
        <div className="text-sm font-semibold mb-3">{t("添加知识库源", "Add knowledge base source")}</div>
        <div className="flex gap-2 mb-3">
          <button type="button" onClick={() => setType("folder")} className={`flex-1 rounded-md border px-3 py-2 text-sm ${type === "folder" ? "border-primary bg-primary/5 font-semibold" : "border-border bg-card"}`}>📁 {t("文件夹", "Folder")}</button>
          <button type="button" onClick={() => setType("upload")} className={`flex-1 rounded-md border px-3 py-2 text-sm ${type === "upload" ? "border-primary bg-primary/5 font-semibold" : "border-border bg-card"}`}>📄 {t("上传文件", "Upload")}</button>
        </div>
        <div className="text-xs text-muted-foreground mb-1">{t("源名称 *", "Source name *")}</div>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("如：2025 年报文件夹", "e.g. 2025 report folder")} className="mb-3" />
        {type === "folder" ? (
          <>
            <div className="text-xs text-muted-foreground mb-1">{t("选择文件夹 *", "Select folder *")}</div>
            <select value={selectedFolder} onChange={(e) => {
              const id = e.target.value;
              setSelectedFolder(id);
              // Keep the source name in sync with the selected folder's
              // display name unless the user has typed a custom name.
              const folder = folders.find((f) => f.id === id);
              if (folder) {
                setName((prev) => {
                  const wasAuto = !prev.trim() || folders.some((f) => f.displayName === prev);
                  return wasAuto ? folder.displayName : prev;
                });
              }
            }} className="mb-3 h-9 w-full rounded-md border border-border bg-card px-3 text-sm">
              <option value="">— {t("选择", "Select")} —</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.displayName} ({f.path})</option>)}
            </select>
          </>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-1">{t("选择文件 *", "Select file *")}</div>
            <input type="file" accept=".md,.txt,.markdown,.csv,.pdf,.docx,.xlsx,.xls" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ""; }} className="mb-2 block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-primary file:text-primary-foreground" />
            {uploading && <div className="text-xs text-muted-foreground mb-2"><Loader2 className="inline h-3 w-3 animate-spin mr-1" />{t("上传中", "Uploading")} {uploadedFileName}…</div>}
            {uploadedDocId && <div className="text-xs text-emerald-600 mb-2">✓ {uploadedFileName} {t("已入库", "ingested")}</div>}
            {uploadError && <div className="text-xs text-red-600 mb-2">{uploadError}</div>}
          </>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" size="sm" onClick={props.onClose}>{t("取消", "Cancel")}</Button>
          <Button size="sm" disabled={!canSubmit || busy} onClick={() => void handleSubmit()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("添加", "Add")}
          </Button>
        </div>
      </div>
    </div>
  );
}

type ProjectDetailInnerView = "overview" | "documents" | "graph" | "mcp";

function ProjectDetail(props: {
  project: SourceRecord | null;
  documents: DocumentRecord[];
  selectedDocumentId: string;
  selectedDocument: DocumentRecord | null;
  chunks: ChunkRecord[];
  events: EventRecord[];
  entities: EntityRecord[];
  projectStats: ProjectStatsRecord | null;
  kbRefreshKey?: number;
  projectGraph: ProjectGraphRecord | null;
  resultView: ResultView;
  showArchivedDocuments: boolean;
  hasActiveUploads: boolean;
  uploadJobs: UploadJobRecord[];
  isUploadQueueExpanded: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  searchResult: SearchResult | null;
  isSearching: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  mcpSettings: PublicMcpSettings | null;
  onUploadFiles: (files: File[]) => void | Promise<void>;
  onToggleUploadQueue: () => void;
  onSelectDocument: (id: string) => void;
  onRenameDocument: (doc: DocumentRecord) => void | Promise<void>;
  onArchiveOrRestoreDocument: (doc: DocumentRecord) => void | Promise<void>;
  onDeleteDocument: (doc: DocumentRecord) => void | Promise<void>;
  onSetResultView: (view: ResultView) => void;
  onToggleArchivedDocuments: (show: boolean) => void;
  onSearchQueryChange: (q: string) => void;
  onSearchModeChange: (m: SearchMode) => void;
  onSearch: () => void | Promise<void>;
  onOpenEvent: (eventId: string) => void | Promise<void>;
  onOpenEntity: (entityId: string) => void | Promise<void>;
  onOpenKbDrawer: () => void | Promise<void>;
  onKbRefresh?: () => void;
  onWatchedFoldersRefresh?: () => void | Promise<void>;
  // Plumbed in from AppShell so the project toolbar (archive / delete)
  // can mutate the project without bouncing through sidebar menus.
  onArchiveOrRestoreProject?: (project: SourceRecord) => void | Promise<void>;
  onDeleteProject?: (project: SourceRecord) => void | Promise<void>;
  watchedFolders?: WatchedFolderListItem[];
}) {
  const { t } = useI18n();
  const [innerView, setInnerView] = useState<ProjectDetailInnerView>("overview");
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [kbOverview, setKbOverview] = useState<{
    sources: Array<{
      id: string; name: string; sourceType: "folder" | "upload";
      folderPath?: string; folderDisplayName?: string; watchedFolderId?: string | null;
      fileName?: string | null; fileSize?: number | null; fileExtension?: string | null;
      enabled: boolean; createdAt?: string;
    }>;
    cachedDocumentsCount: number;
    cachedChunksCount: number;
    cachedEntitiesCount: number;
    cachedUploadDocumentsCount: number;
    cachedUploadChunksCount: number;
    cachedUploadEntitiesCount: number;
    cachedUpdatedAt: string | null;
  } | null>(null);
  const [kbLoading, setKbLoading] = useState(false);
  const [syncingFolderId, setSyncingFolderId] = useState<string | null>(null);
  const [detachingFolderId, setDetachingFolderId] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [overviewStatus, setOverviewStatus] = useState("");

  // Open the "attach existing folders" dialog. The dialog itself lives at
  // the bottom of this component so it can share projectId + reload state.
  function openAttachFoldersDialog() {
    if (!props.project) return;
    setAttachDialogOpen(true);
  }

  // Load the KB project attached to this watched folder on mount and after
  // the user returns from the KB drawer. Uses name-based matching because
  // KB projects are lazy-created with the same name as the watched folder.
  // Failures (no KB project yet, 404, network) are surfaced as kbOverview=null
  // — the empty-state UI handles that case.
  useEffect(() => {
    let cancelled = false;
    const projectName = props.project?.name;
    if (!projectName) return;
    const load = async () => {
      setKbLoading(true);
      try {
        // listKbProjects + find by name — handles the case where the KB
        // project was created out-of-band with a different id than the
        // watched folder (Sprint 6 fix for 409 conflict).
        const list = await api.listKbProjects();
        if (cancelled) return;
        const match = list.projects.find((p) => p.name === projectName);
        if (!match) {
          setKbOverview(null);
          return;
        }
        const detail = await api.getKbProject(match.id);
        if (cancelled) return;
        setKbOverview({
          sources: detail.sources.map((s) => ({
            id: s.id,
            name: s.name,
            sourceType: s.sourceType,
            folderPath: s.folderPath,
            folderDisplayName: s.folderDisplayName,
            watchedFolderId: s.watchedFolderId ?? null,
            fileName: s.fileName ?? null,
            fileSize: s.fileSize ?? null,
            fileExtension: s.fileExtension ?? null,
            enabled: s.enabled,
            createdAt: s.createdAt
          })),
          cachedDocumentsCount: detail.project.cachedDocumentsCount ?? 0,
          cachedChunksCount: detail.project.cachedChunksCount ?? 0,
          cachedEntitiesCount: detail.project.cachedEntitiesCount ?? 0,
          cachedUploadDocumentsCount: detail.project.cachedUploadDocumentsCount ?? 0,
          cachedUploadChunksCount: detail.project.cachedUploadChunksCount ?? 0,
          cachedUploadEntitiesCount: detail.project.cachedUploadEntitiesCount ?? 0,
          cachedUpdatedAt: detail.project.cachedUpdatedAt ?? null
        });
      } catch {
        if (!cancelled) setKbOverview(null);
      } finally {
        if (!cancelled) setKbLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.project?.id, props.project?.name, props.kbRefreshKey]);

  // Imperative refresh exposed to the Uploaded Files row delete handler.
  // Same flow as the useEffect above but without the cancellation guard,
  // so we can call it after a mutation completes.
  const refreshKbOverview = async (): Promise<void> => {
    const projectNameInner = props.project?.name;
    if (!projectNameInner) return;
    try {
      const list = await api.listKbProjects();
      const match = list.projects.find((p) => p.name === projectNameInner);
      if (!match) {
        setKbOverview(null);
        return;
      }
      const detail = await api.getKbProject(match.id);
      setKbOverview({
        sources: detail.sources.map((s) => ({
          id: s.id,
          name: s.name,
          sourceType: s.sourceType,
          folderPath: s.folderPath,
          folderDisplayName: s.folderDisplayName,
          watchedFolderId: s.watchedFolderId ?? null,
          fileName: s.fileName ?? null,
          fileSize: s.fileSize ?? null,
          fileExtension: s.fileExtension ?? null,
          enabled: s.enabled,
          createdAt: s.createdAt
        })),
        cachedDocumentsCount: detail.project.cachedDocumentsCount ?? 0,
        cachedChunksCount: detail.project.cachedChunksCount ?? 0,
        cachedEntitiesCount: detail.project.cachedEntitiesCount ?? 0,
        cachedUploadDocumentsCount: detail.project.cachedUploadDocumentsCount ?? 0,
        cachedUploadChunksCount: detail.project.cachedUploadChunksCount ?? 0,
        cachedUploadEntitiesCount: detail.project.cachedUploadEntitiesCount ?? 0,
        cachedUpdatedAt: detail.project.cachedUpdatedAt ?? null
      });
    } catch {
      // Refresh failed — leave current state in place; the user can
      // retry by closing+reopening the KB drawer.
    }
  };

  if (!props.project) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-center text-sm text-muted-foreground">
        {t("未选项目", "No project selected")}
      </div>
    );
  }

  const innerTabs: Array<{ value: ProjectDetailInnerView; label: string; icon: string }> = [
    { value: "overview", label: t("概览", "Overview"), icon: "📊" },
    { value: "documents", label: t("文档", "Documents"), icon: "📄" },
    { value: "graph", label: t("图谱", "Graph"), icon: "🕸️" },
    { value: "mcp", label: t("MCP", "MCP"), icon: "🔌" }
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Project header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="text-xl font-semibold">📚 {props.project.name}</div>
              {props.projectStats ? (
                <span className="text-xs text-muted-foreground">
                  · {props.projectStats.documentCount} {t("文档", "docs")} · {props.projectStats.chunkCount} {t("块", "chunks")} · {props.projectStats.entityCount} {t("实体", "entities")}
                </span>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("项目 ID", "Project ID")}: <code className="text-[10px]">{props.project.id.slice(0, 8)}…</code>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void props.onOpenKbDrawer()}>
              <BookOpen className="h-3.5 w-3.5 mr-1" />
              {t("管理知识库源", "Manage KB sources")}
            </Button>
            {props.project && props.onArchiveOrRestoreProject ? (
              <Button
                variant="ghost"
                size="sm"
                title={props.project.archivedAt ? t("恢复项目", "Restore project") : t("归档项目", "Archive project")}
                onClick={() => void props.onArchiveOrRestoreProject?.(props.project!)}
              >
                {props.project.archivedAt ? t("恢复", "Restore") : t("归档", "Archive")}
              </Button>
            ) : null}
            {props.project && props.onDeleteProject ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-600 hover:text-red-700"
                title={t("永久删除项目", "Permanently delete project")}
                onClick={() => void props.onDeleteProject?.(props.project!)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t("删除项目", "Delete project")}
              </Button>
            ) : null}
          </div>
        </div>

        {/* Inner tabs */}
        <div className="mt-3 flex items-center gap-1 border-b border-border -mb-4 pb-0">
          {innerTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={cn(
                "flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-sm transition-colors",
                innerView === tab.value
                  ? "border-b-2 border-primary bg-card font-semibold text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              onClick={() => setInnerView(tab.value)}
            >
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Inner content - overflow-y-auto for scrollable views, but Graph needs overflow-hidden to give ReactFlow proper height */}
      <div className={cn("flex-1 bg-card", innerView === "graph" ? "overflow-hidden" : "overflow-y-auto")}>
        {innerView === "overview" ? (
          <>
            {overviewError ? (
              <div className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{overviewError}</span>
                <Button variant="ghost" size="sm" onClick={() => setOverviewError("")}>
                  {t("关闭", "Dismiss")}
                </Button>
              </div>
            ) : null}
            {overviewStatus ? (
              <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-sm text-emerald-700">
                {overviewStatus}
              </div>
            ) : null}
          <ProjectOverview
            project={props.project}
            projectStats={props.projectStats}
            documents={props.documents}
            watchedFolders={props.watchedFolders ?? []}
            onOpenKbDrawer={() => void props.onOpenKbDrawer()}
            onAttachExistingFolders={() => void openAttachFoldersDialog()}
            onSwitchToDocuments={() => setInnerView("documents")}
            onSwitchToMcp={() => setInnerView("mcp")}
            onRemoveUploadSource={async (sourceId, name) => {
              if (!props.project || !kbOverview) return;
              const zhPrompt = `删除已上传的 ${name}？该文档将被永久移除。`;
              const enPrompt = `Delete uploaded ${name}? The document will be permanently removed.`;
              if (!confirm(t(zhPrompt, enPrompt))) return;
              try {
                // Resolve the KB project id (same name-as-watched-folder convention).
                const list = await api.listKbProjects();
                const match = list.projects.find((p) => p.name === props.project!.name);
                if (!match) {
                  setOverviewError(t("未找到对应的知识库项目，请刷新后重试。", "Matching KB project not found. Refresh and try again."));
                  return;
                }
                await api.removeKbSource(match.id, sourceId);
                // Refresh inline view so the row disappears immediately.
                await refreshKbOverview();
                setOverviewStatus(t(`已删除已上传文件「${name}」。`, `Uploaded file "${name}" has been deleted.`));
              } catch (err) {
                setOverviewError(getErrorMessage(err));
              }
            }}
            onForceSyncWatchedFolder={async (watchedFolderId, displayName) => {
              setSyncingFolderId(watchedFolderId);
              try {
                const r = await api.syncWatchedFolder(watchedFolderId);
                if (!r.ok) {
                  if (r.status === 409) {
                    alert(t("该文件夹正在同步中，请等待当前同步完成。", "A sync is already running for this folder. Please wait for it to finish."));
                  } else {
                    alert(t(`同步失败：${r.statusText}`, `Sync failed: ${r.statusText}`));
                  }
                  return;
                }
                // Background sync; refresh overview after a short delay so the
                // freshly-added files show up in the cached counts.
                setTimeout(() => { void refreshKbOverview(); }, 2000);
                setTimeout(() => { void refreshKbOverview(); }, 5000);
              } finally {
                // Clear the spinner a bit after the second refresh so the
                // user sees a clear "synced" state.
                setTimeout(() => setSyncingFolderId(null), 6000);
              }
            }}
            onDetachWatchedFolder={async (watchedFolderId, displayName) => {
              if (!props.project) return;
              if (!confirm(t(`从该项目移除挂载「${displayName}」？该文件夹的文档将不再关联此项目。`, `Detach "${displayName}" from this project? The folder's documents will no longer be linked to this project.`))) {
                return;
              }
              setDetachingFolderId(watchedFolderId);
              try {
                await api.detachFoldersFromProject(props.project.id, [watchedFolderId]);
                // Refresh watched-folders + KB overview so the row disappears
                // immediately from this project view.
                await Promise.all([props.onWatchedFoldersRefresh?.(), refreshKbOverview()]);
                setOverviewStatus(t(`已从项目移除挂载「${displayName}」。`, `Detached "${displayName}" from project.`));
              } catch (err) {
                setOverviewError(getErrorMessage(err));
              } finally {
                setDetachingFolderId(null);
              }
            }}
            detachingFolderId={detachingFolderId}
            syncingFolderId={syncingFolderId}
            kbOverview={kbOverview}
            kbLoading={kbLoading}
          />
          </>
        ) : innerView === "documents" ? (
          <ProjectDocumentsWorkspace
            project={props.project}
            documents={props.documents}
            selectedDocumentId={props.selectedDocumentId}
            selectedDocument={props.selectedDocument}
            chunks={props.chunks}
            events={props.events}
            entities={props.entities}
            projectStats={props.projectStats}
            resultView={props.resultView}
            showArchivedDocuments={props.showArchivedDocuments}
            hasActiveUploads={props.hasActiveUploads}
            uploadJobs={props.uploadJobs}
            isUploadQueueExpanded={props.isUploadQueueExpanded}
            searchQuery={props.searchQuery}
            searchMode={props.searchMode}
            searchResult={props.searchResult}
            isSearching={props.isSearching}
            fileInputRef={props.fileInputRef}
            onUploadFiles={props.onUploadFiles}
            onToggleUploadQueue={props.onToggleUploadQueue}
            onSelectDocument={props.onSelectDocument}
            onRenameDocument={props.onRenameDocument}
            onArchiveOrRestoreDocument={props.onArchiveOrRestoreDocument}
            onDeleteDocument={props.onDeleteDocument}
            onSetResultView={props.onSetResultView}
            onToggleArchivedDocuments={props.onToggleArchivedDocuments}
            onSearchQueryChange={props.onSearchQueryChange}
            onSearchModeChange={props.onSearchModeChange}
            onSearch={props.onSearch}
            onOpenEvent={props.onOpenEvent}
            onOpenEntity={props.onOpenEntity}
          />
        ) : innerView === "graph" ? (
          <ProjectGraphWorkspace
            project={props.project}
            graph={props.projectGraph}
            onOpenEvent={props.onOpenEvent}
            onOpenEntity={props.onOpenEntity}
          />
        ) : innerView === "mcp" ? (
          <ProjectMcpWorkspace
            project={props.project}
            settings={props.mcpSettings}
          />
        ) : null}
      </div>
      {attachDialogOpen && props.project ? (
        <AttachExistingFoldersDialog
          project={props.project}
          watchedFolders={props.watchedFolders ?? []}
          existingSourceIds={new Set((kbOverview?.sources ?? []).filter((s) => s.sourceType === "folder").map((s) => s.folderPath ?? ""))}
          onClose={() => setAttachDialogOpen(false)}
          onAttached={async () => {
            setAttachDialogOpen(false);
            // The new sources-model attach rewrites watched_folders.source_id.
            // Reload the watched-folders list so the UI reflects the change
            // immediately. KB overview reload is also requested for
            // backwards compatibility (it's a separate, stale UI surface).
            await Promise.all([
              props.onWatchedFoldersRefresh?.(),
              props.onKbRefresh?.()
            ]);
          }}
        />
      ) : null}
    </div>
  );
}

function AttachExistingFoldersDialog(props: {
  project: SourceRecord;
  watchedFolders: WatchedFolderListItem[];
  existingSourceIds: Set<string>;
  onClose: () => void;
  onAttached: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Show folders that AREN'T already attached to this project. A folder is
  // "already attached" means the folder's sourceId in `watched_folders` is
  // already pointing at this project (the new sources-model attach flow).
  // The old KB model `kbOverview` is kept in props.existingSourceIds only
  // for status display, but does NOT control which folders can be attached
  // — KB model is a separate, soon-to-be-deprecated UI surface.
  const candidates = useMemo(() => {
    return (props.watchedFolders ?? [])
      .filter((f) => f && f.id && f.displayName && f.path)
      .filter((f) => f.sourceId !== props.project.id)
      .filter((f) => f.enabled !== false);
  }, [props.watchedFolders, props.project.id]);

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (selectedIds.size === 0) {
      setError(t("请选择至少一个文件夹", "Please select at least one folder"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await api.attachFoldersToProject(props.project.id, [...selectedIds]);
      await props.onAttached();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold">📁 {t("挂载已有文件夹", "Attach existing folders")}</div>
            <div className="text-xs text-muted-foreground">
              {t("把已监听的文件夹聚合到", "Aggregate existing watched folders into")}「{props.project.name}」
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={props.onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto px-4 py-3">
          {candidates.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t("暂无可挂载的文件夹（所有监听文件夹已在该项目下）", "No folders available — all watched folders are already attached to this project.")}
            </div>
          ) : (
            <div className="space-y-1.5">
              {candidates.map((f) => {
                const checked = selectedIds.has(f.id);
                return (
                  <label
                    key={f.id}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                      checked ? "border-blue-500 bg-blue-50" : "border-border hover:bg-muted/50"
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={checked}
                      onChange={() => toggle(f.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{f.displayName}</div>
                      <div className="text-xs text-muted-foreground truncate font-mono">{f.path}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t("关联数据源", "Bound source")}: {(f.sourceId ?? "").slice(0, 8)}…
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {error ? (
          <div className="px-4 py-2 text-xs text-red-600">{error}</div>
        ) : null}
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <div className="text-xs text-muted-foreground">
            {t("已选", "Selected")}: {selectedIds.size}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={props.onClose}>{t("取消", "Cancel")}</Button>
            <Button size="sm" disabled={submitting || selectedIds.size === 0} onClick={() => void submit()}>
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {t("挂载", "Attach")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectOverview(props: {
  project: SourceRecord;
  projectStats: ProjectStatsRecord | null;
  documents: DocumentRecord[];
  watchedFolders?: WatchedFolderListItem[];
  onOpenKbDrawer: () => void;
  onAttachExistingFolders?: () => void;
  onSwitchToDocuments: () => void;
  onSwitchToMcp: () => void;
  onRemoveUploadSource?: (sourceId: string, name: string) => void | Promise<void>;
  onForceSyncWatchedFolder?: (watchedFolderId: string, displayName: string) => void | Promise<void>;
  onDetachWatchedFolder?: (watchedFolderId: string, displayName: string) => void | Promise<void>;
  detachingFolderId?: string | null;
  syncingFolderId?: string | null;
  kbOverview: {
    sources: Array<{
      id: string; name: string; sourceType: "folder" | "upload";
      folderPath?: string; folderDisplayName?: string; watchedFolderId?: string | null;
      fileName?: string | null; fileSize?: number | null; fileExtension?: string | null;
      enabled: boolean; createdAt?: string;
    }>;
    cachedDocumentsCount: number;
    cachedChunksCount: number;
    cachedEntitiesCount: number;
    cachedUploadDocumentsCount: number;
    cachedUploadChunksCount: number;
    cachedUploadEntitiesCount: number;
    cachedUpdatedAt: string | null;
  } | null;
  kbLoading: boolean;
}) {
  const { t } = useI18n();
  const recentDocs = props.documents.slice(0, 5);
  // Sources-model view: which watched folders are currently bound to THIS
  // project. The KB drawer shows the same data via `kbOverview`, but we now
  // prefer the watched_folders table so the overview reflects attach/detach
  // changes immediately (KB model lags or is stale for this purpose).
  const watchedFolderSources = (props.watchedFolders ?? [])
    .filter((wf) => wf.sourceId === props.project.id && wf.enabled !== false)
    .map((wf) => ({
      id: wf.id,
      name: wf.displayName,
      sourceType: "folder" as const,
      folderPath: wf.path,
      folderDisplayName: wf.displayName,
      watchedFolderId: wf.id,
      enabled: true,
      createdAt: wf.createdAt
    }));
  const folderSources =
    watchedFolderSources.length > 0
      ? watchedFolderSources
      : (props.kbOverview?.sources.filter((s) => s.sourceType === "folder") ?? []);
  const uploadSources = props.kbOverview?.sources.filter((s) => s.sourceType === "upload") ?? [];
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      {/* 快速统计 */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard icon="📄" label={t("文档", "Documents")} value={props.projectStats?.documentCount ?? 0} />
        <StatCard icon="🧩" label={t("块", "Chunks")} value={props.projectStats?.chunkCount ?? 0} />
        <StatCard icon="⚡" label={t("事件", "Events")} value={props.projectStats?.eventCount ?? 0} />
        <StatCard icon="🏷️" label={t("实体", "Entities")} value={props.projectStats?.entityCount ?? 0} />
      </div>

      {/* KB Sources - watched folders only */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold">📁 {t("监听文件夹", "Watched Folders")}</div>
            <div className="text-xs text-muted-foreground">{t("由 watcher 自动同步；新文件计入顶部 Documents 总数", "Auto-synced by watcher; new files flow into the top Documents total")}</div>
          </div>
          <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={props.onAttachExistingFolders}>
            {t("挂载已有文件夹", "Attach existing")}
          </Button>
          <Button variant="default" size="sm" onClick={props.onOpenKbDrawer}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("挂载文件夹", "Mount folder")}
          </Button>
        </div>
        </div>
        {props.kbLoading && !props.kbOverview ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
            {t("加载中…", "Loading…")}
          </div>
        ) : folderSources.length > 0 ? (
          <>
            <div className="divide-y divide-border">
              {folderSources.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-base">📁</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.folderDisplayName ?? s.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.folderPath ?? s.name} · folder · {s.enabled ? "启用" : "停用"}
                    </div>
                  </div>
                  {props.onForceSyncWatchedFolder && s.watchedFolderId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-600"
                      title={t("立即同步", "Sync now")}
                      disabled={props.syncingFolderId === s.watchedFolderId}
                      onClick={() => void props.onForceSyncWatchedFolder!(s.watchedFolderId!, s.folderDisplayName ?? s.name)}
                    >
                      {props.syncingFolderId === s.watchedFolderId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "⟳"
                      )}
                    </Button>
                  ) : null}
                  {props.onDetachWatchedFolder && s.watchedFolderId ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                      title={t("取消挂载", "Detach from project")}
                      disabled={props.detachingFolderId === s.watchedFolderId}
                      onClick={() => void props.onDetachWatchedFolder!(s.watchedFolderId!, s.folderDisplayName ?? s.name)}
                    >
                      {props.detachingFolderId === s.watchedFolderId ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "×"
                      )}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="p-6 text-center">
            <div className="mb-2 text-3xl">📁</div>
            <div className="text-sm text-muted-foreground mb-3">{t("尚未挂载任何监听文件夹", "No watched folders attached yet")}</div>
            <Button variant="secondary" size="sm" onClick={props.onOpenKbDrawer}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t("挂载第一个文件夹", "Mount first folder")}
            </Button>
          </div>
        )}
      </div>

      {/* Uploaded files - independent section */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold">📎 {t("已上传文件", "Uploaded Files")}</div>
            <div className="text-xs text-muted-foreground">{t("用户手动上传的文档；计入顶部 Documents 总数", "User-uploaded documents; counted in the top Documents total")}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={props.onOpenKbDrawer}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t("上传文件", "Upload")}
          </Button>
        </div>
        {props.kbLoading && !props.kbOverview ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
            {t("加载中…", "Loading…")}
          </div>
        ) : uploadSources.length > 0 ? (
          <>
            <div className="px-4 py-1.5 text-[10px] text-muted-foreground border-b border-border bg-muted/20">
              📦 {t("总大小", "Total size")}: <span className="font-semibold text-foreground tabular-nums">{formatBytes(uploadSources.reduce((sum, s) => sum + (s.fileSize ?? 0), 0))}</span>
            </div>
            <div className="divide-y divide-border">
              {uploadSources.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-base">📄</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{s.fileName ?? s.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.fileExtension ?? ""}{s.fileSize !== null && s.fileSize !== undefined ? ` · ${formatBytes(s.fileSize)}` : ""}{s.createdAt ? ` · ${t("上传于", "Uploaded")} ${new Date(s.createdAt).toISOString().slice(0, 10)}` : ""}
                    </div>
                  </div>
                  {props.onRemoveUploadSource ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-red-600"
                      title={t("删除", "Delete")}
                      onClick={() => void props.onRemoveUploadSource!(s.id, s.fileName ?? s.name)}
                    >
                      ×
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="p-6 text-center">
            <div className="mb-2 text-3xl">📄</div>
            <div className="text-sm text-muted-foreground">{t("尚未上传任何文件", "No files uploaded yet")}</div>
          </div>
        )}
      </div>

      {/* MCP 入口 */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <div className="text-sm font-semibold">🔌 MCP Server (for Trae)</div>
            <div className="text-xs text-muted-foreground">{t("一键接入 Trae，让 AI 直接搜索此项目", "One-click integration with Trae for AI to search this project")}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={props.onSwitchToMcp}>
            {t("查看配置 →", "View config →")}
          </Button>
        </div>
        <div className="px-4 py-3">
          <div className="mb-3 grid gap-1 text-xs text-muted-foreground">
            <div>
              <span className="text-foreground/70">{t("SAG Web 界面", "SAG Web UI")}:</span>{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">{window.location.origin}</code>
            </div>
            <div>
              <span className="text-foreground/70">{t("MCP HTTP 端口", "MCP HTTP port")}:</span>{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-foreground">4174</code>
            </div>
          </div>
          <pre className="rounded-md bg-zinc-900 text-zinc-100 p-3 text-xs overflow-x-auto font-mono leading-relaxed">
{`{
  "mcpServers": {
    "${props.project.name}": {
      "command": "INSTALL_DIR\\\\黑洞-mcp.exe",
      "args": [],
      "env": {
        "DEFAULT_TENANT_ID": "default",
        "SAG_MCP_SOURCE_ID": "${props.project.id}"
      }
    }
  }
}`}
          </pre>
        </div>
      </div>

      {/* 最近文档 */}
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="text-sm font-semibold">📄 {t("最近文档", "Recent documents")}</div>
          <Button variant="secondary" size="sm" onClick={props.onSwitchToDocuments}>
            {t("查看全部 →", "View all →")}
          </Button>
        </div>
        {recentDocs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t("暂无文档", "No documents yet")}</div>
        ) : (
          <div className="divide-y divide-border">
            {recentDocs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{d.title || (d.metadata as Record<string, unknown>)?.fileName as string || d.id.slice(0, 8)}</div>
                  <div className="text-xs text-muted-foreground truncate">{String((d.metadata as Record<string, unknown>)?.fileName ?? d.id)} · {new Date(d.createdAt).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard(props: { icon: string; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-2xl">{props.icon}</div>
      <div className="mt-1 text-2xl font-semibold">{props.value}</div>
      <div className="text-xs text-muted-foreground">{props.label}</div>
    </div>
  );
}


