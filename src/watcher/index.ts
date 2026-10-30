import * as chokidar from "chokidar";
import { createRequire } from "node:module";
import { config } from "../config/env.js";
import { getRuntimePerformanceSettings } from "../services/performance-settings-service.js";
import { embeddingClient } from "../ai/embedding-client.js";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";
import { syncFolder, syncFolderWith } from "./sync-orchestrator.js";
import { ingestQueue, type QueueItem } from "./ingest-queue.js";
import { scanFolder, enumerateWatchTargets, expandToAncestors } from "./analyzer.js";
import { computeSha1, getInode } from "./analyzer.js";
import { makeChokidarIgnoredPredicate, normalizeWatchKey } from "./scan-exclusions.js";
import { DEFAULT_SUPPORTED_EXTENSIONS } from "./types.js";
import { getFolder, getLatestSyncRun, getManifest, resetManifestForRetry, listFailedManifestEntries, purgeDeletedManifests } from "./manifest-store.js";
import { sweepStartupOrphans } from "./com-decrypt.js";
import type { WatchedFolderRecord } from "./types.js";

/**
 * WatcherManager — one chokidar FSWatcher per watched folder, plus the
 * debounced sync dispatcher. This is the runtime entry point for the
 * "watch a folder" feature.
 *
 * Sprint 1 deliberately keeps the API surface small:
 *   - startAll / startOne / stopOne / stopAll
 *   - an explicit production gate (NODE_ENV=production requires
 *     ALLOW_PROD_WATCHER=true)
 *   - a preflight embedding probe + periodic health probes. If the
 *     configured embedding endpoint stops responding, the watcher
 *     auto-stops itself so the user gets a clear "watcher paused:
 *     embedding API unreachable" signal instead of a silent backlog
 *     of failed ingests.
 *
 * On startup we trigger a full scan for every folder (trigger=`startup`)
 * before attaching the watcher, so the initial state of the folder is
 * caught up even if events are missed while the process was down.
 */
/**
 * How long we are willing to wait for chokidar's `ready` event before
 * giving up and continuing without it.
 *
 * On a normal folder this is sub-second. On a drive-root watch
 * (E:\ = 311,978 files / 42,950 directories) chokidar's initial
 * enumeration used to take longer than any reasonable wait, and
 * awaiting it forever wedged the API (health endpoint stopped
 * answering, "start watcher" request never returned). 120 s is long
 * enough for a legitimately slow enumeration and short enough that a
 * stuck one degrades to "watcher still starting" rather than "the
 * whole backend is frozen".
 */
const CHOKIDAR_READY_TIMEOUT_MS = 120_000;

export class WatcherManager {
  private readonly watchers = new Map<string, chokidar.FSWatcher>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly healthTimers = new Map<string, NodeJS.Timeout>();
  private readonly rescanTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Live, mutable set of directories chokidar may watch, per folder.
   *
   * The `ignored` predicate closes over this exact Set instance, so
   * adding a key here immediately makes chokidar willing to descend
   * into that directory. The periodic rescan uses it to pick up
   * directories that appeared after startup.
   */
  private readonly watchableDirs = new Map<string, Set<string>>();
  private tombstoneTimer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private readonly health = new Map<string, {
    consecutiveFailures: number;
    lastError?: string;
    lastOkAt?: number;
    stoppedReason?: "preflight-failed" | "healthcheck-failed" | "user";
  }>();
  private started = false;

  constructor(options: { debounceMs?: number } = {}) {
    this.debounceMs = options.debounceMs ?? 1000;
  }

  assertEnvironment(): void {
    if (config.NODE_ENV === "production" && !config.ALLOW_PROD_WATCHER) {
      throw new Error(
        "watcher: refusing to start in production without ALLOW_PROD_WATCHER=true (this guards against unintentional local-folder sync in deployed environments)"
      );
    }
  }

  async startAll(folders: WatchedFolderRecord[]): Promise<void> {
    this.assertEnvironment();
    if (this.started) {
      return;
    }
    this.started = true;

    // P31 — sweep any EXCEL.EXE that survived a previous SAG run BEFORE
    // we start watching. The sweep is best-effort and bounded to 5s;
    // we don't await it (the watcher proceeds immediately) because the
    // first COM call will hit the regular killOrphanedExcel path
    // anyway if the sweep is still running. The point of the sweep
    // is to clear the most common case (a few leftover EXCEL.EXE
    // from last time) before any file lands in the extractViaCom
    // path, so the first file of the new session doesn't pay the
    // cost of a CoCreateInstance that hangs on a stale apartment.
    void sweepStartupOrphans().catch(() => undefined);
    for (const folder of folders) {
      try {
        await this.startOne(folder);
      } catch (error) {
        logger.error({ folderId: folder.id, error: (error as Error).message }, "watcher: startOne failed");
      }
    }
    this.scheduleTombstoneSweep();
  }

  /**
   * Daily sweep that physically removes manifest rows whose file has
   * been gone for at least TOMBSTONE_RETENTION_DAYS (default 7). Runs
   * once a day starting at the next hour boundary so multiple
   * instances booting at roughly the same time don't all hammer the
   * DB simultaneously. The DB has a covering index on
   * (last_event, last_seen_at) so the DELETE is cheap.
   */
  private scheduleTombstoneSweep(): void {
    if (this.tombstoneTimer) {
      return;
    }
    const interval = Math.max(60_000, config.TOMBSTONE_SWEEP_INTERVAL_MS);
    const runSweep = async () => {
      const cutoff = toLocalISO(new Date(
        Date.now() - Math.max(0, getRuntimePerformanceSettings().tombstoneRetentionDays) * 24 * 60 * 60 * 1000
      ));
      try {
        const { removed } = await purgeDeletedManifests(null, cutoff);
        if (removed > 0) {
          logger.info({ removed, cutoff }, "watcher: tombstone sweep completed");
        }
      } catch (error) {
        logger.error(
          { error: (error as Error).message },
          "watcher: tombstone sweep failed"
        );
      }
    };
    this.tombstoneTimer = setInterval(() => {
      void runSweep();
    }, interval);
    // Best-effort: also run a sweep on boot so newly-restarted
    // instances clear out yesterday's tombstones right away.
    setTimeout(() => {
      void runSweep();
    }, 30_000);
  }

  /**
   * Determine the set of directories chokidar should watch.
   *
   * Returns a set of normalised (upper-cased, separator-normalised)
   * absolute directory paths. `undefined` means "don't prune — watch
   * everything", which is the safe fallback when the pre-walk could
   * not be completed.
   *
   * The set contains:
   *   - every directory that directly holds at least one file matching
   *     the folder's whitelist, and
   *   - every ancestor of those directories up to the watched root,
   *     because chokidar can only reach a directory by traversing its
   *     parents.
   *
   * Directories outside that set are pruned by the `ignored` predicate,
   * so chokidar never opens a watch handle on them. On E:\ that is
   * 1,443 interesting + ~200 ancestors instead of all 41,353
   * directories.
   *
   * The trade-off: a brand-new directory that appears in a location we
   * pruned will not raise a chokidar event. That is covered by the
   * periodic rescan (`schedulePeriodicRescan`).
   */
  private async computeWatchableDirs(
    folder: WatchedFolderRecord
  ): Promise<Set<string> | undefined> {
    const started = Date.now();
    try {
      const filter = effectiveWatchExtensions(folder);
      const { interestingDirs, allDirs, matchedFiles } = await enumerateWatchTargets(
        folder.path,
        folder.recursive,
        filter
          ? (relPath) => filter.includes(normalizeExtension(relPath))
          : undefined
      );

      if (interestingDirs.size === 0) {
        // Nothing ingestible on disk yet. Watch only the root so we
        // still notice the first file that appears.
        logger.info(
          { folderId: folder.id, path: folder.path, allDirs: allDirs.size },
          "watcher: no ingestible files found yet, watching root only"
        );
        return new Set([normalizeDirKey(folder.path)]);
      }

      const expanded = expandToAncestors(interestingDirs, folder.path);
      const watchable = new Set<string>();
      for (const dir of expanded) {
        watchable.add(normalizeDirKey(dir));
      }

      logger.info(
        {
          folderId: folder.id,
          path: folder.path,
          allDirs: allDirs.size,
          interestingDirs: interestingDirs.size,
          watchableDirs: watchable.size,
          matchedFiles,
          elapsedMs: Date.now() - started
        },
        "watcher: computed watch targets — chokidar will only hold handles on directories that contain ingestible files"
      );
      return watchable;
    } catch (error) {
      logger.warn(
        { folderId: folder.id, path: folder.path, error: (error as Error).message },
        "watcher: watch-target computation failed, falling back to watching the whole tree"
      );
      return undefined;
    }
  }

  async startOne(folder: WatchedFolderRecord): Promise<void> {
    this.assertEnvironment();
    if (this.watchers.has(folder.id)) {
      return;
    }
    if (!folder.enabled) {
      logger.info({ folderId: folder.id }, "watcher: folder disabled, skipping");
      return;
    }

    // Preflight: probe the embedding endpoint once before we commit to
    // chokidar. A misconfigured key or unreachable host would otherwise
    // cause every single ingest attempt to fail and pile audit_logs
    // rows; failing fast here gives the user a single clear error.
    // Tests / sandboxes without network access can opt out via
    // SAG_WATCHER_SKIP_PREFLIGHT=1 so the e2e/integration suites can
    // exercise the full chokidar → ingest → DB row path.
    const skipPreflight = process.env.SAG_WATCHER_SKIP_PREFLIGHT === "1";
    if (skipPreflight) {
      logger.warn(
        { folderId: folder.id },
        "watcher: SAG_WATCHER_SKIP_PREFLIGHT=1 set, skipping embedding preflight"
      );
      this.recordHealth(folder.id, undefined);
    } else {
      logger.info({ folderId: folder.id }, "watcher: preflight embedding probe");
      const probe = await embeddingClient.testConnection();
      if (!probe.ok) {
        const msg = `embedding preflight failed: ${probe.error ?? "unknown"} (${probe.baseUrl})`;
        logger.error({ folderId: folder.id, probe }, "watcher: preflight failed, refusing to start");
        this.recordHealth(folder.id, msg, "preflight-failed");
        // Throw so the API route that called startOne can surface a 503
        // with the structured result.
        const err = new Error(msg) as Error & { probe?: typeof probe };
        err.probe = probe;
        throw err;
      }
      logger.info(
        { folderId: folder.id, latencyMs: probe.latencyMs, provider: probe.provider, model: probe.model },
        "watcher: preflight ok"
      );
      this.recordHealth(folder.id, undefined);
    }

    // De-duplicate: if there's already a recent in-progress run for this
    // folder (e.g. a concurrent startAll() or a manual sync that started
    // < 30 seconds ago), don't fire a second startup scan. Two startup
    // scans racing against the same manifest causes spurious "added"
    // rows because the first run hasn't written its manifest updates yet.
    const recentRun = await getLatestSyncRun(folder.id);
    if (
      recentRun &&
      recentRun.status === "running" &&
      recentRun.startedAt &&
      Date.now() - new Date(recentRun.startedAt).getTime() < 30_000
    ) {
      logger.info(
        { folderId: folder.id, runId: recentRun.id, ageMs: Date.now() - new Date(recentRun.startedAt).getTime() },
        "watcher: skipping startup sync, a recent run is still in progress"
      );
    } else {
      // Initial scan: run syncFolder with `waitForCompletion: false` so we
      // still get a sync_run row (for the UI) and the ingest queue does the
      // actual work in the background. This used to block the watcher
      // startup until every file had been ingested — the queue removes
      // that blocking cost while preserving the run-history feature.
      void syncFolder(folder.id, "startup", folder.tenantId, { waitForCompletion: false })
        .catch((error) => {
          logger.error(
            { folderId: folder.id, error: (error as Error).message },
            "watcher: startup sync failed"
          );
        });
    }

    // Work out which directories are actually worth a watch handle
    // BEFORE handing the path to chokidar.
    //
    // chokidar on Windows opens one `ReadDirectoryChangesW` handle per
    // directory it traverses. On a drive-root watch that is 41,353
    // handles for E:\ — and 39,910 of those directories hold no file
    // that can ever match the whitelist. Measured on the v4 build:
    // chokidar never emitted `ready` (600 s, 0 `add` events), the
    // backend leaked handles at ~79/s (117k after 40 min), grew from
    // 1.6 GB to 5.5 GB RSS and died with a V8 heap OOM — so the
    // watcher never went live and the UI sat on "扫描文件系统" forever.
    //
    // We run one fast directory walk (the same traversal the scan
    // uses, ~26 s on E:\) to learn which 1,443 directories hold
    // Office files, then let chokidar watch only those plus their
    // ancestors. That is a ~25x reduction in watch handles.
    const watchableDirs = await this.computeWatchableDirs(folder);
    if (watchableDirs) {
      // Keep the live reference so the periodic rescan can extend it
      // in place; the `ignored` predicate reads this same Set.
      this.watchableDirs.set(folder.id, watchableDirs);
    }

    const watcher = chokidar.watch(folder.path, {
      persistent: true,
      ignoreInitial: true, // we already scanned above
      followSymlinks: false,
      depth: folder.recursive ? undefined : 0,
      usePolling: false,
      awaitWriteFinish: false,
      // Skip excluded directories (system dirs, node_modules, .git, …)
      // so chokidar doesn't hold a watch handle on every inode of a
      // whole drive. On an E:\ root the handle count grew by ~11
      // per second and reached 240k+ before this was added.
      // The predicate matches on whole path segments, so a user
      // directory named e.g. "my-node_modules" is not affected.
      //
      // 2026-10-30: also gate on the folder's file-extension
      // whitelist and prune directories that hold nothing ingestible.
      // See scan-exclusions.ts for the measurements.
      ignored: makeChokidarIgnoredPredicate(
        effectiveWatchExtensions(folder),
        watchableDirs
      )
    });

    const onEvent = (relPath: string, kind: "added" | "updated" | "deleted") => {
      // Coalesce per-folder: many events for one folder collapse into one
      // "process the diff" sweep. The queue itself dedupes by (folderId,
      // relPath) so add+change for the same file doesn't double-ingest.
      this.scheduleSync(folder, relPath, kind);
    };
    // We don't have the kind up-front from chokidar's signature, so we
    // listen to each event and tag it ourselves. The queue dedupe makes
    // the actual kind largely cosmetic.
    watcher.on("add", (relPath: string) => onEvent(relPath, "added"));
    watcher.on("change", (relPath: string) => onEvent(relPath, "updated"));
    watcher.on("unlink", (relPath: string) => onEvent(relPath, "deleted"));
    watcher.on("unlinkDir", () => undefined);
    watcher.on("error", (error) => {
      logger.error({ folderId: folder.id, error: error.message }, "watcher: chokidar error");
    });

    this.watchers.set(folder.id, watcher);
    logger.info({ folderId: folder.id, path: folder.path, recursive: folder.recursive }, "watcher: folder watcher started");

    // Start a periodic health probe so a sudden 401 / network drop
    // can't silently corrupt the manifest. After N consecutive failed
    // probes the watcher auto-stops itself and tags the reason so the
    // UI can show "watcher paused: embedding API unreachable".
    if (config.WATCHER_HEALTHCHECK_INTERVAL_S > 0) {
      this.scheduleHealthCheck(folder);
    }

    // Periodic rescan.
    //
    // Because we prune chokidar down to the directories that hold
    // ingestible files, a directory that appears later in a pruned
    // part of the tree would never raise an event. The rescan closes
    // that gap: it re-walks the tree (fast — 26 s on E:\), picks up
    // any new interesting directories (extending the watchable set
    // in place and telling chokidar to watch them), and enqueues any
    // files the manifest has not seen yet.
    this.schedulePeriodicRescan(folder);

    // Wait for chokidar's initial scan to settle before returning. Without this,
    // events that fire in the window between chokidar.watch() returning and
    // chokidar finishing its initial directory enumeration can be silently
    // dropped. We've already done our own startup scan above, so we don't need
    // chokidar's enumeration — we just need to know it's ready to listen.
    //
    // 2026-10-30: this promise used to wait forever. On a drive-root watch
    // chokidar's initial enumeration could run for hours (it was opening a
    // watch handle on all ~305k non-Office files), so `startOne()` never
    // returned, the "start watcher" HTTP request hung, and the health
    // endpoint stopped answering. We now give up after a bounded wait and
    // let chokidar keep running in the background — a watcher that is
    // "still enumerating" is far better than one that wedges the API.
    const readyTimeoutMs = CHOKIDAR_READY_TIMEOUT_MS;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watcher.off("error", onError);
        resolve();
      };
      const onReady = () => {
        logger.info(
          { folderId: folder.id, path: folder.path },
          "watcher: chokidar ready"
        );
        finish();
      };
      const onError = (error: Error) => {
        logger.error({ folderId: folder.id, error: error.message }, "watcher: chokidar error during ready");
        // Don't block startup on a transient chokidar error — log it and move on.
        finish();
      };
      const timer = setTimeout(() => {
        logger.warn(
          { folderId: folder.id, path: folder.path, timeoutMs: readyTimeoutMs },
          "watcher: chokidar did not become ready in time, continuing without waiting"
        );
        finish();
      }, readyTimeoutMs);
      // Don't let the timer keep the process alive on its own.
      if (typeof timer.unref === "function") timer.unref();
      watcher.once("ready", onReady);
      watcher.once("error", onError);
      logger.info({ folderId: folder.id, path: folder.path }, "watcher: awaiting chokidar ready");
    });
  }

  async stopOne(folderId: string): Promise<void> {
    const watcher = this.watchers.get(folderId);
    if (!watcher) {
      return;
    }
    await watcher.close();
    this.watchers.delete(folderId);
    const timer = this.debounceTimers.get(folderId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(folderId);
    }
    const healthTimer = this.healthTimers.get(folderId);
    if (healthTimer) {
      clearInterval(healthTimer);
      this.healthTimers.delete(folderId);
    }
    const rescanTimer = this.rescanTimers.get(folderId);
    if (rescanTimer) {
      clearInterval(rescanTimer);
      this.rescanTimers.delete(folderId);
    }
    this.watchableDirs.delete(folderId);
    // Drop any pending ingest work for this folder — we don't want to
    // continue processing files for a watcher that's been stopped.
    ingestQueue.removeFolder(folderId);
    logger.info({ folderId }, "watcher: folder watcher stopped");
  }

  async stopAll(): Promise<void> {
    const ids = [...this.watchers.keys()];
    await Promise.all(ids.map((id) => this.stopOne(id)));
    if (this.tombstoneTimer) {
      clearInterval(this.tombstoneTimer);
      this.tombstoneTimer = null;
    }
    this.started = false;
  }

  isRunning(folderId: string): boolean {
    return this.watchers.has(folderId);
  }

  /**
   * P21 — true when any folder watcher is alive (used by /health to
   * surface "watcher is paused" without enumerating each folder).
   */
  isAnyRunning(): boolean {
    return this.watchers.size > 0;
  }

  /**
   * P21 — current ingest queue depth (active + pending) across all
   * folders. The orchestrator dedupes by manifest status so this is
   * the real "how much work is in flight right now" counter.
   */
  getQueueDepth(): { active: number; pending: number } {
    // Use the statically imported singleton — this module already
    // imports it at the top (and the ingest queue is what actually
    // arbitrates in-flight work).
    //
    // The old implementation did `createRequire(import.meta.url)` and
    // required("./ingest-queue.js") at CALL time. That works under tsx
    // (the .ts/.js file really sits next to the module) but NOT in the
    // SEA bundle, where everything is one CommonJS file
    // (sag.bundle.cjs) and the sibling path does not exist — the
    // require threw, the catch swallowed it, and the health endpoint
    // reported {active: 0, pending: 0} forever. The UI then showed
    // "nothing is being ingested" while documents were actually being
    // embedded (2026-10-29).
    return ingestQueue.getGlobalDepth();
  }

  /**
   * Surface the current health of a watched folder so the Web UI can
   * show "watcher paused: embedding API unreachable" with the exact
   * error. Returns null when no health record exists for the folder
   * (i.e. the watcher has never run).
   */
  getHealth(folderId: string): {
    consecutiveFailures: number;
    lastError?: string;
    lastOkAt?: number;
    stoppedReason?: "preflight-failed" | "healthcheck-failed" | "user";
  } | null {
    return this.health.get(folderId) ?? null;
  }

  /** Update health state for a folder. Used by both startOne preflight
   * and the periodic health-check timer. */
  private recordHealth(
    folderId: string,
    errorMessage: string | undefined,
    stoppedReason?: "preflight-failed" | "healthcheck-failed" | "user"
  ): void {
    const prev = this.health.get(folderId) ?? { consecutiveFailures: 0 };
    if (errorMessage) {
      this.health.set(folderId, {
        consecutiveFailures: prev.consecutiveFailures + 1,
        lastError: errorMessage,
        lastOkAt: prev.lastOkAt,
        stoppedReason
      });
    } else {
      this.health.set(folderId, {
        consecutiveFailures: 0,
        lastOkAt: Date.now(),
        stoppedReason
      });
    }
  }

  /** Schedule (or reschedule) the periodic health probe for a folder. */
  private scheduleHealthCheck(folder: WatchedFolderRecord): void {
    const existing = this.healthTimers.get(folder.id);
    if (existing) {
      clearInterval(existing);
    }
    const interval = config.WATCHER_HEALTHCHECK_INTERVAL_S * 1000;
    const timer = setInterval(() => {
      void this.runHealthCheck(folder);
    }, interval);
    // unref so a hanging health probe never blocks process exit.
    timer.unref?.();
    this.healthTimers.set(folder.id, timer);
  }

  /**
   * Schedule the periodic full rescan for a folder.
   *
   * The interval is configurable via `SAG_WATCHER_RESCAN_INTERVAL_S`
   * (default 300 s). Setting it to 0 disables the rescan entirely.
   */
  private schedulePeriodicRescan(folder: WatchedFolderRecord): void {
    const existing = this.rescanTimers.get(folder.id);
    if (existing) {
      clearInterval(existing);
    }
    const intervalS = readRescanIntervalSeconds();
    if (intervalS <= 0) {
      logger.info(
        { folderId: folder.id },
        "watcher: periodic rescan disabled"
      );
      return;
    }
    const timer = setInterval(() => {
      void this.runPeriodicRescan(folder);
    }, intervalS * 1000);
    timer.unref?.();
    this.rescanTimers.set(folder.id, timer);
    logger.info(
      { folderId: folder.id, intervalS },
      "watcher: periodic rescan scheduled"
    );
  }

  /**
   * One periodic rescan cycle.
   *
   * Two jobs:
   *   1. Re-compute the set of directories that hold ingestible files
   *      and extend the live watchable set, so a directory created
   *      after startup becomes watchable. Any genuinely new directory
   *      is handed to chokidar with `watcher.add()`.
   *   2. Diff the tree against the manifest and enqueue anything new
   *      or changed. The manifest's mtime fast path means unchanged
   *      files are not re-read, so the expensive part is the tree
   *      walk, not the hashing.
   */
  private async runPeriodicRescan(folder: WatchedFolderRecord): Promise<void> {
    if (!this.watchers.has(folder.id)) {
      const t = this.rescanTimers.get(folder.id);
      if (t) {
        clearInterval(t);
        this.rescanTimers.delete(folder.id);
      }
      return;
    }
    const started = Date.now();
    try {
      const refreshed = await getFolder(folder.id, folder.tenantId);
      if (!refreshed) return;

      // 1. Extend the watchable directory set.
      const live = this.watchableDirs.get(folder.id);
      if (live) {
        const filter = effectiveWatchExtensions(refreshed);
        const { interestingDirs } = await enumerateWatchTargets(
          refreshed.path,
          refreshed.recursive,
          filter ? (relPath) => filter.includes(normalizeExtension(relPath)) : undefined
        );
        const expanded = expandToAncestors(interestingDirs, refreshed.path);
        const added: string[] = [];
        for (const dir of expanded) {
          const key = normalizeDirKey(dir);
          if (!live.has(key)) {
            live.add(key);
            added.push(dir);
          }
        }
        if (added.length > 0) {
          const watcher = this.watchers.get(folder.id);
          if (watcher) {
            try {
              watcher.add(added);
            } catch (error) {
              logger.warn(
                { folderId: folder.id, error: (error as Error).message },
                "watcher: chokidar could not attach to newly discovered directories"
              );
            }
          }
          logger.info(
            { folderId: folder.id, addedDirs: added.length },
            "watcher: rescan discovered new directories with ingestible files"
          );
        }
      }

      // 2. Diff against the manifest and enqueue deltas.
      const existing = await getManifest(refreshed.id, undefined);
      const scan = await scanFolder(refreshed, existing);
      let enqueued = 0;
      for (const entry of scan.added) {
        ingestQueue.enqueue(makeQueueItem(refreshed, entry, "added"));
        enqueued += 1;
      }
      for (const entry of scan.updated) {
        ingestQueue.enqueue(makeQueueItem(refreshed, entry, "updated"));
        enqueued += 1;
      }
      for (const relPath of scan.deleted) {
        ingestQueue.enqueue({
          key: `${refreshed.id}::${relPath}`,
          folderId: refreshed.id,
          tenantId: refreshed.tenantId,
          kind: "deleted",
          relPath,
          enqueuedAt: Date.now()
        } as QueueItem);
        enqueued += 1;
      }
      logger.info(
        {
          folderId: folder.id,
          added: scan.added.length,
          updated: scan.updated.length,
          deleted: scan.deleted.length,
          enqueued,
          elapsedMs: Date.now() - started
        },
        "watcher: periodic rescan complete"
      );
    } catch (error) {
      logger.error(
        { folderId: folder.id, error: (error as Error).message },
        "watcher: periodic rescan failed"
      );
    }
  }

  private async runHealthCheck(folder: WatchedFolderRecord): Promise<void> {
    // If the watcher was already stopped, cancel the timer.
    if (!this.watchers.has(folder.id)) {
      const t = this.healthTimers.get(folder.id);
      if (t) {
        clearInterval(t);
        this.healthTimers.delete(folder.id);
      }
      return;
    }
    try {
      const probe = await embeddingClient.testConnection();
      if (probe.ok) {
        this.recordHealth(folder.id, undefined);
        return;
      }
      const msg = `embedding healthcheck failed: ${probe.error ?? "unknown"} (http=${probe.httpStatus ?? "?"})`;
      this.recordHealth(folder.id, msg);
      const state = this.health.get(folder.id);
      logger.warn(
        { folderId: folder.id, consecutiveFailures: state?.consecutiveFailures, error: msg },
        "watcher: embedding healthcheck failed"
      );
      if (state && state.consecutiveFailures >= config.WATCHER_HEALTHCHECK_FAILURES) {
        logger.error(
          { folderId: folder.id, consecutiveFailures: state.consecutiveFailures, threshold: config.WATCHER_HEALTHCHECK_FAILURES },
          "watcher: embedding endpoint unreachable after N consecutive failures, auto-stopping"
        );
        await this.autoStop(folder.id, "healthcheck-failed");
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.recordHealth(folder.id, msg);
      logger.error({ folderId: folder.id, error: msg }, "watcher: healthcheck threw");
    }
  }

  /**
   * Internal stop used when the watcher decides to bail on its own.
   * Mirrors stopOne's teardown but tags the reason so the UI / API
   * caller can distinguish "user clicked stop" from "system stopped
   * it because embedding is down".
   */
  private async autoStop(folderId: string, reason: "healthcheck-failed" | "preflight-failed"): Promise<void> {
    const state = this.health.get(folderId) ?? { consecutiveFailures: 0 };
    state.stoppedReason = reason;
    this.health.set(folderId, state);
    await this.stopOne(folderId);
  }

  private scheduleSync(folder: WatchedFolderRecord, relPath: string, kind: "added" | "updated" | "deleted"): void {
    // Coalesce per-folder events into a debounced re-scan. The actual
    // per-file ingest goes through `ingestQueue`, which handles dedupe
    // and concurrency. We schedule a full scan-and-diff because chokidar
    // doesn't tell us the exact file metadata, and the scan cost is
    // dominated by SHA-1 (which only runs on changed files thanks to
    // the manifest's stored sha1).
    const existing = this.debounceTimers.get(folder.id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(folder.id);
      void this.enqueueDiffScan(folder, relPath, kind);
    }, this.debounceMs);
    this.debounceTimers.set(folder.id, timer);
  }

  /**
   * Re-scan the folder and enqueue any deltas into the ingest queue.
   * This is the per-event entry point (debounced).
   */
  private async enqueueDiffScan(
    folder: WatchedFolderRecord,
    changedRelPath: string,
    kind: "added" | "updated" | "deleted"
  ): Promise<void> {
    try {
      const refreshed = await getFolder(folder.id, folder.tenantId);
      if (!refreshed) {
        // Folder was deleted between event and drain.
        return;
      }
      const existing = await getManifest(refreshed.id, undefined);
      const scan = await scanFolder(refreshed, existing);

      // For "unlink", the relPath is gone from disk so the scan's
      // `deleted` list will pick it up. We still push it directly so
      // the user gets a fast path (no scan needed for a single delete).
      if (kind === "deleted" && !scan.deleted.includes(changedRelPath)) {
        scan.deleted.push(changedRelPath);
      }

      let enqueued = 0;
      for (const entry of scan.added) {
        ingestQueue.enqueue(makeQueueItem(refreshed, entry, "added"));
        enqueued += 1;
      }
      for (const entry of scan.updated) {
        ingestQueue.enqueue(makeQueueItem(refreshed, entry, "updated"));
        enqueued += 1;
      }
      for (const relPath of scan.deleted) {
        ingestQueue.enqueue({
          key: `${refreshed.id}::${relPath}`,
          folderId: refreshed.id,
          tenantId: refreshed.tenantId,
          kind: "deleted",
          relPath,
          enqueuedAt: Date.now()
        });
        enqueued += 1;
      }
      logger.info(
        { folderId: refreshed.id, enqueued, added: scan.added.length, updated: scan.updated.length, deleted: scan.deleted.length },
        "watcher: debounced diff enqueued"
      );
    } catch (error) {
      logger.error(
        { folderId: folder.id, error: (error as Error).message },
        "watcher: debounced diff scan failed"
      );
    }
  }

  /**
   * Initial startup scan. Walks the tree, computes the diff against the
   * manifest, and enqueues everything. Does NOT ingest synchronously —
   * the queue drains in the background.
   */
}

function makeQueueItem(folder: WatchedFolderRecord, entry: import("./analyzer.js").FileEntry, kind: "added" | "updated"): QueueItem {
  return {
    key: `${folder.id}::${entry.relPath}`,
    folderId: folder.id,
    tenantId: folder.tenantId,
    kind,
    relPath: entry.relPath,
    entry,
    enqueuedAt: Date.now()
  };
}

/**
 * Retry a set of manifest rows for a folder. Resets each row's `last_event`
 * back to `pending` (and clears its `document_id` so the upcoming ingest
 * creates a fresh document), then re-enqueues the file into the ingest
 * queue as an `updated` work item.
 *
 * Returns the count of files that were actually enqueued — rows that
 * were already in `syncing` or `pending` are skipped (we don't want to
 * re-fire an in-flight ingest). The caller (HTTP route / MCP tool) is
 * expected to surface this count to the UI so the user knows how many
 * retries actually happened.
 *
 * Files that have been deleted from disk since the original ingest are
 * silently skipped — re-ingesting a non-existent file would just fail
 * again.
 */
export async function retryEntries(
  folder: WatchedFolderRecord,
  relPaths: string[]
): Promise<{ enqueued: number; skipped: number; missing: string[] }> {
  if (relPaths.length === 0) {
    return { enqueued: 0, skipped: 0, missing: [] };
  }
  // 1. Reset matching failed/synced rows back to pending. Rows that are
  //    already syncing/pending stay put (no double-fire).
  //
  //    The reset returns the row's previous manifest data (incl. SHA-1
  //    hash from the last successful ingest) so we can reuse the stored
  //    hash here without re-reading the whole file. Re-ingest will
  //    re-validate this hash against the on-disk bytes; if they
  //    disagree (file was modified externally) the user can trigger
  //    a full sync to pick up the new content.
  const reset = await resetManifestForRetry(folder.id, relPaths);
  const resetRows = new Map(reset.map((r) => [r.relPath, r]));
  // 2. For every requested relPath, stat the file on disk and enqueue
  //    an "updated" work item. Files that have been deleted are
  //    reported in `missing` so the API layer can return a 4xx hint.
  //
  //    We do NOT call `computeSha1` here — that would block this
  //    endpoint on N * file-size reads. The queue's drain path will
  //    re-read the file when ingest runs, which is the same work
  //    either way. Stat alone is O(1) per file and returns within
  //    milliseconds.
  const path = await import("node:path");
  const { promises: fs } = await import("node:fs");
  let enqueued = 0;
  let skipped = 0;
  const missing: string[] = [];
  for (const relPath of relPaths) {
    const prev = resetRows.get(relPath);
    if (!prev) {
      // Either the row doesn't exist or it's in syncing/pending — don't
      // re-fire it.
      skipped += 1;
      continue;
    }
    const absPath = path.join(folder.path, relPath.split("/").join(path.sep));
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      missing.push(relPath);
      continue;
    }
    const inode = await getInode(absPath);
    const entry = {
      relPath,
      absPath,
      mtimeMs: Math.trunc(stat.mtimeMs),
      inode,
      sizeBytes: stat.size,
      // Reuse the SHA-1 we stored the last time the file was ingested.
      // ingestEntry never reads this for ingestion correctness; the
      // re-validate happens when the queue worker re-reads the file
      // for chunking. Treating this as a hint keeps the API call
      // fast and avoids redundant disk IO on bulk retries.
      sha1: prev.sha1 ?? ""
    };
    ingestQueue.enqueue(makeQueueItem(folder, entry, "updated"));
    enqueued += 1;
  }
  logger.info(
    { folderId: folder.id, enqueued, skipped, missing: missing.length },
    "watcher: retry entries enqueued"
  );
  return { enqueued, skipped, missing };
}

/**
 * Retry every manifest row currently in `failed` state for a folder.
 * Pagination is the caller's problem (we don't paginate internally so
 * the user can see the totals in the response).
 */
export async function retryAllFailedEntries(
  folder: WatchedFolderRecord,
  failedRelPaths: string[]
): Promise<{ enqueued: number; skipped: number; missing: string[] }> {
  return retryEntries(folder, failedRelPaths);
}

export const watcherManager = new WatcherManager();

/**
 * Normalise a directory path so set membership is reliable.
 *
 * chokidar normalises every path to forward slashes before handing it
 * to the `ignored` predicate, while our own traversal produces the
 * Windows form. `normalizeWatchKey` folds both to the same shape and
 * upper-cases them (Windows paths are case-insensitive).
 */
function normalizeDirKey(p: string): string {
  return normalizeWatchKey(p);
}

/**
 * Lower-case extension of a relative path, with the leading dot.
 */
function normalizeExtension(relPath: string): string {
  const slash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const basename = slash >= 0 ? relPath.slice(slash + 1) : relPath;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot).toLowerCase();
}

/**
 * How often the periodic rescan runs, in seconds.
 *
 * Defaults to 300 s (5 minutes). `SAG_WATCHER_RESCAN_INTERVAL_S=0`
 * disables it. The rescan is what picks up files and directories that
 * appear in parts of the tree chokidar is not watching.
 */
function readRescanIntervalSeconds(): number {
  const raw = process.env.SAG_WATCHER_RESCAN_INTERVAL_S;
  if (raw === undefined || raw === "") {
    return 300;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 300;
  }
  return parsed;
}

/**
 * The file extensions chokidar should track for a watched folder.
 *
 * This mirrors the logic in `analyzer.ts::scanFolder`: a folder that
 * sets its own whitelist uses it verbatim; a folder that doesn't falls
 * back to `DEFAULT_SUPPORTED_EXTENSIONS`.
 *
 * Returning `undefined` means "don't filter by extension" — used when
 * the effective whitelist is empty, because an empty whitelist in the
 * ingest pipeline means "accept everything" and chokidar must then
 * track every file to stay consistent with the manifest.
 */
export function effectiveWatchExtensions(
  folder: Pick<WatchedFolderRecord, "filetypeFilter">
): string[] | undefined {
  const userFilter = folder.filetypeFilter ?? {};
  const whitelist =
    userFilter.whitelist && userFilter.whitelist.length > 0
      ? userFilter.whitelist
      : DEFAULT_SUPPORTED_EXTENSIONS;
  if (!whitelist || whitelist.length === 0) {
    return undefined;
  }
  return whitelist;
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { WatchedFolderRecord, FileManifestRecord, SyncRunRecord, SyncStats, FiletypeFilter } from "./types.js";
export { syncFolder, syncFolderWith } from "./sync-orchestrator.js";
export {
  listFolders,
  getFolder,
  getFolderByPath,
  createFolder,
  updateFolder,
  deleteFolder,
  getManifest,
  upsertManifest,
  markManifestStatus,
  findManifestByDocumentId,
  deleteManifest,
  resetManifestForRetry,
  resetManifestEntryForRetry,
  listFailedManifestEntries,
  purgeDeletedManifests,
  createSyncRun,
  finishSyncRun,
  getLatestSyncRun,
  listSyncRuns
} from "./manifest-store.js";
export { scanFolder, computeSha1, getInode } from "./analyzer.js";
export { convertFile } from "./file-converter.js";
export { shouldIncludeFile, getExtension } from "./filetype-filter.js";