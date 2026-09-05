import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { cn } from "../../lib/utils";

/**
 * Generic paginator: prev / next / jump-to-page / page-size.
 *
 * Works for both cursor-based and offset-based endpoints. The caller
 * passes whatever the API supports and we render the relevant controls.
 * `total === 0` means "total unknown" — we hide the page-jump input
 * and just render prev/next.
 */
export interface PaginationProps {
  /** Total record count. 0 = unknown. */
  total: number;
  /** Page size used to fetch this page. */
  limit: number;
  /** Current page (0-based). UI may receive this via the parent. */
  offset?: number;
  /** When offset-based paging is used: true if there's a next page. */
  hasNext?: boolean;
  /** When offset-based paging is used: true if there's a previous page. */
  hasPrev?: boolean;
  /** When cursor-based paging is used: opaque token from the previous page. */
  nextCursor?: string | null;
  /** When cursor-based paging is used: set to null to start a new chain. */
  prevCursor?: string | null;
  /** Label shown next to the page indicator, e.g. "files" / "rows". */
  itemLabel?: string;
  /** Disable all controls (e.g. while loading). */
  disabled?: boolean;
  /** Called when the user picks a page. Receives either { offset } or { cursor }. */
  onChange: (next: { offset?: number; cursor?: string }) => void;
}

export function Pagination(props: PaginationProps) {
  const {
    total,
    limit,
    offset = 0,
    hasNext = false,
    hasPrev = false,
    nextCursor,
    itemLabel = "items",
    disabled = false,
    onChange
  } = props;

  const knownTotal = total > 0;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = knownTotal ? Math.max(1, Math.ceil(total / limit)) : 1;
  const [jumpTo, setJumpTo] = React.useState<string>("");
  const [pageSize, setPageSize] = React.useState<string>(String(limit));

  // Reset local state if the upstream limit changes.
  React.useEffect(() => {
    setPageSize(String(limit));
  }, [limit]);

  const applyJump = () => {
    const n = Number(jumpTo);
    if (!Number.isFinite(n) || n < 1) return;
    const targetOffset = (n - 1) * limit;
    onChange({ offset: targetOffset });
    setJumpTo("");
  };

  const applyPageSize = () => {
    const n = Number(pageSize);
    if (!Number.isFinite(n) || n < 1) return;
    if (n === limit) return;
    // Changing the page size resets to page 1 (offset = 0).
    onChange({ offset: 0 });
    // The caller is expected to also re-fetch with the new limit. We
    // expose the new size via a custom event so the parent can listen.
    window.dispatchEvent(
      new CustomEvent("pagination:limit-change", { detail: { limit: n } })
    );
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-2 py-3 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>
          {knownTotal ? (
            <>
              第 <strong className="text-foreground">{currentPage}</strong> / {totalPages} 页 · 共 {total.toLocaleString()} {itemLabel}
            </>
          ) : (
            <>显示当前页 {itemLabel}</>
          )}
        </span>
        <span className="hidden sm:inline-block">·</span>
        <label className="hidden items-center gap-1 sm:flex">
          每页
          <Input
            type="number"
            min={1}
            max={500}
            value={pageSize}
            onChange={(e) => setPageSize(e.target.value)}
            onBlur={applyPageSize}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyPageSize();
              }
            }}
            className="h-7 w-16 text-center"
            disabled={disabled}
          />
          条
        </label>
      </div>
      <div className="flex items-center gap-2">
        {knownTotal && totalPages > 1 ? (
          <label className="flex items-center gap-1">
            跳到
            <Input
              type="number"
              min={1}
              max={totalPages}
              value={jumpTo}
              placeholder={String(currentPage)}
              onChange={(e) => setJumpTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyJump();
                }
              }}
              className="h-7 w-16 text-center"
              disabled={disabled}
            />
            页
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={applyJump}
              disabled={disabled || !jumpTo}
            >
              跳转
            </Button>
          </label>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ offset: Math.max(0, offset - limit) })}
          disabled={disabled || (!hasPrev && offset === 0)}
          title="上一页"
        >
          ‹ 上一页
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => nextCursor ? onChange({ cursor: nextCursor }) : onChange({ offset: offset + limit })}
          disabled={disabled || (!hasNext && !nextCursor)}
          title="下一页"
        >
          下一页 ›
        </Button>
      </div>
    </div>
  );
}

/**
 * Indeterminate / determinate progress bar. When `percent === -1`
 * the bar shows a moving shimmer; otherwise a solid fill.
 */
export interface ProgressBarProps {
  percent: number; // 0..100, or -1 for indeterminate
  label?: string;
  detail?: string;
  className?: string;
}

export function ProgressBar({ percent, label, detail, className }: ProgressBarProps) {
  const indeterminate = percent < 0;
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {(label || detail) && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          {label ? <span>{label}</span> : <span />}
          {detail ? <span className="font-mono">{detail}</span> : null}
        </div>
      )}
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
        {indeterminate ? (
          <div
            className="absolute inset-y-0 left-0 w-1/3 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-primary/60"
            style={{ animation: "pagination-shimmer 1.4s linear infinite" }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
      <style>{`
        @keyframes pagination-shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}