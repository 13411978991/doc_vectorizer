/**
 * JobsOverviewView — stage 1 productization.
 *
 * Why this exists:
 *   The previous product feedback was "the app sometimes hangs and I
 *   have no idea what it's doing". This component polls
 *   `/api/jobs/overview` every 2s and renders:
 *     - aggregate counters (pending / active / failed across all folders)
 *     - per-folder queue progress bars
 *     - system resource snapshot (CPU load, RSS, heap, host mem)
 *     - recent failure reasons with per-row retry / skip actions
 *
 *   It's also exposed as a "drawer" mode so the header can show a
 *   compact strip without taking over the whole workspace.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Folder,
  HardDrive,
  Loader2,
  MemoryStick,
  Pause,
  Play,
  RotateCcw,
  X,
  XCircle
} from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useI18n } from "../i18n";
import type { JobsOverview } from "../types";

const POLL_INTERVAL_MS = 2_000;

interface JobsOverviewViewProps {
  className?: string;
  /** Compact mode renders only the per-folder rows + a header strip,
   *  used when the panel is collapsed into a side drawer. */
  compact?: boolean;
}

export function JobsOverviewView({ className, compact }: JobsOverviewViewProps) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<JobsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const tick = useCallback(async () => {
    try {
      const data = await api.getJobsOverview();
      if (!mountedRef.current) return;
      setOverview(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void tick();
    timerRef.current = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [tick]);

  const runAction = useCallback(
    async (
      key: string,
      fn: () => Promise<unknown>,
      optimisticMessage?: string
    ) => {
      setActionPending(key);
      try {
        await fn();
        await tick();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setActionPending(null);
        if (optimisticMessage) {
          // Surface optimistic feedback briefly; the tick above will
          // overwrite the table content with fresh data anyway.
          setError(null);
        }
      }
    },
    [tick]
  );

  if (!overview) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        {error ? (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col overflow-hidden bg-slate-50", className)}>
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
              <Activity className="h-5 w-5 text-slate-500" />
              实时任务面板
            </h1>
            <p className="text-xs text-slate-500">
              自动每 {POLL_INTERVAL_MS / 1000} 秒刷新 · 上次更新 {timeAgo(overview.generatedAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runAction("retry-all", () => api.retryAllFailed({}), "已批量重试失败文件")}
              disabled={actionPending === "retry-all" || overview.aggregate.failed === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {actionPending === "retry-all" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              重试全部失败 ({overview.aggregate.failed})
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8 xl:grid-cols-[repeat(8,minmax(0,1fr))]">
          <Counter icon={<Folder className="h-3.5 w-3.5" />} label="文件夹" value={overview.aggregate.folders} />
          <Counter icon={<Play className="h-3.5 w-3.5" />} label="活跃" value={overview.aggregate.active} accent={overview.aggregate.active > 0 ? "blue" : "slate"} />
          <Counter icon={<Pause className="h-3.5 w-3.5" />} label="队列" value={overview.aggregate.pending} accent={overview.aggregate.pending > 0 ? "amber" : "slate"} />
          <Counter
            icon={<CheckCircle2 className="h-3.5 w-3.5" />}
            label="已加"
            value={overview.aggregate.added}
            accent="emerald"
            title={t("所有监听文件夹的同步记录累计的「新增」文件数。", "Cumulative files_added across all watched folder sync runs.")}
          />
          <Counter
            icon={<Activity className="h-3.5 w-3.5" />}
            label="已更新"
            value={overview.aggregate.updated}
            accent="emerald"
            title={t("所有监听文件夹的同步记录累计的「更新」文件数。", "Cumulative files_updated across all watched folder sync runs.")}
          />
          <Counter
            icon={<XCircle className="h-3.5 w-3.5" />}
            label="已删"
            value={overview.aggregate.deleted}
            accent="slate"
            title={t("所有监听文件夹的同步记录累计的「删除」文件数。", "Cumulative files_deleted across all watched folder sync runs.")}
          />
          <Counter
            icon={<AlertTriangle className="h-3.5 w-3.5" />}
            label="失败"
            value={overview.aggregate.failed}
            accent={overview.aggregate.failed > 0 ? "red" : "slate"}
            title={t("文件清单中处于 failed / partial 状态的总行数（与下方「最近失败」列表口径一致）。", "Total manifest rows currently in failed / partial state (matches the Recent failures list below).")}
          />
          <Counter icon={<CheckCircle2 className="h-3.5 w-3.5" />} label="空闲" value={overview.aggregate.idleFolders} accent="slate" />
        </div>

        <ResourceStrip resources={overview.resources} />
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4">
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}

        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-slate-700">文件夹队列</h2>
          {overview.folders.length === 0 ? (
            <div className="rounded-md border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
              还没有监听的文件夹。打开「监听文件夹」页面添加一个。
            </div>
          ) : (
            <div className="space-y-2">
              {overview.folders.map((folder) => (
                <FolderProgressRow key={folder.folderId} folder={folder} />
              ))}
            </div>
          )}
        </section>

        {!compact && overview.recentFailures.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-slate-700">
              最近失败 ({overview.recentFailures.length})
            </h2>
            <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">文件</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">耗时</th>
                    <th className="px-3 py-2">错误</th>
                    <th className="px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {overview.recentFailures.map((f) => (
                    <FailureRow
                      key={`${f.folderId}::${f.relPath}`}
                      failure={f}
                      pendingKey={actionPending}
                      onSkip={() =>
                        runAction(`skip::${f.folderId}::${f.relPath}`, () =>
                          api.skipManifestRow(f.folderId, f.relPath)
                        )
                      }
                      onRetry={() =>
                        runAction(`retry::${f.folderId}::${f.relPath}`, () =>
                          api.retryManifestRow(f.folderId, f.relPath)
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

interface CounterProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: "slate" | "blue" | "amber" | "emerald" | "red";
  title?: string;
}

function Counter({ icon, label, value, accent = "slate", title }: CounterProps) {
  const accentClass = {
    slate: "bg-slate-50 text-slate-700 border-slate-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
    red: "bg-red-50 text-red-700 border-red-200"
  }[accent];
  return (
    <div
      className={cn("flex items-center gap-1.5 rounded-md border px-2 py-1.5", accentClass)}
      title={title}
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="truncate text-xs">{label}</span>
      <span className="ml-auto shrink-0 text-base font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ResourceStrip({ resources }: { resources: JobsOverview["resources"] }) {
  const usedPct = resources.hostTotalMb > 0
    ? Math.round(((resources.hostTotalMb - resources.hostFreeMb) / resources.hostTotalMb) * 100)
    : 0;
  const cpuAccent =
    resources.loadAverage1 > 0.85 ? "text-red-600" :
    resources.loadAverage1 > 0.6 ? "text-amber-600" : "text-slate-700";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-600">
      <span className="flex items-center gap-1">
        <Cpu className="h-3.5 w-3.5" />
        <span className={cn("font-medium", cpuAccent)}>CPU 负载 {resources.loadAverage1.toFixed(2)}</span>
        <span className="text-slate-400">/ {resources.cpuCount} 核</span>
      </span>
      <span className="flex items-center gap-1">
        <MemoryStick className="h-3.5 w-3.5" />
        进程 {resources.rssMb} MB · 堆 {resources.heapUsedMb} MB
      </span>
      <span className="flex items-center gap-1">
        <HardDrive className="h-3.5 w-3.5" />
        主机内存 {usedPct}% ({resources.hostFreeMb}/{resources.hostTotalMb} MB)
      </span>
    </div>
  );
}

function FolderProgressRow({ folder }: { folder: JobsOverview["folders"][number] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const p = folder.progress;
  const isPaused = !folder.enabled;
  // Paused folders: render a flat "已暂停 — 未在扫描/入库" line instead of
  // the live ProgressBar. The bar otherwise shows an indeterminate
  // animation (since `p.total === 0` and `p.idle === true` for a paused
  // folder) which makes it look like the system is still working when it
  // isn't. We still keep the expand-to-show-details affordance so the
  // operator can see the last known counters if they want.
  const indeterminate = !isPaused && p.total === 0;
  const percent = indeterminate ? -1 : Math.max(0, Math.min(100, Math.round(p.percent)));
  return (
    <div className={cn("rounded-md border bg-white", folder.enabled ? "border-slate-200" : "border-slate-100 opacity-70")}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-slate-400" /> : <ChevronDown className="h-3.5 w-3.5 text-slate-400" />}
          <Folder className="h-4 w-4 text-slate-500" />
          <span className="text-sm font-medium text-slate-800">{folder.displayName}</span>
          {isPaused && (
            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">已暂停</span>
          )}
          <span className="font-mono text-xs text-slate-400">{folder.path}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <span>活跃 {p.active}</span>
          <span>队列 {p.pending}</span>
          <span className="text-red-600">失败 {p.failed}</span>
        </div>
      </button>
      <div className="px-3 pb-3">
        {isPaused ? (
          <div
            className="flex h-1.5 w-full items-center justify-center rounded-full bg-slate-100 text-[10px] text-slate-400"
            title={t("监听器已暂停，不会扫描或入库新文件。", "Watcher is paused; no new files are scanned or ingested.")}
          >
            <span className="sr-only">已暂停</span>
          </div>
        ) : (
          <ProgressBar percent={percent} indeterminate={indeterminate} />
        )}
        {expanded && (
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
            <span>扫描中：{p.scanning ? "是" : "否"}</span>
            <span>已加：{p.added}</span>
            <span>已更新：{p.updated}</span>
            <span>已删：{p.deleted}</span>
            <span>总计：{p.total || "未知"}</span>
            <span>已完成：{p.done}</span>
            <span>空闲：{p.idle ? "是" : "否"}</span>
            <span className="truncate" title={p.lastError ?? ""}>最近错误：{p.lastError ?? "—"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressBar({ percent, indeterminate }: { percent: number; indeterminate: boolean }) {
  if (indeterminate) {
    return (
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="absolute inset-y-0 left-0 w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-blue-400" />
        <style>{`@keyframes indeterminate { 0% { left: -33% } 100% { left: 100% } }`}</style>
      </div>
    );
  }
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div
        className="h-full rounded-full bg-blue-500 transition-all duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

interface FailureRowProps {
  failure: JobsOverview["recentFailures"][number];
  pendingKey: string | null;
  onRetry: () => void;
  onSkip: () => void;
}

function FailureRow({ failure, pendingKey, onRetry, onSkip }: FailureRowProps) {
  const skipKey = `skip::${failure.folderId}::${failure.relPath}`;
  const retryKey = `retry::${failure.folderId}::${failure.relPath}`;
  const isSkipped = (failure.lastError ?? "").startsWith("skipped:");
  return (
    <tr className="hover:bg-slate-50">
      <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-700" title={failure.relPath}>
        {failure.relPath}
      </td>
      <td className="px-3 py-2">
        <span className={cn(
          "rounded-full px-2 py-0.5 text-xs",
          isSkipped ? "bg-amber-100 text-amber-700" :
          failure.lastEvent === "partial" ? "bg-amber-100 text-amber-700" :
          "bg-red-100 text-red-700"
        )}>
          {isSkipped ? "已跳过" : failure.lastEvent}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">
        {failure.lastSyncDurationMs != null ? `${(failure.lastSyncDurationMs / 1000).toFixed(1)}s` : "—"}
      </td>
      <td className="max-w-sm truncate px-3 py-2 text-xs text-slate-600" title={failure.lastError ?? ""}>
        {failure.lastError ?? "—"}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right">
        <div className="flex justify-end gap-1">
          <button
            onClick={onRetry}
            disabled={pendingKey === retryKey || pendingKey === skipKey}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
          >
            {pendingKey === retryKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
            重试
          </button>
          <button
            onClick={onSkip}
            disabled={pendingKey === retryKey || pendingKey === skipKey || isSkipped}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
            title={isSkipped ? "已跳过" : "标记为跳过，不再重试"}
          >
            {pendingKey === skipKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            跳过
          </button>
        </div>
      </td>
    </tr>
  );
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 1500) return "刚刚";
  if (diff < 60_000) return `${Math.round(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  return new Date(iso).toLocaleTimeString("zh-CN");
}
