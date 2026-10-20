/**
 * JobsStatusStrip — compact status badge that sits in the page header.
 *
 * Polls `/api/jobs/overview` every 4s (slower than the full panel so
 * we don't double-fire requests). On click, opens a drawer with the
 * full JobsOverviewView.
 *
 * Why a strip + drawer instead of a dedicated workspace view:
 *   Users reported "the app hangs but I don't know where". The strip
 *   makes the queue status *always visible*, so they see "12 pending,
 *   3 active" even while looking at a document. One click gets the
 *   full troubleshooting view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { JobsOverviewView } from "./JobsOverviewView";
import type { JobsOverview } from "../types";

const POLL_INTERVAL_MS = 4_000;

export function JobsStatusStrip({ className }: { className?: string }) {
  const [overview, setOverview] = useState<JobsOverview | null>(null);
  const [open, setOpen] = useState(false);
  const mountedRef = useRef(true);

  const tick = useCallback(async () => {
    try {
      const data = await api.getJobsOverview();
      if (!mountedRef.current) return;
      setOverview(data);
    } catch {
      // Strip is best-effort; the full panel surfaces the error.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [tick]);

  if (!overview) {
    return null;
  }

  const { pending, active, failed } = overview.aggregate;
  const hasIssues = failed > 0;
  const hasWork = active > 0 || pending > 0;

  const tone = hasIssues
    ? "bg-red-50 text-red-700 border-red-200"
    : hasWork
    ? "bg-blue-50 text-blue-700 border-blue-200"
    : "bg-slate-50 text-slate-600 border-slate-200";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          // When the parent gives us flex-1 (the sidebar header does)
          // we want the button to truncate the long label rather than
          // push the trailing icon buttons off the row.
          "inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium hover:opacity-90",
          tone,
          className
        )}
        title="点击查看实时任务面板"
      >
        {hasIssues ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        ) : hasWork ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        )}
        <Activity className="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span className="truncate">
          {hasIssues ? `${failed} 失败` : hasWork ? `${active} 进行中 · ${pending} 排队` : "队列空闲"}
        </span>
        {failed > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-red-100 px-1.5 text-red-700">{failed}</span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="flex-1 bg-black/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="flex h-full w-full max-w-3xl flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
              <span className="text-sm font-medium text-slate-700">实时任务面板</span>
              <button
                onClick={() => setOpen(false)}
                className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <JobsOverviewView className="flex-1" />
          </div>
        </div>
      )}
    </>
  );
}
