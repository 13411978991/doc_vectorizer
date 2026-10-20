/**
 * jobs-routes.ts — Stage 1 productization: real-time jobs panel.
 *
 * Why this exists:
 *   The previous product feedback was "the app sometimes hangs and I
 *   have no idea what it's doing". The fix is a single endpoint that
 *   the WebUI polls every 2s to render a global "what's running right
 *   now" view: per-folder queue progress (pending / active / failed /
 *   total), system resource snapshot, and recent failure reasons.
 *
 *   We also add per-file skip / retry endpoints here so the WebUI can
 *   act on the panel without round-tripping through WatchedFolders.
 *
 *   Everything is read-only against existing tables and the in-process
 *   IngestQueue singleton — no schema change, no migration, no new
 *   dependencies. The bus factor stays at 1 (single dev who knows the
 *   code) because we re-use the same primitives the rest of the
 *   codebase already uses.
 */
import os from "node:os";
import type { FastifyInstance } from "fastify";
import { ingestQueue, type QueueProgress } from "../watcher/ingest-queue.js";
import { getFolder, listFailedManifestEntries, resetManifestEntryForRetry, markManifestStatus } from "../watcher/manifest-store.js";
import { retryEntries } from "../watcher/index.js";
import { apiError, readTenant, readUuidParam } from "./server-helpers.js";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";

interface FolderJobSummary {
  folderId: string;
  displayName: string;
  path: string;
  enabled: boolean;
  lastScanAt: string | null;
  lastError: string | null;
  progress: QueueProgress;
}

interface ResourceSnapshot {
  /** 1-minute load average, normalised to one CPU. */
  loadAverage1: number;
  cpuCount: number;
  /** process.memoryUsage().rss in MB. */
  rssMb: number;
  /** process.memoryUsage().heapUsed in MB. */
  heapUsedMb: number;
  /** Total host memory in MB (informational; UI can compute %). */
  hostTotalMb: number;
  /** Free host memory in MB. */
  hostFreeMb: number;
}

interface JobsOverview {
  generatedAt: string;
  folders: FolderJobSummary[];
  aggregate: {
    folders: number;
    pending: number;
    active: number;
    failed: number;
    added: number;
    updated: number;
    deleted: number;
    idleFolders: number;
  };
  resources: ResourceSnapshot;
  /** Per-folder list of recent failure reasons (capped) so the UI can
   *  show "why these files are stuck" without scanning the whole
   *  manifest. */
  recentFailures: Array<{
    folderId: string;
    relPath: string;
    lastError: string | null;
    lastEvent: string;
    lastSyncStartedAt: string | null;
    lastSyncDurationMs: number | null;
  }>;
}

function snapshotResources(): ResourceSnapshot {
  const cpuCount = os.cpus()?.length ?? 1;
  const [la1] = os.loadavg();
  const mu = process.memoryUsage();
  return {
    loadAverage1: cpuCount > 0 ? la1 / cpuCount : la1,
    cpuCount,
    rssMb: Math.round(mu.rss / 1024 / 1024),
    heapUsedMb: Math.round(mu.heapUsed / 1024 / 1024),
    hostTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    hostFreeMb: Math.round(os.freemem() / 1024 / 1024)
  };
}

/**
 * Build the global jobs overview response. Pulls from IngestQueue for
 * live counters and SQLite for the recent-failure view. Cheap enough
 * to poll every 2s from a single WebUI client (one folder scan +
 * one query).
 */
export async function buildJobsOverview(tenantId: string): Promise<JobsOverview> {
  // Folder metadata for the summaries: query SQLite directly to avoid
  // a per-folder getFolder round-trip. List by tenant and join.
  const { pool } = await import("../db/pool.js");
  const folderResult = await pool.query<{
    id: string;
    display_name: string;
    path: string;
    enabled: number;
    last_scan_at: string | null;
    last_scan_error: string | null;
  }>(
    `select id, display_name, path, enabled, last_scan_at, last_scan_error
     from watched_folders
     where tenant_id = $1
     order by created_at asc`,
    [tenantId]
  );

  const progressByFolder = new Map<string, QueueProgress>();
  for (const p of ingestQueue.getAllProgress()) {
    progressByFolder.set(p.folderId, p);
  }

  const folders: FolderJobSummary[] = folderResult.rows.map((row) => {
    const progress = progressByFolder.get(row.id) ?? {
      folderId: row.id,
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
    return {
      folderId: row.id,
      displayName: row.display_name,
      path: row.path,
      enabled: row.enabled === 1,
      lastScanAt: row.last_scan_at ?? null,
      lastError: row.last_scan_error ?? null,
      progress
    };
  });

  // Live counters (pending/active/idle) come from the in-memory queue —
  // they reflect "what's happening right now" and have no persistent
  // equivalent. The historical counters (added/updated/deleted/failed)
  // come from SQLite so they match the "最近失败" panel below; otherwise
  // the top counter says "失败 = 0" while the table shows 1 failed row,
  // which the operator reads as a bug.
  let pending = 0;
  let active = 0;
  let idleFolders = 0;
  for (const f of folders) {
    pending += f.progress.pending;
    active += f.progress.active;
    if (f.progress.idle) idleFolders += 1;
  }

  // Historical counters from DB.
  //
  // - `added/updated/deleted` come from `watched_folder_runs` (the
  //   per-folder historical stats table). If a previous sync never
  //   persisted its stats the number will be 0 — that's a separate
  //   upstream bug (sync-orchestrator not writing stats on completion),
  //   not this endpoint's problem. The counter still shows the truth
  //   for the data the DB has.
  // - `failed` comes from the manifest table directly because each
  //   file in `last_event IN ('failed','partial')` represents one
  //   outstanding failure, regardless of which run produced it.
  const historicalCountersResult = await pool.query<{
    added: number | null;
    updated: number | null;
    deleted: number | null;
    failed: number | null;
  }>(
    `select
       (select coalesce(sum(stats_added), 0)
          from watched_folder_runs
         where tenant_id = $1) as added,
       (select coalesce(sum(stats_updated), 0)
          from watched_folder_runs
         where tenant_id = $1) as updated,
       (select coalesce(sum(stats_deleted), 0)
          from watched_folder_runs
         where tenant_id = $1) as deleted,
       (select count(*)
          from watched_folder_manifests m
          join watched_folders f on f.id = m.folder_id
         where f.tenant_id = $1
           and m.last_event in ('failed','partial')) as failed`,
    [tenantId]
  );
  const historical = historicalCountersResult.rows[0] ?? { added: 0, updated: 0, deleted: 0, failed: 0 };

  // Recent failures: top 20 most-recent failed rows across all folders
  // in this tenant. The watcher manifest already carries the timing +
  // error columns we want, so no extra schema work is required.
  const failuresResult = await pool.query<{
    folder_id: string;
    rel_path: string;
    last_error: string | null;
    last_event: string;
    last_sync_started_at: string | null;
    last_sync_duration_ms: number | null;
  }>(
    `select m.folder_id, m.rel_path, m.last_error, m.last_event,
            m.last_sync_started_at, m.last_sync_duration_ms
     from watched_folder_manifests m
     join watched_folders f on f.id = m.folder_id
     where f.tenant_id = $1
       and m.last_event in ('failed', 'partial')
     order by coalesce(m.last_sync_started_at, m.last_seen_at) desc
     limit 20`,
    [tenantId]
  );

  const recentFailures = failuresResult.rows.map((r) => ({
    folderId: r.folder_id,
    relPath: r.rel_path,
    lastError: r.last_error ?? null,
    lastEvent: r.last_event,
    lastSyncStartedAt: r.last_sync_started_at ?? null,
    lastSyncDurationMs: r.last_sync_duration_ms ?? null
  }));

  return {
    generatedAt: new Date().toISOString(),
    folders,
    aggregate: {
      folders: folders.length,
      pending,
      active,
      failed: Number(historical.failed ?? 0),
      added: Number(historical.added ?? 0),
      updated: Number(historical.updated ?? 0),
      deleted: Number(historical.deleted ?? 0),
      idleFolders
    },
    resources: snapshotResources(),
    recentFailures
  };
}

export function registerJobsRoutes(app: FastifyInstance): void {
  // ─── Real-time jobs overview ─────────────────────────────────────────────
  // Returns the per-folder QueueProgress snapshot + system resources +
  // recent failures in one round-trip. The WebUI polls this every 2s.
  app.get("/api/jobs/overview", async (request) => {
    const tenantId = readTenant(request);
    return buildJobsOverview(tenantId);
  });

  // ─── Per-file actions on the manifest ────────────────────────────────────
  // Why these live here (not in watched-folders.ts):
  //   The Jobs panel needs to skip / retry individual files inline. Keeping
  //   the routes co-located with the overview endpoint makes the panel's
  //   data + actions stay in one mental module.
  //
  //   Both routes use the existing manifest-store primitives — the new
  //   surface is just URL-level sugar + Zod validation.

  /**
   * POST /api/jobs/manifest/:folderId/skip
   * body: { relPath: string }
   *
   * Mark a manifest row as user-skipped. We piggy-back on the existing
   * failed-state convention: last_event='failed' + last_error starting
   * with "skipped:" so the row is invisible to retry-failed unless the
   * user explicitly resets it.
   */
  app.post("/api/jobs/manifest/:folderId/skip", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "folderId");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const body = (request.body ?? {}) as { relPath?: unknown };
    const relPath = typeof body.relPath === "string" ? body.relPath.trim() : "";
    if (!relPath) {
      return reply.code(400).send(apiError("BAD_REQUEST", "relPath is required"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    const row = await markManifestStatus(
      folder.id,
      relPath,
      "failed",
      `skipped: user request at ${new Date().toISOString()}`
    );
    if (!row) {
      return reply
        .code(404)
        .send(apiError("MANIFEST_NOT_FOUND", `no manifest row for ${relPath}`));
    }
    logger.info({ folderId: folder.id, relPath }, "jobs: manifest row marked skipped");
    return { ok: true, folderId: folder.id, relPath, status: row.status };
  });

  /**
   * POST /api/jobs/manifest/:folderId/retry
   * body: { relPath: string }
   *
   * Reset a single manifest row to pending and enqueue an "updated"
   * ingest. Works for failed/skipped/partial alike. Reuses the bulk
   * retryEntries helper so the path semantics stay identical.
   */
  app.post("/api/jobs/manifest/:folderId/retry", async (request, reply) => {
    const tenantId = readTenant(request);
    const folderId = readUuidParam(request, "folderId");
    if (!folderId) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid folder id"));
    }
    const body = (request.body ?? {}) as { relPath?: unknown };
    const relPath = typeof body.relPath === "string" ? body.relPath.trim() : "";
    if (!relPath) {
      return reply.code(400).send(apiError("BAD_REQUEST", "relPath is required"));
    }
    const folder = await getFolder(folderId, tenantId);
    if (!folder) {
      return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
    }
    // Pre-reset the row so a failed/skipped manifest gets re-included by
    // retryEntries' WHERE clause (which targets failed/synced/partial).
    const reset = await resetManifestEntryForRetry(folder.id, relPath);
    if (!reset) {
      return reply
        .code(404)
        .send(apiError("MANIFEST_NOT_FOUND", `no manifest row to retry for ${relPath}`));
    }
    const result = await retryEntries(folder, [relPath]);
    logger.info(
      { folderId: folder.id, relPath, enqueued: result.enqueued, missing: result.missing.length },
      "jobs: single-file retry enqueued"
    );
    return {
      ok: true,
      folderId: folder.id,
      relPath,
      enqueued: result.enqueued,
      missing: result.missing
    };
  });

  // ─── Tenant-scoped convenience: retry every failed/skipped row ──────────
  // POST /api/jobs/retry-failed
  // body: { folderId?: string }
  //
  // Without folderId → every folder in the tenant. With folderId →
  // that single folder. UI calls this from the panel's "Retry all" button.
  app.post("/api/jobs/retry-failed", async (request, reply) => {
    const tenantId = readTenant(request);
    const body = (request.body ?? {}) as { folderId?: unknown };
    const targetFolderId = typeof body.folderId === "string" ? body.folderId.trim() : "";
    let targetIds: string[];
    if (targetFolderId) {
      if (!/^[0-9a-f-]{36}$/i.test(targetFolderId)) {
        return reply.code(400).send(apiError("BAD_REQUEST", "invalid folderId"));
      }
      const folder = await getFolder(targetFolderId, tenantId);
      if (!folder) {
        return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
      }
      targetIds = [targetFolderId];
    } else {
      const { pool } = await import("../db/pool.js");
      const rows = await pool.query<{ id: string }>(
        "select id from watched_folders where tenant_id = $1",
        [tenantId]
      );
      targetIds = rows.rows.map((r) => String(r.id));
    }
    let totalEnqueued = 0;
    let totalMissing = 0;
    const perFolder: Array<{ folderId: string; enqueued: number; missing: number }> = [];
    for (const folderId of targetIds) {
      const folder = await getFolder(folderId, tenantId);
      if (!folder) continue;
      const failed = await listFailedManifestEntries(folder.id);
      if (failed.length === 0) {
        perFolder.push({ folderId: folder.id, enqueued: 0, missing: 0 });
        continue;
      }
      const result = await retryEntries(folder, failed.map((r) => r.relPath));
      totalEnqueued += result.enqueued;
      totalMissing += result.missing.length;
      perFolder.push({
        folderId: folder.id,
        enqueued: result.enqueued,
        missing: result.missing.length
      });
    }
    logger.info(
      { targetFolderId: targetFolderId || "ALL", totalEnqueued, totalMissing, folderCount: targetIds.length },
      "jobs: bulk retry-failed enqueued"
    );
    return {
      ok: true,
      totalEnqueued,
      totalMissing,
      perFolder
    };
  });

  // Echo the server config so the panel can show "where is this running".
  // Same data as /api/server/info but bundled with the jobs call would
  // double-poll, so we keep it separate. Documented here so future
  // debugging starts in the right place.
  app.get("/api/jobs/server-info", async () => ({
    httpHost: config.HTTP_HOST,
    httpPort: config.HTTP_PORT,
    nodeEnv: config.NODE_ENV,
    logLevel: config.LOG_LEVEL
  }));
}
