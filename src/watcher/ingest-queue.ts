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
import { getRuntimePerformanceSettings } from "../services/performance-settings-service.js";
import { ingestEntry, removeEntry, AbortError } from "./sync-orchestrator.js";
import { DRAIN_POLL_INTERVAL_MS } from "../config/tuning-constants.js";
import type { FileEntry } from "./analyzer.js";
import type { SyncStats, WatchedFolderRecord } from "./types.js";
import path from "node:path";

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
  /**
   * P-Tier2-#13 — currently-processing file path, for the UI to show
   * "Embedding 200/200 of 0-2026…xlsx (chunk 87/120)". Null when the
   * queue is idle. Only one file is in-flight per folder so this is
   * a scalar, not a list.
   */
  currentFile?: string | null;
  /**
   * Sub-stage label for the in-flight file (e.g. "parsing",
   * "embedding", "extracting", "dbWrite"). Lets the UI render a
   * progress sub-bar without needing to parse the server log.
   */
  currentStage?: string | null;
  /**
   * Per-stage progress 0-100 for the in-flight file. Combines with
   * `total` (folder-level) so the UI can show
   *   overall: 45/100 files done (45%)
   *   current:  0-2026…xlsx, dbWrite 78%
   */
  currentPercent?: number;
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
  /** P-Tier2-#13 — currently-processing file path. */
  currentFile: string | null;
  currentStage: string | null;
  currentPercent: number;
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
  /**
   * Per-folder concurrency. Read once per drain cycle (see drain())
   * via getRuntimePerformanceSettings() so a UI tweak takes effect on
   * the next file pickup without restarting the watcher. We cache the
   * resolved value in a private field rather than re-reading per file
   * to keep the cost bounded.
   */
  private perFolderConcurrencyCached: number;
  private readonly maxQueueSizePerFolder: number;
  private readonly ingestStatsScratch = new Map<string, SyncStats>();
  /** AbortControllers keyed by folderId. destroyFolder (or removeFolder)
   *  calls .abort() so that in-flight processItem calls bail out before
   *  doing expensive IO (embedding, chunking, DB writes). */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(options: { perFolderConcurrency?: number; maxQueueSizePerFolder?: number } = {}) {
    this.perFolderConcurrencyCached = options.perFolderConcurrency ?? config.INGEST_CONCURRENCY;
    this.maxQueueSizePerFolder = options.maxQueueSizePerFolder ?? 100_000;
  }

  /**
   * Resolve the current per-folder concurrency from the live performance
   * settings service (DB-backed, env-fallback). Called once at the top of
   * every drain cycle so the queue honours UI tweaks within ~1 file of
   * latency, without paying for the cache hit per item.
   */
  private resolveConcurrency(): number {
    const live = getRuntimePerformanceSettings().ingestConcurrency;
    if (live !== this.perFolderConcurrencyCached) {
      logger.info({ from: this.perFolderConcurrencyCached, to: live }, "ingest-queue: concurrency updated");
      this.perFolderConcurrencyCached = live;
    }
    return this.perFolderConcurrencyCached;
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
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
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
      idle,
      // P-Tier2-#13 — currently-processing file. Cleared when the
      // queue becomes idle so the UI doesn't show a stale "processing
      // foo.xlsx 78%" after the run finished.
      currentFile: idle ? null : state.currentFile,
      currentStage: idle ? null : state.currentStage,
      currentPercent: idle ? 0 : state.currentPercent
    };
  }

  /**
   * P-Tier2-#13 — set the in-flight file + stage + percent so the
   * progress API can surface "what is the queue actually doing
   * right now". Called from processItem() right before invoking
   * ingestEntry(), and again from inside the IngestService progress
   * callback to update the per-stage label. A no-op when the
   * folder state is gone (queue was cleared mid-ingest).
   */
  setCurrentFile(
    folderId: string,
    relPath: string,
    stage: string,
    percent: number
  ): void {
    const state = this.folders.get(folderId);
    if (!state) return;
    state.currentFile = relPath;
    state.currentStage = stage;
    state.currentPercent = Math.max(0, Math.min(100, Math.round(percent)));
  }

  /**
   * P21 — aggregate active+pending across ALL folders. Used by
   * the /health endpoint to surface "queue is stalled" without
   * having to enumerate each folder.
   */
  getGlobalDepth(): { active: number; pending: number } {
    let active = 0;
    let pending = 0;
    for (const state of this.folders.values()) {
      active += state.active;
      pending += state.pending.size;
    }
    return { active, pending };
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

  /**
   * P-Tier3-#T3d — recover manifest rows left in `pending` by a previous
   * process. This is the "pending-orphan reaper", complementary to
   * `reapStaleSyncingManifests` in manifest-store.ts which only handles
   * `syncing` rows. Why we need a separate reaper:
   *
   *   The `syncing` reaper catches rows where the previous process
   *   crashed mid-ingest (it had time to flip status to `syncing` and
   *   write `last_sync_started_at`). The `pending` orphan is the EARLIER
   *   failure mode: a process that crashed between
   *     1. `markManifestStatus('pending')` (orchestrator planning stage)
   *     2. `ingestQueue.enqueue(item)` (worker dispatch)
   *   After such a crash the row is "ready to ingest" by intent but
   *   has no queue item to back it. Without a reaper, the only way
   *   for that file to be re-ingested is to (a) wait for the next
   *   explicit `syncFolder` call, or (b) wait for chokidar to re-emit
   *   an event for the same path. Both are unreliable on shared /
   *   network drives with stale mtime caches.
   *
   * Strategy: on boot, before HTTP starts serving traffic, find every
   * `pending` row whose `last_sync_started_at` is NULL (i.e. ingest
   * never started for it) and re-enqueue it as kind='updated'. We
   * synthesise a FileEntry from the manifest row's persisted size /
   * sha1 / mtimeMs / inode so the ingest path is a no-op-shallow
   * compare first; the actual hash compare will re-run on the worker
   * and trigger a full re-ingest only if the file's content drifted.
   *
   * Idempotency: re-enqueuing a file that has no corresponding manifest
   * row would create a duplicate document on the next ingest. We DO
   * only re-enqueue rows that already exist in the manifest, so the
   * document_id the orchestrator looks up is the SAME document the
   * previous process was about to ingest (which is null since ingest
   * never ran, but that's fine — the upsert in ingestDocument is
   * idempotent on (folder_id, rel_path)).
   *
   * Multi-tenant: pending orphans are loaded per-folder so we honour
   * the folder's tenant_id when constructing the FileEntry. The
   * manifest table itself is keyed by folder_id, so a single query
   * joined against the folder row is enough.
   *
   * Returns: the number of orphans actually re-enqueued, plus the
   * set of folders that received work so the caller can log a
   * helpful "X files re-queued across Y folders" line.
   */
  async requeuePendingOrphans(input: { tenantId: string }): Promise<{
    requeued: number;
    foldersTouched: number;
    folderIds: string[];
  }> {
    const requeuedAt = Date.now();
    const folderIdsTouched = new Set<string>();
    let requeued = 0;

    // Lazy imports to keep the manifest-store / sync-orchestrator
    // dependency arrows pointed at the queue (avoids the same
    // circular-dep dance used by loadFolderForQueue).
    const [{ getFolder }, { pool }] = await Promise.all([
      import("./manifest-store.js"),
      import("../db/pool.js")
    ]);

    // 1. List every (folder_id, rel_path) row that is `pending` with
    //    no `last_sync_started_at`. We join against the folders table
    //    to filter by tenant — a previous process may have left
    //    orphans for OTHER tenants and we must not touch them from
    //    this boot.
    //
    //    Note: SQLite schema only persists `size` and `hash` (the PG
    //    schema also has mtime_ms / inode but those were never
    //    migrated to SQLite). We therefore only pull the columns that
    //    actually exist; the worker re-stats the file to refresh
    //    mtime/inode before the hash compare.
    const candidates = await pool.query<{
      folder_id: string;
      tenant_id: string;
      rel_path: string;
      size: number | null;
      hash: string | null;
    }>(
      `
        select
          m.folder_id,
          f.tenant_id,
          m.rel_path,
          m.size,
          m.hash
        from watched_folder_manifests m
        join watched_folders f on f.id = m.folder_id
        where m.last_event = 'pending'
          and m.last_sync_started_at is null
          and f.tenant_id = $1
      `,
      [input.tenantId]
    );

    if (candidates.rowCount === 0) {
      return { requeued: 0, foldersTouched: 0, folderIds: [] };
    }

    // 2. Group by folder so we only call getFolder() once per
    //    folder. (candidates.rowCount is typically small — only
    //    orphans from the last boot — so a Map suffices.)
    const byFolder = new Map<string, typeof candidates.rows>();
    for (const row of candidates.rows) {
      const list = byFolder.get(row.folder_id) ?? [];
      list.push(row);
      byFolder.set(row.folder_id, list);
    }

    for (const [folderId, rows] of byFolder) {
      const folder = await getFolder(folderId, input.tenantId);
      if (!folder) {
        // Folder was deleted after the orphans were left behind.
        // Skip silently — the next purgeDeletedManifests sweep will
        // physically remove the orphan rows.
        logger.debug(
          { folderId, orphanCount: rows.length },
          "ingest-queue: pending-orphan reaper skipping deleted folder"
        );
        continue;
      }

      for (const row of rows) {
        // Synthesise a FileEntry from the manifest row. The
        // worker-side hash compare will trigger a real re-ingest
        // only if the file drifted since the row was written.
        // mtime/inode are not persisted on SQLite, so we leave them
        // as 0 — syncFolder's pre-stat will refresh them on the
        // first compare step inside ingestEntry.
        const entry: FileEntry = {
          relPath: row.rel_path,
          // path.posix.join is a no-op on Windows paths but keeps
          // the code portable; the worker resolves absPath back to
          // native via path.resolve before stat-ing.
          absPath: path.posix.join(folder.path, row.rel_path),
          mtimeMs: 0,
          inode: 0,
          sizeBytes: row.size ?? 0,
          sha1: row.hash ?? ""
        };

        this.enqueue({
          key: `${folderId}::${row.rel_path}`,
          folderId,
          tenantId: folder.tenantId,
          kind: "updated",
          relPath: row.rel_path,
          entry,
          enqueuedAt: requeuedAt
        });
        requeued += 1;
        folderIdsTouched.add(folderId);
      }
    }

    const folderIds = [...folderIdsTouched];
    if (requeued > 0) {
      logger.info(
        { requeued, foldersTouched: folderIds.length, folderIds },
        "ingest-queue: re-queued pending-orphan manifest rows from previous process"
      );
    } else {
      logger.debug(
        { candidates: candidates.rowCount },
        "ingest-queue: pending-orphan reaper found no eligible rows"
      );
    }
    return { requeued, foldersTouched: folderIds.length, folderIds };
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
        processing: new Set(),
        currentFile: null,
        currentStage: null,
        currentPercent: 0
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
    const concurrency = this.resolveConcurrency();
    if (state.active >= concurrency) return;
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
    const concurrency = this.resolveConcurrency();
    while (state.active < concurrency && state.pending.size > 0) {
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
          // P-Tier2-#13 — surface the in-flight file + starting stage
          // before kicking off ingestEntry. The progress callback inside
          // ingestDocument (now wired up below) updates the stage +
          // percent as it runs. Without this, the UI sees "active: 1"
          // but no way to know which file is being processed.
          this.setCurrentFile(item.folderId, item.relPath, "starting", 0);
          const onProgress = (update: { stage?: string; progress?: number }) => {
            if (update.stage || typeof update.progress === "number") {
              this.setCurrentFile(
                item.folderId,
                item.relPath,
                update.stage ?? "processing",
                update.progress ?? 0
              );
            }
          };
          const ok = await ingestEntry(folder, item.entry, stats, item.kind, ctrl?.signal, onProgress);
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