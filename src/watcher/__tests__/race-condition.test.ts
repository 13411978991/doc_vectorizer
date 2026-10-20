import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import { createFolder, getManifest, transitionManifestStatus, upsertManifest } from "../manifest-store.js";
import type { FileEntry, ScanResult } from "../analyzer.js";
import { syncFolderWith, type OrchestratorOverrides } from "../sync-orchestrator.js";

const TENANT = `race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

/**
 * Slow ingest spy — captures call count, lets us hold the call open with a
 * promise so we can simulate concurrent ingests racing for the same file.
 */
function makeSlowIngest(): {
  ingest: OrchestratorOverrides["ingestionService"];
  callCount: { value: number };
  block: { promise: Promise<void>; resolve: () => void } | null;
} {
  const callCount = { value: 0 };
  let block: { promise: Promise<void>; resolve: () => void } | null = null;
  const ingest = {
    ingestDocument: async (input: { title: string; metadata?: Record<string, unknown> }) => {
      callCount.value += 1;
      if (block) {
        await block.promise;
      }
      return {
        documentId: randomUUID(),
        sourceId: "src-test",
        chunkCount: 1,
        eventCount: 0,
        taskId: randomUUID(),
        traceId: randomUUID()
      };
    }
  };
  return { ingest, callCount, get block() { return block; }, set block(v) { block = v; } } as {
    ingest: OrchestratorOverrides["ingestionService"];
    callCount: { value: number };
    block: { promise: Promise<void>; resolve: () => void } | null;
  };
}

describe("race condition — concurrent ingests of the same file", () => {
  it("two parallel syncFolderWith calls ingest the file at most once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-race-same-"));
    try {
      await writeFile(join(dir, "shared.md"), "content");
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      const entry: FileEntry = {
        relPath: "shared.md",
        absPath: join(dir, "shared.md"),
        mtimeMs: 1,
        inode: 1,
        sizeBytes: 7,
        sha1: "abc"
      };
      const scan: ScanResult = { added: [entry], updated: [], deleted: [] };
      const slow = makeSlowIngest();
      // Block ingest until both calls have started.
      let resolveBlock!: () => void;
      slow.block = { promise: new Promise<void>((r) => { resolveBlock = r; }), resolve: resolveBlock };

      // Fire two syncs in parallel.
      const p1 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: slow.ingest,
        analyze: async () => scan
      });
      // Give the first one enough time to claim the manifest lock and reach
      // the slow ingestDocument. We need ~50ms here because the production
      // code does a couple of DB round-trips (createSyncRun + transition)
      // before it starts ingesting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const p2 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: slow.ingest,
        analyze: async () => scan
      });

      // Both calls have started; one is sitting at `await block.promise`.
      // Let them finish.
      resolveBlock();
      const [r1, r2] = await Promise.all([p1, p2]);

      // Ingest was called at most once.
      expect(slow.callCount.value).toBe(1);
      // Both runs completed without error.
      expect(r1.status).toBe("completed");
      expect(r2.status).toBe("completed");
      // Manifest reflects a single synced file.
      const manifest = await getManifest(folder.id);
      expect(manifest).toHaveLength(1);
      expect(manifest[0].status).toBe("synced");
      expect(manifest[0].documentId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("two parallel ingests of DIFFERENT files both succeed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-race-diff-"));
    try {
      await writeFile(join(dir, "a.md"), "alpha");
      await writeFile(join(dir, "b.md"), "beta");
      const folder = await createFolder({ tenantId: TENANT, path: dir });

      // First sync: only a.md.
      const entryA: FileEntry = {
        relPath: "a.md",
        absPath: join(dir, "a.md"),
        mtimeMs: 1,
        inode: 1,
        sizeBytes: 5,
        sha1: "a"
      };
      const entryB: FileEntry = {
        relPath: "b.md",
        absPath: join(dir, "b.md"),
        mtimeMs: 2,
        inode: 2,
        sizeBytes: 4,
        sha1: "b"
      };
      const slow = makeSlowIngest();
      let resolveBlock!: () => void;
      slow.block = { promise: new Promise<void>((r) => { resolveBlock = r; }), resolve: resolveBlock };

      const p1 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: slow.ingest,
        analyze: async () => ({ added: [entryA], updated: [], deleted: [] })
      });
      await new Promise((r) => setTimeout(r, 50));
      const p2 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: slow.ingest,
        analyze: async () => ({ added: [entryB], updated: [], deleted: [] })
      });

      resolveBlock();
      await Promise.all([p1, p2]);

      // Both files were ingested.
      expect(slow.callCount.value).toBe(2);
      const manifest = await getManifest(folder.id);
      const paths = manifest.map((m) => m.relPath).sort();
      expect(paths).toEqual(["a.md", "b.md"]);
      expect(manifest.every((m) => m.status === "synced")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("race condition — concurrent UPDATES leave exactly one document", () => {
  it("two concurrent updates to the same file produce exactly one document in the documents table", async () => {
    // Contract: regardless of how the race resolves (CAS winner loses,
    // both run sequentially after the first finishes, etc.), the end state
    // MUST be exactly one document for the folder — not two, not zero.
    // The P0 bug was that re-ingesting a file left the old document behind.
    //
    // We use REAL ingestion (via syncFolder) for setup so the documents table
    // actually has an oldDocId row. The updates use the seam (syncFolderWith)
    // with mocks that do real DB work — so we can verify the documents-table
    // count end-to-end.
    const dir = await mkdtemp(join(tmpdir(), "sag-race-upd-"));
    try {
      await writeFile(join(dir, "shared.md"), "v1");
      const folder = await createFolder({ tenantId: TENANT, path: dir, metadata: { skipExtraction: true } });

      // Real first sync — creates an actual documents row we can later delete.
      const { syncFolder } = await import("../sync-orchestrator.js");
      const setup = await syncFolder(folder.id, "manual", TENANT);
      expect(setup.stats.added).toBe(1);

      const manifestBefore = await getManifest(folder.id);
      const oldDocId = manifestBefore[0].documentId!;
      expect(oldDocId).toMatch(/^[0-9a-f-]{36}$/);

      const docsBefore = await pool.query(
        "select id from documents where source_id = $1",
        [folder.sourceId]
      );
      expect(docsBefore.rowCount).toBe(1);
      expect(docsBefore.rows[0].id).toBe(oldDocId);

      // Race two parallel updates. The mocks touch the real DB so we can
      // verify the documents-table end state.
      const updateScan: ScanResult = {
        added: [],
        updated: [{
          relPath: "shared.md",
          absPath: join(dir, "shared.md"),
          mtimeMs: 2,
          inode: 2,
          sizeBytes: 3,
          sha1: "v2"
        }],
        deleted: []
      };
      const deletedIds: string[] = [];
      const racingWebui = {
        deleteDocument: async (id: string) => {
          deletedIds.push(id);
          // Mimic the real webui.deleteDocument: tenant-scoped delete from
          // the documents table (and only the documents row; in the seam we
          // don't care about chunks/events). SQLite equivalent of PG's
          // `delete from documents d using sources s where ...`:
          // `delete from documents where id = ? and source_id in (select id from sources where tenant_id = ?)`.
          const r = await pool.query(
            "delete from documents where id = ? and source_id in (select id from sources where tenant_id = ?)",
            [id, TENANT]
          );
          return { deleted: (r.rowCount ?? 0) > 0 };
        }
      };
      // ingestDocument that actually inserts a documents row, mimicking
      // the production ingest path's document-creation behavior (without
      // going through chunks/events/embeddings).
      const racingIngest = {
        ingestDocument: async (_input: { sourceId?: string; title: string; content?: string }) => {
          const newId = randomUUID();
          await pool.query(
            `insert into documents (id, source_id, title, content, parse_status, metadata)
             values ($1, $2, $3, $4, 'PARSED', '{}'::jsonb)`,
            [newId, folder.sourceId, _input.title, _input.content ?? "racing-test-content"]
          );
          return {
            documentId: newId,
            sourceId: folder.sourceId,
            chunkCount: 0,
            eventCount: 0,
            taskId: randomUUID(),
            traceId: randomUUID()
          };
        }
      };

      const p1 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: racingIngest,
        webuiService: racingWebui,
        analyze: async () => updateScan
      });
      const p2 = syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: racingIngest,
        webuiService: racingWebui,
        analyze: async () => updateScan
      });
      const [r1, r2] = await Promise.all([p1, p2]);

      // Both runs reached a definitive status.
      expect(["completed", "failed"]).toContain(r1.status);
      expect(["completed", "failed"]).toContain(r2.status);

      // The manifest CAS keeps the row coherent.
      const manifestAfter = await getManifest(folder.id);
      expect(manifestAfter).toHaveLength(1);
      expect(manifestAfter[0].status).toBe("synced");
      expect(manifestAfter[0].documentId).not.toBe(oldDocId);
      expect(manifestAfter[0].documentId).toMatch(/^[0-9a-f-]{36}$/);

      // The headline assertion: exactly ONE document in the documents table
      // for this folder. Without the P0 fix this would be 2 (or 3 if both
      // workers ran their delete+ingest sequentially).
      const docsAfter = await pool.query(
        "select id from documents where source_id = $1",
        [folder.sourceId]
      );
      expect(docsAfter.rowCount).toBe(1);
      expect(docsAfter.rows[0].id).toBe(manifestAfter[0].documentId);

      // The old document was explicitly deleted at least once.
      expect(deletedIds).toContain(oldDocId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sequential update produces exactly one document (P0 regression check)", async () => {
    // Direct end-to-end: pretend we don't get a chance to test the CAS race
    // and just verify the orphan fix on a single-threaded re-ingest.
    const dir = await mkdtemp(join(tmpdir(), "sag-race-seq-"));
    try {
      await writeFile(join(dir, "shared.md"), "v1");
      const folder = await createFolder({ tenantId: TENANT, path: dir });

      const oldDocId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const newDocId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const deletedIds: string[] = [];
      const ingestCalls: Array<{ title: string }> = [];

      const ingest = {
        ingestDocument: async (input: { title: string }) => {
          ingestCalls.push({ title: input.title });
          return {
            documentId: newDocId,
            sourceId: "src-test",
            chunkCount: 1,
            eventCount: 0,
            taskId: randomUUID(),
            traceId: randomUUID()
          };
        }
      };
      const webui = {
        deleteDocument: async (id: string) => {
          deletedIds.push(id);
          return { deleted: true };
        }
      };

      const scan = (sha: string, mtime: number): ScanResult => ({
        added: [],
        updated: [{
          relPath: "shared.md",
          absPath: join(dir, "shared.md"),
          mtimeMs: mtime,
          inode: mtime,
          sizeBytes: mtime,
          sha1: sha
        }],
        deleted: []
      });

      // First update with no prior manifest → no delete.
      await syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: ingest,
        webuiService: webui,
        analyze: async () => scan("v1", 1)
      });
      // After the first run, the manifest has newDocId and status=synced.
      const m1 = await getManifest(folder.id);
      expect(m1[0].documentId).toBe(newDocId);
      expect(deletedIds).toEqual([]);

      // Now manually mutate the manifest so it points at `oldDocId`, then
      // simulate a second update — this is the exact situation the bug fix
      // addresses: a prior document exists when we want to re-ingest.
      const { upsertManifest } = await import("../manifest-store.js");
      await upsertManifest({
        folderId: folder.id,
        relPath: "shared.md",
        status: "synced",
        documentId: oldDocId,
        mtimeMs: 1,
        inode: 1,
        sizeBytes: 1,
        sha1: "v1"
      });

      await syncFolderWith(folder.id, "event", TENANT, {
        ingestionService: ingest,
        webuiService: webui,
        analyze: async () => scan("v2", 2)
      });

      // The old document id must have been deleted exactly once.
      expect(deletedIds).toEqual([oldDocId]);
      // Ingest ran twice total.
      expect(ingestCalls).toHaveLength(2);
      // The manifest now points at the NEW document id, not the old one.
      const m2 = await getManifest(folder.id);
      expect(m2[0].documentId).toBe(newDocId);
      expect(m2[0].documentId).not.toBe(oldDocId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("race condition — transitionManifestStatus acts as CAS", () => {
  it("only one of N concurrent transitions wins the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-race-cas-"));
    try {
      const folder = await createFolder({ tenantId: TENANT, path: dir });
      await upsertManifest({ folderId: folder.id, relPath: "contended.md", status: "pending" });

      const attempts = await Promise.all(
        Array.from({ length: 5 }, () =>
          transitionManifestStatus(folder.id, "contended.md", ["pending"], "syncing")
        )
      );

      const winners = attempts.filter((r) => r?.status === "syncing");
      const losers = attempts.filter((r) => r === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});