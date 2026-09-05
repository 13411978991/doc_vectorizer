import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, closePool } from "../../db/pool.js";
import {
  createFolder,
  createSyncRun,
  deleteFolder,
  deleteManifest,
  finishSyncRun,
  findManifestByDocumentId,
  getFolder,
  getFolderByPath,
  getLatestSyncRun,
  getManifest,
  listFolders,
  listSyncRuns,
  markManifestStatus,
  transitionManifestStatus,
  updateFolder,
  upsertManifest
} from "../manifest-store.js";

const TENANT = `watcher-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ALT_TENANT = `${TENANT}-alt`;

async function cleanup(): Promise<void> {
  await pool.query("delete from watched_folders where tenant_id in ($1, $2)", [TENANT, ALT_TENANT]);
  // CASCADE drops manifest + sync_runs. We also drop any orphan sources
  // we created in tests where folder creation succeeded.
  await pool.query(
    "delete from sources where tenant_id in ($1, $2) and metadata->>'semanticType' = 'watched_folder'",
    [TENANT, ALT_TENANT]
  );
}

beforeAll(async () => {
  // Best-effort ping to skip gracefully if PG isn't reachable.
  try {
    await pool.query("select 1");
  } catch (error) {
    throw new Error(`Postgres unavailable; integration tests require a running database: ${(error as Error).message}`);
  }
});

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

describe("manifest-store — folder CRUD", () => {
  it("creates a folder and auto-creates a Source", async () => {
    const path = `/tmp/sag-watcher-folder-${Date.now()}`;
    const folder = await createFolder({ tenantId: TENANT, path, displayName: "审计资料库" });

    expect(folder.tenantId).toBe(TENANT);
    expect(folder.path).toBe(path);
    expect(folder.displayName).toBeTruthy();
    expect(folder.enabled).toBe(true);
    expect(folder.recursive).toBe(true);
    expect(folder.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(folder.metadata).toEqual({});

    // Source was created with the right shape.
    const sourceResult = await pool.query("select * from sources where id = $1", [folder.sourceId]);
    const source = sourceResult.rows[0];
    expect(source).toBeTruthy();
    expect(source.tenant_id).toBe(TENANT);
    expect(source.name).toBe(folder.displayName);
    expect(source.description).toBe("Auto-created from watched folder");
    // SQLite stores metadata as JSON text; parse before reading fields.
    const sourceMetadata = JSON.parse(source.metadata ?? "{}");
    expect(sourceMetadata.createdVia).toBe("watcher");
    expect(sourceMetadata.semanticType).toBe("watched_folder");
  });

  it("lists folders by tenant", async () => {
    const a = await createFolder({ tenantId: TENANT, path: `/tmp/a-${Date.now()}` });
    const b = await createFolder({ tenantId: TENANT, path: `/tmp/b-${Date.now()}` });
    // Another tenant — must not appear.
    await createFolder({ tenantId: ALT_TENANT, path: `/tmp/c-${Date.now()}` });

    const list = await listFolders(TENANT);
    const ids = list.map((f) => f.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(list.every((f) => f.tenantId === TENANT)).toBe(true);
  });

  it("getFolder is tenant-scoped", async () => {
    const folder = await createFolder({ tenantId: TENANT, path: `/tmp/iso-${Date.now()}` });
    expect((await getFolder(folder.id, TENANT))?.id).toBe(folder.id);
    expect(await getFolder(folder.id, ALT_TENANT)).toBeNull();
  });

  it("getFolderByPath resolves by path within a tenant", async () => {
    const path = `/tmp/path-lookup-${Date.now()}`;
    const folder = await createFolder({ tenantId: TENANT, path });
    const found = await getFolderByPath(path, TENANT);
    expect(found?.id).toBe(folder.id);
    expect(await getFolderByPath(path, ALT_TENANT)).toBeNull();
  });

  it("updateFolder changes fields and bumps updated_at", async () => {
    const folder = await createFolder({ tenantId: TENANT, path: `/tmp/upd-${Date.now()}` });
    const updated = await updateFolder(folder.id, {
      displayName: "renamed",
      enabled: false,
      recursive: false,
      filetypeFilter: { whitelist: [".md"] },
      metadata: { foo: "bar" }
    });
    expect(updated?.displayName).toBe("renamed");
    expect(updated?.enabled).toBe(false);
    expect(updated?.recursive).toBe(false);
    expect(updated?.filetypeFilter).toEqual({ whitelist: [".md"] });
    expect(updated?.metadata?.foo).toBe("bar");
  });

  it("deleteFolder cascades to manifest, runs, and source", async () => {
    const folder = await createFolder({ tenantId: TENANT, path: `/tmp/cascade-${Date.now()}` });
    const sourceId = folder.sourceId;

    await upsertManifest({ folderId: folder.id, relPath: "a.md" });
    await upsertManifest({ folderId: folder.id, relPath: "b.md" });
    const run = await createSyncRun(folder.id, "manual");

    await deleteFolder(folder.id, TENANT);

    expect(await getFolder(folder.id, TENANT)).toBeNull();
    expect((await getManifest(folder.id)).length).toBe(0);
    expect(await getLatestSyncRun(folder.id)).toBeNull();
    // Source was cleaned up.
    const sourceRow = await pool.query("select id from sources where id = $1", [sourceId]);
    expect(sourceRow.rowCount).toBe(0);
  });

  it("deleteFolder returns false when the folder does not exist", async () => {
    expect(
      await deleteFolder("00000000-0000-0000-0000-000000000000", TENANT)
    ).toBe(false);
  });
});

describe("manifest-store — manifest CRUD", () => {
  let folderId: string;

  beforeEach(async () => {
    const folder = await createFolder({ tenantId: TENANT, path: `/tmp/mfst-${Date.now()}` });
    folderId = folder.id;
  });

  it("upserts new and existing entries", async () => {
    const first = await upsertManifest({ folderId, relPath: "a.md", sha1: "abc" });
    expect(first.status).toBe("pending");
    expect(first.sha1).toBe("abc");

    const updated = await upsertManifest({
      folderId,
      relPath: "a.md",
      sha1: "def",
      status: "synced",
      documentId: "00000000-0000-0000-0000-000000000123"
    });
    expect(updated.status).toBe("synced");
    expect(updated.sha1).toBe("def");
    expect(updated.documentId).toBe("00000000-0000-0000-0000-000000000123");
  });

  it("getManifest filters by status", async () => {
    await upsertManifest({ folderId, relPath: "p.md", status: "pending" });
    await upsertManifest({ folderId, relPath: "s.md", status: "synced" });
    await upsertManifest({ folderId, relPath: "f.md", status: "failed" });

    const synced = await getManifest(folderId, "synced");
    expect(synced.map((m) => m.relPath)).toEqual(["s.md"]);
  });

  it("markManifestStatus updates status and error", async () => {
    await upsertManifest({ folderId, relPath: "x.md" });
    const marked = await markManifestStatus(folderId, "x.md", "failed", "boom");
    expect(marked?.status).toBe("failed");
    // last_error is persisted (migration 010) so the UI can surface the
    // failure reason next to the red badge.
    expect(marked?.lastError).toBe("boom");
  });

  it("transitionManifestStatus acts as a status CAS", async () => {
    await upsertManifest({ folderId, relPath: "y.md", status: "pending" });

    const ok = await transitionManifestStatus(folderId, "y.md", ["pending", "failed"], "syncing");
    expect(ok?.status).toBe("syncing");

    // Wrong from-status → returns null, manifest unchanged.
    const blocked = await transitionManifestStatus(folderId, "y.md", ["pending"], "synced");
    expect(blocked).toBeNull();
    const stillSyncing = await getManifest(folderId);
    expect(stillSyncing.find((m) => m.relPath === "y.md")?.status).toBe("syncing");

    // Right from-status → succeeds.
    const done = await transitionManifestStatus(folderId, "y.md", ["syncing"], "synced", {
      documentId: "00000000-0000-0000-0000-000000000999"
    });
    expect(done?.status).toBe("synced");
    expect(done?.documentId).toBe("00000000-0000-0000-0000-000000000999");
  });

  it("findManifestByDocumentId locates the owning manifest row", async () => {
    const docId = "00000000-0000-0000-0000-000000000abc";
    await upsertManifest({
      folderId,
      relPath: "lookup.md",
      status: "synced",
      documentId: docId
    });
    const found = await findManifestByDocumentId(docId);
    expect(found?.relPath).toBe("lookup.md");
    expect(found?.folderId).toBe(folderId);
  });

  it("deleteManifest soft-deletes by setting status=deleted", async () => {
    await upsertManifest({ folderId, relPath: "to-delete.md", status: "synced" });
    const deleted = await deleteManifest(folderId, "to-delete.md");
    expect(deleted?.status).toBe("deleted");
    const all = await getManifest(folderId);
    const entry = all.find((m) => m.relPath === "to-delete.md");
    expect(entry?.status).toBe("deleted");
  });
});

describe("manifest-store — sync runs", () => {
  let folderId: string;

  beforeEach(async () => {
    const folder = await createFolder({ tenantId: TENANT, path: `/tmp/runs-${Date.now()}` });
    folderId = folder.id;
  });

  it("createSyncRun + finishSyncRun record stats correctly", async () => {
    const run = await createSyncRun(folderId, "scan");
    expect(run.status).toBe("running");
    expect(run.trigger).toBe("scan");
    expect(run.filesAdded).toBe(0);

    const finished = await finishSyncRun(
      run.id,
      "completed",
      { filesAdded: 2, filesUpdated: 3, filesDeleted: 1, filesFailed: 0 }
    );
    expect(finished?.status).toBe("completed");
    expect(finished?.filesAdded).toBe(2);
    expect(finished?.filesUpdated).toBe(3);
    expect(finished?.filesDeleted).toBe(1);
    expect(finished?.filesFailed).toBe(0);
    expect(finished?.finishedAt).toBeTruthy();
  });

  it("finishSyncRun records errorMessage on failure", async () => {
    const run = await createSyncRun(folderId, "event");
    const finished = await finishSyncRun(
      run.id,
      "failed",
      { filesAdded: 0, filesUpdated: 0, filesDeleted: 0, filesFailed: 1 },
      "boom"
    );
    expect(finished?.status).toBe("failed");
    expect(finished?.errorMessage).toBe("boom");
  });

  it("getLatestSyncRun returns the most recent run", async () => {
    const a = await createSyncRun(folderId, "manual");
    await finishSyncRun(a.id, "completed", { filesAdded: 0, filesUpdated: 0, filesDeleted: 0, filesFailed: 0 });
    // Brief pause so started_at differs deterministically.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await createSyncRun(folderId, "scan");
    await finishSyncRun(b.id, "completed", { filesAdded: 0, filesUpdated: 0, filesDeleted: 0, filesFailed: 0 });
    const latest = await getLatestSyncRun(folderId);
    expect(latest?.id).toBe(b.id);
  });

  it("listSyncRuns orders newest first and respects limit", async () => {
    for (let i = 0; i < 3; i += 1) {
      const run = await createSyncRun(folderId, "manual");
      await finishSyncRun(run.id, "completed", { filesAdded: 0, filesUpdated: 0, filesDeleted: 0, filesFailed: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const runs = await listSyncRuns(folderId, 2);
    const arr = Array.isArray(runs) ? runs : runs.runs;
    expect(arr.length).toBe(2);
  });
});