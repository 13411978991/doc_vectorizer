/**
 * PerformanceSettingsView — stage 1 productization.
 *
 * Why this exists:
 *   The previous product feedback was "threading can't be tuned". Before
 *   this component, every concurrency / timeout knob lived in .env and
 *   required a process restart. The backend now exposes
 *   `ai_provider_settings.metadata.performance` as a live-editable JSONB
 *   row (see src/services/performance-settings-service.ts). This view is
 *   the UI for that row.
 *
 * What it does:
 *   - 3 preset profiles (Low / Balanced / Aggressive) that resolve to a
 *     full preset set of values; user can override individual sliders.
 *   - 7 sliders backed by integer bounds returned by the backend
 *     (`/api/settings/performance` returns bounds too so we don't have
 *     to keep two copies of the limits in sync).
 *   - PUT writes profile + overrides; service merges so un-touched
 *     fields keep their preset values.
 *   - "Reset to defaults" calls `/reset` which clears the DB row, falling
 *     back to env defaults.
 *   - "fromDatabase" badge tells the user whether their values come from
 *     the DB or env defaults — useful when triaging "why isn't my .env
 *     change taking effect".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Save, Sliders, Zap } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type {
  PerformanceBounds,
  PerformanceProfile,
  PublicPerformanceSettings
} from "../types";

interface ProfileMeta {
  id: PerformanceProfile;
  label: string;
  tagline: string;
  emoji: string;
}

const PROFILES: ProfileMeta[] = [
  { id: "low", label: "低占用", tagline: "老旧机器 / 后台跑", emoji: "🐢" },
  { id: "balanced", label: "平衡", tagline: "默认推荐", emoji: "⚖️" },
  { id: "aggressive", label: "激进", tagline: "大机器 / 离线任务", emoji: "🚀" }
];

interface SliderRowProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}

function SliderRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange
}: SliderRowProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-slate-800">{label}</label>
        <span className="text-sm tabular-nums text-slate-600">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500 disabled:opacity-50"
      />
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );
}

interface PerformanceSettingsViewProps {
  className?: string;
}

export function PerformanceSettingsView({ className }: PerformanceSettingsViewProps) {
  const [settings, setSettings] = useState<PublicPerformanceSettings | null>(null);
  const [bounds, setBounds] = useState<PerformanceBounds | null>(null);
  const [draft, setDraft] = useState<PublicPerformanceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.getPerformanceSettings();
      setSettings(result.settings);
      setBounds(result.bounds);
      // If the user hasn't made any local edits, also sync the draft
      // — otherwise we'd stomp over their in-progress slider nudges.
      // Compare against the freshly-fetched server payload (not the
      // closed-over `settings`), so this callback's identity stays
      // stable and the parent useEffect doesn't re-fire endlessly.
      setDraft((prev) => {
        if (!prev) return result.settings;
        const fresh = result.settings;
        const isPristine =
          prev.profile === fresh.profile &&
          prev.ingestConcurrency === fresh.ingestConcurrency &&
          prev.embeddingBatchConcurrency === fresh.embeddingBatchConcurrency &&
          prev.watcherMaxConcurrent === fresh.watcherMaxConcurrent &&
          prev.embeddingTimeoutMs === fresh.embeddingTimeoutMs &&
          prev.llmTimeoutMs === fresh.llmTimeoutMs &&
          prev.llmThreads === fresh.llmThreads &&
          prev.maxFileBytes === fresh.maxFileBytes &&
          prev.tombstoneRetentionDays === fresh.tombstoneRetentionDays &&
          prev.maxSheetRows === fresh.maxSheetRows &&
          prev.maxSheetCols === fresh.maxSheetCols;
        return isPristine ? result.settings : prev;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []); // intentionally empty — initial mount only

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!settings || !draft) return false;
    return (
      settings.profile !== draft.profile ||
      settings.ingestConcurrency !== draft.ingestConcurrency ||
      settings.embeddingBatchConcurrency !== draft.embeddingBatchConcurrency ||
      settings.watcherMaxConcurrent !== draft.watcherMaxConcurrent ||
      settings.embeddingTimeoutMs !== draft.embeddingTimeoutMs ||
      settings.llmTimeoutMs !== draft.llmTimeoutMs ||
      settings.llmThreads !== draft.llmThreads ||
      settings.maxFileBytes !== draft.maxFileBytes ||
      settings.tombstoneRetentionDays !== draft.tombstoneRetentionDays ||
      settings.maxSheetRows !== draft.maxSheetRows ||
      settings.maxSheetCols !== draft.maxSheetCols
    );
  }, [settings, draft]);

  const applyProfile = useCallback(
    (profile: PerformanceProfile) => {
      // Switching profiles reapplies the preset values without losing
      // any in-progress slider nudges the user hasn't committed yet
      // (those live in `draft` and are about to be overwritten by the
      // preset — that's the user's intent when picking a preset).
      if (!bounds) return;
      const preset: Record<PerformanceProfile, Omit<PublicPerformanceSettings, "fromDatabase" | "updatedAt">> = {
        low: {
          profile,
          ingestConcurrency: 1,
          embeddingBatchConcurrency: 1,
          watcherMaxConcurrent: 1,
          embeddingTimeoutMs: 60_000,
          llmTimeoutMs: 120_000,
          llmThreads: 4,
          maxFileBytes: 50 * 1024 * 1024,
          tombstoneRetentionDays: 7,
          maxSheetRows: 50,
          maxSheetCols: 26
        },
        balanced: {
          profile,
          ingestConcurrency: 1,
          embeddingBatchConcurrency: 5,
          watcherMaxConcurrent: 1,
          embeddingTimeoutMs: 30_000,
          llmTimeoutMs: 60_000,
          llmThreads: 4,
          maxFileBytes: 200 * 1024 * 1024,
          tombstoneRetentionDays: 7,
          maxSheetRows: 200,
          maxSheetCols: 26
        },
        aggressive: {
          profile,
          ingestConcurrency: 3,
          embeddingBatchConcurrency: 10,
          watcherMaxConcurrent: 2,
          embeddingTimeoutMs: 20_000,
          llmTimeoutMs: 45_000,
          llmThreads: 8,
          maxFileBytes: 500 * 1024 * 1024,
          tombstoneRetentionDays: 3,
          maxSheetRows: 500,
          maxSheetCols: 50
        }
      };
      setDraft((prev) => ({
        ...(prev ?? settings!),
        ...preset[profile]
      }));
    },
    [bounds, settings]
  );

  const save = useCallback(async () => {
    if (!draft || !settings) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.updatePerformanceSettings({
        profile: draft.profile,
        overrides: {
          ingestConcurrency: draft.ingestConcurrency,
          embeddingBatchConcurrency: draft.embeddingBatchConcurrency,
          watcherMaxConcurrent: draft.watcherMaxConcurrent,
          embeddingTimeoutMs: draft.embeddingTimeoutMs,
          llmTimeoutMs: draft.llmTimeoutMs,
          llmThreads: draft.llmThreads,
          maxFileBytes: draft.maxFileBytes,
          tombstoneRetentionDays: draft.tombstoneRetentionDays,
          maxSheetRows: draft.maxSheetRows,
          maxSheetCols: draft.maxSheetCols
        }
      });
      setSettings(result.settings);
      setDraft(result.settings);
      // LLM threads no longer trigger a model reload — Plan B retired the GGUF
      // path so changing this field has no runtime effect. We just save.
      const threadsChanged =
        draft.llmThreads !== settings.llmThreads;
      if (threadsChanged) {
        setSuccess("已保存。LLM 线程数字段已更新（Plan B 已退役 LLM，无运行时效果）。");
      } else {
        setSuccess("已保存。下次 watcher / ingest 调用即生效。");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, settings]);

  const reset = useCallback(async () => {
    setResetting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await api.resetPerformanceSettings();
      setSettings(result.settings);
      setDraft(result.settings);
      setSuccess("已重置为环境变量默认值。");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setResetting(false);
    }
  }, []);

  if (loading || !draft || !bounds || !settings) {
    return (
      <div className={cn("flex h-full items-center justify-center", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className={cn("flex h-full flex-col overflow-y-auto bg-slate-50", className)}>
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <header className="flex items-start justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
              <Sliders className="h-5 w-5 text-slate-500" />
              性能设置
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              调整并发、超时、文件大小上限。改动写入数据库，立即生效，无需重启。
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs",
                settings.fromDatabase
                  ? "bg-blue-100 text-blue-700"
                  : "bg-slate-100 text-slate-500"
              )}
            >
              {settings.fromDatabase ? "数据库配置" : "环境变量默认值"}
            </span>
            <span className="text-xs text-slate-400">
              更新于 {new Date(settings.updatedAt).toLocaleString("zh-CN")}
            </span>
            <button
              type="button"
              onClick={() => load({ silent: true })}
              disabled={refreshing || saving || resetting}
              title="重新读取服务器上的当前配置"
              className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {refreshing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              刷新
            </button>
          </div>
        </header>

        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {success}
          </div>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-700">预设方案</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PROFILES.map((p) => (
              <button
                key={p.id}
                onClick={() => applyProfile(p.id)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition",
                  draft.profile === p.id
                    ? "border-blue-400 bg-blue-50 text-blue-900"
                    : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                )}
              >
                <div className="text-base">
                  <span className="mr-1">{p.emoji}</span>
                  <span className="font-medium">{p.label}</span>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{p.tagline}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-700">细调</h2>

          <SliderRow
            label="单文件并行度"
            hint="单文件被切成多个 batch 后，batch 之间并行调用 embedding 的并发数。"
            value={draft.embeddingBatchConcurrency}
            min={bounds.embeddingBatchConcurrency.min}
            max={bounds.embeddingBatchConcurrency.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 路并行`}
            onChange={(v) => setDraft({ ...draft, embeddingBatchConcurrency: v })}
          />

          <SliderRow
            label="文件夹内并发文件数"
            hint="同一文件夹下同时处理的文件数。xlsx COM 解析建议保持 1。"
            value={draft.ingestConcurrency}
            min={bounds.ingestConcurrency.min}
            max={bounds.ingestConcurrency.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 个文件`}
            onChange={(v) => setDraft({ ...draft, ingestConcurrency: v })}
          />

          <SliderRow
            label="监听器并发"
            hint="多个文件夹并行同步的文件夹数。一般 1 个足够。"
            value={draft.watcherMaxConcurrent}
            min={bounds.watcherMaxConcurrent.min}
            max={bounds.watcherMaxConcurrent.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 个文件夹`}
            onChange={(v) => setDraft({ ...draft, watcherMaxConcurrent: v })}
          />

          <SliderRow
            label="Embedding 超时"
            hint="单次 embedding API/ONNX 前向调用的最大等待时间。超时后会失败重试。"
            value={draft.embeddingTimeoutMs}
            min={bounds.embeddingTimeoutMs.min}
            max={bounds.embeddingTimeoutMs.max}
            step={1000}
            disabled={saving}
            format={(v) => `${(v / 1000).toFixed(0)} 秒`}
            onChange={(v) => setDraft({ ...draft, embeddingTimeoutMs: v })}
          />

          <SliderRow
            label="Rerank 超时（兼容字段）"
            hint="单次 qwen3-rerank 调用的最大等待时间。LLM 路径已退役，但字段保留以便向后兼容。"
            value={draft.llmTimeoutMs}
            min={bounds.llmTimeoutMs.min}
            max={bounds.llmTimeoutMs.max}
            step={1000}
            disabled={saving}
            format={(v) => `${(v / 1000).toFixed(0)} 秒`}
            onChange={(v) => setDraft({ ...draft, llmTimeoutMs: v })}
          />

          <SliderRow
            label="并发实体/事件抽取的线程数（兼容字段）"
            hint={`Plan B 已退役 LLM 抽取路径，本字段仅在 settings 表里保留以便向后兼容；当前无运行时效果。实际并发抽取请通过 ingestConcurrency（单切片并发）控制。`}
            value={draft.llmThreads}
            min={bounds.llmThreads.min}
            max={bounds.llmThreads.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 线程`}
            onChange={(v) => setDraft({ ...draft, llmThreads: v })}
          />

          <SliderRow
            label="单文件大小上限"
            hint="超过此大小的文件会被跳过（记录为 skipped）。"
            value={draft.maxFileBytes}
            min={bounds.maxFileBytes.min}
            max={bounds.maxFileBytes.max}
            step={10 * 1024 * 1024}
            disabled={saving}
            format={(v) => formatBytes(v)}
            onChange={(v) => setDraft({ ...draft, maxFileBytes: v })}
          />

          <SliderRow
            label="已删除文件保留天数"
            hint="文件被删除后，manifest 记录保留多少天后才物理删除。0 = 立即清理。"
            value={draft.tombstoneRetentionDays}
            min={bounds.tombstoneRetentionDays.min}
            max={bounds.tombstoneRetentionDays.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 天`}
            onChange={(v) => setDraft({ ...draft, tombstoneRetentionDays: v })}
          />
        </section>

        <section className="space-y-5 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-medium text-slate-700">Excel / CSV 抽取上限</h2>
          <p className="text-xs text-slate-500 -mt-3">
            每个 xlsx/xls/csv 工作表在转 markdown 时最多保留的行数和列数。超出部分会丢弃并在末尾追加
            <code className="mx-1 rounded bg-slate-100 px-1">truncated: ...</code>
            标记。改动对下次入库生效，已抽取的 chunk 不会重切。
          </p>

          <SliderRow
            label="单表最多行数"
            hint="每个 sheet 的最大行数（保留表头）。审计底稿 200 行基本够用；财务报表建议 500+。"
            value={draft.maxSheetRows}
            min={bounds.maxSheetRows.min}
            max={bounds.maxSheetRows.max}
            step={10}
            disabled={saving}
            format={(v) => `${v} 行`}
            onChange={(v) => setDraft({ ...draft, maxSheetRows: v })}
          />

          <SliderRow
            label="单表最多列数"
            hint="每个 sheet 的最大列数（Excel 默认 26，A-Z）。宽表 50 列能覆盖大部分审计矩阵。"
            value={draft.maxSheetCols}
            min={bounds.maxSheetCols.min}
            max={bounds.maxSheetCols.max}
            step={1}
            disabled={saving}
            format={(v) => `${v} 列`}
            onChange={(v) => setDraft({ ...draft, maxSheetCols: v })}
          />
        </section>

        <footer className="flex items-center justify-between gap-2">
          <button
            onClick={reset}
            disabled={resetting || saving}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            重置为默认值
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving || resetting}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white",
              dirty && !saving
                ? "bg-blue-600 hover:bg-blue-700"
                : "cursor-not-allowed bg-slate-300"
            )}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存
          </button>
        </footer>

        <p className="flex items-start gap-2 text-xs text-slate-500">
          <Zap className="mt-0.5 h-3 w-3 flex-shrink-0" />
          这些值是"运行时的最佳猜测"——实际表现还取决于 embedding 模型速度、网络、文件类型。建议先用 Balanced，跑了 100 个文件后再按需调整。
        </p>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
