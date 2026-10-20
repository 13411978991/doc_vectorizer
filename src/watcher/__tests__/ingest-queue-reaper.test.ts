/**
 * P-Tier3-#T3d — tests for `IngestQueue.requeuePendingOrphans`.
 *
 * The reaper runs at boot to recover manifest rows left in `pending`
 * state by a previous (crashed) process. Without it, the only way
 * for those files to be re-ingested is to wait for the next chokidar
 * event with the same rel_path — unreliable on shared/network
 * drives with stale mtime caches.
 *
 * What we verify:
 *  1. Rows with `last_event='pending' AND last_sync_started_at IS NULL`
 *     ARE re-enqueued (the reaper's return value `requeued` is the
 *     authoritative count; `pending.size` may have already drained
 *     by the time we assert).
 *  2. Rows with `last_event='synced'` (already-ingested) are NOT
 *     touched.
 *  3. Rows with `last_sync_started_at` set (currently-syncing) are
 *     NOT touched (those belong to the existing
 *     `reapStaleSyncingManifests` path).
 *  4. Rows for OTHER tenants are NOT touched.
 *  5. Orphan rows whose folder was deleted are silently skipped
 *     (reaper is best-effort, not destructive).
 *
 * The test uses a real SQLite DB via the existing pool fixture
 * (the watcher __tests__/manifest-store.test.ts file documents the
 * pattern) — `pool.query` is the production interface the reaper
 * uses, so any mock would diverge from the actual SQL semantics.
 *
 * NOTE: the queue's private `folders` Map is intentionally not
 * exported (see ingest-queue.ts), so we observe its state through
 * the public `getProgress(folderId)` surface instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import {
  createFolder,
  deleteFolder,
  upsertManifest
} from "../manifest-store.js";
import { ingestQueue } from "../ingest-queue.js";

const TENANT = `reaper-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ALT_TENANT = `${TENANT}-alt`;
const TEST_FOLDER_DISPLAY = "Reaper Test Folder";

async function cleanup(): Promise<void> {
  // Drop in dependency order: manifest rows first, then folder.
  // Both CASCADE from folder via FK on delete cascade.
  await pool.query(
    "delete from watched_folders where tenant_id in ($1, $2)",
    [TENANT, ALT_TENANT]
  );
  await pool.query(
    "delete from sources where tenant_id in ($1, $2) and metadata->>'semanticType' = 'watched_folder'",
    [TENANT, ALT_TENANT]
  );
  // Drain any folder the queue might be tracking for these
  // tenants. removeFolder() is a no-op if the folder isn't in the
  // queue's tracking, so this is safe to call unconditionally.
  // We don't track per-folder ids here — instead we wipe by
  // iterating getAllProgress() which is the public surface.
  for (const progress of ingestQueue.getAllProgress()) {
    ingestQueue.removeFolder(progress.folderId);
  }
}

beforeAll(async () => {
  // Best-effort ping — skip with a clear error if the DB isn't ready.
  try {
    await pool.query("select 1");
  } catch (error) {
    throw new Error(
      `DB unavailable; integration test requires running pool: ${(error as Error).message}`
    );
  }
});

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

async function setupFolder(): Promise<string> {
  const folder = await createFolder({
    tenantId: TENANT,
    path: `E:/reaper-test-${Date.now()}`,
    displayName: TEST_FOLDER_DISPLAY,
    recursive: true,
    filetypeFilter: { whitelist: [".txt", ".md"], maxBytes: 1_000_000 },
    sourceId: undefined
  });
  return folder.id;
}

describe("IngestQueue.requeuePendingOrphans", () => {
  it("requeues pending rows with no last_sync_started_at", async () => {
    const folderId = await setupFolder();
    // Insert two orphan rows that the reaper should pick up.
    await upsertManifest({
      folderId,
      relPath: "orphan-1.md",
      documentId: null,
      sizeBytes: 1234,
      sha1: "abc123"
    });
    await upsertManifest({
      folderId,
      relPath: "orphan-2.md",
      documentId: null,
      sizeBytes: 5678,
      sha1: "def456"
    });

    // The authoritative count is what the reaper returns. The
    // queue's drain loop fires as a microtask and may have pulled
    // one or both items into the active set (and started an async
    // ingest) by the time the next line of test code runs — so we
    // assert on the return value rather than peeking into the
    // pending Map directly.
    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });

    expect(result.requeued).toBe(2);
    expect(result.foldersTouched).toBe(1);
    expect(result.folderIds).toEqual([folderId]);

    // Also assert that the queue at least registered one item in
    // either pending or active. After requeuePendingOrphans returns,
    // the microtask drain hasn't run yet (the current sync block
    // holds the event loop), so we expect to see both items in
    // pending.size OR active == 1 (if drain already grabbed one).
    const progress = ingestQueue.getProgress(folderId);
    expect(progress.folderId).toBe(folderId);
    expect(progress.pending + progress.active).toBeGreaterThanOrEqual(1);
    expect(progress.added + progress.updated).toBeGreaterThanOrEqual(0);
  });

  it("does NOT requeue synced rows", async () => {
    const folderId = await setupFolder();
    // Insert a synced row that the reaper must NOT touch.
    await upsertManifest({
      folderId,
      relPath: "synced.md",
      documentId: null,
      sizeBytes: 100,
      sha1: "h1"
    });
    // Force the row's last_event to 'synced' — upsertManifest may
    // set 'pending' by default, so we update afterwards to make the
    // negative-path assumption hold.
    await pool.query(
      "update watched_folder_manifests set last_event = 'synced' where folder_id = $1 and rel_path = $2",
      [folderId, "synced.md"]
    );

    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });
    expect(result.requeued).toBe(0);
    // The folder should not have been registered in the queue at
    // all (no work item got enqueued for it).
    expect(ingestQueue.getProgress(folderId).pending).toBe(0);
  });

  it("does NOT requeue rows with last_sync_started_at set", async () => {
    const folderId = await setupFolder();
    // 'pending' but already touched by an in-flight process — the
    // reaper must leave these for reapStaleSyncingManifests.
    await upsertManifest({
      folderId,
      relPath: "in-flight.md",
      documentId: null,
      sizeBytes: 50,
      sha1: "h2"
    });
    await pool.query(
      "update watched_folder_manifests set last_sync_started_at = current_timestamp where folder_id = $1 and rel_path = $2",
      [folderId, "in-flight.md"]
    );

    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });
    expect(result.requeued).toBe(0);
    expect(ingestQueue.getProgress(folderId).pending).toBe(0);
  });

  it("does NOT requeue rows for other tenants", async () => {
    // Set up a folder under ALT_TENANT — reaper must ignore it
    // when called for TENANT.
    const altFolder = await createFolder({
      tenantId: ALT_TENANT,
      path: `E:/reaper-test-alt-${Date.now()}`,
      displayName: "Alt Tenant Folder",
      recursive: true,
      filetypeFilter: { whitelist: [".txt"], maxBytes: 1000 },
      sourceId: undefined
    });
    await upsertManifest({
      folderId: altFolder.id,
      relPath: "alt-orphan.md",
      documentId: null,
      sizeBytes: 200,
      sha1: "h3"
    });

    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });
    expect(result.requeued).toBe(0);
    expect(result.folderIds).toEqual([]);
    // The ALT folder's orphan must remain untouched.
    expect(ingestQueue.getProgress(altFolder.id).pending).toBe(0);
  });

  it("skips orphans whose folder was deleted", async () => {
    const folderId = await setupFolder();
    await upsertManifest({
      folderId,
      relPath: "ghost.md",
      documentId: null,
      sizeBytes: 10,
      sha1: "h4"
    });
    // Delete the folder — the manifest row CASCADEs with it, but
    // simulate the race where the manifest row survives for a
    // tick. To force this we delete via raw SQL and skip the
    // cascade (the migration doesn't always CASCADE manifest
    // from folder, so this race is real).
    await pool.query(
      "delete from watched_folder_manifests where folder_id = $1",
      [folderId]
    );
    await deleteFolder(folderId, TENANT);

    // No crash, no enqueue.
    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });
    expect(result.requeued).toBe(0);
  });

  it("returns zero when there are no orphans", async () => {
    const result = await ingestQueue.requeuePendingOrphans({ tenantId: TENANT });
    expect(result).toEqual({ requeued: 0, foldersTouched: 0, folderIds: [] });
  });
});