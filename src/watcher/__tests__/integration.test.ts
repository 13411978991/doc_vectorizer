/**
 * End-to-end integration test: real Postgres + real Python converter.
 *
 * We deliberately use .txt files because they're the fastest path through
 * the converter (no PDF/DOCX dependencies needed). Sprint 1's contract is
 * "files flow through the pipeline correctly"; format-specific behaviors
 * are exercised in unit tests with mocked spawn.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import {
  createFolder,
  getFolder,
  getLatestSyncRun,
  getManifest,
  markManifestStatus,
  upsertManifest
} from "../manifest-store.js";
import { syncFolder } from "../sync-orchestrator.js";

const TENANT = `integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

describe("integration — end-to-end sync", () => {
  it("creates a watched folder, syncs new .txt files, and ingests them as documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-integ-"));
    try {
      const fileA = join(dir, "alpha.txt");
      const fileB = join(dir, "beta.txt");
      await writeFile(fileA, "Alpha content — event A happens here.\nMore context.\n");
      await writeFile(fileB, "Beta content — event B happens here.\n");

      // skipExtraction keeps the test hermetic — it doesn't depend on a working
      // LLM endpoint. The chunks + embeddings still happen.
      const folder = await createFolder({
        tenantId: TENANT,
        path: dir,
        metadata: { skipExtraction: true }
      });
      expect(folder.sourceId).toMatch(/^[0-9a-f-]{36}$/);

      // Run a manual sync. This will:
      //   1. Scan the folder.
      //   2. Convert .txt files via the Python converter.
      //   3. Call ingestionService.ingestDocument() which embeds + persists.
      const result = await syncFolder(folder.id, "manual", TENANT);
      expect(result.status).toBe("completed");
      expect(result.stats.added).toBe(2);
      expect(result.stats.failed).toBe(0);

      // Manifest was updated.
      const manifest = await getManifest(folder.id);
      const byPath = Object.fromEntries(manifest.map((m) => [m.relPath, m]));
      expect(Object.keys(byPath).sort()).toEqual(["alpha.txt", "beta.txt"]);
      for (const m of Object.values(byPath)) {
        expect(m.status).toBe("synced");
        expect(m.documentId).toMatch(/^[0-9a-f-]{36}$/);
      }

      // Documents were actually inserted into the documents table.
      const docIds = Object.values(byPath).map((m) => m.documentId);
      const docsResult = await pool.query(
        "select id, source_id, title from documents where id = any($1::uuid[])",
        [docIds]
      );
      expect(docsResult.rowCount).toBe(2);
      for (const row of docsResult.rows) {
        expect(row.source_id).toBe(folder.sourceId);
      }

      // Sync run was recorded with stats.
      const run = await getLatestSyncRun(folder.id);
      expect(run?.status).toBe("completed");
      expect(run?.filesAdded).toBe(2);
      expect(run?.trigger).toBe("manual");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000); // Python + embeddings may take a moment

  it("detects a deleted file and hard-deletes the corresponding document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-integ-del-"));
    try {
      const fileA = join(dir, "to-delete.txt");
      await writeFile(fileA, "This file will be deleted.");

      const folder = await createFolder({ tenantId: TENANT, path: dir, metadata: { skipExtraction: true } });
      const first = await syncFolder(folder.id, "manual", TENANT);
      expect(first.stats.added).toBe(1);

      const manifestBefore = await getManifest(folder.id);
      const docId = manifestBefore[0].documentId!;
      expect(docId).toMatch(/^[0-9a-f-]{36}$/);

      // Confirm the document is queryable.
      const docBefore = await pool.query("select id, archived_at from documents where id = $1", [docId]);
      expect(docBefore.rowCount).toBe(1);

      // Delete the file from disk and resync.
      await rm(fileA);
      const second = await syncFolder(folder.id, "event", TENANT);
      expect(second.status).toBe("completed");
      expect(second.stats.deleted).toBe(1);

      // Manifest entry is marked deleted (soft delete on the manifest).
      const manifestAfter = await getManifest(folder.id);
      expect(manifestAfter[0].status).toBe("deleted");
      expect(manifestAfter[0].documentId).toBe(docId); // still points to doc

      // The underlying document is HARD-deleted from the documents table.
      const docAfter = await pool.query("select id from documents where id = $1", [docId]);
      expect(docAfter.rowCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("picks up changes when the file content changes (mtime + sha1 differ)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-integ-change-"));
    try {
      const fileA = join(dir, "changing.txt");
      await writeFile(fileA, "First version.");

      const folder = await createFolder({ tenantId: TENANT, path: dir, metadata: { skipExtraction: true } });
      const first = await syncFolder(folder.id, "manual", TENANT);
      expect(first.stats.added).toBe(1);

      // Capture the original document id so we can verify it's gone after the re-ingest.
      const manifestBefore = await getManifest(folder.id);
      const previousDocId = manifestBefore[0].documentId!;
      expect(previousDocId).toMatch(/^[0-9a-f-]{36}$/);

      // Wait a tick so mtime is definitely different.
      await new Promise((r) => setTimeout(r, 30));
      await writeFile(fileA, "Second version with more content.");
      const second = await syncFolder(folder.id, "event", TENANT);
      expect(second.status).toBe("completed");
      expect(second.stats.updated).toBe(1);

      // Manifest reflects the change. The new document id must differ from
      // the original because we hard-delete the old document on re-ingest
      // (P0 fix in Sprint 2).
      const manifest = await getManifest(folder.id);
      expect(manifest[0].status).toBe("synced");
      const newDocId = manifest[0].documentId!;
      expect(newDocId).toMatch(/^[0-9a-f-]{36}$/);
      expect(newDocId).not.toBe(previousDocId);

      // Only ONE document remains for this folder — no orphan from the first
      // version. This is the headline assertion for the Sprint 2 fix.
      const docs = await pool.query(
        "select id, title from documents where source_id = $1",
        [folder.sourceId]
      );
      expect(docs.rowCount).toBe(1);
      expect(docs.rows[0].id).toBe(newDocId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("respects a blacklist (excluded file does not become a document)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-integ-bl-"));
    try {
      await writeFile(join(dir, "keep.txt"), "This should be ingested.");
      await writeFile(join(dir, "skip.log"), "This should be skipped.");

      const folder = await createFolder({
        tenantId: TENANT,
        path: dir,
        filetypeFilter: { blacklist: [".log"] },
        metadata: { skipExtraction: true }
      });
      const result = await syncFolder(folder.id, "manual", TENANT);
      expect(result.status).toBe("completed");

      // Manifest has the .txt synced and the .log marked synced (with a skip reason).
      const manifest = await getManifest(folder.id);
      const byPath = Object.fromEntries(manifest.map((m) => [m.relPath, m]));
      expect(byPath["keep.txt"]?.status).toBe("synced");
      expect(byPath["skip.log"]?.status).toBe("synced");
      // SQLite manifest schema does not store per-file lastError (only the
      // folder-level last_scan_error), so the blacklist reason is logged
      // but not persisted on the manifest row. Verifying it here would
      // require a schema change.

      // Only one document was created.
      const docs = await pool.query("select id from documents where source_id = $1", [folder.sourceId]);
      expect(docs.rowCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a failing sync marks the run as failed and records the error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sag-integ-fail-"));
    try {
      await writeFile(join(dir, "ok.txt"), "ok");

      const folder = await createFolder({ tenantId: TENANT, path: dir });
      // Inject a bad manifest entry that points at a manifest document_id that
      // does not exist as a documents row, then mark it as something that will
      // fail to ingest on the next sync. Actually, the simpler way: pre-create
      // a manifest row for a non-existent file. Scan finds nothing new on
      // disk, so we need a different approach to force failure.
      //
      // Easiest: corrupt the folder path so the analyzer's stat check fails.
      const folderRecord = await getFolder(folder.id, TENANT);
      expect(folderRecord).toBeTruthy();
      await pool.query(
        "update watched_folders set path = $1 where id = $2",
        [join(dir, "this-does-not-exist"), folder.id]
      );

      const result = await syncFolder(folder.id, "manual", TENANT);
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toMatch(/path not accessible|not a directory/i);
      const run = await getLatestSyncRun(folder.id);
      expect(run?.status).toBe("failed");
      expect(run?.errorMessage).toMatch(/path not accessible|not a directory/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});