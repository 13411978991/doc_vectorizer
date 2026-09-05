/**
 * useRetryStatus — single-flight retry state + toast notifications for
 * the Watched Folders detail page.
 *
 * Two retry paths share it:
 *  - per-file retry (one relPath at a time)
 *  - bulk retry ("retry all failed")
 *
 * The hook exposes a small API to the rest of the page:
 *   - startFileRetry(relPath) / finishFileRetry(relPath, ok, msg)
 *   - startBulkRetry() / finishBulkRetry(ok, msg)
 *   - isRowRetrying(relPath)  → for the per-row button spinner
 *   - isBulkRetrying (bool)   → for the "Retry all failed" button
 *   - toasts                   → list of active toasts
 *
 * Why this lives in its own hook:
 *   - the per-row "loading" state must be reactive (button shows
 *     spinner) but the surrounding `busy` flag in WatchedFolderDetails
 *     is too coarse — it locks the whole detail page.
 *   - toasts need a queue + auto-dismiss timer; we'd rather not embed
 *     that timer logic in the 1500-line page.
 */
import { useCallback, useMemo, useRef, useState } from "react";

export type ToastKind = "info" | "success" | "error";
export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
  /** When the toast expires; null = permanent (not used yet). */
  expiresAt: number;
}

const TOAST_TTL_MS = 4000;

let toastCounter = 0;
function nextToastId(): string {
  toastCounter += 1;
  return `t-${Date.now()}-${toastCounter}`;
}

export interface RetryStatus {
  // Set of relPaths that are currently being retried (in-flight HTTP call).
  inflightRows: Set<string>;
  /** True while a bulk retry (POST /retry-failed) is in-flight. */
  bulkInflight: boolean;
  /** Active toasts the UI should render. */
  toasts: Toast[];

  isRowRetrying(relPath: string): boolean;
  /** True while a bulk retry (POST /retry-failed) is in-flight. */
  isBulkRetrying: boolean;

  /** Mark a single-file retry as in-flight. Returns a "begin" callback. */
  withFileRetry<T>(relPath: string, fn: () => Promise<T>): Promise<T>;
  /** Mark a bulk retry as in-flight. */
  withBulkRetry<T>(fn: () => Promise<T>): Promise<T>;

  /** Push a toast onto the queue; auto-dismisses after TOAST_TTL_MS. */
  pushToast(kind: ToastKind, message: string): void;
  /** Remove a toast by id (used by the X button on the toast card). */
  dismissToast(id: string): void;
}

export function useRetryStatus(): RetryStatus {
  const [inflightRows, setInflightRows] = useState<Set<string>>(() => new Set());
  const [bulkInflight, setBulkInflight] = useState<boolean>(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // A ref of the latest toasts so the auto-dismiss timer can dedupe
  // and cancel without forcing us to wire a useEffect for every toast.
  const toastsRef = useRef<Toast[]>([]);
  toastsRef.current = toasts;

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextToastId();
      const toast: Toast = { id, kind, message, expiresAt: Date.now() + TOAST_TTL_MS };
      setToasts((current) => [...current, toast]);
      // Schedule auto-dismiss. setTimeout keeps the timer alive even if
      // the component unmounts; React will just ignore the setState
      // call when the closure is on an unmounted instance.
      window.setTimeout(() => dismissToast(id), TOAST_TTL_MS);
    },
    [dismissToast]
  );

  const withFileRetry = useCallback(
    async <T,>(relPath: string, fn: () => Promise<T>): Promise<T> => {
      setInflightRows((current) => {
        if (current.has(relPath)) {
          return current;
        }
        const next = new Set(current);
        next.add(relPath);
        return next;
      });
      try {
        return await fn();
      } finally {
        setInflightRows((current) => {
          if (!current.has(relPath)) {
            return current;
          }
          const next = new Set(current);
          next.delete(relPath);
          return next;
        });
      }
    },
    []
  );

  const withBulkRetry = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      setBulkInflight(true);
      try {
        return await fn();
      } finally {
        setBulkInflight(false);
      }
    },
    []
  );

  // isRowRetrying has to be a callback (the consumer queries it per
  // relPath), but we need to read from the live `inflightRows` state
  // — not a closure over the value at hook-creation time. We solve
  // this with a ref that's always up to date and a useMemo'd
  // function that reads the ref.
  const inflightRowsRef = useRef(inflightRows);
  inflightRowsRef.current = inflightRows;
  const isRowRetrying = useCallback(
    (relPath: string) => inflightRowsRef.current.has(relPath),
    []
  );

  // isBulkRetrying is just a value — the parent's re-render picks
  // up the fresh boolean. Returning a value (not a function) means
  // the consumer's `<DetailsManifest busy={...}>` recomputes
  // correctly each render.
  const isBulkRetrying = bulkInflight;
  return {
    inflightRows,
    bulkInflight,
    toasts,
    isRowRetrying,
    isBulkRetrying,
    withFileRetry,
    withBulkRetry,
    pushToast,
    dismissToast
  };
}
