import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import {
  createFolder,
  getLatestSyncRun,
  getManifest
} from "../manifest-store.js";
import { syncFolderWith, type OrchestratorOverrides } from "../sync-orchestrator.js";
import type { ScanResult } from "../analyzer.js";

const TENANT = `sync-orch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

function makeIngestSpy(impl?: (input: { title: string; metadata?: Record<string, unknown> }) => Promise<{ documentId: string }>) {
  const calls: Array<{ title: string; metadata: Record<string, unknown> }> = [];
  let counter = 0;
  const ingest = {
    ingestDocument: async (input: { title: string; content?: string; sourceId?: string; metadata?: Record<string, unknown> }) => {
      calls.push({ title: String(input.title), metadata: input.metadata ?? {} });
      counter += 1;
      const documentId = impl
        ? (await impl({ title: input.title, metadata: input.metadata })).documentId
        : makeUuid(`doc-${counter}`);
      return {
        documentId,
        sourceId: makeUuid("src"),
        chunkCount: 1,
        eventCount: 0,
        taskId: makeUuid("task"),
        traceId: makeUuid("trace")
      };
    }
  };
  return { ingest, calls };
}

function makeUuid(_prefix: string): string {
  // Real production code uses randomUUID(); we mirror that here so manifest
  // rows accept the id as a valid UUID.
  return randomUUID();
}

function makeDeleteSpy() {
  const calls: string[] = [];
  const webui = {
    deleteDocument: async (documentId: string) => {
      calls.push(documentId);
      return { deleted: true };
    }
  };
  return { webui, calls };
}

describe("syncFolderWith — added/updated", () => {
  it("ingests added files and updates the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-add-"));
    try {
      await writeFile(join(dir, "a.md"), "alpha");
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const { ingest, calls } = makeIngestSpy();
      const scan: ScanResult = {
        added: [{
          relPath: "a.md",
          absPath: join(dir, "a.md"),
          mtimeMs: 1,
          inode: 1,
          sizeBytes: 5,
          sha1: "abc"
        }],
        updated: [],
        deleted: []
      };
      const overrides: OrchestratorOverrides = {
        ingestionService: ingest,
        analyze: async () => scan
      };
      const result = await syncFolderWith(folder.id, "scan", TENANT, overrides);
      expect(result.status).toBe("completed");
      expect(result.stats.added).toBe(1);
      expect(result.stats.failed).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0].title).toBe("a");
      // Manifest was updated.
      const manifest = await getManifest(folder.id);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].status).toBe("synced");
      expect(manifest[0].documentId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ingests updated files and counts them as updated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-upd-"));
    try {
      const filePath = join(dir, "x.md");
      await writeFile(filePath, "alpha");
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const { ingest, calls } = makeIngestSpy();
      const scan: ScanResult = {
        added: [],
        updated: [{
          relPath: "x.md",
          absPath: filePath,
          mtimeMs: 2,
          inode: 2,
          sizeBytes: 6,
          sha1: "new"
        }],
        deleted: []
      };
      const result = await syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: ingest,
        analyze: async () => scan
      });
      expect(result.stats.updated).toBe(1);
      expect(calls).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("partial failure: one file fails, the run completes with filesFailed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-fail-"));
    try {
      const okPath = join(dir, "ok.md");
      const badPath = join(dir, "bad.md");
      await writeFile(okPath, "ok content");
      await writeFile(badPath, "bad content");
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const ingest = {
        ingestDocument: async (input: { title: string }) => {
          if (input.title === "bad") {
            throw new Error("ingest failed");
          }
          return {
            documentId: makeUuid(`doc-${input.title}`),
            sourceId: makeUuid("src"),
            chunkCount: 1,
            eventCount: 0,
            taskId: makeUuid("task"),
            traceId: makeUuid("trace")
          };
        }
      };
      const scan: ScanResult = {
        added: [
          {
            relPath: "ok.md",
            absPath: okPath,
            mtimeMs: 1,
            inode: 1,
            sizeBytes: 1,
            sha1: "ok"
          },
          {
            relPath: "bad.md",
            absPath: badPath,
            mtimeMs: 1,
            inode: 1,
            sizeBytes: 1,
            sha1: "bad"
          }
        ],
        updated: [],
        deleted: []
      };
      const result = await syncFolderWith(folder.id, "scan", TENANT, {
        ingestionService: ingest,
        analyze: async () => scan
      });
      expect(result.status).toBe("completed");
      expect(result.stats.added).toBe(1);
      expect(result.stats.failed).toBe(1);
      // The run is finished with the right stats in DB.
      const run = await getLatestSyncRun(folder.id);
      expect(run?.filesAdded).toBe(1);
      expect(run?.filesFailed).toBe(1);
      // Manifest: one synced, one failed.
      const manifest = await getManifest(folder.id);
      const statuses = Object.fromEntries(manifest.map((m) => [m.relPath, m.status]));
      expect(statuses["ok.md"]).toBe("synced");
      expect(statuses["bad.md"]).toBe("failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records the trigger and finished_at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-trigger-"));
    try {
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const { ingest } = makeIngestSpy();
      const result = await syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: ingest,
        analyze: async () => ({ added: [], updated: [], deleted: [] })
      });
      expect(result.status).toBe("completed");
      const run = await getLatestSyncRun(folder.id);
      expect(run?.trigger).toBe("event");
      expect(run?.finishedAt).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("syncFolderWith — deletion", () => {
  it("calls deleteDocument for files that disappeared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-del-"));
    try {
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      // Pre-populate the manifest with one synced file pointing at a doc.
      const { upsertManifest } = await import("../manifest-store.js");
      await upsertManifest({
        folderId: folder.id,
        relPath: "gone.md",
        status: "synced",
        documentId: "11111111-1111-1111-1111-111111111111"
      });
      const { webui, calls } = makeDeleteSpy();
      const scan: ScanResult = { added: [], updated: [], deleted: ["gone.md"] };
      const result = await syncFolderWith(folder.id, "scan", TENANT, {
        webuiService: webui,
        analyze: async () => scan
      });
      expect(result.stats.deleted).toBe(1);
      expect(calls).toEqual(["11111111-1111-1111-1111-111111111111"]);
      // Manifest marked deleted.
      const manifest = await getManifest(folder.id);
      expect(manifest.find((m) => m.relPath === "gone.md")?.status).toBe("deleted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("swallows 'document not found' errors from deleteDocument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-del2-"));
    try {
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const { upsertManifest } = await import("../manifest-store.js");
      await upsertManifest({
        folderId: folder.id,
        relPath: "ghost.md",
        status: "synced",
        documentId: "22222222-2222-2222-2222-222222222222"
      });
      const webui = {
        deleteDocument: async () => {
          throw new Error("文档不存在");
        }
      };
      const scan: ScanResult = { added: [], updated: [], deleted: ["ghost.md"] };
      const result = await syncFolderWith(folder.id, "scan", TENANT, {
        webuiService: webui,
        analyze: async () => scan
      });
      expect(result.status).toBe("completed");
      expect(result.stats.deleted).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("syncFolderWith — error handling", () => {
  it("marks the run as failed when the analyzer throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-err-"));
    try {
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const result = await syncFolderWith(folder.id, "scan", TENANT, {
        analyze: async () => {
          throw new Error("scan boom");
        }
      });
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/scan boom/);
      expect(result.stats.failed).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("throws when the folder does not exist", async () => {
    await expect(
      syncFolderWith("00000000-0000-0000-0000-000000000000", "scan", TENANT, {})
    ).rejects.toThrow(/not found/i);
  });
});

describe("syncFolderWith — filetype filter", () => {
  it("skips files excluded by whitelist (does not ingest, but does not fail)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-sync-flt-"));
    try {
      const okPath = join(dir, "ok.md");
      const skipPath = join(dir, "skip.pdf");
      await writeFile(okPath, "ok");
      await writeFile(skipPath, "skip");
      const folder = await createFolder({
        tenantId: TENANT,
        path: dir,
        filetypeFilter: { whitelist: [".md"] }
      });
      const { ingest, calls } = makeIngestSpy();
      const scan: ScanResult = {
        added: [
          {
            relPath: "skip.pdf",
            absPath: skipPath,
            mtimeMs: 1,
            inode: 1,
            sizeBytes: 1,
            sha1: "x"
          },
          {
            relPath: "ok.md",
            absPath: okPath,
            mtimeMs: 1,
            inode: 1,
            sizeBytes: 1,
            sha1: "y"
          }
        ],
        updated: [],
        deleted: []
      };
      const result = await syncFolderWith(folder.id, "scan", TENANT, {
        ingestionService: ingest,
        analyze: async () => scan
      });
      expect(result.status).toBe("completed");
      // Only the .md was ingested.
      expect(calls.map((c) => c.title)).toEqual(["ok"]);
      expect(result.stats.added).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});