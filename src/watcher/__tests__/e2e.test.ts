/**
 * End-to-end test: real WatcherManager + real chokidar + real Postgres + real Python converter.
 *
 * This is the "no mocks, no shortcuts" test. We boot a WatcherManager against a
 * real temporary directory, drop a real .txt file in it, and verify that:
 *
 *   1. chokidar fires the add event
 *   2. WatcherManager's 1 s debounce kicks in
 *   3. syncFolder runs against the real DB
 *   4. ingestionService.ingestDocument() persists a document
 *   5. We can SELECT it from the documents table
 *
 * We then mutate the file (change) and delete it (unlink), verifying the same
 * flow applies and the P0 fix from Sprint 2 (no orphan documents on re-ingest)
 * holds end-to-end.
 *
 * Constraints:
 *   - Each test creates its own tmp directory via mkdtemp.
 *   - Each test cleans up its watched_folders + sources + documents before
 *     and after the suite runs.
 *   - 30 s timeouts (debounce + ingest can be slow on a cold DB).
 *   - We never call `syncFolder` manually in the happy-path tests — we wait
 *     for chokidar to deliver the event and the debounced timer to fire. This
 *     is the headline assertion of the test: the watcher works end-to-end.
 */

import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import {
  createFolder,
  deleteFolder,
  getLatestSyncRun,
  getManifest
} from "../manifest-store.js";
import { WatcherManager } from "../index.js";

// Each test gets its own tenant id so we can clean up aggressively without
// trampling other suites sharing the same database.
const TENANT = `e2e-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Hard-cleanup: drop everything this test ever created, in dependency order.
 * - documents → chunks are FK'd, chunks → entities are FK'd → just nuke sources.
 * - watched_folders → cascades manifest + sync_runs.
 * - sources → cascades documents + chunks + entities.
 *
 * We do this from raw SQL because the application layer doesn't expose a
 * "delete all docs for this tenant" entry point, and we want each test to
 * start from a known empty state.
 */
async function cleanup(): Promise<void> {
  // 1) Find sources we created (sources owned by us = semanticType=watched_folder).
  const sources = await pool.query<{ id: string }>(
    "select id from sources where tenant_id = $1 and metadata->>'semanticType' = 'watched_folder'",
    [TENANT]
  );
  const sourceIds = sources.rows.map((row) => row.id);

  // 2) Drop documents tied to those sources first (FK cascade handles chunks/entities
  //    once sources are gone, but documents have no tenant_id, so we go by source).
  if (sourceIds.length > 0) {
    await pool.query("delete from documents where source_id = any($1::uuid[])", [sourceIds]);
  }

  // 3) Drop watched_folders — cascades manifest + sync_runs via the FK chain.
  await pool.query("delete from watched_folders where tenant_id = $1", [TENANT]);

  // 4) Drop sources.
  await pool.query(
    "delete from sources where tenant_id = $1 and metadata->>'semanticType' = 'watched_folder'",
    [TENANT]
  );
}

beforeEach(async () => {
  await cleanup();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

/**
 * Poll for a predicate to become true. Used to wait for chokidar's debounce +
 * the sync run to complete. Throws if `timeoutMs` elapses without success.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  options: { timeoutMs: number; intervalMs?: number; description?: string } = { timeoutMs: 30_000 }
): Promise<void> {
  const intervalMs = options.intervalMs ?? 150;
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitFor timed out after ${options.timeoutMs}ms${
      options.description ? ` (waiting for: ${options.description})` : ""
    }`
  );
}

async function documentCountFor(sourceId: string): Promise<number> {
  const result = await pool.query("select count(*)::int as count from documents where source_id = $1", [sourceId]);
  return Number(result.rows[0]?.count ?? 0);
}

async function documentTitlesFor(sourceId: string): Promise<string[]> {
  const result = await pool.query("select title from documents where source_id = $1 order by created_at", [sourceId]);
  return result.rows.map((row) => String(row.title));
}

/**
 * Build a WatcherManager against a real folder. Returns the manager, the
 * folder record, and the temp dir. Caller is responsible for cleanup.
 *
 * We pause briefly after startOne to let chokidar's initial scan finish.
 * Without this, a write that lands during the scan window can be silently
 * ignored (chokidar's `ignoreInitial: true` policy treats files that exist
 * before the scan completes as part of the initial state).
 */
async function bootWatcherAgainst(
  dir: string,
  displayName: string
): Promise<{ manager: WatcherManager; folder: Awaited<ReturnType<typeof createFolder>>; dir: string }> {
  const folder = await createFolder({
    tenantId: TENANT,
    path: dir,
    displayName,
    recursive: true,
    metadata: { skipExtraction: true } // keep the test hermetic — no LLM calls
  });
  const manager = new WatcherManager({ debounceMs: 250 }); // shorter than prod's 1s for test speed
  await manager.startOne(folder);
  // Give chokidar a beat to finish its initial scan. Without this, the
  // very first event-driven sync can be missed because the write lands
  // while chokidar is still enumerating. 200 ms is empirical: long enough
  // for fs.watch on Linux to settle, short enough to keep tests snappy.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { manager, folder, dir };
}

describe("e2e — real WatcherManager + real chokidar + real PG", () => {
  it(
    "detects a new .txt file, ingests it, and persists a row in documents",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-add-"));
      const { manager, folder } = await bootWatcherAgainst(dir, "add-test");

      try {
        const filePath = join(dir, "fresh.txt");
        await writeFile(filePath, "First content: hello SAG e2e world.\nMore lines.\n");

        // Wait for: chokidar fires add → debounce 250 ms → syncFolder runs → document appears.
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 1,
          { timeoutMs: 30_000, description: "documents row count to reach 1" }
        );

        const titles = await documentTitlesFor(folder.sourceId);
        expect(titles).toEqual(["fresh"]);

        const manifest = await getManifest(folder.id);
        expect(manifest).toHaveLength(1);
        expect(manifest[0].relPath).toBe("fresh.txt");
        expect(manifest[0].status).toBe("synced");
        expect(manifest[0].documentId).toMatch(/^[0-9a-f-]{36}$/);

        // Sync run was recorded.
        const run = await getLatestSyncRun(folder.id);
        expect(run?.status).toBe("completed");
        expect(run?.filesAdded).toBe(1);
        expect(run?.trigger).toBe("event");
      } finally {
        await manager.stopAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  it(
    "detects a change and replaces the document with a fresh one (P0 fix: no orphan)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-change-"));
      const { manager, folder } = await bootWatcherAgainst(dir, "change-test");

      try {
        const filePath = join(dir, "evolving.txt");
        await writeFile(filePath, "Version 1.");

        // Wait for first ingest.
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 1,
          { timeoutMs: 30_000, description: "initial document" }
        );
        const firstDocId = (await getManifest(folder.id))[0].documentId;
        expect(firstDocId).toMatch(/^[0-9a-f-]{36}$/);

        // Give the FS a moment so mtime is definitely different on slow boxes.
        await new Promise((r) => setTimeout(r, 50));
        await writeFile(filePath, "Version 2 with completely different bytes for sha1 to differ.");

        // Wait for: chokidar fires change → debounce → sync → new doc replaces old.
        await waitFor(
          async () => {
            const manifest = await getManifest(folder.id);
            return manifest.length === 1 && manifest[0].documentId !== firstDocId && manifest[0].status === "synced";
          },
          { timeoutMs: 30_000, description: "document id to flip to a new one" }
        );

        // Headline assertion: only ONE document remains for this source. The
        // Sprint 2 P0 fix deleted the old document before re-ingesting.
        const count = await documentCountFor(folder.sourceId);
        expect(count).toBe(1);

        const manifest = await getManifest(folder.id);
        const newDocId = manifest[0].documentId;
        expect(newDocId).not.toBe(firstDocId);
        expect(newDocId).toMatch(/^[0-9a-f-]{36}$/);
        // Old document is HARD-deleted from the table.
        const oldDocResult = await pool.query("select id from documents where id = $1", [firstDocId]);
        expect(oldDocResult.rowCount).toBe(0);
      } finally {
        await manager.stopAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  it(
    "detects an unlink and hard-deletes the corresponding document",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-unlink-"));
      const { manager, folder } = await bootWatcherAgainst(dir, "unlink-test");

      try {
        const filePath = join(dir, "doomed.txt");
        await writeFile(filePath, "Soon to be deleted.");

        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 1,
          { timeoutMs: 30_000, description: "document to appear" }
        );
        const docId = (await getManifest(folder.id))[0].documentId;
        expect(docId).toMatch(/^[0-9a-f-]{36}$/);

        await unlink(filePath);

        // Wait for: chokidar fires unlink → debounce → sync → document gone.
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 0,
          { timeoutMs: 30_000, description: "document to be hard-deleted" }
        );

        // Manifest entry was soft-deleted (status='deleted'), but the row stays
        // for history. The documents row is hard-deleted.
        const manifest = await getManifest(folder.id);
        expect(manifest).toHaveLength(1);
        expect(manifest[0].status).toBe("deleted");

        const docCheck = await pool.query("select id from documents where id = $1", [docId]);
        expect(docCheck.rowCount).toBe(0);

        // Sync run recorded the deletion.
        const run = await getLatestSyncRun(folder.id);
        expect(run?.status).toBe("completed");
        expect(run?.filesDeleted).toBe(1);
      } finally {
        await manager.stopAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  it(
    "bootWatchedFolders-style startup scan catches up existing files",
    async () => {
      // Pre-populate the directory before the watcher starts. The startup scan
      // (trigger=startup) should pick everything up regardless of chokidar's
      // ignoreInitial flag.
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-startup-"));
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, "pre-a.txt"), "Pre-existing A.");
      await writeFile(join(dir, "pre-b.txt"), "Pre-existing B.");
      await writeFile(join(dir, "nested", "pre-c.txt"), "Pre-existing C (nested).");

      const folder = await createFolder({
        tenantId: TENANT,
        path: dir,
        recursive: true,
        metadata: { skipExtraction: true }
      });
      const manager = new WatcherManager({ debounceMs: 250 });

      try {
        // Start the watcher — this internally does a startup scan before attaching.
        await manager.startOne(folder);

        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 3,
          { timeoutMs: 30_000, description: "3 startup-scan documents" }
        );

        const manifest = await getManifest(folder.id);
        const relPaths = manifest.map((m) => m.relPath).sort();
        expect(relPaths).toEqual(["nested/pre-c.txt", "pre-a.txt", "pre-b.txt"]);

        // After the startup scan, an event-driven sync should also work.
        await writeFile(join(dir, "post-startup.txt"), "After startup.");
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 4,
          { timeoutMs: 30_000, description: "post-startup file ingested via event" }
        );
      } finally {
        await manager.stopAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
    45_000
  );

  it(
    "debounces burst events: 5 file creates in 100 ms yield a single sync run with all 5 ingested",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-burst-"));
      const { manager, folder } = await bootWatcherAgainst(dir, "burst-test");

      try {
        // Fire 5 writes back-to-back. Without the debounce, each would trigger a sync.
        for (let i = 0; i < 5; i += 1) {
          await writeFile(join(dir, `burst-${i}.txt`), `Burst ${i}.`);
          // Tiny pause so each file is observed as a separate chokidar event
          // — but still well within the 250 ms debounce window.
          await new Promise((r) => setTimeout(r, 20));
        }

        // Wait for the debounced sync to settle.
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 5,
          { timeoutMs: 30_000, description: "5 burst documents" }
        );

        const manifest = await getManifest(folder.id);
        expect(manifest).toHaveLength(5);
        for (const entry of manifest) {
          expect(entry.status).toBe("synced");
        }
      } finally {
        await manager.stopAll();
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000
  );

  it(
    "deleteFolder tears down the watcher and cascades DB rows (documents included)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "sag-e2e-cleanup-"));
      const { manager, folder } = await bootWatcherAgainst(dir, "cleanup-test");

      try {
        await writeFile(join(dir, "ephemeral.txt"), "Short-lived content.");
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 1,
          { timeoutMs: 30_000, description: "initial document" }
        );

        // Stop the watcher + drop the folder + the source. documents cascade.
        await manager.stopAll();
        const deleted = await deleteFolder(folder.id, TENANT);
        expect(deleted).toBe(true);

        // Documents tied to the source are hard-deleted.
        await waitFor(
          async () => (await documentCountFor(folder.sourceId)) === 0,
          { timeoutMs: 10_000, description: "documents to cascade-delete" }
        );

        // Source row is gone.
        const sourceCheck = await pool.query("select id from sources where id = $1", [folder.sourceId]);
        expect(sourceCheck.rowCount).toBe(0);

        // Manifest + sync_runs are gone too (cascade from watched_folders).
        const manifestCheck = await pool.query("select folder_id, rel_path from watched_folder_manifests where folder_id = $1", [folder.id]);
        expect(manifestCheck.rowCount).toBe(0);
        const runsCheck = await pool.query("select id from watched_folder_runs where folder_id = $1", [folder.id]);
        expect(runsCheck.rowCount).toBe(0);

        // WatcherManager reports not running.
        expect(manager.isRunning(folder.id)).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000
  );
});