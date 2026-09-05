/**
 * Watcher MCP service — Sprint 2
 *
 * Wraps the watched-folders feature for MCP tool exposure. The four tools
 * (add / list / trigger_sync / remove) are registered in `src/mcp/server.ts`
 * and delegate here so the actual logic (DB writes + watcher lifecycle) is
 * reusable from both the MCP and HTTP surfaces.
 *
 * Conventions mirror `webuiService`: tenant-scoped, throws on missing input,
 * returns plain JSON-friendly values (no Date objects, no class instances).
 */

import { promises as fs } from "node:fs";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import {
  createFolder,
  deleteFolder,
  getFolder,
  getFolderByPath,
  getLatestSyncRun,
  getManifestEntry,
  listFailedManifestEntries,
  listFolders
} from "../watcher/manifest-store.js";
import { syncFolder } from "../watcher/sync-orchestrator.js";
import { retryAllFailedEntries, retryEntries, watcherManager } from "../watcher/index.js";
import type { FiletypeFilter, WatchedFolderRecord } from "../watcher/types.js";

type FiletypeFilterInput = {
  whitelist?: string[];
  maxBytes?: number;
};

export interface WatcherFolderSummary {
  id: string;
  path: string;
  displayName: string;
  enabled: boolean;
  lastScanAt: string | null;
  filesAdded: number;
  filesUpdated: number;
  filesDeleted: number;
  filesFailed: number;
}

export class WatcherMcpService {
  /**
   * Add a folder to the watched-folders list. Validates the path exists and
   * is a directory, then creates the row + the chokidar watcher.
   */
  async addWatchedFolder(input: {
    path: string;
    recursive?: boolean;
    filetypeFilter?: FiletypeFilterInput;
    displayName?: string;
    metadata?: Record<string, unknown>;
    tenantId?: string;
    sourceId?: string;
  }): Promise<{ folderId: string; sourceId: string; path: string; displayName: string }> {
    const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
    const path = input.path?.trim();
    if (!path) {
      throw new Error("path is required");
    }
    try {
      const stat = await fs.stat(path);
      if (!stat.isDirectory()) {
        throw new Error(`path is not a directory: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`path not accessible: ${path}`);
      }
      throw error;
    }
    const existing = await getFolderByPath(path, tenantId);
    if (existing) {
      throw new Error(`a watched folder for this path already exists (id=${existing.id})`);
    }
    const filetypeFilter = sanitizeFiletypeFilter(input.filetypeFilter);
    const folder = await createFolder({
      tenantId,
      path,
      displayName: input.displayName,
      recursive: input.recursive ?? true,
      filetypeFilter,
      metadata: input.metadata,
      enabled: true,
      sourceId: input.sourceId
    });
    try {
      await watcherManager.startOne(folder);
    } catch (error) {
      logger.error(
        { folderId: folder.id, error: (error as Error).message },
        "watcher-mcp: start watcher failed (folder created in DB)"
      );
    }
    return {
      folderId: folder.id,
      sourceId: folder.sourceId,
      path: folder.path,
      displayName: folder.displayName
    };
  }

  async listWatchedFolders(tenantId?: string): Promise<{ folders: WatcherFolderSummary[] }> {
    const effectiveTenant = tenantId ?? config.DEFAULT_TENANT_ID;
    const folders = await listFolders(effectiveTenant);
    const summaries = await Promise.all(folders.map(async (f) => summarizeFolder(f)));
    return { folders: summaries };
  }

  /**
   * Kick off a manual sync. Returns immediately with the folder info; the
   * sync runs in the background. Mirrors the API's POST /sync behavior.
   */
  async triggerSync(input: { folderId: string; tenantId?: string }): Promise<{ runId: string | null; status: "started"; folderId: string }> {
    const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
    const folder = await getFolder(input.folderId, tenantId);
    if (!folder) {
      throw new Error(`watched folder not found: ${input.folderId}`);
    }
    // Fire-and-forget. We start the sync and return a synthetic placeholder;
    // the client polls listWatchedFolders (or the API's /runs) for completion.
    const runPromise = syncFolder(folder.id, "manual", folder.tenantId)
      .then((result) => {
        logger.info(
          { folderId: folder.id, status: result.status, stats: result.stats },
          "watcher-mcp: manual sync complete"
        );
        return result;
      })
      .catch((error: unknown) => {
        logger.error({ folderId: folder.id, error: (error as Error).message }, "watcher-mcp: manual sync failed");
        throw error;
      });
    // We don't expose the runId here because syncFolder creates the run
    // internally; the API surface is what the MCP client should use to look
    // up the run. We return null so the response shape is stable.
    void runPromise;
    return { runId: null, status: "started", folderId: folder.id };
  }

  /**
   * Retry a single failed file inside a watched folder. Returns the
   * enqueue outcome so MCP clients can render "file X re-queued" /
   * "missing on disk" messages without a second round-trip.
   */
  async retryFailedFile(input: { folderId: string; relPath: string; tenantId?: string }): Promise<{
    folderId: string;
    relPath: string;
    previousStatus: string;
    wasFailed: boolean;
    enqueued: number;
    skipped: number;
    missing: string[];
  }> {
    const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
    const folder = await getFolder(input.folderId, tenantId);
    if (!folder) {
      throw new Error(`watched folder not found: ${input.folderId}`);
    }
    const relPath = input.relPath?.trim();
    if (!relPath) {
      throw new Error("relPath is required");
    }
    const existing = await getManifestEntry(folder.id, relPath);
    if (!existing) {
      throw new Error(`no manifest entry for relPath: ${relPath}`);
    }
    const result = await retryEntries(folder, [relPath]);
    return {
      folderId: folder.id,
      relPath,
      previousStatus: existing.status,
      wasFailed: existing.status === "failed",
      enqueued: result.enqueued,
      skipped: result.skipped,
      missing: result.missing
    };
  }

  /**
   * Bulk-retry every `failed` manifest row in a folder. Files that have
   * been deleted since the original ingest are reported in `missing`
   * so the MCP client can surface them in its UI.
   */
  async retryFailedFiles(input: { folderId: string; tenantId?: string }): Promise<{
    folderId: string;
    total: number;
    enqueued: number;
    skipped: number;
    missing: string[];
  }> {
    const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
    const folder = await getFolder(input.folderId, tenantId);
    if (!folder) {
      throw new Error(`watched folder not found: ${input.folderId}`);
    }
    const failed = await listFailedManifestEntries(folder.id);
    if (failed.length === 0) {
      return { folderId: folder.id, total: 0, enqueued: 0, skipped: 0, missing: [] };
    }
    const result = await retryAllFailedEntries(folder, failed.map((row) => row.relPath));
    logger.info(
      { folderId: folder.id, total: failed.length, enqueued: result.enqueued, skipped: result.skipped, missing: result.missing.length },
      "watcher-mcp: bulk retry failed"
    );
    return {
      folderId: folder.id,
      total: failed.length,
      enqueued: result.enqueued,
      skipped: result.skipped,
      missing: result.missing
    };
  }

  async removeWatchedFolder(input: { folderId: string; tenantId?: string }): Promise<{ deleted: boolean; folderId: string }> {
    const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
    const folder = await getFolder(input.folderId, tenantId);
    if (!folder) {
      throw new Error(`watched folder not found: ${input.folderId}`);
    }
    try {
      await watcherManager.stopOne(folder.id);
    } catch (error) {
      logger.warn({ folderId: folder.id, error: (error as Error).message }, "watcher-mcp: stop watcher before delete failed");
    }
    const deleted = await deleteFolder(folder.id, tenantId);
    if (!deleted) {
      throw new Error(`watched folder not found: ${input.folderId}`);
    }
    return { deleted: true, folderId: folder.id };
  }
}

function sanitizeFiletypeFilter(input: FiletypeFilterInput | undefined): FiletypeFilter {
  if (!input) {
    return {};
  }
  const out: FiletypeFilter = {};
  if (Array.isArray(input.whitelist)) {
    out.whitelist = input.whitelist.filter((s) => typeof s === "string" && s.length > 0);
  }
  // The blacklist field was removed in v2. We silently drop any legacy
  // values an older MCP client may still send rather than 400-ing the
  // request — keeping the wire schema forgiving during the rollout.
  if (typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes) && input.maxBytes > 0) {
    out.maxBytes = Math.trunc(input.maxBytes);
  }
  return out;
}

async function summarizeFolder(folder: WatchedFolderRecord): Promise<WatcherFolderSummary> {
  const lastRun = await getLatestSyncRun(folder.id);
  return {
    id: folder.id,
    path: folder.path,
    displayName: folder.displayName,
    enabled: folder.enabled,
    lastScanAt: folder.lastScanAt ?? null,
    filesAdded: lastRun?.filesAdded ?? 0,
    filesUpdated: lastRun?.filesUpdated ?? 0,
    filesDeleted: lastRun?.filesDeleted ?? 0,
    filesFailed: lastRun?.filesFailed ?? 0
  };
}

export const watcherMcpService = new WatcherMcpService();