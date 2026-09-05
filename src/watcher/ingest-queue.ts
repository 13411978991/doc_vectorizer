/**
 * IngestQueue — single-process background queue that drains file ingest
 * work without blocking the watcher startup path.
 *
 * Why this exists: the previous design called `syncFolder` from inside
 * `startOne`, which meant `startOne` only returned after every file in the
 * watched folder had been ingested. For a folder with thousands of files
 * (typical real-world IT-audit repos), the watcher took a very long time
 * to "start" and the UI felt frozen. Worse, every chokidar event during
 * that window got serialized behind the same scan.
 *
 * This queue:
 *   - accepts `FileEntry` work items keyed by `${folderId}::${relPath}`
 *   - coalesces duplicate enqueues (e.g. chokidar fires add+change in quick
 *     succession on a slow disk) into a single ingest
 *   - drains with bounded concurrency per folder (default 2) so we don't
 *     fan out disk IO across thousands of files
 *   - surfaces progress via `getProgress(folderId)` for the UI
 *
 * Note: this module deliberately does NOT own the chokidar watcher or
 * the DB. The watcher keeps owning the FS watch; the queue owns the
 * ingest pipeline. The orchestrator (`syncFolder`) is still the
 * authoritative path for explicit user-triggered syncs.
 */
import { logger } from "../observability/logger.js";
import { config } from "../config/env.js";
import { ingestEntry, removeEntry, AbortError } from "./sync-orchestrator.js";
import type { FileEntry } from "./analyzer.js";
import type { SyncStats, WatchedFolderRecord } from "./types.js";

export type QueueKind = "added" | "updated" | "deleted";

export interface QueueItem {
  /** Stable key for dedupe: `${folderId}::${relPath}`. */
  key: string;
  folderId: string;
  tenantId: string;
  kind: QueueKind;
  relPath: string;
  /** Present for `added`/`updated`, omitted for `deleted`. */
  entry?: FileEntry;
  enqueuedAt: number;
}

export interface QueueProgress {
  folderId: string;
  /** True while syncFolder is still walking the filesystem and computing
   * SHA-1 hashes. UI should show "scanning N files" rather than
   * "pending M ingest work" during this phase. */
  scanning: boolean;
  pending: number;
  active: number;
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  /** Most recent error message, if any. Cleared after a successful drain. */
  lastError?: string | null;
  /**
   * Total work units (added+updated+deleted) discovered by the most
   * recent scan. 0 means "unknown" → the UI should fall back to
   * indeterminate progress. Once non-zero, the UI can derive:
   *   done = added + updated + deleted + failed
   *   percent = done / total
   * Persists across runs (lastTotal) so the bar stays on the last
   * denominator when the queue is idle.
   */
  total: number;
  /**
   * Percentage 0-100 of files processed in the current (or last)
   * sync. -1 means "indeterminate" (total unknown or queue idle).
   * Pre-computed here so every consumer doesn't have to repeat the
   * arithmetic — and so the UI can do `style="width: ${percent}%"`.
   */
  percent: number;
  /** Convenience: done count (added + updated + deleted + failed). */
  done: number;
  /** True when the queue has fully drained (no active or pending
   * work). UI can swap from "in progress" to "last completed". */
  idle: boolean;
}

interface FolderState {
  pending: Map<string, QueueItem>;
  active: number;
  added: number;
  updated: number;
  deleted: number;
  failed: number;
  scanning: boolean;
  lastError: string | null;
  /** Set when we know the folder row but haven't enqueued anything yet. */
  initialised: boolean;
  /**
   * Total work units for the in-flight (or most-recently-finished) sync.
   * 0 means "unknown" — caller should fall back to indeterminate
   * progress UI. The orchestrator sets this just before it starts
   * enqueuing the per-file work, so a single source of truth drives
   * the progress bar from "scanning → ingesting → done".
   */
  total: number;
  /** Snapshot of `total` when the queue last drained to empty. Lets
   * the UI keep showing the last-run denominator on the "completed"
   * state. */
  lastTotal: number;
  /**
   * Track files currently being processed (active ingest). Prevents
   * duplicate enqueues when the same file is detected multiple times
   * (e.g. SafeNetLOCK shared folders with unstable mtime).
   */
  processing: Set<string>;
}

export class IngestQueue {
  private readonly folders = new Map<string, FolderState>();
  private readonly perFolderConcurrency: number;
  private readonly maxQueueSizePerFolder: number;
  private readonly ingestStatsScratch = new Map<string, SyncStats>();
  /** AbortControllers keyed by folderId. destroyFolder (or removeFolder)
   *  calls .abort() so that in-flight processItem calls bail out before
   *  doing expensive IO (embedding, chunking, DB writes). */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: { perFolderConcurrency?: number; maxQueueSizePerFolder?: number } = {}) {
    this.perFolderConcurrency = options.perFolderConcurrency ?? config.INGEST_CONCURRENCY;
    this.maxQueueSizePerFolder = options.maxQueueSizePerFolder ?? 100_000;
  }

  /**
   * Mark a folder as currently scanning (filesystem walk + SHA-1). The
   * UI uses this to differentiate "still walking the tree" from "queue
   * is empty but ingest is done".
   */
  setScanning(folderId: string, scanning: boolean): void {
    this.ensureState(folderId).scanning = scanning;
  }

  /**
   * Reset counters for a folder. Used by `syncFolder` before enqueuing a
   * new batch so the returned `drainFolder` snapshot only reflects the
   * current run, not historical work.
   */
  resetCounters(folderId: string): void {
    const state = this.folders.get(folderId);
    if (!state) return;
    state.added = 0;
    state.updated = 0;
    state.deleted = 0;
    state.failed = 0;
    state.lastError = null;
    this.ingestStatsScratch.delete(folderId);
  }

  /**
   * Enqueue an ingest work item. If an item with the same key is already
   * pending, it is replaced with the newer one (we always want the latest
   * mtime/sha1).
   *
   * If the queue is full (default 100k items per folder), the oldest
   * pending items are dropped — we prefer to ingest recent state over
   * historical state under sustained heavy churn.
   *
   * If the file is currently being processed (in `processing` set), skip
   * enqueue to avoid duplicate concurrent processing (e.g. SafeNetLOCK
   * shared folders with unstable mtime triggering multiple events).
   */
  enqueue(item: QueueItem): void {
    const state = this.ensureState(item.folderId);
    
    // Skip if file is currently being processed to avoid duplicate
    // concurrent PowerShell/Excel instances competing for COM resources
    if (state.processing.has(item.key)) {
      logger.debug(
        { folderId: item.folderId, key: item.key },
        "ingest-queue: skipping enqueue, file already being processed"
      );
      return;
    }
    
    if (state.pending.size >= this.maxQueueSizePerFolder) {
      const oldestKey = state.pending.keys().next().value;
      if (oldestKey !== undefined) {
        state.pending.delete(oldestKey);
        logger.warn(
          { folderId: item.folderId, dropped: oldestKey },
          "ingest-queue: dropping oldest pending item (queue full)"
        );
      }
    }
    state.pending.set(item.key, item);
    this.scheduleDrain(item.folderId);
  }

  /**
   * Wait until the queue has drained for the given folder (no pending
   * items, no in-flight items). Returns the final progress snapshot.
   *
   * Used by `syncFolder` so that explicit user-triggered syncs still
   * block until all files have been ingested (preserving the existing
   * sync-run lifecycle semantics), while startup scans no longer block
   * because they fire-and-forget.
   */
  async drainFolder(folderId: string): Promise<QueueProgress> {
    const ctrl = this.abortControllers.get(folderId);
    for (;;) {
      const progress = this.getProgress(folderId);
      if (progress.pending === 0 && progress.active === 0) {
        this.rememberTotal(folderId);
        return progress;
      }
      // If the folder was removed/stopped, the AbortController will be
      // signalled. Exit immediately instead of spinning forever.
      if (ctrl?.signal.aborted) {
        return this.getProgress(folderId);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Remove all pending and in-progress items for a folder. The
   * AbortController is signalled first so in-flight processItem calls
   * drop out before doing expensive IO (embedding, chunking, DB writes).
   * Already-running ingestEntry calls will complete but their result is
   * discarded because the FolderState is gone.
   */
  removeFolder(folderId: string): void {
    const ctrl = this.abortControllers.get(folderId);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(folderId);
    }
    this.folders.delete(folderId);
    this.ingestStatsScratch.delete(folderId);
  }

  getProgress(folderId: string): QueueProgress {
    const state = this.folders.get(folderId);
    if (!state) {
      return {
        folderId,
        scanning: false,
        pending: 0,
        active: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        lastError: null,
        total: 0,
        percent: -1,
        done: 0,
        idle: true
      };
    }
    const done = state.added + state.updated + state.deleted + state.failed;
    // Use the run's total if we know it, otherwise the last completed
    // run's total so the bar can still render the previous denominator.
    const denominator = state.total > 0 ? state.total : state.lastTotal;
    const idle = state.pending.size === 0 && state.active === 0;
    const percent = denominator > 0
      ? Math.max(0, Math.min(100, Math.round((done / denominator) * 100)))
      : -1;
    return {
      folderId,
      scanning: state.scanning,
      pending: state.pending.size,
      active: state.active,
      added: state.added,
      updated: state.updated,
      deleted: state.deleted,
      failed: state.failed,
      lastError: state.lastError,
      total: denominator,
      percent,
      done,
      idle
    };
  }

  /**
   * Update the total expected-work-units for a folder's current sync.
   * Called by the orchestrator after scan completes (so we know
   * added+updated+deleted) and before any ingest starts. Idempotent.
   */
  setTotal(folderId: string, total: number): void {
    const state = this.ensureState(folderId);
    state.total = Math.max(0, total);
  }

  /**
   * Snapshot the current total into lastTotal. Called by the queue
   * itself when it drains to empty, so subsequent polls keep showing
   * the denominator even after the run row flips to "completed".
   */
  rememberTotal(folderId: string): void {
    const state = this.folders.get(folderId);
    if (!state) return;
    if (state.total > 0) {
      state.lastTotal = state.total;
    }
  }

  getAllProgress(): QueueProgress[] {
    const out: QueueProgress[] = [];
    for (const folderId of this.folders.keys()) {
      out.push(this.getProgress(folderId));
    }
    return out;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private ensureState(folderId: string): FolderState {
    let state = this.folders.get(folderId);
    if (!state) {
      state = {
        pending: new Map(),
        active: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        failed: 0,
        scanning: false,
        lastError: null,
        initialised: true,
        total: 0,
        lastTotal: 0,
        processing: new Set()
      };
      this.folders.set(folderId, state);
      // Create a fresh AbortController for this folder. If a previous
      // one was aborted, we replace it so the new drain cycle can run.
      this.abortControllers.set(folderId, new AbortController());
    }
    return state;
  }

  /**
   * Schedule a drain pass for a folder. Coalesces concurrent schedule
   * calls (chokidar events arrive in bursts) into a single microtask.
   */
  private scheduleDrain(folderId: string): void {
    const state = this.folders.get(folderId);
    if (!state) return;
    if (state.active >= this.perFolderConcurrency) return;
    if (state.pending.size === 0) return;
    // Microtask scheduling keeps drain order predictable and avoids
    // recursive call stacks if a synchronous enqueue triggers another.
    queueMicrotask(() => {
      void this.drain(folderId);
    });
  }

  private async drain(folderId: string): Promise<void> {
    const state = this.folders.get(folderId);
    if (!state) return;
    while (state.active < this.perFolderConcurrency && state.pending.size > 0) {
      const item = state.pending.values().next().value;
      if (!item) return;
      state.pending.delete(item.key);
      state.active += 1;
      // Don't await inside the while loop — fire and continue so we
      // pick up the next item immediately.
      void this.processItem(state, item).finally(() => {
        state.active -= 1;
        if (state.pending.size > 0) {
          this.scheduleDrain(folderId);
        }
      });
    }
  }

  private async processItem(state: FolderState, item: QueueItem): Promise<void> {
    // Check if the folder has been removed/stopped before we do any IO.
    const ctrl = this.abortControllers.get(item.folderId);
    if (ctrl?.signal.aborted) {
      return;
    }
    
    // Check if this file is already being processed (prevents duplicate
    // concurrent processing when SafeNetLOCK causes mtime changes)
    if (state.processing.has(item.key)) {
      logger.info(
        { folderId: item.folderId, relPath: item.relPath },
        "ingest-queue: skipping duplicate processing (already in progress)"
      );
      return;
    }
    
    // Mark this file as being processed
    state.processing.add(item.key);
    
    const folder = await loadFolderForQueue(item.folderId, item.tenantId);
    if (!folder) {
      // Folder was deleted while the item was queued — drop silently.
      state.processing.delete(item.key);
      return;
    }
    // Re-check after the async DB load — the folder might have been
    // stopped during the await.
    if (ctrl?.signal.aborted) {
      state.processing.delete(item.key);
      return;
    }
    const stats = this.ingestStatsScratch.get(folder.id) ?? {
      added: 0,
      updated: 0,
      deleted: 0,
      failed: 0
    };
    try {
      if (item.kind === "deleted") {
        const ok = await removeEntry(folder, item.relPath);
        if (ok) {
          stats.deleted += 1;
          state.deleted += 1;
        }
      } else if (item.entry) {
        try {
          const ok = await ingestEntry(folder, item.entry, stats, item.kind, ctrl?.signal);
          if (ok) {
            if (item.kind === "added") {
              stats.added += 1;
              state.added += 1;
            } else if (item.kind === "updated") {
              stats.updated += 1;
              state.updated += 1;
            }
            state.lastError = null;
          } else {
            state.failed += 1;
          }
        } catch (error) {
          // Only treat the error as a "paused folder" event when it was
          // EXPLICITLY marked so by the ingest pipeline (AbortError
          // instances, or objects with .isAbort set). Message-text
          // matching is too broad — LLM/embedding client code wraps
          // every fetch timeout in a plain AbortError with a message
          // like "llm request aborted: timed out after 60000ms", and
          // treating those as "paused" would silently hide real
          // network/gateway failures.
          //
          // OperationCanceledException (some .NET / sqlite drivers)
          // is NOT explicitly marked by our pipeline, so we do treat
          // it as a likely-paused case — but ONLY when the upstream
          // AbortSignal was actually fired (signal?.aborted is true).
          // Otherwise it must surface as a real failure so the user
          // sees it.
          const errAny = error as Error & { isAbort?: boolean; signal?: { aborted?: boolean } };
          const errMsg = errAny?.message ?? "";
          const errName = errAny?.name ?? "";
          const explicitlyAborted =
            error instanceof AbortError ||
            errAny?.isAbort === true ||
            errName === "IngestAbortError";
          const signalFired = errAny?.signal?.aborted === true;
          if (explicitlyAborted) {
            logger.info(
              { folderId: item.folderId, relPath: item.relPath, reason: errMsg, errName },
              "ingest-queue: item dropped (folder paused)"
            );
            return;
          }
          if (errName === "OperationCanceledException" && signalFired) {
            logger.info(
              { folderId: item.folderId, relPath: item.relPath, reason: errMsg, errName },
              "ingest-queue: item dropped (signal fired, .NET driver reported cancel)"
            );
            return;
          }
          state.failed += 1;
          state.lastError = errMsg;
          // Mirror sync-orchestrator's structured error log so a
          // future "aborted" incident gives us name/stack instead of
          // just message text.
          const inner = error as Error & { code?: string; errno?: number };
          logger.error(
            {
              folderId: item.folderId,
              relPath: item.relPath,
              error: state.lastError,
              errorName: inner?.name,
              errorStack: inner?.stack,
              errorCode: inner?.code,
              errorErrno: inner?.errno
            },
            "ingest-queue: item failed"
          );
        }
      } else {
        // Defensive: kind is added/updated but no entry. Skip.
        state.failed += 1;
      }
    } catch (error) {
      // Outer catch only fires for non-ingestEntry failures (e.g. the
      // upsertManifest call after a successful ingest). The
      // ingestEntry AbortError is rethrown by the inner catch's
      // explicit `throw err;`, so it lands here.
      if (error instanceof AbortError || (error as Error & { isAbort?: boolean })?.isAbort) {
        return;
      }
      state.failed += 1;
      state.lastError = (error as Error).message;
      const outer = error as Error & { code?: string; errno?: number };
      logger.error(
        {
          folderId: item.folderId,
          relPath: item.relPath,
          error: state.lastError,
          errorName: outer?.name,
          errorStack: outer?.stack,
          errorCode: outer?.code,
          errorErrno: outer?.errno
        },
        "ingest-queue: item failed"
      );
    } finally {
      // Clean up processing set to allow future re-queue
      state.processing.delete(item.key);
      this.ingestStatsScratch.set(item.folderId, stats);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Lazy import the manifest store so we don't introduce a circular dep
 * (manifest-store → ... → sync-orchestrator → ingest-queue → manifest-store).
 */
async function loadFolderForQueue(folderId: string, tenantId: string): Promise<WatchedFolderRecord | null> {
  const { getFolder } = await import("./manifest-store.js");
  return getFolder(folderId, tenantId);
}

export const ingestQueue = new IngestQueue();