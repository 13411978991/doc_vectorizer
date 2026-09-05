/**
 * Integration tests for the Watcher MCP service (Sprint 2).
 *
 * Calls watcherMcpService directly (not through the MCP transport) so we
 * exercise the actual logic without standing up an MCP server. The four
 * tools (add / list / trigger_sync / remove) map 1:1 to service methods.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import { watcherMcpService } from "../watcher-mcp-service.js";
import { watcherManager } from "../../watcher/index.js";

const TENANT = `wf-mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function cleanup(): Promise<void> {
  await pool.query("delete from watched_folders where tenant_id = $1", [TENANT]);
  await pool.query(
    "delete from sources where tenant_id = $1 and metadata->>'semanticType' = 'watched_folder'",
    [TENANT]
  );
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

describe("watcherMcpService — add_watched_folder", () => {
  it("creates a folder, returns identifiers, and starts the watcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-add-"));
    try {
      const result = await watcherMcpService.addWatchedFolder({
        path: dir,
        recursive: false,
        displayName: "MCP Folder",
        tenantId: TENANT
      });
      expect(result.folderId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.sourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.path).toBe(dir);
      expect(result.displayName).toBe("MCP Folder");

      // Watcher was started.
      expect(watcherManager.isRunning(result.folderId)).toBe(true);

      const inDb = await pool.query("select id, path, display_name from watched_folders where id = $1", [result.folderId]);
      expect(inDb.rowCount).toBe(1);
      expect(inDb.rows[0].path).toBe(dir);
      expect(inDb.rows[0].display_name).toBe("MCP Folder");
    } finally {
      // Stop the watcher BEFORE cleanup so we don't leak chokidar handles.
      const inDb = await pool.query("select id from watched_folders where tenant_id = $1", [TENANT]);
      for (const row of inDb.rows) {
        await watcherManager.stopOne(row.id);
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects when the path does not exist", async () => {
    await expect(
      watcherMcpService.addWatchedFolder({
        path: "/tmp/nope-" + Date.now(),
        tenantId: TENANT
      })
    ).rejects.toThrow(/not accessible|not a directory/i);
  });

  it("rejects when the path is a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-file-"));
    try {
      const file = join(dir, "f.txt");
      await writeFile(file, "x");
      await expect(
        watcherMcpService.addWatchedFolder({
          path: file,
          tenantId: TENANT
        })
      ).rejects.toThrow(/not a directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-dup-"));
    try {
      const first = await watcherMcpService.addWatchedFolder({
        path: dir,
        tenantId: TENANT
      });
      try {
        await expect(
          watcherMcpService.addWatchedFolder({ path: dir, tenantId: TENANT })
        ).rejects.toThrow(/already exists/i);
      } finally {
        await watcherManager.stopOne(first.folderId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts and persists a filetypeFilter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-filter-"));
    try {
      const result = await watcherMcpService.addWatchedFolder({
        path: dir,
        tenantId: TENANT,
        filetypeFilter: {
          whitelist: [".md"],
          blacklist: [".tmp"],
          maxBytes: 1024 * 1024
        }
      });
      try {
        const row = await pool.query(
          "select file_extensions_filter, ignore_patterns, metadata from watched_folders where id = $1",
          [result.folderId]
        );
        const row0 = row.rows[0] as { file_extensions_filter: string; ignore_patterns: string; metadata: string };
        const ff = {
          whitelist: JSON.parse(row0.file_extensions_filter),
          blacklist: JSON.parse(row0.ignore_patterns),
          maxBytes: (JSON.parse(row0.metadata) as { maxBytes: number }).maxBytes
        };
        expect(ff.whitelist).toEqual([".md"]);
        expect(ff.blacklist).toEqual([".tmp"]);
        expect(ff.maxBytes).toBe(1024 * 1024);
      } finally {
        await watcherManager.stopOne(result.folderId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("watcherMcpService — list_watched_folders", () => {
  it("returns the registered folders with stats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-list-"));
    try {
      // Seed a file so the startup scan has something to ingest (with
      // skipExtraction: true we don't hit the LLM).
      await writeFile(join(dir, "seed.md"), "seed content");
      const added = await watcherMcpService.addWatchedFolder({
        path: dir,
        tenantId: TENANT,
        metadata: { skipExtraction: true }
      });
      try {
        // Wait for the startup scan to record at least one sync run with
        // filesAdded=1 (real ingestion goes through embeddings, which take a
        // moment, so we poll briefly).
        const deadline = Date.now() + 30_000;
        let filesAdded = 0;
        while (Date.now() < deadline) {
          const r = await pool.query(
            "select stats_added from watched_folder_runs where folder_id = $1 order by started_at desc limit 1",
            [added.folderId]
          );
          filesAdded = Number(r.rows[0]?.stats_added ?? 0);
          if (filesAdded >= 1) {
            break;
          }
          await new Promise((res) => setTimeout(res, 500));
        }
        expect(filesAdded).toBeGreaterThanOrEqual(1);

        const list = await watcherMcpService.listWatchedFolders(TENANT);
        expect(list.folders).toHaveLength(1);
        const folder = list.folders[0];
        expect(folder.id).toBe(added.folderId);
        expect(folder.path).toBe(dir);
        expect(folder.enabled).toBe(true);
        expect(typeof folder.lastScanAt === "string" || folder.lastScanAt === null).toBe(true);
        expect(folder.filesAdded).toBeGreaterThanOrEqual(1);
        expect(folder.filesUpdated).toBe(0);
      } finally {
        await watcherManager.stopOne(added.folderId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns empty when no folders are registered", async () => {
    const list = await watcherMcpService.listWatchedFolders(TENANT);
    expect(list.folders).toEqual([]);
  });
});

describe("watcherMcpService — trigger_sync", () => {
  it("starts a sync and reports folderId + status=started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-sync-"));
    try {
      await writeFile(join(dir, "f.md"), "alpha content");
      const added = await watcherMcpService.addWatchedFolder({
        path: dir,
        tenantId: TENANT,
        metadata: { skipExtraction: true }
      });
      try {
        const result = await watcherMcpService.triggerSync({
          folderId: added.folderId,
          tenantId: TENANT
        });
        expect(result.status).toBe("started");
        expect(result.folderId).toBe(added.folderId);

        // Wait for the sync to land the file in the manifest.
        const deadline = Date.now() + 60_000;
        let manifestCount = 0;
        while (Date.now() < deadline) {
          const r = await pool.query(
            "select last_event as status from watched_folder_manifests where folder_id = $1",
            [added.folderId]
          );
          const synced = r.rows.filter((row: { status: string }) => row.status === "synced").length;
          manifestCount = synced;
          if (synced >= 1) {
            break;
          }
          await new Promise((res) => setTimeout(res, 500));
        }
        expect(manifestCount).toBeGreaterThanOrEqual(1);
      } finally {
        await watcherManager.stopOne(added.folderId);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("throws when the folder does not exist", async () => {
    await expect(
      watcherMcpService.triggerSync({
        folderId: "00000000-0000-0000-0000-000000000000",
        tenantId: TENANT
      })
    ).rejects.toThrow(/not found/i);
  });
});

describe("watcherMcpService — remove_watched_folder", () => {
  it("stops the watcher and deletes the folder + source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-mcp-remove-"));
    try {
      const added = await watcherMcpService.addWatchedFolder({
        path: dir,
        tenantId: TENANT
      });
      expect(watcherManager.isRunning(added.folderId)).toBe(true);

      const result = await watcherMcpService.removeWatchedFolder({
        folderId: added.folderId,
        tenantId: TENANT
      });
      expect(result.deleted).toBe(true);
      expect(result.folderId).toBe(added.folderId);

      expect(watcherManager.isRunning(added.folderId)).toBe(false);

      const folderCheck = await pool.query("select id from watched_folders where id = $1", [added.folderId]);
      expect(folderCheck.rowCount).toBe(0);
      const sourceCheck = await pool.query("select id from sources where id = $1", [added.sourceId]);
      expect(sourceCheck.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when the folder does not exist", async () => {
    await expect(
      watcherMcpService.removeWatchedFolder({
        folderId: "00000000-0000-0000-0000-000000000000",
        tenantId: TENANT
      })
    ).rejects.toThrow(/not found/i);
  });
});