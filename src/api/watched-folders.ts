/**
 * Watched Folders API — Sprint 2
 *
 * Exposes CRUD + lifecycle endpoints for the `watched_folders` feature
 * (Sprint 1). Wires the existing WatcherManager and manifest store into
 * the Fastify HTTP surface so the web UI (or any client) can manage
 * folders over HTTP.
 *
 * Conventions:
 *   - All routes accept `?tenantId=` (defaults to `config.DEFAULT_TENANT_ID`).
 *   - Folder create / delete also start/stop the chokidar watcher.
 *   - 4xx errors use the same `{ error: { code, message } }` shape as the
 *     rest of the API (see `src/api/server.ts` `notFound()` helper).
 *   - Path-not-existing → 400; duplicate path → 409; concurrent sync → 409.
 *
 * NOTE: This module only defines routes; it's registered in
 * `src/api/server.ts` via `registerWatchedFoldersRoutes(app)`. The host
 * file's existing logic is not modified.
 */

import { promises as fs } from "node:fs";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/env.js";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";
import {
  createFolder,
  deleteFolder,
  getFolder,
  getFolderByPath,
  getLatestSyncRun,
  getManifest,
  getManifestEntry,
  getManifestPage,
  listFailedManifestEntries,
  listFolders,
  listSyncRuns,
  purgeDeletedManifests,
  resetManifestEntryForRetry,
  updateFolder
} from "../watcher/manifest-store.js";
import { syncFolder } from "../watcher/sync-orchestrator.js";
import { retryAllFailedEntries, retryEntries, watcherManager } from "../watcher/index.js";
import { ingestQueue } from "../watcher/ingest-queue.js";
import {
  mergeAndRegisterMergedDataFolder,
  mergedDataReady,
  type MergeResult
} from "../services/merge-data-service.js";
import type { ManifestStatus, WatchedFolderRecord } from "../watcher/types.js";

const filetypeFilterSchema = z.object({
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
  maxBytes: z.number().int().positive().optional()
});

const folderCreateSchema = z.object({
  path: z.string().min(1),
  displayName: z.string().optional(),
  recursive: z.boolean().default(true),
  filetypeFilter: filetypeFilterSchema.default({}),
  metadata: z.record(z.unknown()).default({}),
  /** Bind to an existing project instead of auto-creating a new one. */
  sourceId: z.string().uuid().optional()
});

const folderUpdateSchema = z.object({
  displayName: z.string().optional(),
  enabled: z.boolean().optional(),
  recursive: z.boolean().optional(),
  filetypeFilter: filetypeFilterSchema.optional(),
  metadata: z.record(z.unknown()).optional()
});

const tenantQuerySchema = z.object({
  tenantId: z.string().min(1).optional()
});

const runsQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  limit: z.string().optional(),
  cursor: z.string().min(1).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  includeTotal: z.preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v.toLowerCase() !== "false" && v !== "0";
    return Boolean(v);
  }, z.boolean()).optional()
});

// Boolean coercion that correctly turns query strings like
// "?includeTotal=false" into `false`. `z.coerce.boolean()` would
// always yield `true` because the string "false" is truthy in JS.
const queryBool = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() !== "false" && v !== "0";
  return Boolean(v);
}, z.boolean());

const manifestQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  status: z.enum(["pending", "syncing", "synced", "failed", "deleted"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
  sort: z.enum(["recent", "path"]).optional(),
  includeTotal: queryBool.optional()
});

// In-process guard: one folder can only have one sync run at a time.
const activeSyncs = new Map<string, Promise<unknown>>();

export function registerWatchedFoldersRoutes(app: FastifyInstance): void {
  // ─── POST /api/watched-folders ────────────────────────────────────────────
  app.post("/api/watched-folders", async (request, reply) => {
    const tenantId = readTenant(request);
    const input = folderCreateSchema.parse(request.body);

    // Path must exist and be a directory. We do this BEFORE hitting the DB so
    // that the user gets a clear error message for typo'd paths.
    try {
      const stat = await fs.stat(input.path);
      if (!stat.isDirectory()) {
        return reply.code(400).send(apiError(
          "FOLDER_PATH_NOT_DIRECTORY",
          `path is not a directory: ${input.path}`
        ));
      }
    } catch (error) {
      return reply.code(400).send(apiError(
        "FOLDER_PATH_NOT_FOUND",
        `path not accessible: ${(error as Error).message}`
      ));
    }

    const existing = await getFolderByPath(input.path, tenantId);
    if (existing) {
      return reply.code(409).send(apiError(
        "FOLDER_PATH_ALREADY_EXISTS",
        `a watched folder for this path already exists (id=${existing.id})`
      ));
    }

    const folder = await createFolder({
      tenantId,
      path: input.path,
      displayName: input.displayName,
      recursive: input.recursive,
      filetypeFilter: input.filetypeFilter,
      metadata: input.metadata,
      enabled: true,
      sourceId: input.sourceId
    });

    // Best-effort: start watching. The DB row is the source of truth; if the
    // watcher fails to start (e.g. production guard), we still report success
    // so the user can retry by patching enabled / restarting the server.
    try {
      await watcherManager.startOne(folder);
    } catch (error) {
      logger.error(
        { folderId: folder.id, error: (error as Error).message },
        "watched-folders: start watcher failed (folder created in DB)"
      );
    }

    return reply.code(201).send({ folder: decorateFolder(folder) });
  });

  // ─── GET /api/watched-folders/merge-data-ready ────────────────────────────
  // Lightweight probe the Web UI calls before showing the "合并数据"
  // button. Returns whether `<exeDir>/合并数据/data/sag.db` exists and is
  // readable, plus the absolute path so the user knows what will be merged.
  app.get("/api/watched-folders/merge-data-ready", async (request, reply) => {
    const tenantId = readTenant(request);
    void tenantId;
    const status = await mergedDataReady();
    return reply.code(200).send({
      ready: status.ready,
      dbPath: status.dbPath,
      reason: status.reason ?? null
    });
  });

  // ─── POST /api/watched-folders/merge-data ────────────────────────────────
  // Atomic "click the button" endpoint: validates the merge dump, creates
  // a fresh auto-source + watched folder pointing at `<exeDir>/合并数据/`,
  // copies data tables into the main DB inside a single transaction, and
  // starts the watcher. Conflicts on documents are resolved by the newer
  // `updated_at` winning.
  app.post("/api/watched-folders/merge-data", async (request, reply) => {
    const tenantId = readTenant(request);
    const body = z.object({
      displayName: z.string().optional()
    }).parse(request.body ?? {});

    try {
      const result: MergeResult = await mergeAndRegisterMergedDataFolder({
        tenantId,
        displayName: body.displayName
      });
      return reply.code(201).send({ result });
    } catch (error) {
      const message = (error as Error).message;
      logger.error({ tenantId, error: message }, "watched-folders: merge-data failed");
      const code =
        message.includes("ENOENT") || message.includes("not found") || message.includes("not a")
          ? "MERGE_DATA_NOT_READY"
          : message.includes("missing required table") || message.includes("no watched_folder")
            ? "MERGE_DATA_INVALID"
            : "MERGE_DATA_FAILED";
      return reply.code(400).send({
        error: { code, message }
      });
    }
  });

  // ─── GET /api/watched-folders ─────────────────────────────────────────────
  app.get("/api/watched-folders", async (request) => {
    const tenantId = readTenant(request);
    const folders = await listFolders(tenantId);
    const decorated = await Promise.all(folders.map(async (f) => {
      const lastRun = await getLatestSyncRun(f.id);
      return decorateFolder(f, lastRun);
    }));
    return { folders: decorated };
  });

  // ─── GET /api/watched-folders/:id ─────────────────────────────────────────
  app.get("/api/watched-folders/:id", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const runs = await listSyncRuns(folder.id, 10);
    // Legacy numeric overload returns SyncRunRecord[]. Narrow so the
    // route's response shape doesn't leak the union type.
    const recentRuns = Array.isArray(runs) ? runs : runs.runs;
    return { folder: decorateFolder(folder, recentRuns[0] ?? null), recentRuns };
  });

  // ─── PATCH /api/watched-folders/:id ───────────────────────────────────────
  app.patch("/api/watched-folders/:id", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const input = folderUpdateSchema.parse(request.body);
    const before = await getFolder(folderId, tenantId);
    if (!before) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }

    const updated = await updateFolder(folderId, {
      displayName: input.displayName,
      enabled: input.enabled,
      recursive: input.recursive,
      filetypeFilter: input.filetypeFilter,
      metadata: input.metadata
    });
    if (!updated) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }

    // Lifecycle: start/stop the watcher if `enabled` flipped.
    const wasEnabled = before.enabled;
    const isEnabled = input.enabled ?? wasEnabled;
    if (wasEnabled !== isEnabled) {
      try {
        if (isEnabled) {
          await watcherManager.startOne(updated);
        } else {
          await watcherManager.stopOne(updated.id);
        }
      } catch (error) {
        logger.error(
          { folderId: updated.id, error: (error as Error).message },
          "watched-folders: lifecycle toggle failed (DB updated)"
        );
      }
    } else if (isEnabled && watcherManager.isRunning(updated.id)) {
      // Recursive / filetypeFilter / metadata changed while running — restart
      // so the chokidar watcher picks up the new depth. Best-effort.
      try {
        await watcherManager.stopOne(updated.id);
        await watcherManager.startOne(updated);
      } catch (error) {
        logger.warn(
          { folderId: updated.id, error: (error as Error).message },
          "watched-folders: restart on config change failed"
        );
      }
    }

    return { folder: decorateFolder(updated) };
  });

  // ─── DELETE /api/watched-folders/:id ──────────────────────────────────────
  app.delete("/api/watched-folders/:id", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    // Stop the watcher BEFORE deleting the row so we don't fire a sync
    // against a folder that's about to be removed.
    try {
      await watcherManager.stopOne(folder.id);
    } catch (error) {
      logger.warn({ folderId: folder.id, error: (error as Error).message }, "watched-folders: stop watcher before delete failed");
    }
    const deleted = await deleteFolder(folder.id, tenantId);
    if (!deleted) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    activeSyncs.delete(folder.id);
    return { deleted: true };
  });

  // ─── POST /api/watched-folders/:id/sync ───────────────────────────────────
  app.post("/api/watched-folders/:id/sync", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    if (activeSyncs.has(folder.id)) {
      return reply.code(409).send(apiError(
        "SYNC_ALREADY_RUNNING",
        "a sync is already running for this folder"
      ));
    }
    // Fire-and-track: we return immediately with the run id, and the sync
    // runs in the background. The client can poll /runs or /manifest to
    // observe progress.
    const runPromise = (async () => {
      try {
        const result = await syncFolder(folder.id, "manual", folder.tenantId);
        return result;
      } finally {
        activeSyncs.delete(folder.id);
      }
    })();
    activeSyncs.set(folder.id, runPromise);
    // Kick the microtask so the runPromise is observable but we don't block.
    runPromise.catch((error) => {
      logger.error({ folderId: folder.id, error: (error as Error).message }, "watched-folders: background sync failed");
    });
    return reply.code(202).send({
      status: "started",
      folderId: folder.id,
      message: "sync started in the background; poll /runs for progress"
    });
  });

  // ─── POST /api/watched-folders/:id/pause ──────────────────────────────────
  app.post("/api/watched-folders/:id/pause", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const updated = await updateFolder(folder.id, { enabled: false });
    try {
      await watcherManager.stopOne(folder.id);
    } catch (error) {
      logger.warn({ folderId: folder.id, error: (error as Error).message }, "watched-folders: pause stop watcher failed");
    }
    return { folder: updated ? decorateFolder(updated) : null };
  });

  // ─── POST /api/watched-folders/:id/resume ─────────────────────────────────
  app.post("/api/watched-folders/:id/resume", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const updated = await updateFolder(folder.id, { enabled: true });
    if (updated) {
      try {
        await watcherManager.startOne(updated);
      } catch (error) {
        const err = error as Error & { probe?: unknown };
        logger.error({ folderId: updated.id, error: err.message }, "watched-folders: resume start watcher failed");
        // Preflight failure: surface the embedding probe to the caller so
        // the UI can show "embedding API unreachable: 401 ..." instead
        // of a generic 500. 503 Service Unavailable conveys "the system
        // is up but a dependency is down" which is the right shape here.
        if (err.probe) {
          return reply.code(503).send({
            error: {
              code: "WATCHER_PREFLIGHT_FAILED",
              message: err.message,
              probe: err.probe
            }
          });
        }
        return reply.code(500).send(apiError("WATCHER_START_FAILED", err.message));
      }
    }
    return { folder: updated ? decorateFolder(updated) : null };
  });

  // ─── GET /api/watched-folders/:id/runs ────────────────────────────────────
  app.get("/api/watched-folders/:id/runs", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const parsed = runsQuerySchema.safeParse(request.query);
    const limitRaw = parsed.success ? parsed.data.limit : undefined;
    const limit = clampInt(limitRaw, 50, 1, 200);
    const cursor = parsed.success ? parsed.data.cursor : undefined;
    const offsetRaw = parsed.success ? parsed.data.offset : undefined;
    const offset = offsetRaw ? Math.max(0, Number(offsetRaw)) : 0;
    const includeTotal = parsed.success ? parsed.data.includeTotal : undefined;
    const page = await listSyncRuns(folder.id, {
      limit,
      cursor,
      offset,
      includeTotal
    });
    // The repo returns `SyncRunRecord[]` for the legacy numeric arg
    // overload and `SyncRunPage` for the object overload. Object
    // overload is always used here, so narrowing is trivial.
    return page as {
      runs: import("../watcher/types.js").SyncRunRecord[];
      nextCursor: string | null;
      prevOffset: number | null;
      total: number;
      limit: number;
      offset: number;
    };
  });

  // ─── GET /api/watched-folders/:id/manifest ────────────────────────────────
  app.get("/api/watched-folders/:id/manifest", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const parsed = manifestQuerySchema.safeParse(request.query);
    const status = parsed.success ? parsed.data.status : undefined;
    const limit = parsed.success ? parsed.data.limit : undefined;
    const cursor = parsed.success ? parsed.data.cursor : undefined;
    const sort = parsed.success ? parsed.data.sort : undefined;
    const includeTotal = parsed.success ? parsed.data.includeTotal : undefined;
    const offsetRaw = parsed.success ? parsed.data.offset : undefined;
    const offset = offsetRaw != null ? Math.max(0, Number(offsetRaw)) : 0;
    const page = await getManifestPage(folder.id, {
      status: status as ManifestStatus | undefined,
      limit,
      cursor,
      offset,
      sort,
      includeTotal
    });
    return page;
  });

  // ─── GET /api/watched-folders/:id/queue ───────────────────────────────────
  // Returns the live ingest-queue progress for a folder so the UI can
  // surface "syncing N files" instead of leaving the user in the dark
  // after they create a watcher.
  app.get("/api/watched-folders/:id/queue", async (request, reply) => {
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    return { progress: ingestQueue.getProgress(folderId) };
  });

  // ─── POST /api/watched-folders/:id/retry-file ─────────────────────────────
  // Retry a single failed file. Resets the manifest row to `pending` and
  // re-enqueues it as an `updated` ingest. The queue drains in the
  // background; callers can poll /queue for progress and /manifest for the
  // new status.
  //
  // We accept `relPath` as a query parameter rather than a path segment
  // because Fastify v5's catch-all syntax (`/*`) is fragile across
  // versions and unstable when the relPath itself contains slashes.
  // Encoding it into the URL keeps the route shape predictable and
  // matches how the rest of the API treats opaque identifiers.
  const retryFileQuerySchema = z.object({
    tenantId: z.string().min(1).optional(),
    relPath: z.string().min(1)
  });
  app.post("/api/watched-folders/:id/retry-file", async (request, reply) => {
    const parsed = retryFileQuerySchema.safeParse(request.query ?? {});
    // We resolve tenantId explicitly so a failed parse (which leaves
    // `tenantId` as `undefined`) still falls back to the default tenant
    // via `readTenant` instead of being typed as `string | undefined`.
    const tenantId = parsed.success && parsed.data.tenantId
      ? parsed.data.tenantId
      : readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const relPath = parsed.success ? parsed.data.relPath : "";
    if (!relPath) {
      return reply.code(400).send(apiError("BAD_REQUEST", "relPath query param is required"));
    }
    const existing = await getManifestEntry(folder.id, relPath);
    if (!existing) {
      return reply.code(404).send(apiError(
        "MANIFEST_ENTRY_NOT_FOUND",
        `no manifest entry for relPath: ${relPath}`
      ));
    }
    // If the row isn't currently failed, we still let the retry
    // through (idempotent — the manifest reset is a no-op for
    // non-failed rows), but we report the actual state so the UI can
    // tell the user "this file isn't failed, nothing to do".
    const wasFailed = existing.status === "failed";
    const result = await retryEntries(folder, [relPath]);
    return {
      folderId: folder.id,
      relPath,
      wasFailed,
      previousStatus: existing.status,
      enqueued: result.enqueued,
      skipped: result.skipped,
      missing: result.missing
    };
  });

  // ─── Legacy per-file retry: removed ────────────────────────────────────
  // Earlier we kept a path-style alias (`/api/watched-folders/:id/files/*/retry`)
  // as a fallback for stale browser tabs, but Fastify v5's `*` catch-all
  // syntax conflicts with our other routes under the same `:id` segment
  // and the route table won't register at all. Rather than ship a
  // half-broken alias, we removed it and let the WebUI degrade
  // gracefully: see the `tryBothRetryFileEndpoints` helper in
  // `web/src/lib/api.ts`, which falls back to the path form if the
  // query-string form returns 404.

  // ─── POST /api/watched-folders/:id/retry-failed ──────────────────────────
  // Bulk-retry every manifest row currently in `failed` state. We don't
  // accept a list from the caller — the UI usually just wants "retry
  // them all" and we have the canonical list on disk. Files that have
  // been deleted since the original ingest are returned in `missing`
  // so the UI can surface them.
  app.post("/api/watched-folders/:id/retry-failed", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const failed = await listFailedManifestEntries(folder.id);
    if (failed.length === 0) {
      return { folderId: folder.id, total: 0, enqueued: 0, skipped: 0, missing: [] };
    }
    const result = await retryAllFailedEntries(folder, failed.map((row) => row.relPath));
    logger.info(
      { folderId: folder.id, total: failed.length, enqueued: result.enqueued, skipped: result.skipped, missing: result.missing.length },
      "watched-folders: bulk retry failed"
    );
    return {
      folderId: folder.id,
      total: failed.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
      missing: result.missing
    };
  });

  // ─── POST /api/watched-folders/:id/purge-tombstones ──────────────────────
  // Physically delete manifest rows in `deleted` state. The associated
  // document/chunks/events rows were already cleared by the original
  // removal path; this is just a manifest-table hygiene sweep so the
  // list and `total` counter stop showing ghost rows. Optional body:
  //   { olderThanDays?: number } — default 0 (purge everything).
  // Pass 7 to require the tombstone to be at least a week old.
  app.post("/api/watched-folders/:id/purge-tombstones", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "id");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const body = (request.body ?? {}) as { olderThanDays?: number };
    const days = Math.max(0, Number(body.olderThanDays ?? 0));
    const cutoff = toLocalISO(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    const { removed } = await purgeDeletedManifests(folder.id, cutoff);
    logger.info(
      { folderId: folder.id, olderThanDays: days, removed },
      "watched-folders: purged tombstones"
    );
    return { folderId: folder.id, removed, olderThanDays: days };
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function readTenant(request: FastifyRequest): string {
  const parsed = tenantQuerySchema.safeParse(request.query ?? {});
  if (parsed.success && parsed.data.tenantId) {
    return parsed.data.tenantId;
  }
  return config.DEFAULT_TENANT_ID;
}

function readUuidParam(request: FastifyRequest, key: string): string | null {
  const params = request.params as Record<string, string>;
  const raw = params[key];
  if (typeof raw !== "string") {
    return null;
  }
  return raw; // We don't enforce UUID here — the route's own DB lookup will
  // surface 404 if the row doesn't exist.
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(n), min), max);
}

interface SyncRunLite {
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesFailed: number;
  status: string;
  finishedAt?: string | null;
  startedAt: string;
}

function decorateFolder(folder: WatchedFolderRecord, lastRun?: SyncRunLite | null): WatchedFolderRecord & {
  watcherRunning: boolean;
  watcherHealth: ReturnType<typeof watcherManager.getHealth>;
  lastRunStats?: { added: number; updated: number; deleted: number; failed: number };
} {
  return {
    ...folder,
    watcherRunning: watcherManager.isRunning(folder.id),
    watcherHealth: watcherManager.getHealth(folder.id),
    lastRunStats: lastRun
      ? {
          added: lastRun.filesAdded,
          updated: lastRun.filesUpdated,
          deleted: lastRun.filesDeleted,
          failed: lastRun.filesFailed
        }
      : undefined
  };
}