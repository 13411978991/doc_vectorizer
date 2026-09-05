/**
 * Integration tests for the Watched Folders API (Sprint 2).
 *
 * Uses fastify.inject() for in-process HTTP testing — no real socket, no
 * port collisions with other tests. Real Postgres for the persistence side.
 *
 * Tests cover the 10 endpoints:
 *   POST   /api/watched-folders
 *   GET    /api/watched-folders
 *   GET    /api/watched-folders/:id
 *   PATCH  /api/watched-folders/:id
 *   DELETE /api/watched-folders/:id
 *   POST   /api/watched-folders/:id/sync
 *   POST   /api/watched-folders/:id/pause
 *   POST   /api/watched-folders/:id/resume
 *   GET    /api/watched-folders/:id/runs
 *   GET    /api/watched-folders/:id/manifest
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildHttpServer } from "../server.js";
import { pool, closePool } from "../../db/pool.js";

const TENANT = `wf-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

describe("API — watched folders CRUD", () => {
  it("POST /api/watched-folders creates a folder and starts the watcher", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-create-"));
      try {
        const res = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: {
            path: dir,
            displayName: "My Folder",
            recursive: true,
            filetypeFilter: { blacklist: [".log"] },
            metadata: { source: "api-test" }
          }
        });
        expect(res.statusCode).toBe(201);
        const body = res.json();
        expect(body.folder).toBeTruthy();
        expect(body.folder.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.folder.path).toBe(dir);
        expect(body.folder.displayName).toBe("My Folder");
        expect(body.folder.enabled).toBe(true);
        expect(body.folder.recursive).toBe(true);
        expect(body.folder.filetypeFilter.blacklist).toEqual([".log"]);
        expect(body.folder.metadata.source).toBe("api-test");
        expect(body.folder.sourceId).toMatch(/^[0-9a-f-]{36}$/);
        expect(body.folder.watcherRunning).toBe(true);

        // Source was auto-created.
        const srcCheck = await pool.query("select id from sources where id = $1", [body.folder.sourceId]);
        expect(srcCheck.rowCount).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("POST /api/watched-folders returns 400 when the path does not exist", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/watched-folders",
        query: { tenantId: TENANT },
        payload: { path: "/tmp/does-not-exist-" + Date.now() }
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("FOLDER_PATH_NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("POST /api/watched-folders returns 400 when the path is a file, not a directory", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-file-"));
      try {
        const filePath = join(dir, "afile.txt");
        await writeFile(filePath, "x");
        const res = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: filePath }
        });
        expect(res.statusCode).toBe(400);
        const body = res.json();
        expect(body.error.code).toBe("FOLDER_PATH_NOT_DIRECTORY");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("POST /api/watched-folders returns 409 when the path is already registered", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-dup-"));
      try {
        const first = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir }
        });
        expect(first.statusCode).toBe(201);
        const second = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir }
        });
        expect(second.statusCode).toBe(409);
        const body = second.json();
        expect(body.error.code).toBe("FOLDER_PATH_ALREADY_EXISTS");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("GET /api/watched-folders lists folders with lastRunStats", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-list-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const list = await app.inject({
          method: "GET",
          url: "/api/watched-folders",
          query: { tenantId: TENANT }
        });
        expect(list.statusCode).toBe(200);
        const body = list.json();
        expect(body.folders).toHaveLength(1);
        expect(body.folders[0].id).toBe(folderId);
        expect(body.folders[0].lastRunStats).toBeDefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("GET /api/watched-folders/:id returns details and recent runs", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-detail-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const detail = await app.inject({
          method: "GET",
          url: `/api/watched-folders/${folderId}`,
          query: { tenantId: TENANT }
        });
        expect(detail.statusCode).toBe(200);
        const body = detail.json();
        expect(body.folder.id).toBe(folderId);
        expect(Array.isArray(body.recentRuns)).toBe(true);
        // The initial startup scan created at least one sync run.
        expect(body.recentRuns.length).toBeGreaterThanOrEqual(1);
        expect(body.recentRuns[0].trigger).toBe("startup");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("GET /api/watched-folders/:id returns 404 for unknown id", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/watched-folders/00000000-0000-0000-0000-000000000000",
        query: { tenantId: TENANT }
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe("FOLDER_NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("PATCH /api/watched-folders/:id updates displayName and metadata", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-patch-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const patched = await app.inject({
          method: "PATCH",
          url: `/api/watched-folders/${folderId}`,
          query: { tenantId: TENANT },
          payload: {
            displayName: "Renamed",
            metadata: { extra: "value" }
          }
        });
        expect(patched.statusCode).toBe(200);
        const body = patched.json();
        expect(body.folder.displayName).toBe("Renamed");
        expect(body.folder.metadata.extra).toBe("value");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("DELETE /api/watched-folders/:id stops the watcher and removes the row", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-del-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;
        const sourceId = created.json().folder.sourceId;

        const deleted = await app.inject({
          method: "DELETE",
          url: `/api/watched-folders/${folderId}`,
          query: { tenantId: TENANT }
        });
        expect(deleted.statusCode).toBe(200);
        expect(deleted.json().deleted).toBe(true);

        // Folder row and its source are both gone.
        const folderCheck = await pool.query("select id from watched_folders where id = $1", [folderId]);
        expect(folderCheck.rowCount).toBe(0);
        const sourceCheck = await pool.query("select id from sources where id = $1", [sourceId]);
        expect(sourceCheck.rowCount).toBe(0);

        // 404 on subsequent fetch.
        const after = await app.inject({
          method: "GET",
          url: `/api/watched-folders/${folderId}`,
          query: { tenantId: TENANT }
        });
        expect(after.statusCode).toBe(404);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });
});

describe("API — sync, pause, resume", () => {
  it("POST /api/watched-folders/:id/sync runs a manual sync and the document appears", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-sync-"));
      try {
        await writeFile(join(dir, "a.md"), "alpha content");
        await writeFile(join(dir, "b.md"), "beta content");
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const sync = await app.inject({
          method: "POST",
          url: `/api/watched-folders/${folderId}/sync`,
          query: { tenantId: TENANT }
        });
        expect(sync.statusCode).toBe(202);
        expect(sync.json().status).toBe("started");

        // Wait for the background sync to finish. Each sync can take a few
        // seconds because it goes through embedding, so we poll.
        const deadline = Date.now() + 60_000;
        let manifestCount = 0;
        while (Date.now() < deadline) {
          const m = await pool.query(
            "select last_event as status from watched_folder_manifests where folder_id = $1",
            [folderId]
          );
          manifestCount = m.rowCount ?? 0;
          if (manifestCount === 2) {
            const synced = m.rows.filter((r: { status: string }) => r.status === "synced").length;
            if (synced === 2) {
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(manifestCount).toBe(2);

        // The /manifest endpoint reflects the same.
        const manifest = await app.inject({
          method: "GET",
          url: `/api/watched-folders/${folderId}/manifest`,
          query: { tenantId: TENANT, status: "synced" }
        });
        expect(manifest.statusCode).toBe(200);
        const manifestBody = manifest.json();
        expect(manifestBody.manifest).toHaveLength(2);
        for (const entry of manifestBody.manifest) {
          expect(entry.status).toBe("synced");
          expect(entry.documentId).toMatch(/^[0-9a-f-]{36}$/);
        }

        // And /runs has the manual trigger.
        const runs = await app.inject({
          method: "GET",
          url: `/api/watched-folders/${folderId}/runs`,
          query: { tenantId: TENANT }
        });
        expect(runs.statusCode).toBe(200);
        const triggers = runs.json().runs.map((r: { trigger: string }) => r.trigger);
        expect(triggers).toContain("manual");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  }, 90_000);

  it("POST /sync returns 409 when a sync is already running", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-sync409-"));
      try {
        // A bunch of files so the sync takes long enough to race.
        for (let i = 0; i < 10; i += 1) {
          await writeFile(join(dir, `f${i}.md`), `content ${i}\n`.repeat(200));
        }
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const first = await app.inject({
          method: "POST",
          url: `/api/watched-folders/${folderId}/sync`,
          query: { tenantId: TENANT }
        });
        expect(first.statusCode).toBe(202);

        const second = await app.inject({
          method: "POST",
          url: `/api/watched-folders/${folderId}/sync`,
          query: { tenantId: TENANT }
        });
        expect(second.statusCode).toBe(409);
        const body = second.json();
        expect(body.error.code).toBe("SYNC_ALREADY_RUNNING");

        // Wait for the first sync to finish before tearing down.
        await waitForSyncToFinish(folderId);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  }, 90_000);

  it("POST /pause + /resume toggles the watcher", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-pause-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;
        expect(created.json().folder.watcherRunning).toBe(true);

        const paused = await app.inject({
          method: "POST",
          url: `/api/watched-folders/${folderId}/pause`,
          query: { tenantId: TENANT }
        });
        expect(paused.statusCode).toBe(200);
        expect(paused.json().folder.enabled).toBe(false);
        expect(paused.json().folder.watcherRunning).toBe(false);

        const resumed = await app.inject({
          method: "POST",
          url: `/api/watched-folders/${folderId}/resume`,
          query: { tenantId: TENANT }
        });
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json().folder.enabled).toBe(true);
        expect(resumed.json().folder.watcherRunning).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });

  it("PATCH with enabled=false stops the watcher", async () => {
    const app = await buildApp();
    try {
      const dir = await mkdtemp(join(tmpdir(), "wf-api-disable-"));
      try {
        const created = await app.inject({
          method: "POST",
          url: "/api/watched-folders",
          query: { tenantId: TENANT },
          payload: { path: dir, metadata: { skipExtraction: true } }
        });
        const folderId = created.json().folder.id;

        const patched = await app.inject({
          method: "PATCH",
          url: `/api/watched-folders/${folderId}`,
          query: { tenantId: TENANT },
          payload: { enabled: false }
        });
        expect(patched.statusCode).toBe(200);
        expect(patched.json().folder.enabled).toBe(false);
        expect(patched.json().folder.watcherRunning).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await app.close();
    }
  });
});

async function buildApp() {
  const app = buildHttpServer();
  await app.ready();
  return app;
}

async function waitForSyncToFinish(folderId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await pool.query(
      "select 1 from watched_folder_runs where folder_id = $1 and status = 'running' limit 1",
      [folderId]
    );
    if ((r.rowCount ?? 0) === 0) {
      return;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}