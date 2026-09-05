import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRetryStatus } from "../../hooks/useRetryStatus";
import { ToastStack } from "../../components/ui/toast";
import {
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Database,
  Folder,
  FolderInput,
  Loader2,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  XCircle
} from "lucide-react";
import { useI18n } from "../../i18n";
import { api, type ConnectionProbe } from "../../lib/api";
import { cn, formatDate, shortId } from "../../lib/utils";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Pagination, ProgressBar } from "../../components/ui/pagination";
import { Textarea } from "../../components/ui/textarea";
import type {
  FileManifestRecord,
  FiletypeFilter,
  QueueProgress,
  SyncRunRecord,
  WatchedFolderListItem,
  WatchedFolderRecord,
  WatcherHealth
} from "../../types";

// === View types ===
type WorkspaceSubView = "list" | "new" | "details";
type DetailsTab = "overview" | "manifest" | "runs";

type FolderCreateDraft = {
  path: string;
  displayName: string;
  recursive: boolean;
  whitelist: string;
  blacklist: string;
  maxBytes: string;
};

const EMPTY_DRAFT: FolderCreateDraft = {
  path: "",
  displayName: "",
  recursive: true,
  whitelist: "",
  blacklist: "",
  maxBytes: ""
};

// === Helpers ===
function parseExtensionsInput(input: string): string[] {
  return input
    .split(/[\s,;]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
}

function parseMaxBytesInput(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function buildFiletypeFilter(draft: FolderCreateDraft): FiletypeFilter | undefined {
  const whitelist = parseExtensionsInput(draft.whitelist);
  const blacklist = parseExtensionsInput(draft.blacklist);
  const maxBytes = parseMaxBytesInput(draft.maxBytes);
  if (whitelist.length === 0 && blacklist.length === 0 && maxBytes == null) {
    return undefined;
  }
  const filter: FiletypeFilter = {};
  if (whitelist.length > 0) filter.whitelist = whitelist;
  if (blacklist.length > 0) filter.blacklist = blacklist;
  if (maxBytes != null) filter.maxBytes = maxBytes;
  return filter;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format a single-file ingest duration in milliseconds. The column is
 * used to spot slow file types — at 5s+ the value jumps to "5.0s" and
 * at 60s+ we cross to "1m 5s" so the cell never gets unwieldy. Null
 * (rows that haven't been ingested since migration 011) renders as
 * "—" to match the rest of the manifest table.
 */
function formatSyncDuration(durationMs: number | null | undefined): string {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function manifestStatusLabel(
  status: FileManifestRecord["status"],
  t: (zh: string, en: string) => string
): string {
  if (status === "pending") return t("待同步", "Pending");
  if (status === "syncing") return t("同步中", "Syncing");
  if (status === "synced") return t("已同步", "Synced");
  // "partial" means the file was ingested but at least one chunk's
  // event extraction failed. The document is still searchable; surface
  // it as an amber "partial" badge so it doesn't look like a failed or
  // deleted row.
  if (status === "partial") return t("部分失败", "Partial success");
  if (status === "failed") return t("失败", "Failed");
  return t("已删除", "Deleted");
}

function manifestStatusClassName(status: FileManifestRecord["status"]): string {
  if (status === "synced") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "syncing" || status === "pending")
    return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "partial")
    return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-border bg-muted text-muted-foreground";
}

function runStatusLabel(
  status: SyncRunRecord["status"],
  t: (zh: string, en: string) => string
): string {
  if (status === "running") return t("运行中", "Running");
  if (status === "completed") return t("完成", "Completed");
  // "completed_with_errors" sits between green and red — the scan ran
  // fine but some files failed, so we use amber to signal "look here"
  // without panicking the user.
  if (status === "completed_with_errors") return t("部分失败", "Completed with errors");
  return t("失败", "Failed");
}

function runStatusClassName(status: SyncRunRecord["status"]): string {
  if (status === "running") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "completed_with_errors")
    return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-red-200 bg-red-50 text-red-700";
}

function triggerLabel(
  trigger: SyncRunRecord["trigger"],
  t: (zh: string, en: string) => string
): string {
  if (trigger === "manual") return t("手动", "Manual");
  if (trigger === "scan") return t("扫描", "Scan");
  if (trigger === "event") return t("事件", "Event");
  return t("启动", "Startup");
}

// === Top-level workspace (state machine) ===
export function WatchedFoldersWorkspace(props: {
  selectedWatchedId?: string | null;
  openInNewMode?: boolean;
  sourceId?: string;
  onBack?: () => void;
  onFoldersChanged?: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<WorkspaceSubView>(props.openInNewMode ? "new" : "list");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // When parent tells us to open a specific folder, do it
  useEffect(() => {
    if (props.selectedWatchedId) {
      setSelectedFolderId(props.selectedWatchedId);
      setView("details");
    }
  }, [props.selectedWatchedId]);
  // Bumped after mutations so child lists refetch.
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
    props.onFoldersChanged?.();
  }, [props.onFoldersChanged]);

  function openDetails(folderId: string) {
    setSelectedFolderId(folderId);
    setView("details");
  }

  function backToList() {
    setSelectedFolderId(null);
    setView("list");
    props.onBack?.();
  }

  if (view === "new") {
    return (
      <NewWatchedFolderWizard
        onCancel={backToList}
        onCreated={(folder) => {
          reload();
          openDetails(folder.id);
        }}
      />
    );
  }

  if (view === "details" && selectedFolderId) {
    return (
      <WatchedFolderDetails
        key={selectedFolderId}
        folderId={selectedFolderId}
        reloadToken={reloadToken}
        onBack={backToList}
        onChanged={reload}
      />
    );
  }

  return (
    <WatchedFoldersList
      key={`list-${reloadToken}`}
      reloadToken={reloadToken}
      onCreate={() => setView("new")}
      onOpenDetails={openDetails}
      onChanged={reload}
    />
  );
}

/**
 * Inline result of the most recent "Test connection" probe. Shows
 * green / red with one-line summary so the user knows whether the
 * configured embedding endpoint is reachable BEFORE they hit "New
 * watcher". The full error stays in a tooltip so the row stays
 * compact.
 */
function ConnectionBadge({ probe }: { probe: ConnectionProbe }) {
  const { t } = useI18n();
  if (probe.ok) {
    const title = `${probe.provider} · ${probe.baseUrl}\nmodel: ${probe.model}\nlatency: ${probe.latencyMs} ms`;
    return (
      <Badge
        className="mt-1.5 border-emerald-200 bg-emerald-50 text-emerald-700"
        title={title}
      >
        <CheckCircle2 className="mr-1 h-3 w-3" />
        {t("连接正常", "Connection OK")} · {probe.latencyMs} ms
      </Badge>
    );
  }
  const title = probe.error
    ? `${probe.baseUrl}\n${probe.httpStatus ? `HTTP ${probe.httpStatus}\n` : ""}${probe.error}`
    : probe.baseUrl;
  return (
    <Badge
      className="mt-1.5 border-red-200 bg-red-50 text-red-700"
      title={title}
    >
      <XCircle className="mr-1 h-3 w-3" />
      {probe.httpStatus ? `HTTP ${probe.httpStatus}` : t("连接失败", "Connection failed")}
      {probe.error ? ` · ${truncateForBadge(probe.error)}` : ""}
    </Badge>
  );
}

/**
 * Compact an error string so it fits on the badge without breaking the
 * top bar layout. We keep the first line / 60 chars, whichever is
 * shorter.
 */
function truncateForBadge(input: string, maxLen = 60): string {
  const firstLine = input.split(/[\n\r]/)[0] ?? input;
  if (firstLine.length <= maxLen) return firstLine;
  return `${firstLine.slice(0, maxLen - 1)}…`;
}

// === List view ===
function WatchedFoldersList(props: {
  reloadToken: number;
  onCreate: () => void;
  onOpenDetails: (folderId: string) => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [folders, setFolders] = useState<WatchedFolderListItem[] | null>(null);
  const [error, setError] = useState("");
  const [busyFolderId, setBusyFolderId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  // "Test connection" probe state. `null` = never run; `undefined` while
  // a probe is in flight. Otherwise the structured result from
  // `/api/test-connection`.
  const [probe, setProbe] = useState<{ state: "running" } | { state: "done"; result: ConnectionProbe } | null>(null);
  // "合并数据" feature: probe state + the actual merge run state.
  // The probe is fetched when the dialog opens; the merge is launched by
  // clicking the primary button in the dialog.
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  type MergeReadyState =
    | { status: "loading" }
    | { status: "ready"; dbPath: string }
    | { status: "missing"; dbPath: string; reason: string };
  const [mergeReady, setMergeReady] = useState<MergeReadyState | null>(null);
  const [mergeRunning, setMergeRunning] = useState(false);
  const [mergeResult, setMergeResult] = useState<null | {
    folderId: string;
    newSourceId: string;
    documents: { inserted: number; updated: number; skipped: number };
    chunks: number;
    events: number;
    entities: number;
    eventEntities: number;
  }>(null);
  const [mergeError, setMergeError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setError("");
        const response = await api.listWatchedFolders();
        if (!cancelled) {
          setFolders(response.folders);
        }
      } catch (err) {
        if (!cancelled) {
          setFolders([]);
          setError(getErrorMessage(err));
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.reloadToken]);

  const filtered = useMemo(() => {
    if (!folders) return [];
    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return folders;
    return folders.filter(
      (folder) =>
        folder.displayName.toLowerCase().includes(normalized) ||
        folder.path.toLowerCase().includes(normalized)
    );
  }, [folders, keyword]);

  async function refresh() {
    try {
      setError("");
      const response = await api.listWatchedFolders();
      setFolders(response.folders);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleTestConnection() {
    try {
      setError("");
      setProbe({ state: "running" });
      const result = await api.testConnection();
      setProbe({ state: "done", result });
    } catch (err) {
      setError(getErrorMessage(err));
      setProbe(null);
    }
  }

  async function openMergeDialog() {
    setMergeDialogOpen(true);
    setMergeError("");
    setMergeResult(null);
    setMergeReady({ status: "loading" });
    try {
      const status = await api.getMergeDataReady();
      if (status.ready) {
        setMergeReady({ status: "ready", dbPath: status.dbPath });
      } else {
        setMergeReady({ status: "missing", dbPath: status.dbPath, reason: status.reason ?? "" });
      }
    } catch (err) {
      setMergeReady({ status: "missing", dbPath: "", reason: getErrorMessage(err) });
    }
  }

  function closeMergeDialog() {
    if (mergeRunning) return;
    setMergeDialogOpen(false);
  }

  async function confirmMergeData() {
    if (!mergeReady || mergeReady.status !== "ready") return;
    try {
      setMergeRunning(true);
      setMergeError("");
      const response = await api.mergeDataFolder({});
      setMergeResult(response.result);
      props.onChanged();
      void refresh();
    } catch (err) {
      setMergeError(getErrorMessage(err));
    } finally {
      setMergeRunning(false);
    }
  }

  async function handleSync(folder: WatchedFolderListItem) {
    if (!folder.enabled) {
      setError(t("已禁用的文件夹无法触发同步，请先启用。", "Disabled folders cannot trigger sync. Enable the folder first."));
      return;
    }
    try {
      setError("");
      setBusyFolderId(folder.id);
      await api.triggerFolderSync(folder.id);
      props.onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyFolderId(null);
    }
  }

  async function handleToggleEnabled(folder: WatchedFolderListItem) {
    try {
      setError("");
      setBusyFolderId(folder.id);
      if (folder.enabled) {
        await api.pauseWatchedFolder(folder.id);
      } else {
        await api.resumeWatchedFolder(folder.id);
      }
      props.onChanged();
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyFolderId(null);
    }
  }

  async function handleDelete(folder: WatchedFolderListItem) {
    const confirmed = window.confirm(t(
      `永久删除监听文件夹「${folder.displayName}」？\n\n这会停止监听器并级联删除对应的文件清单与同步历史（已生成的文档不会被删除）。`,
      `Permanently delete watched folder "${folder.displayName}"?\n\nThis stops the watcher and cascade-deletes the file manifest and sync history. Already ingested documents are not deleted.`
    ));
    if (!confirmed) return;
    try {
      setError("");
      setBusyFolderId(folder.id);
      await api.deleteWatchedFolder(folder.id);
      props.onChanged();
      await refresh();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyFolderId(null);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:flex-nowrap md:items-center md:px-6">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{t("监听文件夹", "Watched folders")}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {t("把本地目录加入监听后，新增或修改的文件会自动同步到 SAG。", "Add a local folder to watch. New or modified files are synced to SAG automatically.")}
          </p>
          {probe?.state === "done" ? <ConnectionBadge probe={probe.result} /> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={folders == null}>
            <RefreshCw className="h-4 w-4" />
            {t("刷新", "Refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleTestConnection()}
            disabled={probe?.state === "running"}
            title={t("测一次 embedding API 连通性（不会写入数据库）", "Probe the embedding API once (no side effects)")}
          >
            {probe?.state === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
            {t("测试连接", "Test connection")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openMergeDialog()}
            title={t(
              "把黑洞.exe 同级目录下的「合并数据」文件夹里的内容合并到 SAG，并开始监听该文件夹。",
              "Merge the data in the 「合并数据」 folder next to 黑洞.exe into SAG and start watching it."
            )}
          >
            <Database className="h-4 w-4" />
            {t("合并数据", "Merge data")}
          </Button>
          <Button size="sm" onClick={props.onCreate}>
            <Plus className="h-4 w-4" />
            {t("新建监听", "New watcher")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 md:px-6">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin md:p-6">
        <div className="mx-auto grid max-w-6xl gap-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={t("按名称或路径搜索", "Search by name or path")}
              />
            </div>
            <Badge>{folders ? `${filtered.length} / ${folders.length}` : "…"}</Badge>
          </div>

          {folders == null ? (
            <Card>
              <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("正在加载监听文件夹...", "Loading watched folders...")}
              </CardContent>
            </Card>
          ) : folders.length === 0 ? (
            <EmptyState
              title={t("还没有监听文件夹", "No watched folders yet")}
              description={t("点击「新建监听」开始配置本地目录。", 'Click "New watcher" to start configuring a local folder.')}
            />
          ) : filtered.length === 0 ? (
            <EmptyLine text={t("没有匹配项。", "No matches.")} />
          ) : (
            <div className="space-y-2">
              {filtered.map((folder) => (
                <WatchedFolderRow
                  key={folder.id}
                  folder={folder}
                  busy={busyFolderId === folder.id}
                  onOpenDetails={() => props.onOpenDetails(folder.id)}
                  onSync={() => void handleSync(folder)}
                  onToggleEnabled={() => void handleToggleEnabled(folder)}
                  onDelete={() => void handleDelete(folder)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {mergeDialogOpen ? (
        <MergeDataDialog
          ready={mergeReady}
          running={mergeRunning}
          result={mergeResult}
          error={mergeError}
          onCancel={closeMergeDialog}
          onConfirm={() => void confirmMergeData()}
        />
      ) : null}
    </section>
  );
}

function WatchedFolderRow(props: {
  folder: WatchedFolderListItem;
  busy: boolean;
  onOpenDetails: () => void;
  onSync: () => void;
  onToggleEnabled: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const folder = props.folder;
  const watcherRunning = Boolean((folder as { watcherRunning?: boolean }).watcherRunning);
  const lastRunStats = (folder as { lastRunStats?: { added: number; updated: number; deleted: number; failed: number } })
    .lastRunStats;
  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            onClick={props.onOpenDetails}
          >
            <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{folder.displayName}</span>
              <span className="mt-0.5 block break-all text-xs text-muted-foreground">{folder.path}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {folder.recursive ? t("递归监听", "Recursive") : t("仅顶层", "Top-level only")}
                {" · "}
                {shortId(folder.id)}
              </span>
            </span>
          </button>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Badge className={folder.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-muted text-muted-foreground"}>
              {folder.enabled ? t("启用", "Enabled") : t("已暂停", "Paused")}
            </Badge>
            <Badge className={watcherRunning ? "border-blue-200 bg-blue-50 text-blue-700" : "border-border bg-muted text-muted-foreground"}>
              {watcherRunning ? t("运行中", "Running") : t("未运行", "Stopped")}
            </Badge>
            {folder.lastRunStatus ? (
              <Badge className={runStatusClassName(folder.lastRunStatus)}>
                {runStatusLabel(folder.lastRunStatus, t)}
              </Badge>
            ) : (
              <Badge className="border-border bg-muted text-muted-foreground">{t("无运行", "No run")}</Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label={t("最后扫描", "Last scan")} value={folder.lastScanAt ? formatDate(folder.lastScanAt) : t("从未", "Never")} />
          <Metric label={t("最后同步", "Last run")} value={folder.lastRunAt ? formatDate(folder.lastRunAt) : t("从未", "Never")} />
          <Metric
            label={t("累计同步", "Synced")}
            value={`${folder.totalFilesSynced ?? 0}`}
          />
          <Metric
            label={t("最近结果", "Last run stats")}
            value={
              lastRunStats
                ? t(`+${lastRunStats.added} / ~${lastRunStats.updated} / -${lastRunStats.deleted}`, `+${lastRunStats.added} / ~${lastRunStats.updated} / -${lastRunStats.deleted}`)
                : t("—", "—")
            }
          />
        </div>

        {folder.lastError ? (
          <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{folder.lastError}</div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={props.onOpenDetails}>
            <ChevronRight className="h-4 w-4" />
            {t("详情", "Details")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onSync} disabled={props.busy || !folder.enabled}>
            {props.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("立即同步", "Sync now")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onToggleEnabled} disabled={props.busy}>
            {folder.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {folder.enabled ? t("暂停", "Pause") : t("启用", "Resume")}
          </Button>
          <Button variant="outline" size="sm" onClick={props.onDelete} disabled={props.busy}>
            <Trash2 className="h-4 w-4" />
            {t("删除", "Delete")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Modal that shows the user where the merge dump will be read from,
 * confirms the user wants to import + start watching the folder, and
 * reports a per-table summary when the run finishes.
 */
function MergeDataDialog(props: {
  ready: { status: "loading" } | { status: "ready"; dbPath: string } | { status: "missing"; dbPath: string; reason: string } | null;
  running: boolean;
  result: null | {
    folderId: string;
    newSourceId: string;
    documents: { inserted: number; updated: number; skipped: number };
    chunks: number;
    events: number;
    entities: number;
    eventEntities: number;
  };
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const ready = props.ready;
  const canConfirm = ready?.status === "ready" && !props.running && !props.result;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-md border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold">
            {t("合并数据", "Merge data folder")}
          </h3>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={props.onCancel}
            disabled={props.running}
            title={t("关闭", "Close")}
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <p className="text-foreground">
            {t(
              "把黑洞.exe 同级目录下的「合并数据/data/sag.db」合并到 SAG 本体数据库，并在合并完成后自动开始监听该文件夹；以后该目录下的文件变更也会同步进来。",
              "Merge the sag.db in `<黑洞.exe dir>\\合并数据\\data\\` into SAG's main database, then start watching that folder. After the merge, any future file changes in that folder will sync in automatically."
            )}
          </p>

          {ready == null || ready.status === "loading" ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("正在探测黑洞.exe 同级目录…", "Checking the directory next to 黑洞.exe…")}
            </div>
          ) : null}

          {ready?.status === "ready" ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-700">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                {t("找到合并数据", "Found merge data")}
              </div>
              <div className="mt-1 break-all text-xs text-emerald-700/90">
                {ready.dbPath}
              </div>
            </div>
          ) : null}

          {ready?.status === "missing" ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">
              <div className="flex items-center gap-2 font-medium">
                <XCircle className="h-4 w-4" />
                {t("没有找到合并数据", "No merge data found")}
              </div>
              <div className="mt-1 break-all text-xs">
                {ready.reason ? `${t("原因", "Reason")}: ${ready.reason}\n` : ""}
                {ready.dbPath}
              </div>
            </div>
          ) : null}

          {props.result ? (
            <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <div className="font-medium">
                {t("合并完成", "Merge finished")}
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>
                  {t("文档", "Documents")}: {props.result.documents.inserted} {t("新增", "inserted")} ·{" "}
                  {props.result.documents.updated} {t("覆盖", "updated")} ·{" "}
                  {props.result.documents.skipped} {t("跳过", "skipped")}
                </li>
                <li>
                  {t("切片", "Chunks")}: {props.result.chunks} · {t("事件", "Events")}:{" "}
                  {props.result.events} · {t("实体", "Entities")}: {props.result.entities}
                </li>
                <li>
                  {t("事件-实体关联", "Event-entity links")}: {props.result.eventEntities}
                </li>
              </ul>
              <div className="mt-2 break-all text-[11px] text-emerald-700/80">
                {t("新源 ID", "New source id")}: {props.result.newSourceId}
              </div>
            </div>
          ) : null}

          {props.error ? (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {props.error}
            </div>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 px-4 py-3">
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.running}>
            {props.result ? t("关闭", "Close") : t("取消", "Cancel")}
          </Button>
          <Button
            size="sm"
            onClick={props.onConfirm}
            disabled={!canConfirm}
          >
            {props.running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FolderInput className="h-4 w-4" />
            )}
            {t("开始合并", "Merge & watch")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// === Wizard (4 steps) ===
function NewWatchedFolderWizard(props: {
  onCancel: () => void;
  onCreated: (folder: WatchedFolderRecord) => void;
  sourceId?: string;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [draft, setDraft] = useState<FolderCreateDraft>(EMPTY_DRAFT);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function updateDraft<K extends keyof FolderCreateDraft>(key: K, value: FolderCreateDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const trimmedPath = draft.path.trim();
  const canProceedStep1 = trimmedPath.length > 0;
  const filetypeFilter = useMemo(() => buildFiletypeFilter(draft), [draft]);

  async function submit() {
    if (!canProceedStep1) return;
    try {
      setError("");
      setSubmitting(true);
      setStep(4);
      const response = await api.createWatchedFolder({
        path: trimmedPath,
        displayName: draft.displayName.trim() || undefined,
        recursive: draft.recursive,
        ...(filetypeFilter ? { filetypeFilter } : {}),
        ...(props.sourceId ? { sourceId: props.sourceId } : {})
      });
      props.onCreated(response.folder);
    } catch (err) {
      setError(getErrorMessage(err));
      setStep(3);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={props.onCancel} disabled={submitting} className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{t("新建监听文件夹", "New watched folder")}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {t("第", "Step")} {step} / 4 · {wizardStepLabel(step, t)}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 md:px-6">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin md:p-6">
        <div className="mx-auto grid max-w-2xl gap-4">
          <Card>
            <CardContent className="space-y-4 p-4">
              {step === 1 ? (
                <StepPath draft={draft} onChange={updateDraft} />
              ) : step === 2 ? (
                <StepFilter draft={draft} onChange={updateDraft} />
              ) : step === 3 ? (
                <StepConfirm draft={draft} filetypeFilter={filetypeFilter} />
              ) : (
                <StepSubmitting />
              )}
            </CardContent>
          </Card>

          {step !== 4 ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {[1, 2, 3].map((indicator) => (
                  <span
                    key={indicator}
                    className={cn(
                      "h-1.5 w-6 rounded-full",
                      indicator <= step ? "bg-primary" : "bg-muted"
                    )}
                  />
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={submitting}>
                  {t("取消", "Cancel")}
                </Button>
                {step > 1 ? (
                  <Button variant="outline" size="sm" onClick={() => setStep((step - 1) as 1 | 2)} disabled={submitting}>
                    <ChevronLeft className="h-4 w-4" />
                    {t("上一步", "Back")}
                  </Button>
                ) : null}
                {step < 3 ? (
                  <Button
                    size="sm"
                    onClick={() => setStep((step + 1) as 2 | 3)}
                    disabled={step === 1 && !canProceedStep1}
                  >
                    {t("下一步", "Next")}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void submit()} disabled={submitting || !canProceedStep1}>
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {t("启动监听", "Start watcher")}
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function wizardStepLabel(
  step: number,
  t: (zh: string, en: string) => string
): string {
  if (step === 1) return t("路径", "Path");
  if (step === 2) return t("过滤规则", "Filter");
  if (step === 3) return t("确认", "Confirm");
  return t("启动", "Starting");
}

function StepPath(props: {
  draft: FolderCreateDraft;
  onChange: <K extends keyof FolderCreateDraft>(key: K, value: FolderCreateDraft[K]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <Field label={t("监听路径", "Watched path")}>
        <Input
          autoFocus
          value={props.draft.path}
          onChange={(event) => props.onChange("path", event.target.value)}
          placeholder={t("/absolute/path/to/folder", "/absolute/path/to/folder")}
        />
      </Field>
      <Field label={t("显示名称（可选）", "Display name (optional)")}>
        <Input
          value={props.draft.displayName}
          onChange={(event) => props.onChange("displayName", event.target.value)}
          placeholder={t("如：IT 审计 · 制度文档库", "e.g. IT audit · policy library")}
        />
        <p className="mt-1 text-[11px] text-muted-foreground/80">
          {t("命名参考：审计领域 + 内容类型，如「财务审计 · 凭证扫描件」。留空则用文件夹名。", "Naming tip: audit domain + content type, e.g. \"Finance audit · vouchers\". Defaults to the folder name.")}
        </p>
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={props.draft.recursive}
          onChange={(event) => props.onChange("recursive", event.target.checked)}
        />
        {t("递归监听子目录", "Watch subdirectories recursively")}
      </label>
      <p className="text-xs text-muted-foreground">
        {t("请输入服务器可访问的绝对路径。", "Enter an absolute path accessible to the server.")}
      </p>
    </div>
  );
}

function StepFilter(props: {
  draft: FolderCreateDraft;
  onChange: <K extends keyof FolderCreateDraft>(key: K, value: FolderCreateDraft[K]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <Field label={t("白名单后缀（逗号分隔，留空表示接受全部）", "Whitelist extensions (comma-separated; empty = all)")}>
        <Textarea
          className="min-h-16"
          value={props.draft.whitelist}
          onChange={(event) => props.onChange("whitelist", event.target.value)}
          placeholder=".md, .txt, .pdf"
        />
      </Field>
      <Field label={t("黑名单后缀（永远生效）", "Blacklist extensions (always wins)")}>
        <Textarea
          className="min-h-16"
          value={props.draft.blacklist}
          onChange={(event) => props.onChange("blacklist", event.target.value)}
          placeholder=".tmp, .bak"
        />
      </Field>
      <Field label={t("最大文件大小（字节，留空不限制）", "Max file size in bytes (empty = no limit)")}>
        <Input
          inputMode="numeric"
          value={props.draft.maxBytes}
          onChange={(event) => props.onChange("maxBytes", event.target.value)}
          placeholder="10485760"
        />
      </Field>
    </div>
  );
}

function StepConfirm(props: {
  draft: FolderCreateDraft;
  filetypeFilter: FiletypeFilter | undefined;
}) {
  const { t } = useI18n();
  const whitelist = props.filetypeFilter?.whitelist ?? [];
  const blacklist = props.filetypeFilter?.blacklist ?? [];
  const maxBytes = props.filetypeFilter?.maxBytes;
  // Pre-flight probe state — runs before the user clicks "Start
  // watcher" so we can fail fast on a bad API key or unreachable host.
  const [probe, setProbe] = useState<{ state: "running" } | { state: "done"; result: ConnectionProbe } | null>(null);
  // Reset the probe whenever the wizard is re-entered (path / filter
  // changes are user-initiated; we don't want a stale green check from
  // the last attempt).
  useEffect(() => {
    setProbe(null);
  }, [props.draft.path, props.draft.displayName]);

  async function handleTestConnection() {
    try {
      setProbe({ state: "running" });
      const result = await api.testConnection();
      setProbe({ state: "done", result });
    } catch (err) {
      setProbe({ state: "done", result: {
        ok: false,
        provider: "?",
        baseUrl: "?",
        model: "?",
        dimensions: 0,
        latencyMs: 0,
        error: getErrorMessage(err)
      } });
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <PanelInfo label={t("监听路径", "Path")} value={props.draft.path || "—"} multiline />
      <PanelInfo label={t("显示名称", "Display name")} value={props.draft.displayName || "—"} />
      <PanelInfo label={t("递归", "Recursive")} value={props.draft.recursive ? t("是", "Yes") : t("否", "No")} />
      <PanelInfo
        label={t("白名单", "Whitelist")}
        value={whitelist.length > 0 ? whitelist.join(", ") : t("接受全部", "Accept all")}
      />
      <PanelInfo
        label={t("黑名单", "Blacklist")}
        value={blacklist.length > 0 ? blacklist.join(", ") : t("无", "None")}
      />
      <PanelInfo
        label={t("最大文件", "Max size")}
        value={maxBytes != null ? formatBytes(maxBytes) : t("无限制", "Unlimited")}
      />

      {/* Pre-flight embedding probe. Lets the user catch a bad key /
          unreachable host before they commit to creating + starting a
          watcher that would otherwise fail silently in the background. */}
      <div className="rounded-md border border-border bg-muted/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-xs font-medium text-muted-foreground">
            {t("Embedding 连通性预检", "Embedding pre-flight")}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleTestConnection()}
            disabled={probe?.state === "running"}
          >
            {probe?.state === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            {t("测试连接", "Test connection")}
          </Button>
        </div>
        {probe?.state === "done" ? (
          <div className="mt-2">
            <ConnectionBadge probe={probe.result} />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("点击测试按钮验证当前 embedding 配置可用；通过后再启动监听。", "Click the test button to verify the current embedding configuration is reachable; only then start the watcher.")}
          </p>
        )}
      </div>

      <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        {t("点击「启动监听」后会立即创建并尝试启动监听器；监听路径必须存在且为目录。", 'Click "Start watcher" to create the folder and try to start the watcher immediately. The path must exist and be a directory.')}
      </div>
    </div>
  );
}

function StepSubmitting() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {t("正在创建并启动监听器...", "Creating folder and starting watcher...")}
    </div>
  );
}

// === Details view (3 tabs, 5s polling) ===
function WatchedFolderDetails(props: {
  folderId: string;
  reloadToken: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [folder, setFolder] = useState<WatchedFolderRecord | null>(null);
  const [recentRuns, setRecentRuns] = useState<SyncRunRecord[]>([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<DetailsTab>("overview");
  const [busy, setBusy] = useState(false);

  // Shared per-tab caches (Sprint 4 refactor). The interval at the top of
  // WatchedFolderDetails populates whichever cache is needed for the active
  // tab; switching tabs reads from the cache so the UI is instant.
  //
  // The manifest cache is now paged — we keep all returned rows in
  // memory and re-derive the visible page from (offset, limit) so the
  // Pagination component can show prev/next/jump without re-fetching.
  const [manifest, setManifest] = useState<FileManifestRecord[] | null>(null);
  const [manifestNextCursor, setManifestNextCursor] = useState<string | null>(null);
  const [manifestTotal, setManifestTotal] = useState<number>(0);
  const [manifestOffset, setManifestOffset] = useState<number>(0);
  const [manifestLimit, setManifestLimit] = useState<number>(50);
  // Total across the whole folder (unfiltered). The Retry-All-Failed
  // button surfaces this so the user knows what "retry all" actually
  // means (e.g. "重试 12 个失败文件").
  const [manifestFailedTotal, setManifestFailedTotal] = useState<number>(0);
  // Page chain: when the user advances via "next", we cache the cursor
  // for each visited page so "previous" can walk back without an extra
  // server round-trip. The key is the absolute offset; the value is
  // the cursor that, when applied, returns the NEXT page.
  const manifestCursorChain = useRef<Map<number, string>>(new Map());
  const manifestCacheRef = useRef<{
    status: string;
    limit: number;
    manifest: FileManifestRecord[];
  } | null>(null);
  const [manifestError, setManifestError] = useState("");
  const [manifestStatusFilter, setManifestStatusFilter] = useState<string>("");

  // Live progress bar (sourced from /queue every 1.5s while on the
  // overview tab).
  const [progress, setProgress] = useState<QueueProgress | null>(null);

  const [runs, setRuns] = useState<SyncRunRecord[]>(recentRuns);
  const runsCacheRef = useRef<SyncRunRecord[] | null>(null);
  const [runsError, setRunsError] = useState("");

  // Per-row + bulk retry state lives in its own hook so the rest of
  // the page doesn't have to thread a dozen `inflightRows` setters
  // through every component. See web/src/hooks/useRetryStatus.ts.
  const retryStatus = useRetryStatus();

  const refreshFolder = useCallback(async () => {
    try {
      const response = await api.getWatchedFolder(props.folderId);
      setFolder(response.folder);
      setRecentRuns(response.recentRuns);
      // Seed the runs cache so the runs tab doesn't flash "loading" on first switch.
      if (runsCacheRef.current == null) {
        runsCacheRef.current = response.recentRuns;
        setRuns(response.recentRuns);
      }
      setError("");
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [props.folderId]);

  // Mirror manifestTotal into a ref so refreshManifest can read it
  // without having it as a useCallback dependency (otherwise the
  // callback identity changes every time total updates, which
  // re-runs the polling effect that calls refreshManifest — an
  // infinite loop).
  const manifestTotalRef = useRef<number>(manifestTotal);
  manifestTotalRef.current = manifestTotal;

  const refreshManifest = useCallback(async (status: string) => {
    try {
      // Skip the COUNT(*) on every refresh — it's expensive on SQLite
      // (full table scan) and only needed once per (folderId, status,
      // limit) tuple. Re-fetched manually when the user clicks 立即同步
      // so the "showing X of Y" widget stays correct after a sync run.
      const wantTotal = manifestTotalRef.current === 0;
      const response = await api.getWatchedFolderManifest(props.folderId, {
        status: status || undefined,
        limit: manifestLimit,
        offset: manifestOffset,
        sort: "recent",
        includeTotal: wantTotal
      });
      manifestCacheRef.current = { status, limit: manifestLimit, manifest: response.manifest };
      setManifest(response.manifest);
      setManifestNextCursor(response.nextCursor);
      if (wantTotal) setManifestTotal(response.total);
      setManifestError("");
      // Track this page's cursor in the chain (key = start offset of
      // the page we just fetched). The chain enables "previous"
      // navigation by jumping to the previous offset.
      manifestCursorChain.current.set(manifestOffset, response.nextCursor ?? "");
    } catch (err) {
      setManifestError(getErrorMessage(err));
    }
  }, [props.folderId, manifestLimit, manifestOffset]);

  // Refresh the folder-wide "how many failed" count so the bulk retry
  // button can show "重试 N 个失败文件" regardless of the current
  // manifest filter. Cheap (single COUNT(*)).
  const refreshFailedTotal = useCallback(async () => {
    try {
      const response = await api.getWatchedFolderManifest(props.folderId, {
        status: "failed",
        limit: 1,
        offset: 0,
        sort: "recent",
        includeTotal: true
      });
      setManifestFailedTotal(response.total);
    } catch {
      // Non-fatal — the bulk-retry button just hides itself on 0.
      setManifestFailedTotal(0);
    }
  }, [props.folderId]);

  /**
   * Jump to a specific page. Uses cursor when one is available for
   * the target offset (already visited), otherwise re-fetches with
   * offset only.
   */
  const goToManifestPage = useCallback((next: { offset?: number; cursor?: string }) => {
    if (next.cursor !== undefined) {
      // Forward page navigation via cursor. We don't know the offset
      // yet — let the API call set it via the cursor's encoded value.
      setManifestOffset(manifestOffset); // placeholder, refreshed below
      // We need to fetch with cursor, so call API directly.
      (async () => {
        try {
          const response = await api.getWatchedFolderManifest(props.folderId, {
            status: manifestStatusFilter || undefined,
            limit: manifestLimit,
            cursor: next.cursor,
            includeTotal: false,
            sort: "recent"
          });
          setManifest(response.manifest);
          setManifestNextCursor(response.nextCursor);
          // The new offset = previous offset + limit.
          const newOffset = manifestOffset + manifestLimit;
          setManifestOffset(newOffset);
          manifestCursorChain.current.set(newOffset, response.nextCursor ?? "");
        } catch (err) {
          setManifestError(getErrorMessage(err));
        }
      })();
      return;
    }
    if (next.offset != null) {
      setManifestOffset(next.offset);
    }
  }, [props.folderId, manifestStatusFilter, manifestLimit, manifestOffset]);

  /**
   * Update the page size and reset to offset 0.
   */
  const setManifestPageSize = useCallback((newLimit: number) => {
    setManifestLimit(newLimit);
    setManifestOffset(0);
    manifestCursorChain.current.clear();
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const response = await api.getWatchedFolderRuns(props.folderId, 50);
      runsCacheRef.current = response.runs;
      setRuns(response.runs);
      setRunsError("");
    } catch (err) {
      setRunsError(getErrorMessage(err));
    }
  }, [props.folderId]);

  // Initial load + reload on prop changes.
  useEffect(() => {
    // Reset caches when switching folders.
    manifestCacheRef.current = null;
    runsCacheRef.current = null;
    setManifest(null);
    setManifestError("");
    setRunsError("");
    setManifestOffset(0);
    manifestCursorChain.current.clear();
    void refreshFolder();
  }, [refreshFolder, props.reloadToken]);

  // Listen for "pagination:limit-change" events emitted by the
  // shared Pagination component when the user picks a new page size.
  useEffect(() => {
    const handler = (event: Event) => {
      const e = event as CustomEvent<{ limit: number }>;
      const newLimit = e.detail?.limit;
      if (typeof newLimit === "number" && newLimit !== manifestLimit) {
        setManifestPageSize(newLimit);
      }
    };
    window.addEventListener("pagination:limit-change", handler);
    return () => window.removeEventListener("pagination:limit-change", handler);
  }, [manifestLimit, setManifestPageSize]);

  // Live progress: poll /queue every 1.5s on every tab (cheap; just a
  // single in-memory snapshot).
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await api.getWatchedFolderQueue(props.folderId);
        if (!cancelled) setProgress(r.progress);
      } catch {
        // Silent — the progress bar just freezes on the last value.
      }
    };
    void tick();
    const timer = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.folderId]);

  // Polling interval: 5 s when idle, 10 s while the queue is draining.
  // During heavy ingest we already show live progress from the queue
  // endpoint; polling the manifest every 5 s while thousands of rows
  // churn made status-filter clicks feel laggy. The longer interval
  // keeps the UI responsive without making it feel stale.
  const [pollIntervalMs, setPollIntervalMs] = useState(5000);
  useEffect(() => {
    const queue = folder?.queueProgress;
    const isBusy = queue ? (queue.pending + queue.active > 0) : false;
    setPollIntervalMs(isBusy ? 10_000 : 5_000);
  }, [folder?.queueProgress?.pending, folder?.queueProgress?.active]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshFolder();
      if (tab === "manifest") {
        void refreshManifest(manifestStatusFilter);
        // The bulk-retry button's label depends on this, so refresh it
        // on the same cadence as the manifest list itself.
        void refreshFailedTotal();
      } else if (tab === "runs") {
        void refreshRuns();
      }
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshFolder, refreshManifest, refreshFailedTotal, refreshRuns, tab, manifestStatusFilter, pollIntervalMs]);

  // First-time fetch of the failed count whenever the folder changes
  // (or the user switches back to the manifest tab) so the bulk-retry
  // button label is correct from the first paint.
  useEffect(() => {
    void refreshFailedTotal();
  }, [refreshFailedTotal, props.reloadToken]);

  // When the user switches to manifest / runs, fetch if the cache is empty
  // (or if the manifest status filter changed since we cached it).
  useEffect(() => {
    if (tab === "manifest") {
      const cached = manifestCacheRef.current;
      if (!cached || cached.status !== manifestStatusFilter) {
        void refreshManifest(manifestStatusFilter);
      } else {
        setManifest(cached.manifest);
      }
    } else if (tab === "runs") {
      if (runsCacheRef.current == null) {
        void refreshRuns();
      } else {
        setRuns(runsCacheRef.current);
      }
    }
  }, [tab, manifestStatusFilter, refreshManifest, refreshRuns]);

  async function handleSync() {
    if (!folder) return;
    try {
      setError("");
      setBusy(true);
      await api.triggerFolderSync(folder.id);
      await refreshFolder();
      // Invalidate manifest cache + reset total so the next manifest
      // refresh re-runs COUNT(*) — sync runs may have added rows.
      manifestCacheRef.current = null;
      manifestCursorChain.current.clear();
      setManifestTotal(0);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleEnabled() {
    if (!folder) return;
    try {
      setError("");
      setBusy(true);
      if (folder.enabled) {
        await api.pauseWatchedFolder(folder.id);
      } else {
        await api.resumeWatchedFolder(folder.id);
      }
      props.onChanged();
      await refreshFolder();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!folder) return;
    const confirmed = window.confirm(t(
      `永久删除监听文件夹「${folder.displayName}」？`,
      `Permanently delete watched folder "${folder.displayName}"?`
    ));
    if (!confirmed) return;
    try {
      setError("");
      setBusy(true);
      await api.deleteWatchedFolder(folder.id);
      // Don't reset busy — props.onBack() unmounts this component,
      // and keeping buttons disabled during the transition avoids
      // duplicate mutations if the user clicks again.
      props.onChanged();
      props.onBack();
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  }

  async function handleRetryFile(relPath: string) {
    if (!folder) return;
    // Per-row retry: we wrap the network call in the retry-status hook
    // so the per-row button shows a spinner and the toast queue picks
    // up the result. The surrounding `busy` flag stays untouched so
    // the rest of the page (manifest list, sync history, etc.) keeps
    // working.
    try {
      setError("");
      const result = await retryStatus.withFileRetry(relPath, () =>
        api.retryWatchedFolderFile(folder.id, relPath)
      );
      if (result.missing.length > 0) {
        retryStatus.pushToast(
          "error",
          t(
            `文件不存在于磁盘：${result.missing.join(", ")}`,
            `File no longer exists on disk: ${result.missing.join(", ")}`
          )
        );
      } else if (result.enqueued > 0) {
        retryStatus.pushToast(
          "success",
          t(
            `已重新入队：${truncateRelPath(relPath)}`,
            `Re-queued: ${truncateRelPath(relPath)}`
          )
        );
      } else if (result.skipped > 0) {
        // The row was already syncing/pending from a prior call —
        // surface that as an info toast so the user isn't confused
        // by the lack of state change.
        retryStatus.pushToast(
          "info",
          t(
            `已是最新状态：${truncateRelPath(relPath)}`,
            `Already up to date: ${truncateRelPath(relPath)}`
          )
        );
      }
      await refreshManifest(manifestStatusFilter);
      await refreshFolder();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      retryStatus.pushToast("error", message);
    }
  }

  // Bulk retry uses an inline confirm toast (a clickable "确认" in the
  // toast card) rather than window.confirm, because window.confirm is
  // blocking + easy for tab focus to lose, which manifests as the
  // "spinner stuck forever" symptom we hit on the IT books folder
  // (313 files → user has to click something they can't see).
  // State machine:
  //   "idle"      — no confirm pending; clicking the bulk button
  //                 transitions to "confirming"
  //   "confirming" — a toast with a "确认" / "取消" button is visible.
  //                  Clicking either returns to "idle"
  //   "running"   — actuallyRunBulkRetry() in flight; the bulk button
  //                 shows its spinner (driven by retryStatus.bulkInflight)
  //                 and is disabled
  const [bulkConfirm, setBulkConfirm] = useState<
    { open: boolean; count: number } | null
  >(null);

  async function actuallyRunBulkRetry() {
    if (!folder) return;
    setBulkConfirm(null);
    try {
      setError("");
      const result = await retryStatus.withBulkRetry(() =>
        api.retryAllFailedWatchedFolderFiles(folder.id)
      );
      if (result.missing.length > 0) {
        retryStatus.pushToast(
          "info",
          t(
            `${result.missing.length} 个文件已不存在于磁盘，跳过。`,
            `${result.missing.length} files no longer exist on disk, skipped.`
          )
        );
      }
      if (result.enqueued > 0) {
        retryStatus.pushToast(
          "success",
          t(
            `已重新入队 ${result.enqueued} 个文件`,
            `Re-queued ${result.enqueued} files`
          )
        );
      } else if (result.total > 0) {
        retryStatus.pushToast(
          "info",
          t(
            `${result.total} 个文件已是最新状态`,
            `${result.total} files were already up to date`
          )
        );
      } else {
        retryStatus.pushToast(
          "info",
          t("没有需要重试的文件", "Nothing to retry")
        );
      }
      await refreshManifest(manifestStatusFilter);
      await refreshFolder();
    } catch (err) {
      const message = getErrorMessage(err);
      setError(message);
      retryStatus.pushToast("error", message);
    }
  }

  function handleRetryAllFailed() {
    if (!folder) return;
    if (manifestFailedTotal === 0) return;
    // Open the inline confirm card. We snapshot the count so the
    // confirm message stays accurate even if the user takes 30s to
    // decide while other retries are still being processed.
    setBulkConfirm({ open: true, count: manifestFailedTotal });
  }

  if (!folder) {
    return (
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 md:px-6">
          <Button variant="ghost" size="icon" onClick={props.onBack} className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="truncate text-base font-semibold">{t("监听文件夹详情", "Watched folder details")}</h2>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          {error ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("正在加载...", "Loading...")}
            </div>
          )}
        </div>
        <ToastStack toasts={retryStatus.toasts} onDismiss={retryStatus.dismissToast} />
      </section>
    );
  }

  const watcherRunning = Boolean((folder as { watcherRunning?: boolean }).watcherRunning);
  const lastRunStats = (folder as { lastRunStats?: { added: number; updated: number; deleted: number; failed: number } })
    .lastRunStats;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 md:flex-nowrap md:items-center md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" onClick={props.onBack} className="h-8 w-8">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{folder.displayName}</h2>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {folder.path} · {shortId(folder.id)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleSync()} disabled={busy || !folder.enabled}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("立即同步", "Sync now")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleToggleEnabled()} disabled={busy}>
            {folder.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {folder.enabled ? t("暂停", "Pause") : t("启用", "Resume")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void handleDelete()} disabled={busy}>
            <Trash2 className="h-4 w-4" />
            {t("删除", "Delete")}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 md:px-6">
          {error}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 md:px-6">
        {(["overview", "manifest", "runs"] as DetailsTab[]).map((option) => (
          <button
            key={option}
            type="button"
            className={cn(
              "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
              tab === option && "bg-accent text-foreground"
            )}
            onClick={() => setTab(option)}
          >
            {detailsTabLabel(option, t)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin md:p-6">
        <div className="mx-auto grid max-w-6xl gap-4">
          {tab === "overview" ? (
            <DetailsOverview
              folder={folder}
              watcherRunning={watcherRunning}
              watcherHealth={(folder as { watcherHealth?: WatcherHealth | null }).watcherHealth ?? null}
              lastRunStats={lastRunStats}
              recentRuns={recentRuns}
              progress={progress}
            />
          ) : tab === "manifest" ? (
            <DetailsManifest
              manifest={manifest}
              error={manifestError}
              statusFilter={manifestStatusFilter}
              onStatusFilterChange={setManifestStatusFilter}
              failedTotal={manifestFailedTotal}
              busy={busy || retryStatus.bulkInflight}
              isRowRetrying={(relPath) => retryStatus.isRowRetrying(relPath)}
              isBulkRetrying={retryStatus.isBulkRetrying}
              onRetryFile={handleRetryFile}
              onRetryAllFailed={handleRetryAllFailed}
              pagination={{
                total: manifestTotal,
                limit: manifestLimit,
                offset: manifestOffset,
                nextCursor: manifestNextCursor
              }}
              onPageChange={goToManifestPage}
            />
          ) : (
            <DetailsRuns runs={runs} error={runsError} />
          )}
        </div>
      </div>
      {/* Toast stack — bottom-right notifications for retry success
          / failure. Lives at the section root so it's always above
          the tab content but still scoped to this page. */}
      <ToastStack toasts={retryStatus.toasts} onDismiss={retryStatus.dismissToast} />
      {/* Inline confirm dialog for bulk retry. We don't use
          window.confirm because it is blocking + easy to lose focus
          for, which the IT-books folder (313 files) exposed as
          "stuck spinner forever". A clickable modal is unambiguous
          and trivially scriptable. */}
      {bulkConfirm ? (
        <div
          // backdrop
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 px-4"
          onClick={() => setBulkConfirm(null)}
          role="presentation"
        >
          <div
            // dialog
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-sm rounded-lg border border-blue-200 bg-white p-4 shadow-xl"
          >
            <h3 className="text-sm font-semibold">
              {t("确认批量重试", "Confirm bulk retry")}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(
                `将重新入队 ${bulkConfirm.count} 个失败文件。已删除的文件会跳过。`,
                `This will re-queue ${bulkConfirm.count} failed files. Files that no longer exist on disk will be skipped.`
              )}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBulkConfirm(null)}
              >
                {t("取消", "Cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void actuallyRunBulkRetry();
                }}
              >
                {t(`确认重试 ${bulkConfirm.count} 个`, `Confirm retry (${bulkConfirm.count})`)}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function detailsTabLabel(
  tab: DetailsTab,
  t: (zh: string, en: string) => string
): string {
  if (tab === "overview") return t("概览", "Overview");
  if (tab === "manifest") return t("文件清单", "File manifest");
  return t("同步历史", "Sync history");
}

function DetailsOverview(props: {
  folder: WatchedFolderRecord;
  watcherRunning: boolean;
  watcherHealth: WatcherHealth | null;
  lastRunStats?: { added: number; updated: number; deleted: number; failed: number };
  recentRuns: SyncRunRecord[];
  progress: QueueProgress | null;
}) {
  const { t } = useI18n();
  const { folder } = props;
  const progressLabel = (() => {
    if (!props.progress) return null;
    const p = props.progress;
    if (p.scanning) return t("正在扫描文件系统...", "Scanning filesystem...");
    if (!p.idle) return t("正在入库文件...", "Ingesting files...");
    if (p.lastError) return p.lastError;
    return null;
  })();
  const progressDetail = props.progress
    ? `${props.progress.done}/${props.progress.total > 0 ? props.progress.total : "?"}${props.progress.failed > 0 ? ` · ${props.progress.failed} 失败` : ""}`
    : null;
  return (
    <>
      {progressLabel ? (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold">{t("同步进度", "Sync progress")}</h3>
          </CardHeader>
          <CardContent>
            <ProgressBar
              percent={props.progress?.percent ?? -1}
              label={progressLabel}
              detail={progressDetail ?? undefined}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {props.progress && (
                <>
                  {props.progress.pending > 0 ? (
                    <span>{t("待处理", "pending")}: {props.progress.pending}</span>
                  ) : null}
                  {props.progress.active > 0 ? (
                    <span>{t("进行中", "active")}: {props.progress.active}</span>
                  ) : null}
                  {props.progress.added > 0 ? (
                    <span>+{props.progress.added}</span>
                  ) : null}
                  {props.progress.updated > 0 ? (
                    <span>~{props.progress.updated}</span>
                  ) : null}
                  {props.progress.deleted > 0 ? (
                    <span>-{props.progress.deleted}</span>
                  ) : null}
                  {props.progress.failed > 0 ? (
                    <span className="text-red-600">×{props.progress.failed}</span>
                  ) : null}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("概览", "Overview")}</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={folder.enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-border bg-muted text-muted-foreground"}>
              {folder.enabled ? t("启用", "Enabled") : t("已暂停", "Paused")}
            </Badge>
            <Badge className={props.watcherRunning ? "border-blue-200 bg-blue-50 text-blue-700" : "border-border bg-muted text-muted-foreground"}>
              {props.watcherRunning ? t("监听中", "Watching") : t("未运行", "Stopped")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <PanelInfo label={t("路径", "Path")} value={folder.path} multiline />
          <PanelInfo label={t("显示名称", "Display name")} value={folder.displayName} />
          <PanelInfo
            label={t("递归", "Recursive")}
            value={folder.recursive ? t("是", "Yes") : t("否", "No")}
          />
          <PanelInfo
            label={t("最后扫描", "Last scan")}
            value={folder.lastScanAt ? formatDate(folder.lastScanAt) : t("从未", "Never")}
          />
          <PanelInfo
            label={t("最后错误", "Last error")}
            value={folder.lastError || t("无", "None")}
            multiline
          />
          <PanelInfo
            label={t("创建时间", "Created")}
            value={folder.createdAt ? formatDate(folder.createdAt) : "—"}
          />
          <PanelInfo
            label={t("更新时间", "Updated")}
            value={folder.updatedAt ? formatDate(folder.updatedAt) : "—"}
          />
          <PanelInfo
            label={t("最近结果", "Last run stats")}
            value={
              props.lastRunStats
                ? t(
                    `+${props.lastRunStats.added} 新增 / ~${props.lastRunStats.updated} 更新 / -${props.lastRunStats.deleted} 删除 / ×${props.lastRunStats.failed} 失败`,
                    `+${props.lastRunStats.added} added / ~${props.lastRunStats.updated} updated / -${props.lastRunStats.deleted} deleted / ×${props.lastRunStats.failed} failed`
                  )
                : t("—", "—")
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">{t("过滤规则", "File type filter")}</h3>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <PanelInfo
            label={t("白名单", "Whitelist")}
            value={
              folder.filetypeFilter.whitelist && folder.filetypeFilter.whitelist.length > 0
                ? folder.filetypeFilter.whitelist.join(", ")
                : t("接受全部", "Accept all")
            }
          />
          <PanelInfo
            label={t("黑名单", "Blacklist")}
            value={
              folder.filetypeFilter.blacklist && folder.filetypeFilter.blacklist.length > 0
                ? folder.filetypeFilter.blacklist.join(", ")
                : t("无", "None")
            }
          />
          <PanelInfo
            label={t("最大文件", "Max size")}
            value={
              folder.filetypeFilter.maxBytes != null
                ? formatBytes(folder.filetypeFilter.maxBytes)
                : t("无限制", "Unlimited")
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-sm font-semibold">{t("最近同步", "Recent runs")}</h3>
        </CardHeader>
        <CardContent className="space-y-2">
          {props.recentRuns.length === 0 ? (
            <EmptyLine text={t("还没有同步记录。", "No sync history yet.")} />
          ) : (
            props.recentRuns.slice(0, 5).map((run) => <RunRow key={run.id} run={run} />)
          )}
        </CardContent>
      </Card>

      {props.watcherHealth && props.watcherHealth.stoppedReason ? (
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold">{t("监听器状态", "Watcher status")}</h3>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                className={
                  props.watcherHealth.stoppedReason === "healthcheck-failed" ||
                  props.watcherHealth.stoppedReason === "preflight-failed"
                    ? "border-red-200 bg-red-50 text-red-700"
                    : "border-border bg-muted text-muted-foreground"
                }
              >
                {watcherStoppedReasonLabel(props.watcherHealth.stoppedReason, t)}
              </Badge>
              {props.watcherHealth.consecutiveFailures > 0 ? (
                <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                  {t(`连续失败 ${props.watcherHealth.consecutiveFailures} 次`, `${props.watcherHealth.consecutiveFailures} consecutive failures`)}
                </Badge>
              ) : null}
            </div>
            {props.watcherHealth.lastError ? (
              <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">
                {props.watcherHealth.lastError}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t(
                "点顶栏「测试连接」可手动验证 embedding API；通过后再次「启用」监听器即可恢复。",
                'Use "Test connection" in the top bar to re-verify the embedding API; once it passes, click "Resume" to restart the watcher.'
              )}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function watcherStoppedReasonLabel(
  reason: NonNullable<WatcherHealth["stoppedReason"]>,
  t: (zh: string, en: string) => string
): string {
  if (reason === "preflight-failed") return t("预检失败：embedding API 不可达", "Stopped: preflight failed (embedding API unreachable)");
  if (reason === "healthcheck-failed") return t("已暂停：embedding API 持续不可达", "Stopped: embedding API unreachable after N consecutive failures");
  return t("已手动停止", "Stopped by user");
}

function DetailsManifest(props: {
  manifest: FileManifestRecord[] | null;
  error: string;
  statusFilter: string;
  onStatusFilterChange: (next: string) => void;
  failedTotal: number;
  busy: boolean;
  isRowRetrying: (relPath: string) => boolean;
  isBulkRetrying: boolean;
  onRetryFile: (relPath: string) => void;
  onRetryAllFailed: () => void;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    nextCursor: string | null;
  };
  onPageChange: (next: { offset?: number; cursor?: string }) => void;
}) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("文件清单", "File manifest")}</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {(["", "synced", "syncing", "pending", "failed", "deleted"] as string[]).map((option) => (
            <button
              key={option || "all"}
              type="button"
              className={cn(
                "rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
                props.statusFilter === option && "bg-accent text-foreground"
              )}
              onClick={() => props.onStatusFilterChange(option)}
            >
              {option === "" ? t("全部", "All") : manifestStatusLabel(option as FileManifestRecord["status"], t)}
            </button>
          ))}
          {/* Bulk retry — always visible; disabled when there's nothing
              to retry, which is the only sane default. We swap the
              icon to a spinner while a bulk call is in-flight so the
              user gets immediate visual feedback. */}
          <Button
            variant="outline"
            size="sm"
            onClick={props.onRetryAllFailed}
            disabled={props.busy || props.failedTotal === 0}
          >
            {props.isBulkRetrying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcw className="h-4 w-4" />
            )}
            {t(`重试全部失败 (${props.failedTotal})`, `Retry all failed (${props.failedTotal})`)}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {props.error ? (
          <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{props.error}</div>
        ) : props.manifest == null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("正在加载文件清单...", "Loading manifest...")}
          </div>
        ) : props.manifest.length === 0 ? (
          <EmptyLine text={t("清单为空。", "Manifest is empty.")} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] table-auto border-collapse text-left text-xs leading-5">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">{t("相对路径", "Path")}</th>
                    <th className="px-2 py-2 font-medium">{t("状态", "Status")}</th>
                    <th className="px-2 py-2 font-medium">{t("大小", "Size")}</th>
                    <th className="px-2 py-2 font-medium">{t("最后同步", "Last sync")}</th>
                    <th
                      className="px-2 py-2 font-medium"
                      title={t(
                        "本列显示该文件最近一次同步耗时（包含解析与向量化）。用于定位同步慢的文件类型。",
                        "Wall-clock duration of the most-recent ingest (parse + embed). Use this to spot slow file types."
                      )}
                    >
                      {t("同步耗时", "Sync time")}
                    </th>
                    <th className="px-2 py-2 font-medium">{t("错误", "Error")}</th>
                    <th className="px-2 py-2 font-medium">{t("操作", "Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {props.manifest.map((item) => (
                    <tr key={item.id} className="border-t border-border/70">
                      <td className="px-2 py-1.5 align-top">
                        <div className="break-all font-mono">{item.relPath}</div>
                        {item.sha1 ? (
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">sha1: {item.sha1.slice(0, 12)}</div>
                        ) : null}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <Badge className={manifestStatusClassName(item.status)}>
                          {manifestStatusLabel(item.status, t)}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 align-top text-muted-foreground">
                        {item.sizeBytes != null ? formatBytes(item.sizeBytes) : "—"}
                      </td>
                      <td className="px-2 py-1.5 align-top text-muted-foreground">
                        {item.lastSyncedAt ? formatDate(item.lastSyncedAt) : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-2 py-1.5 align-top tabular-nums",
                          // Highlight slow rows so the eye lands on the
                          // files worth investigating. >5s flags the
                          // cell in amber; >30s goes red. Anything
                          // faster is muted to match "Last sync".
                          item.lastSyncDurationMs != null && item.lastSyncDurationMs >= 30_000
                            ? "text-red-700"
                            : item.lastSyncDurationMs != null && item.lastSyncDurationMs >= 5_000
                              ? "text-amber-700"
                              : "text-muted-foreground"
                        )}
                        title={
                          item.lastSyncStartedAt
                            ? t(
                                `起始 ${formatDate(item.lastSyncStartedAt)}`,
                                `Started ${formatDate(item.lastSyncStartedAt)}`
                              )
                            : undefined
                        }
                      >
                        {formatSyncDuration(item.lastSyncDurationMs)}
                      </td>
                      <td className="px-2 py-1.5 align-top text-red-700">
                        {item.lastError ? (
                          <span className="line-clamp-2" title={item.lastError}>{item.lastError}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        {/* Per-row retry. The button shows a spinner
                            while the HTTP call is in-flight (via
                            isRowRetrying), and we always render it —
                            the API treats the call as a no-op when the
                            row isn't `failed`, so the user can still
                            retry a file that just transitioned out of
                            failed. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => props.onRetryFile(item.relPath)}
                          disabled={
                            props.busy ||
                            item.status === "syncing" ||
                            props.isRowRetrying(item.relPath)
                          }
                        >
                          {props.isRowRetrying(item.relPath) ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                          {t("重试", "Retry")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={props.pagination.total}
              limit={props.pagination.limit}
              offset={props.pagination.offset}
              nextCursor={props.pagination.nextCursor}
              hasPrev={props.pagination.offset > 0}
              hasNext={props.pagination.nextCursor != null}
              itemLabel={t("文件", "files")}
              onChange={props.onPageChange}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DetailsRuns(props: { runs: SyncRunRecord[]; error: string }) {
  const { t } = useI18n();

  return (
    <Card>
      <CardHeader>
        <h3 className="text-sm font-semibold">{t("同步历史", "Sync history")}</h3>
      </CardHeader>
      <CardContent className="space-y-2">
        {props.error ? (
          <div className="rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{props.error}</div>
        ) : props.runs.length === 0 ? (
          <EmptyLine text={t("还没有同步记录。", "No sync history yet.")} />
        ) : (
          props.runs.map((run) => <RunRow key={run.id} run={run} />)
        )}
      </CardContent>
    </Card>
  );
}

function RunRow({ run }: { run: SyncRunRecord }) {
  const { t } = useI18n();
  const durationMs = run.finishedAt
    ? Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
    : null;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge className={runStatusClassName(run.status)}>{runStatusLabel(run.status, t)}</Badge>
            <Badge className="border-border bg-background text-muted-foreground">{triggerLabel(run.trigger, t)}</Badge>
            <span>{formatDate(run.startedAt)}</span>
            {durationMs != null ? <span>{t(`耗时 ${durationMs} 毫秒`, `${durationMs} ms`)}</span> : null}
          </div>
          {run.errorMessage ? (
            <div className="mt-1 text-xs text-red-700">{run.errorMessage}</div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">+{run.filesAdded}</Badge>
          <Badge className="border-blue-200 bg-blue-50 text-blue-700">~{run.filesUpdated}</Badge>
          <Badge className="border-border bg-muted text-muted-foreground">-{run.filesDeleted}</Badge>
          {run.filesFailed > 0 ? (
            <Badge className="border-red-200 bg-red-50 text-red-700">×{run.filesFailed}</Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// === Inline helpers (kept private to this page) ===
/**
 * Shorten long relPaths for toast/notification copy. We keep the last
 * 40 characters so the user can still recognise the file (e.g. folder
 * name + filename) without overflowing the toast width.
 */
function truncateRelPath(relPath: string, maxLen = 40): string {
  if (relPath.length <= maxLen) {
    return relPath;
  }
  const tail = relPath.slice(-(maxLen - 1));
  return `…${tail}`;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</div>
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="rounded-md px-3 py-2 text-xs text-muted-foreground">{text}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/35 px-2 py-2">
      <div className="truncate text-sm font-semibold">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}