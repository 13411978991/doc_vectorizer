import { promises as fs } from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { toLocalISO } from "../db/row-helpers.js";
import { ingestionService } from "../services/ingestion-service.js";
import { webuiService } from "../services/webui-service.js";
import { logger } from "../observability/logger.js";
import { ingestQueue } from "./ingest-queue.js";

/**
 * Manifest rows left in `last_event='syncing'` longer than this are
 * considered orphaned (a previous worker crashed mid-ingest) and get
 * reset to `pending` at the start of every sync run. 10 minutes is
 * comfortably longer than any legitimate single-file ingest (even the
 * 9-minute xlsx we tuned for) but short enough that a user doesn't have
 * to wait hours for stuck rows to recover.
 */
const STALE_SYNCING_SECONDS = 600;

/**
 * AbortError — thrown by the ingestion pipeline when the folder is
 * paused (or otherwise cancelled). Distinct from a regular error so
 * the watcher can decide not to mark the manifest as "failed" and
 * to skip the "no work to do" retry path.
 */
export class AbortError extends Error {
  readonly name = "AbortError";
  readonly isAbort = true;
}
import {
  type CreateWatchedFolderInput,
  type FiletypeFilter,
  type SyncStats,
  type SyncRunTrigger,
  type WatchedFolderRecord,
  DEFAULT_SUPPORTED_EXTENSIONS
} from "./types.js";
import type { FileEntry, ScanResult } from "./analyzer.js";
import {
  createSyncRun,
  deleteManifest,
  finishSyncRun,
  getFolder,
  getManifest,
  getManifestEntry,
  markFolderScanned,
  purgeDeletedManifests,
  transitionManifestStatus,
  upsertManifest
} from "./manifest-store.js";
import { scanFolder } from "./analyzer.js";
import { shouldIncludeFile, getExtension } from "./filetype-filter.js";
import { convertFile } from "./file-converter.js";

/**
 * Sync a folder: scan → ingest diffs → delete what's gone → close out the run.
 *
 * `syncFolder` is the single entry point. Per-file failures are recorded but
 * don't abort the run. The function is concurrency-safe at the manifest
 * level: only one worker can transition a given file from `pending` → `syncing`
 * at a time, which is what protects us from duplicate ingests when chokidar
 * fires twice for the same event.
 */
export async function syncFolder(
  folderId: string,
  trigger: SyncRunTrigger = "manual",
  tenantId: string,
  options: { maxConcurrency?: number; waitForCompletion?: boolean } = {}
): Promise<{ runId: string; stats: SyncStats; status: "completed" | "completed_with_errors" | "failed"; errorMessage?: string }> {
  const folder = await getFolder(folderId, tenantId);
  if (!folder) {
    throw new Error(`watched folder not found: ${folderId}`);
  }

  const run = await createSyncRun(folderId, trigger);
  process.stderr.write(`[diag] syncFolder ENTRY ${folderId} runId=${run.id} trigger=${trigger}\n`);
  logger.info({ folderId, runId: run.id, trigger, path: folder.path }, "watcher: sync started");

  // Defensive: if a previous worker crashed mid-ingest, the file can stay
  // in `last_event='syncing'` forever and block every subsequent run
  // (the orchestrator skips "already syncing" files). Reset rows that
  // have been stuck in syncing for too long back to pending. We only
  // touch rows for THIS folder and only when no active sync run exists
  // for the folder, to avoid stealing work from a live worker.
  try {
    const activeRun = await pool.query(
      "select id from watched_folder_runs where folder_id = $1 and status = 'running' limit 1",
      [folderId]
    );
    if ((activeRun.rowCount ?? 0) === 0) {
      const reset = await pool.query(
        `update watched_folders m
            set last_event = 'pending',
                last_error = coalesce(last_error, 'recovered from stale syncing state')
          where m.folder_id = $1
            and m.last_event = 'syncing'
            and (strftime('%s','now') - strftime('%s', coalesce(m.last_seen_at, '1970-01-01'))) > $2`,
        [folderId, STALE_SYNCING_SECONDS]
      );
      if ((reset.rowCount ?? 0) > 0) {
        logger.warn(
          { folderId, recovered: reset.rowCount, staleAfterSeconds: STALE_SYNCING_SECONDS },
          "watcher: recovered stale syncing manifest rows"
        );
      }
    }
  } catch (error) {
    logger.warn({ folderId, error: (error as Error).message }, "watcher: stale syncing recovery failed (non-fatal)");
  }

  const stats: SyncStats = { added: 0, updated: 0, deleted: 0, failed: 0 };
  let errorMessage: string | null = null;
  // Task-level status. Per-file failures bump `stats.failed` but leave this
  // alone — see `finalizeStatus` below for the 3-state mapping.
  let status: "completed" | "failed" = "completed";

  try {
    // Verify the folder exists. If not, abort with a clear error.
    try {
      const stat = await fs.stat(folder.path);
      if (!stat.isDirectory()) {
        throw new Error(`path is not a directory: ${folder.path}`);
      }
    } catch (error) {
      throw new Error(`watched folder path not accessible: ${(error as Error).message}`);
    }

    const existing = await getManifest(folder.id, undefined);
    // Flip the queue into "scanning" so the UI can show progress on the
    // filesystem walk phase (which for a 27k-file folder can take
    // several minutes and previously looked like the watcher was
    // stuck).
    ingestQueue.setScanning(folder.id, true);
    const scan = await scanFolder(folder, existing);
    ingestQueue.setScanning(folder.id, false);
    logger.info(
      { folderId, runId: run.id, added: scan.added.length, updated: scan.updated.length, deleted: scan.deleted.length },
      "watcher: scan complete"
    );

    // Hand the queue the total expected work so /queue can compute
    // a real progress percentage. Counts every discovered delta
    // (added + updated + deleted) — same set we're about to enqueue.
    ingestQueue.setTotal(
      folder.id,
      scan.added.length + scan.updated.length + scan.deleted.length
    );

    // Enqueue every discovered file into the ingest queue and wait for
    // it to drain. This keeps the synchronous semantics callers depend on
    // (syncFolder returns only after all files are ingested) while
    // bounding per-folder concurrency inside the queue — which is what
    // makes a startup scan over a 10k-file folder finish without
    // saturating disk IO. We reset counters first so the drain snapshot
    // only reflects this run.
    ingestQueue.resetCounters(folder.id);
    for (const entry of scan.added) {
      ingestQueue.enqueue({
        key: `${folder.id}::${entry.relPath}`,
        folderId: folder.id,
        tenantId: folder.tenantId,
        kind: "added",
        relPath: entry.relPath,
        entry,
        enqueuedAt: Date.now()
      });
    }
    for (const entry of scan.updated) {
      ingestQueue.enqueue({
        key: `${folder.id}::${entry.relPath}`,
        folderId: folder.id,
        tenantId: folder.tenantId,
        kind: "updated",
        relPath: entry.relPath,
        entry,
        enqueuedAt: Date.now()
      });
    }
    for (const relPath of scan.deleted) {
      ingestQueue.enqueue({
        key: `${folder.id}::${relPath}`,
        folderId: folder.id,
        tenantId: folder.tenantId,
        kind: "deleted",
        relPath,
        enqueuedAt: Date.now()
      });
    }

    const finalProgress = options.waitForCompletion === false
      ? { added: 0, updated: 0, deleted: 0, failed: 0 } // fire-and-forget; queue drains in background
      : await ingestQueue.drainFolder(folder.id);
    if (options.waitForCompletion !== false) {
      stats.added = finalProgress.added;
      stats.updated = finalProgress.updated;
      stats.deleted = finalProgress.deleted;
      stats.failed = finalProgress.failed;
    }

    await markFolderScanned(folder.id, null);
  } catch (error) {
    errorMessage = (error as Error).message;
    status = "failed";
    stats.failed += 1;
    await markFolderScanned(folder.id, errorMessage);
    logger.error({ folderId, runId: run.id, error: errorMessage }, "watcher: sync failed");
  }

  if (options.waitForCompletion !== false) {
    // Collapse raw task-status + per-file failures into one of the 3
    // user-facing states. File-level errors do NOT poison the task status;
    // they show up via filesFailed and the manifest's failed rows instead.
    const finalStatus = finalizeStatus(status, stats.failed);
    await finishSyncRun(run.id, finalStatus, statsToRow(stats), errorMessage);
    logger.info({ folderId, runId: run.id, status: finalStatus, stats }, "watcher: sync finished");
    return { runId: run.id, stats, status: finalStatus, errorMessage: errorMessage ?? undefined };
  }

  // Fire-and-forget path: finishSyncRun must STILL be called when the
  // queue eventually drains, otherwise the run row stays "running"
  // forever and clogs the UI's "Recent sync" list. We schedule a
  // background wait that finishes the run after drain (success or
  // failure). The run row remains "running" with zero stats until
  // the queue finishes, which is exactly what the UI queue endpoint
  // shows for live progress.
  logger.info(
    { folderId, runId: run.id, trigger },
    "watcher: sync enqueued (fire-and-forget, will finish when queue drains)"
  );
  void (async () => {
    try {
      const drained = await ingestQueue.drainFolder(folder.id);
      const finalStats = {
        added: drained.added,
        updated: drained.updated,
        deleted: drained.deleted,
        failed: drained.failed
      };
      // Status flips to "completed" only when the queue finished without
      // errors AND the orchestrator didn't already fail; otherwise we map
      // onto the 3-state shape so per-file errors surface as
      // "completed_with_errors" rather than poisoning the whole task.
      const finalStatus = finalizeStatus(status, drained.failed);
      await finishSyncRun(run.id, finalStatus, statsToRow(finalStats), errorMessage);
      logger.info(
        { folderId, runId: run.id, status: finalStatus, stats: finalStats },
        "watcher: fire-and-forget sync finished"
      );
    } catch (drainErr) {
      // If drainFolder itself throws (e.g. folder deleted mid-flight),
      // fall back to marking the run failed so the UI can recover.
      try {
        await finishSyncRun(
          run.id,
          "failed",
          statsToRow({ added: stats.added, updated: stats.updated, deleted: stats.deleted, failed: 1 }),
          (drainErr as Error).message
        );
      } catch {
        // Best-effort — the next boot's zombie cleanup will catch it.
      }
      logger.error(
        { folderId, runId: run.id, error: (drainErr as Error).message },
        "watcher: fire-and-forget drain failed"
      );
    }
  })();
  return { runId: run.id, stats: { added: 0, updated: 0, deleted: 0, failed: 0 }, status: "completed", errorMessage: errorMessage ?? undefined };
}

/**
 * Ingest (or re-ingest) one file. Returns true on success, false on failure.
 * On success the manifest is updated to `synced` with the new document id.
 */
export async function ingestEntry(
  folder: WatchedFolderRecord,
  entry: FileEntry,
  stats: SyncStats,
  kind: "added" | "updated",
  signal?: AbortSignal
): Promise<boolean> {
  // Abort check (pause/resume): drop the file immediately so a paused
  // folder's pending queue doesn't keep ticking through ingest. We also
  // throw so the caller's catch (processItem) can tag the manifest as
  // "cancelled" instead of "synced" — the file is not actually in the DB.
  if (signal?.aborted) {
    throw new AbortError("folder paused before ingest started");
  }
  // Filter: extension + size. If the user didn't set a whitelist on the
  // folder, fall back to DEFAULT_SUPPORTED_EXTENSIONS so a recursive watch
  // over Documents (which contains game saves, emoji, caches, etc.) doesn't
  // try to ingest every file under the sun.
  const userFilter = folder.filetypeFilter ?? {};
  const effectiveFilter: FiletypeFilter = userFilter.whitelist
    ? userFilter
    : { ...userFilter, whitelist: DEFAULT_SUPPORTED_EXTENSIONS };
  const decision = shouldIncludeFile(entry.relPath, effectiveFilter);
  if (!decision.include) {
    logger.info({ folderId: folder.id, relPath: entry.relPath, reason: decision.reason }, "watcher: skipping file (filter)");
    // Don't count it as a failure; the user explicitly excluded it.
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      mtimeMs: entry.mtimeMs,
      inode: entry.inode,
      sizeBytes: entry.sizeBytes,
      sha1: entry.sha1,
      status: "synced",
      lastError: `skipped: ${decision.reason ?? "excluded"}`
    });
    return false;
  }
  if (effectiveFilter.maxBytes && entry.sizeBytes > effectiveFilter.maxBytes) {
    logger.info(
      { folderId: folder.id, relPath: entry.relPath, size: entry.sizeBytes, max: effectiveFilter.maxBytes },
      "watcher: skipping file (too large)"
    );
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      mtimeMs: entry.mtimeMs,
      inode: entry.inode,
      sizeBytes: entry.sizeBytes,
      sha1: entry.sha1,
      status: "synced",
      lastError: "skipped: exceeds maxBytes"
    });
    return false;
  }

  // Manifest lock: only one worker can take a given file from pending → syncing.
  // If another worker beat us to it, we leave it alone.
  const prevManifest = await getManifestEntry(folder.id, entry.relPath);
  if (prevManifest?.status === "syncing") {
    logger.info({ folderId: folder.id, relPath: entry.relPath }, "watcher: file already syncing, skipping duplicate");
    return false;
  }
  // For an `added` kind, a manifest row already in `synced` state means a
  // previous ingest won the race. Skipping prevents double-ingest when two
  // sync calls race on the same file and the first one finishes (transition
  // pending → syncing → ingest → upsert(synced)) before the second sync
  // call reaches this point. Re-ingesting an `updated` file is still
  // allowed, so we don't skip `updated` here.
  if (kind === "added" && prevManifest?.status === "synced") {
    logger.info({ folderId: folder.id, relPath: entry.relPath }, "watcher: file already synced, skipping duplicate add");
    return false;
  }

  const acquired = await transitionManifestStatus(
    folder.id,
    entry.relPath,
    ["pending", "synced", "failed"],
    "syncing",
    { documentId: null, lastError: null, allowInsert: true }
  );
  if (!acquired) {
    // Another worker beat us to the transition (manifest is now in
    // `syncing` or a non-eligible status). For both `added` and `updated`
    // we skip — the parallel ingest would otherwise double-write the
    // document row and break the test expectations / dedupe contract.
    logger.info({ folderId: folder.id, relPath: entry.relPath }, "watcher: lost transition race, skipping");
    return false;
  }

  // P0 fix (Sprint 2): when re-ingesting an existing file we MUST delete the
  // old document first, otherwise it stays in the DB as an orphan and the
  // manifest simply overwrites documentId with the new id.
  if (kind === "updated" && prevManifest?.documentId) {
    await deleteOldDocument(webuiService, prevManifest.documentId, folder.tenantId, stats, folder.id, entry.relPath);
  }

  try {
    // Per-file sync timing. Capture `startedAt` as the wall-clock
    // moment we begin the actual ingestion (after the filter + lock
    // acquisition above), then derive `durationMs` once the call
    // resolves. The `upsertManifest` writer persists both columns so
    // the manifest table can answer "which file types are slow".
    const startedAt = new Date();
    const readTimer = Date.now();
    if (signal?.aborted) {
      throw new AbortError("folder paused before readContent");
    }
    const { content, title } = await readContent(folder, entry);
    if (signal?.aborted) {
      throw new AbortError("folder paused after readContent");
    }
    const readMs = Date.now() - readTimer;
    const skipExtraction = folder.metadata?.skipExtraction === true;
    const result = await ingestionService.ingestDocument({
      sourceId: folder.sourceId,
      title,
      content,
      extract: !skipExtraction,
      metadata: {
        watchedFolderId: folder.id,
        relPath: entry.relPath,
        sourcePath: entry.absPath,
        ingestedVia: "watcher",
        ingestedAt: toLocalISO(),
        extension: getExtension(entry.relPath)
      },
      signal
    }, folder.tenantId);
    const durationMs = Date.now() - startedAt.getTime();

    const syncStatus = result.status === "PARTIAL_SUCCESS" ? "partial" : "synced";
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      mtimeMs: entry.mtimeMs,
      inode: entry.inode,
      sizeBytes: entry.sizeBytes,
      sha1: entry.sha1,
      status: syncStatus,
      documentId: result.documentId,
      lastSyncStartedAt: startedAt,
      lastSyncDurationMs: durationMs
    });
    logger.info(
      {
        folderId: folder.id,
        relPath: entry.relPath,
        documentId: result.documentId,
        status: syncStatus,
        kind,
        durationMs,
        readMs,
        // `ingestMs` is the time inside ingestDocument (chunking +
        // embedding + DB write). `readMs` covers file IO + parser
        // (xlsx → markdown, pdf → text, etc.). For small txt/md files
        // readMs is tiny; for xlsx with thousands of rows the parser
        // dominates. Use these two numbers to know which side to optimise.
        ingestMs: durationMs - readMs
      },
      "watcher: file ingested"
    );
    return true;
  } catch (error) {
    const err = error as Error & {
      isAbort?: boolean;
      code?: string;
      // For Node-level network errors (ECONNRESET, ETIMEDOUT, etc.)
      errno?: number;
      syscall?: string;
    };
    // P0 — defensive message coercion. The downstream Error chain
    // (LLM client, ingestion-service, embedding-client) occasionally
    // throws an Error subclass with `.message === undefined` — e.g.
    // a chunked AbortError re-thrown without `super(message)`, an
    // HTTP error that only populates `.code`/`.errno`, or a
    // third-party Error that forgot to set `.message`. Reading
    // `.message` directly would yield `undefined` and crash
    // `classifyErrorPhase(undefined.toLowerCase())` (see
    // sag_xlsx-同步进度-toLowerCase-20260828.md). The fallback string
    // surfaces the error name + code so the row still gets a useful
    // marker instead of silently turning into "[unknown]".
    const rawMessage = (err && typeof err.message === "string") ? err.message : "";
    const message = rawMessage || `<no message: ${err?.name ?? typeof error}>`;
    // AbortError (paused folder): don't bump failed stats, don't write
    // "failed" to the manifest. The manifest stays as it was (pending
    // or syncing) and a future resume will pick it up via re-scan.
    if (err.isAbort) {
      logger.info(
        { folderId: folder.id, relPath: entry.relPath, reason: message },
        "watcher: ingest aborted (folder paused)"
      );
      // Throw so the queue's processItem doesn't bump its own failed
      // counter either. The AbortError propagates out of ingestEntry.
      throw err;
    }
    stats.failed += 1;
    // P3 — see sag_xlsx-9-数据中台文件夹失败根因-20260827.md §根因 #3.
    //
    // The previous code stamped the raw error message into last_error
    // with no phase indicator. That made the UI indistinguishable: a
    // "com-extract failed" error (PS helper exit) would look the same
    // as an "llm request aborted" error (HTTP timeout deep in
    // ingestionService). For the data-platform folder this hid the
    // real failure cause — 5 of the 32 failed xlsx/pdf/docx files
    // showed `last_error = "llm request aborted: timed out after
    // 120000ms"` even though the LLM had never been called (manifest
    // had hash="", chunk_count_pending=0, chunk_count_embedded=0).
    //
    // Mark the phase explicitly: `read:` for failures that originated
    // inside `readContent` / COM extract, `ingest:` for failures that
    // originated inside ingestionService (chunking / embedding / LLM).
    // The marker is appended to last_error so existing UI still works
    // while a future release can split it out into a dedicated column.
    const phase = classifyErrorPhase(message);
    await markFailed(folder.id, entry.relPath, `${phase} ${message}`);
    // Capture full error context so the next incident (CA-19-style
    // "This operation was aborted") doesn't leave us guessing. We log:
    //   - errorName: distinguishes `AbortError` / `OperationCanceledException` /
    //     `Error` / etc. — the previous heuristic on message text alone was
    //     unreliable (see sag_xlsx-CA-19-aborted-诚实评估-20260818.md).
    //   - errorStack: shows the throw site, so we know whether it came from
    //     ingestionService, an HTTP call, or a SQLite driver.
    //   - code/errno/syscall: node-level transport errors that look like
    //     aborts but aren't.
    //   - signalAborted: whether the upstream AbortSignal was fired
    //     BEFORE the error (meaning the error is a consequence of cancel,
    //     not a real failure).
    logger.error(
      {
        folderId: folder.id,
        relPath: entry.relPath,
        phase,
        error: message,
        errorName: err.name,
        errorStack: err.stack,
        errorCode: err.code,
        errorErrno: err.errno,
        errorSyscall: err.syscall,
        signalAborted: signal?.aborted ?? null
      },
      "watcher: ingest failed"
    );
    return false;
  }
}

/**
 * P3 — tag an ingest error with its source phase so the UI doesn't
 * mistake a COM/extract failure for an LLM failure (and vice versa).
 *
 * Rules (loose substring match — we want this to survive PS helper
 * rewording, not be brittle):
 *   - messages that mention "com-extract" / "powershell exit" / "PS1"
 *     come from the read/extract path
 *   - messages that mention "llm" / "embedding" / "aborted: timed out"
 *     come from the ingest path (LLM / embedding HTTP)
 *   - everything else is treated as a generic ingest error
 *
 * P0 — defensive `String(message ?? "")` coercion. The raw Error caught
 * from upstream layers (LLM client, ingestion-service, embedding-client)
 * occasionally lands here with `.message === undefined`: a chunked
 * AbortError re-thrown without super(message), an HTTP error path that
 * sets only `.code` / `.errno`, or a third-party Error subclass that
 * forgot to populate `.message`. The previous code did
 * `message.toLowerCase()` and crashed on those — see
 * sag_xlsx-同步进度-toLowerCase-20260828.md. Falling back to the empty
 * string routes the row to "[unknown]" and keeps the queue alive.
 */
function classifyErrorPhase(message: unknown): "[read]" | "[ingest]" | "[unknown]" {
  const m = String(message ?? "").toLowerCase();
  if (
    m.includes("com-extract") ||
    m.includes("powershell exit") ||
    m.includes("ps1 exit") ||
    m.includes("openxml") ||
    m.includes("openxml failed") ||
    m.includes("openxml timed out") ||
    m.includes("open() failed") ||
    m.includes("open() timed out") ||
    m.includes("open returned null document")
  ) {
    return "[read]";
  }
  if (
    m.includes("llm") ||
    m.includes("embedding") ||
    m.includes("aborted: timed out") ||
    m.includes("chunk")
  ) {
    return "[ingest]";
  }
  return "[unknown]";
}

/**
 * Remove a file's document. We use a soft-delete on the manifest
 * (status = `deleted`) so re-adding the file later isn't a confusing re-ingest.
 */
export async function removeEntry(
  folder: WatchedFolderRecord,
  relPath: string
): Promise<boolean> {
  try {
    const manifest = await getManifestEntry(folder.id, relPath);
    if (!manifest) {
      return true;
    }
    if (manifest.documentId) {
      try {
        await webuiService.deleteDocument(manifest.documentId, folder.tenantId);
      } catch (error) {
        // "文档不存在" is fine — somebody else deleted it. Anything else bubbles up.
        const msg = (error as Error).message;
        if (!/不存在|not found/i.test(msg)) {
          throw error;
        }
      }
    }
    await deleteManifest(folder.id, relPath);
    logger.info({ folderId: folder.id, relPath }, "watcher: file removed");
    return true;
  } catch (error) {
    logger.error(
      { folderId: folder.id, relPath, error: (error as Error).message },
      "watcher: failed to remove file"
    );
    return false;
  }
}

/**
 * Read the file's content as markdown, using the Python converter for binary
 * formats and passing text through directly.
 */
async function readContent(
  folder: WatchedFolderRecord,
  entry: FileEntry
): Promise<{ content: string; title: string }> {
  const ext = getExtension(entry.relPath);
  const title = path.basename(entry.relPath).replace(/\.[^.]+$/, "") || entry.relPath;

  if (ext === ".txt" || ext === ".md") {
    const content = await fs.readFile(entry.absPath, "utf-8");
    return { content, title };
  }

  // The Node converter reads directly from `absPath` and writes a sibling
  // `.md` debug copy under .tmp/watcher/ for parity with the old Python
  // flow. We pass the original path twice — the converter ignores the
  // "input" alias and just reads absPath again.
  const debugDir = path.join(process.cwd(), ".tmp", "watcher");
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const debugOutput = path.join(debugDir, `${stamp}_${path.basename(entry.relPath)}.md`);
  const content = await convertFile(entry.absPath, debugOutput);
  return { content, title };
}

async function markFailed(folderId: string, relPath: string, message: string): Promise<void> {
  try {
    await upsertManifest({
      folderId,
      relPath,
      status: "failed",
      lastError: message.slice(0, 1000)
    });
  } catch (error) {
    logger.error({ folderId, relPath, error: (error as Error).message }, "watcher: failed to mark manifest failed");
  }
}

// ─── Test / extension seams ──────────────────────────────────────────────────

/**
 * Replaceable seams so tests can swap out ingestionService / webuiService /
 * the analyzer / converter without going through vi.mock on dynamic imports.
 * Production code never touches these — they're for the orchestrator tests.
 */
export interface OrchestratorOverrides {
  ingestionService?: {
    ingestDocument: (input: {
      sourceId?: string;
      title: string;
      content: string;
      metadata?: Record<string, unknown>;
    }, tenantId?: string) => Promise<{ documentId: string; sourceId: string; chunkCount: number; eventCount: number; taskId: string; traceId: string }>;
  };
  webuiService?: {
    deleteDocument: (documentId: string, tenantId?: string) => Promise<{ deleted: boolean }>;
  };
  analyze?: (folder: WatchedFolderRecord) => Promise<ScanResult>;
  /** Max files ingested concurrently. Default: 5. */
  maxConcurrency?: number;
}

export async function syncFolderWith(
  folderId: string,
  trigger: SyncRunTrigger,
  tenantId: string,
  overrides: OrchestratorOverrides = {}
): Promise<{ runId: string; stats: SyncStats; status: "completed" | "completed_with_errors" | "failed"; errorMessage?: string }> {
  const folder = await getFolder(folderId, tenantId);
  if (!folder) {
    throw new Error(`watched folder not found: ${folderId}`);
  }

  const run = await createSyncRun(folderId, trigger);
  const stats: SyncStats = { added: 0, updated: 0, deleted: 0, failed: 0 };
  const ingest = overrides.ingestionService ?? ingestionService;
  const webui = overrides.webuiService ?? webuiService;
  const analyze = overrides.analyze ?? ((f) => scanFolder(f, []));
  // See config/env.ts. There's no longer a hard serial cap; we cap at 4
  // so concurrent ingestion stays within what the LLM/embedding endpoints
  // can absorb. Callers can still pass overrides.maxConcurrency to
  // tighten further.
  const concurrency = Math.min(overrides.maxConcurrency ?? config.INGEST_CONCURRENCY, 4);

  let errorMessage: string | null = null;
  let status: "completed" | "failed" = "completed";

  try {
    const scan = await analyze(folder);
    const limit = pLimit(concurrency);

    const addResults = await Promise.all(
      scan.added.map((entry) =>
        limit(() => ingestOne(folder, entry, stats, ingest, webui, "added").then((ok) => (ok ? 1 : 0)))
      )
    );
    stats.added = addResults.reduce<number>((s, v) => s + v, 0);

    const updateResults = await Promise.all(
      scan.updated.map((entry) =>
        limit(() => ingestOne(folder, entry, stats, ingest, webui, "updated").then((ok) => (ok ? 1 : 0)))
      )
    );
    stats.updated = updateResults.reduce<number>((s, v) => s + v, 0);

    for (const relPath of scan.deleted) {
      const ok = await removeOne(folder, relPath, webui);
      if (ok) {
        stats.deleted += 1;
      }
    }

    await markFolderScanned(folder.id, null);
  } catch (error) {
    errorMessage = (error as Error).message;
    status = "failed";
    stats.failed += 1;
    await markFolderScanned(folder.id, errorMessage);
  }

  const finalStatus = finalizeStatus(status, stats.failed);
  await finishSyncRun(run.id, finalStatus, statsToRow(stats), errorMessage);
  return { runId: run.id, stats, status: finalStatus, errorMessage: errorMessage ?? undefined };
}

async function ingestOne(
  folder: WatchedFolderRecord,
  entry: FileEntry,
  stats: SyncStats,
  ingest: OrchestratorOverrides["ingestionService"],
  webui: OrchestratorOverrides["webuiService"] | undefined,
  kind: "added" | "updated"
): Promise<boolean> {
  if (!ingest) {
    return false;
  }
  const filter = folder.filetypeFilter ?? {};
  const decision = shouldIncludeFile(entry.relPath, filter);
  if (!decision.include) {
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      status: "synced",
      lastError: `skipped: ${decision.reason ?? "excluded"}`
    });
    return false;
  }
  if (filter.maxBytes && entry.sizeBytes > filter.maxBytes) {
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      status: "synced",
      lastError: "skipped: exceeds maxBytes"
    });
    return false;
  }

  // Manifest lock: only one worker can take a given file from pending → syncing.
  // We re-check the manifest right before transitioning so a parallel ingest
  // that just won the race isn't double-ingested. transitionManifestStatus
  // also enforces this via the ON CONFLICT WHERE clause, but the read here
  // gives us a fast-path that avoids the INSERT/CONFLICT round-trip when
  // we're guaranteed to lose.
  const prevManifest = await getManifestEntry(folder.id, entry.relPath);
  if (prevManifest?.status === "syncing") {
    logger.info({ folderId: folder.id, relPath: entry.relPath }, "watcher: file already syncing, skipping duplicate");
    return false;
  }
  // For an `added` kind, a manifest row already in `synced` state means a
  // previous ingest won the race. See comment in `ingestEntry` above for
  // the full rationale. The seam mirrors the production path so the
  // race-condition tests exercise the same dedupe contract.
  if (kind === "added" && prevManifest?.status === "synced") {
    logger.info({ folderId: folder.id, relPath: entry.relPath }, "watcher: file already synced, skipping duplicate add");
    return false;
  }

  const acquired = await transitionManifestStatus(
    folder.id,
    entry.relPath,
    ["pending", "synced", "failed"],
    "syncing",
    { allowInsert: true }
  );
  if (!acquired) {
    // Either another worker beat us to it (status was already 'syncing'),
    // or — for kind='updated' — the row is in some unexpected state.
    logger.info({ folderId: folder.id, relPath: entry.relPath, kind }, "watcher: lost transition race, skipping");
    return false;
  }

  // P0 fix (Sprint 2): mirror the production path's orphan-document cleanup.
  // If the previous manifest had a document id, hard-delete it before we
  // create the new document. Swallow "not found" errors (idempotent).
  if (kind === "updated") {
    const prev = await getManifestEntry(folder.id, entry.relPath);
    if (prev?.documentId) {
      await deleteOldDocument(webui, prev.documentId, folder.tenantId, stats, folder.id, entry.relPath);
    }
  }

  try {
    // Per-file sync timing. Same pattern as the production
    // `ingestEntry` above — capture start before any I/O and emit
    // duration on the terminal `upsertManifest` so the test seam
    // exercises the same column shape. Without this, the
    // manifest-store.test fixtures would have to special-case
    // `ingestOne` to avoid regressing the timing contract.
    const startedAt = new Date();
    const content = await fs.readFile(entry.absPath, "utf-8");
    const result = await ingest.ingestDocument({
      sourceId: folder.sourceId,
      title: path.basename(entry.relPath).replace(/\.[^.]+$/, ""),
      content,
      metadata: {
        watchedFolderId: folder.id,
        relPath: entry.relPath,
        sourcePath: entry.absPath
      }
    }, folder.tenantId);
    const durationMs = Date.now() - startedAt.getTime();
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      mtimeMs: entry.mtimeMs,
      inode: entry.inode,
      sizeBytes: entry.sizeBytes,
      sha1: entry.sha1,
      status: "synced",
      documentId: result.documentId,
      lastSyncStartedAt: startedAt,
      lastSyncDurationMs: durationMs
    });
    return true;
  } catch (error) {
    stats.failed += 1;
    await upsertManifest({
      folderId: folder.id,
      relPath: entry.relPath,
      status: "failed",
      lastError: (error as Error).message.slice(0, 1000)
    });
    return false;
  }
}

async function removeOne(
  folder: WatchedFolderRecord,
  relPath: string,
  webui: OrchestratorOverrides["webuiService"]
): Promise<boolean> {
  if (!webui) {
    return false;
  }
  try {
    const manifest = await getManifestEntry(folder.id, relPath);
    if (!manifest) {
      return true;
    }
    if (manifest.documentId) {
      try {
        await webui.deleteDocument(manifest.documentId, folder.tenantId);
      } catch (error) {
        const msg = (error as Error).message;
        if (!/不存在|not found/i.test(msg)) {
          throw error;
        }
      }
    }
    await deleteManifest(folder.id, relPath);
    // Physically remove the tombstone immediately so the manifest
    // list and `total` stop showing ghost rows right away — the
    // scheduled sweep would catch it within 24h anyway. The cutoff
    // is "now" (olderThanDays=0) which matches the just-set
    // last_seen_at from deleteManifest above. We swallow errors
    // here because the row is already in the tombstone state, so
    // a transient failure just means it gets cleaned up on the
    // next sweep instead of right now.
    try {
      await purgeDeletedManifests(folder.id, toLocalISO());
    } catch (error) {
      logger.warn(
        { folderId: folder.id, relPath, error: (error as Error).message },
        "watcher: immediate tombstone purge failed, sweep will retry"
      );
    }
    return true;
  } catch (error) {
    logger.error(
      { folderId: folder.id, relPath, error: (error as Error).message },
      "watcher: remove failed"
    );
    return false;
  }
}

// Re-export defaults so callers don't need to know about the orchestrator-internal alias.
export { DEFAULT_SUPPORTED_EXTENSIONS };
export type { CreateWatchedFolderInput };

/**
 * Delete a previous-version document before re-ingesting a changed file.
 *
 * - Idempotent: "document not found" / "文档不存在" errors are swallowed (the
 *   same doc might have been deleted by a concurrent worker).
 * - Failure does NOT abort the sync run. A delete that fails for a different
 *   reason is logged and counted in `filesFailed` so the run still surfaces
 *   the issue, but the new ingest will still proceed (leaving us with a
 *   potential duplicate document rather than blocking the user).
 */
async function deleteOldDocument(
  webui: { deleteDocument: (documentId: string, tenantId?: string) => Promise<{ deleted: boolean }> } | undefined,
  oldDocumentId: string,
  tenantId: string,
  stats: SyncStats,
  folderId: string,
  relPath: string
): Promise<void> {
  if (!webui) {
    return;
  }
  try {
    await webui.deleteDocument(oldDocumentId, tenantId);
    logger.info({ folderId, relPath, oldDocumentId }, "watcher: old document deleted before re-ingest");
  } catch (error) {
    const msg = (error as Error).message;
    if (/不存在|not found/i.test(msg)) {
      // Already gone — nothing to do. The new ingest will still produce a
      // single, current document.
      logger.info({ folderId, relPath, oldDocumentId }, "watcher: old document already gone, skipping delete");
      return;
    }
    stats.failed += 1;
    logger.error(
      { folderId, relPath, oldDocumentId, error: msg },
      "watcher: failed to delete old document before re-ingest (continuing)"
    );
  }
}

function statsToRow(stats: SyncStats): {
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesFailed: number;
} {
  return {
    filesAdded: stats.added,
    filesUpdated: stats.updated,
    filesDeleted: stats.deleted,
    filesFailed: stats.failed
  };
}

/**
 * Collapse the in-flight task status + the per-file failure count into the
 * 3-state shape exposed to the UI. The rule:
 *
 *   task failed  → "failed"           (folder is gone, scan threw, etc.)
 *   no failures  → "completed"
 *   otherwise    → "completed_with_errors"
 *
 * The point is that "I tried 10k files and 2 of them threw" must not look
 * like "the sync crashed". Both states are surfaced; the user just gets a
 * different badge and a different default CTA (Retry failed vs Trigger
 * sync).
 */
export function finalizeStatus(
  taskStatus: "completed" | "failed",
  filesFailed: number
): "completed" | "completed_with_errors" | "failed" {
  if (taskStatus === "failed") {
    return "failed";
  }
  if (filesFailed > 0) {
    return "completed_with_errors";
  }
  return "completed";
}