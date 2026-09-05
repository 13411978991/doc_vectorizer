/**
 * Integration tests for the KB Projects API (Sprint 6 — cached counts).
 *
 * Focus: the cached_documents_count / cached_chunks_count / cached_entities_count
 * fields populated by `aggregateAndCacheKbProjectCounts` after a folder source
 * is added/removed. Documents/chunks/entities are seeded directly via SQL
 * (skipping the watcher pipeline) so the assertions stay focused on the
 * aggregation contract, not on file ingestion.
 *
 * Pattern mirrors watched-folders.test.ts: fastify.inject() + real Postgres.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildHttpServer } from "../server.js";
import { pool, closePool } from "../../db/pool.js";
import { createFolder } from "../../watcher/manifest-store.js";
import { createSource } from "../../db/repositories.js";
import { getProjectStats } from "../../db/repositories.js";
import { aggregateAndCacheKbProjectCounts, createUploadSource } from "../kb-projects.js";

const TENANT = `kb-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function cleanup(): Promise<void> {
  await pool.query("delete from kb_projects where tenant_id = $1", [TENANT]);
  await pool.query("delete from sources where tenant_id = $1", [TENANT]);
  await pool.query("delete from watched_folders where tenant_id = $1", [TENANT]);
  // documents/chunks/entities cascade from sources.
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closePool();
});

async function buildApp() {
  const app = buildHttpServer();
  // server.ts already calls registerKbProjectRoutes(app) — no need to re-register.
  await app.ready();
  return app;
}

async function seedWatchedFolderWithDocuments(
  suffix: string,
  docCount: number
): Promise<{ folderId: string; sourceId: string }> {
  const source = await createSource({
    tenantId: TENANT,
    name: `src-${suffix}`,
    metadata: { test: true }
  });
  const folder = await createFolder({
    tenantId: TENANT,
    path: `/tmp/kb-test-${suffix}`,
    displayName: `kb-folder-${suffix}`,
    recursive: true,
    filetypeFilter: {},
    metadata: { test: true, skipExtraction: true },
    enabled: true
  });
  // Overwrite the folder's auto-created source with our pre-seeded source so
  // documents inserted against that source are visible to the folder.
  await pool.query("update watched_folders set source_id = $1 where id = $2", [source.id, folder.id]);
  // Seed one entity_type per source (entities has a FK to entity_types).
  const entityTypeId = randomUUID();
  await pool.query(
    `insert into entity_types (id, source_id, scope, type, name)
     values ($1, $2, 'global', 'concept', 'concept-type')`,
    [entityTypeId, source.id]
  );
  for (let i = 0; i < docCount; i++) {
    const docId = randomUUID();
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values ($1, $2, $3, $4, 'SUCCESS')`,
      [docId, source.id, `doc-${suffix}-${i}`, `content-${i}`,]
    );
    await pool.query(
      `insert into chunks (id, source_id, document_id, content, rank)
       values ($1, $2, $3, $4, 0)`,
      [randomUUID(), source.id, docId, `chunk-${i}`]
    );
    await pool.query(
      `insert into entities (id, source_id, entity_type_id, type, name, normalized_name)
       values ($1, $2, $3, 'concept', $4, $4)`,
      [randomUUID(), source.id, entityTypeId, `entity-${i}`]
    );
  }
  return { folderId: folder.id, sourceId: source.id };
}

describe("aggregateAndCacheKbProjectCounts", () => {
  it("returns 0/0/0 when project has no folder sources", async () => {
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "empty"]
    );
    const counts = await aggregateAndCacheKbProjectCounts(proj.rows[0].id, TENANT);
    expect(counts).toEqual({
      documents: 0, chunks: 0, entities: 0,
      uploadDocuments: 0, uploadChunks: 0, uploadEntities: 0
    });
  });

  it("aggregates counts across all folder sources", async () => {
    const a = await seedWatchedFolderWithDocuments("a", 3);
    const b = await seedWatchedFolderWithDocuments("b", 2);
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "agg"]
    );
    const projectId = proj.rows[0].id as string;
    for (const f of [a, b]) {
      await pool.query(
        `insert into kb_sources (kb_project_id, source_type, name, watched_folder_id, enabled)
         values ($1, 'folder', 'src', $2, true)`,
        [projectId, f.folderId]
      );
    }
    const counts = await aggregateAndCacheKbProjectCounts(projectId, TENANT);
    expect(counts.documents).toBe(5);
    expect(counts.chunks).toBe(5);
    expect(counts.entities).toBe(5);

    const row = await pool.query(
      `select cached_documents_count, cached_chunks_count, cached_entities_count
       from kb_projects where id = $1`,
      [projectId]
    );
    expect(parseInt(row.rows[0].cached_documents_count, 10)).toBe(5);
    expect(row.rows[0].cached_updated_at).not.toBeNull();
  });

  it("respects tenant_id (does not leak counts across tenants)", async () => {
    const { folderId } = await seedWatchedFolderWithDocuments("iso", 4);
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "iso"]
    );
    const projectId = proj.rows[0].id as string;
    await pool.query(
      `insert into kb_sources (kb_project_id, source_type, name, watched_folder_id, enabled)
       values ($1, 'folder', 'src', $2, true)`,
      [projectId, folderId]
    );
    const wrongTenant = `${TENANT}-other`;
    const counts = await aggregateAndCacheKbProjectCounts(projectId, wrongTenant);
    expect(counts.documents).toBe(0);
  });

  it("skips disabled sources", async () => {
    const { folderId } = await seedWatchedFolderWithDocuments("dis", 3);
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "dis"]
    );
    const projectId = proj.rows[0].id as string;
    await pool.query(
      `insert into kb_sources (kb_project_id, source_type, name, watched_folder_id, enabled)
       values ($1, 'folder', 'src', $2, false)`,
      [projectId, folderId]
    );
    const counts = await aggregateAndCacheKbProjectCounts(projectId, TENANT);
    expect(counts.documents).toBe(0);
  });
});

describe("API — KB project cached counts on source add/remove", () => {
  it("POST /sources triggers a background refresh of cached_*", async () => {
    const { folderId } = await seedWatchedFolderWithDocuments("post", 7);
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/kb-projects",
        query: { tenantId: TENANT },
        payload: { name: "post" }
      });
      const projectId = create.json().project.id as string;

      const add = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/sources`,
        query: { tenantId: TENANT },
        payload: {
          source_type: "folder",
          name: "src",
          watched_folder_id: folderId
        }
      });
      expect(add.statusCode).toBe(200);

      // Background refresh is fire-and-forget; wait briefly for it to land.
      await new Promise((r) => setTimeout(r, 200));

      const list = await app.inject({
        method: "GET",
        url: "/api/kb-projects",
        query: { tenantId: TENANT }
      });
      const proj = list.json().projects.find((p: { id: string }) => p.id === projectId);
      expect(proj.cachedDocumentsCount).toBe(7);
      expect(proj.cachedChunksCount).toBe(7);
      expect(proj.cachedEntitiesCount).toBe(7);
    } finally {
      await app.close();
    }
  });

  it("DELETE /sources/:sourceId refreshes cached counts", async () => {
    const { folderId } = await seedWatchedFolderWithDocuments("del", 5);
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "del"]
    );
    const projectId = proj.rows[0].id as string;
    const source = await pool.query(
      `insert into kb_sources (kb_project_id, source_type, name, watched_folder_id, enabled)
       values ($1, 'folder', 'src', $2, true) returning id`,
      [projectId, folderId]
    );
    // Pre-warm cache.
    await aggregateAndCacheKbProjectCounts(projectId, TENANT);

    const app = await buildApp();
    try {
      const del = await app.inject({
        method: "DELETE",
        url: `/api/kb-projects/${projectId}/sources/${source.rows[0].id}`,
        query: { tenantId: TENANT }
      });
      expect(del.statusCode).toBe(200);

      await new Promise((r) => setTimeout(r, 200));

      const after = await pool.query(
        `select cached_documents_count from kb_projects where id = $1`,
        [projectId]
      );
      expect(parseInt(after.rows[0].cached_documents_count, 10)).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("createUploadSource", () => {
  it("creates a fresh, independent source per call", async () => {
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "upload-source-1"]
    );
    const projectId = proj.rows[0].id as string;

    const first = await createUploadSource(projectId, TENANT);
    const second = await createUploadSource(projectId, TENANT);

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
    // Each call produces a distinct source so uploads don't share storage.
    expect(first.id).not.toBe(second.id);

    const names = await pool.query(
      `select name, tenant_id from sources where id = any($1::uuid[])`,
      [[first.id, second.id]]
    );
    expect(names.rows.length).toBe(2);
    for (const row of names.rows) {
      expect(row.name.startsWith(`kb-upload-${projectId}-`)).toBe(true);
      expect(row.tenant_id).toBe(TENANT);
    }
  });

  it("aggregates upload documents into cached_upload_* independently of folder counts", async () => {
    const folder = await seedWatchedFolderWithDocuments("upload-iso", 2);
    const proj = await pool.query(
      `insert into kb_projects (tenant_id, name) values ($1, $2) returning id`,
      [TENANT, "upload-iso"]
    );
    const projectId = proj.rows[0].id as string;
    await pool.query(
      `insert into kb_sources (kb_project_id, source_type, name, watched_folder_id, enabled)
       values ($1, 'folder', 'src', $2, true)`,
      [projectId, folder.folderId]
    );

    // Create an independent upload source for this KB project.
    const { id: uploadSourceId } = await createUploadSource(projectId, TENANT);

    // Add 3 documents into the upload source.
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `insert into documents (id, source_id, title, content, parse_status)
         values ($1, $2, $3, $4, 'SUCCESS')`,
        [randomUUID(), uploadSourceId, `up-doc-${i}`, `up-${i}`]
      );
    }
    // Insert a kb_sources row of type=upload so the aggregate SQL joins
    // upload_sources to source_id via the kb_sources row's upload_id.
    await pool.query(
      `insert into kb_sources (kb_project_id, source_type, name, upload_id, enabled)
       values ($1, 'upload', 'bundle.md', $2, true)`,
      [projectId, uploadSourceId]
    );

    const counts = await aggregateAndCacheKbProjectCounts(projectId, TENANT);
    expect(counts.documents).toBe(2);
    expect(counts.uploadDocuments).toBe(3);

    const row = await pool.query(
      `select cached_documents_count, cached_upload_documents_count from kb_projects where id = $1`,
      [projectId]
    );
    expect(parseInt(row.rows[0].cached_documents_count, 10)).toBe(2);
    expect(parseInt(row.rows[0].cached_upload_documents_count, 10)).toBe(3);
  });
});

describe("POST /api/kb-projects/:id/ensure-upload-source", () => {
  it("creates a fresh upload source per call (independent per upload)", async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/kb-projects",
        query: { tenantId: TENANT },
        payload: { name: "ensure-test" }
      });
      const projectId = create.json().project.id as string;

      const r1 = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/ensure-upload-source`,
        query: { tenantId: TENANT }
      });
      expect(r1.statusCode).toBe(200);
      const body1 = r1.json();
      expect(body1.sourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body1.isNew).toBe(true);

      const r2 = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/ensure-upload-source`,
        query: { tenantId: TENANT }
      });
      const body2 = r2.json();
      // Each upload gets its own source so the delete button can target
      // a single file without disturbing other uploads on the same KB
      // project.
      expect(body2.sourceId).not.toBe(body1.sourceId);
      expect(body2.isNew).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown kb project id", async () => {
    const app = await buildApp();
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/kb-projects/00000000-0000-0000-0000-000000000000/ensure-upload-source",
        query: { tenantId: TENANT }
      });
      expect(r.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("POST /api/kb-projects/:id/sources with upload metadata", () => {
  it("stores file_name + file_size for upload-type sources", async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/kb-projects",
        query: { tenantId: TENANT },
        payload: { name: "upload-meta" }
      });
      const projectId = create.json().project.id as string;

      const { id: uploadSourceId } = await createUploadSource(projectId, TENANT);
      const docId = randomUUID();
      await pool.query(
        `insert into documents (id, source_id, title, content, parse_status)
         values ($1, $2, 'price-report', 'content', 'SUCCESS')`,
        [docId, uploadSourceId]
      );

      const add = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/sources`,
        query: { tenantId: TENANT },
        payload: {
          source_type: "upload",
          name: "价格分析报告.md",
          upload_id: uploadSourceId,
          file_name: "价格分析报告.md",
          file_size: 12345,
          file_extension: ".md"
        }
      });
      expect(add.statusCode).toBe(200);
      const source = add.json().source;
      expect(source.fileName).toBe("价格分析报告.md");
      expect(source.fileSize).toBe(12345);
      expect(source.fileExtension).toBe(".md");
    } finally {
      await app.close();
    }
  });
});

describe("DELETE /api/kb-projects/:id/sources/:sourceId cascade for upload", () => {
  it("removes the underlying documents when an upload-type source is deleted", async () => {
    const app = await buildApp();
    try {
      const create = await app.inject({
        method: "POST",
        url: "/api/kb-projects",
        query: { tenantId: TENANT },
        payload: { name: "upload-cleanup" }
      });
      const projectId = create.json().project.id as string;

      const { id: uploadSourceId } = await createUploadSource(projectId, TENANT);
      // Insert 2 documents into the upload source.
      const docIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const id = randomUUID();
        docIds.push(id);
        await pool.query(
          `insert into documents (id, source_id, title, content, parse_status)
           values ($1, $2, $3, 'content', 'SUCCESS')`,
          [id, uploadSourceId, `up-doc-${i}`]
        );
      }

      const add = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/sources`,
        query: { tenantId: TENANT },
        payload: {
          source_type: "upload",
          name: "bundle.md",
          upload_id: uploadSourceId,
          file_name: "bundle.md",
          file_size: 999,
          file_extension: ".md"
        }
      });
      const kbSourceId = add.json().source.id as string;

      // Sanity: both documents are present.
      const before = await pool.query(
        `select count(*) as c from documents where source_id = $1`,
        [uploadSourceId]
      );
      expect(parseInt(before.rows[0].c, 10)).toBe(2);

      const del = await app.inject({
        method: "DELETE",
        url: `/api/kb-projects/${projectId}/sources/${kbSourceId}`,
        query: { tenantId: TENANT }
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toBe(true);
      expect(del.json().documentsDeleted).toBe(2);

      const after = await pool.query(
        `select count(*) as c from documents where source_id = $1`,
        [uploadSourceId]
      );
      expect(parseInt(after.rows[0].c, 10)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("does NOT touch documents when a folder-type source is deleted", async () => {
    const app = await buildApp();
    try {
      const folder = await seedWatchedFolderWithDocuments("cascade-skip", 3);
      const create = await app.inject({
        method: "POST",
        url: "/api/kb-projects",
        query: { tenantId: TENANT },
        payload: { name: "cascade-skip" }
      });
      const projectId = create.json().project.id as string;

      const add = await app.inject({
        method: "POST",
        url: `/api/kb-projects/${projectId}/sources`,
        query: { tenantId: TENANT },
        payload: {
          source_type: "folder",
          name: "src",
          watched_folder_id: folder.folderId
        }
      });
      const kbSourceId = add.json().source.id as string;

      const before = await pool.query(
        `select count(*) as c from documents where source_id = $1`,
        [folder.sourceId]
      );
      const beforeCount = parseInt(before.rows[0].c, 10);

      const del = await app.inject({
        method: "DELETE",
        url: `/api/kb-projects/${projectId}/sources/${kbSourceId}`,
        query: { tenantId: TENANT }
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toBe(true);
      expect(del.json().documentsDeleted).toBe(0);

      const after = await pool.query(
        `select count(*) as c from documents where source_id = $1`,
        [folder.sourceId]
      );
      expect(parseInt(after.rows[0].c, 10)).toBe(beforeCount);
    } finally {
      await app.close();
    }
  });
});
describe("getProjectStats — total across all linked sources (Sprint 13)", () => {
  // Sprint 13: getProjectStats now counts documents/chunks/events/entities
  // across the audit project source AND every source attached to its linked
  // KB project (watched folders + uploaded files). Before Sprint 13, the
  // function only counted the audit project's own source, which is typically
  // empty or near-empty, leaving the top-of-overview 4-cell row out of sync
  // with the Watched Folders / Uploaded Files cards.
  it("returns 0/0/0/0 when the project has no KB project attached", async () => {
    const source = await createSource({
      tenantId: TENANT,
      name: "solo-project",
      metadata: { test: true }
    });
    const stats = await getProjectStats({ sourceId: source.id, tenantId: TENANT });
    expect(stats).toEqual({
      documentCount: 0,
      chunkCount: 0,
      eventCount: 0,
      entityCount: 0
    });
  });

  it("sums direct + folder + upload sources via the linked KB project", async () => {
    // Set up three sources with the same lifecycle the user would create
    // in the wizard:
    //   1. audit project source (direct uploads land here)
    //   2. watched folder source (sync pipeline creates docs here)
    //   3. upload source (per-file source after Sprint 11)
    // Then verify getProjectStats returns the SUM across all three.

    // 1. Direct: 1 doc, 1 chunk, 1 event, 1 entity on the audit project source.
    const direct = await createSource({
      tenantId: TENANT,
      name: "totals-project",
      metadata: { test: true }
    });
    const directDoc = randomUUID();
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values ($1, $2, 'direct-doc', 'content', 'SUCCESS')`,
      [directDoc, direct.id]
    );
    await pool.query(
      `insert into chunks (id, source_id, document_id, content, rank)
       values ($1, $2, $3, 'direct-chunk', 0)`,
      [randomUUID(), direct.id, directDoc]
    );
    const directEt = randomUUID();
    await pool.query(
      `insert into entity_types (id, source_id, scope, type, name)
       values ($1, $2, 'global', 'concept', 'concept-type')`,
      [directEt, direct.id]
    );
    const directEvent = randomUUID();
    await pool.query(
      `insert into events (id, source_id, document_id, source_type, title, category, status, content)
       values ($1, $2, $3, 'document', 'direct-event-title', 'fact', 'CONFIRMED', 'direct-event')`,
      [directEvent, direct.id, directDoc]
    );
    await pool.query(
      `insert into entities (id, source_id, entity_type_id, type, name, normalized_name)
       values ($1, $2, $3, 'concept', 'direct-entity', 'direct-entity')`,
      [randomUUID(), direct.id, directEt]
    );

    // 2. Folder: 2 docs, 2 chunks, 2 events, 2 entities on a watched folder.
    const folderSeed = await seedWatchedFolderWithDocuments("totals-folder", 2);

    // 3. Upload: 1 doc on a per-file source.
    const upload = await createSource({
      tenantId: TENANT,
      name: "totals-upload-src",
      metadata: { test: true }
    });
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values ($1, $2, 'up-doc', 'content', 'SUCCESS')`,
      [randomUUID(), upload.id]
    );

    // Create the KB project that links them (same name as the audit project).
    const create = await (
      await buildApp()
    ).inject({
      method: "POST",
      url: "/api/kb-projects",
      query: { tenantId: TENANT },
      payload: { name: "totals-project" }
    });
    const projectId = create.json().project.id as string;

    // Attach the folder source to the KB project.
    const addFolder = await (
      await buildApp()
    ).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "folder",
        name: "totals-folder",
        watched_folder_id: folderSeed.folderId
      }
    });
    expect(addFolder.statusCode).toBe(200);

    // Attach the upload source to the KB project.
    const addUpload = await (
      await buildApp()
    ).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "upload",
        name: "totals-upload.md",
        upload_id: upload.id,
        file_name: "totals-upload.md",
        file_size: 42,
        file_extension: ".md"
      }
    });
    expect(addUpload.statusCode).toBe(200);

    // Now: getProjectStats should return the sum across all three sources.
    //   direct:  1 doc / 1 chunk / 1 event / 1 entity
    //   folder:  2 docs / 2 chunks / 0 events / 2 entities (seed has no events)
    //   upload:  1 doc / 0 chunks / 0 events / 0 entities
    //   total:   4 docs / 3 chunks / 1 event / 3 entities
    const stats = await getProjectStats({ sourceId: direct.id, tenantId: TENANT });
    expect(stats.documentCount).toBe(4);
    expect(stats.chunkCount).toBe(3);
    expect(stats.eventCount).toBe(1);
    expect(stats.entityCount).toBe(3);
  });

  it("returns 0/0/0/0 when the KB project has sources attached but they're empty", async () => {
    const direct = await createSource({
      tenantId: TENANT,
      name: "empty-totals",
      metadata: { test: true }
    });
    const folderSeed = await seedWatchedFolderWithDocuments("empty-totals", 0);
    // Create KB project + attach empty folder source.
    const create = await (
      await buildApp()
    ).inject({
      method: "POST",
      url: "/api/kb-projects",
      query: { tenantId: TENANT },
      payload: { name: "empty-totals" }
    });
    const projectId = create.json().project.id as string;
    await (
      await buildApp()
    ).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "folder",
        name: "empty-folder",
        watched_folder_id: folderSeed.folderId
      }
    });
    const stats = await getProjectStats({ sourceId: direct.id, tenantId: TENANT });
    expect(stats).toEqual({
      documentCount: 0,
      chunkCount: 0,
      eventCount: 0,
      entityCount: 0
    });
  });
});

describe("listDocumentsBySource — total across linked sources (Sprint 13)", () => {
  // Sprint 13+ follow-up: the Documents tab on the project overview was
  // still showing only direct uploads. Same root cause as the top 4-cell
  // row: listDocumentsBySource used `d.source_id = $1` instead of joining
  // through the linked KB project. Now the documents list shows the same
  // 32 docs the overview counts, each row tagged with its sourceName.

  it("returns 0 documents when the project has no KB project attached", async () => {
    const source = await createSource({
      tenantId: TENANT,
      name: "lonely-doc-project",
      metadata: { test: true }
    });
    const { listDocumentsBySource } = await import("../../db/repositories.js");
    const docs = await listDocumentsBySource({
      sourceId: source.id,
      tenantId: TENANT,
      limit: 100
    });
    expect(docs).toEqual([]);
  });

  it("returns docs from direct + folder + upload sources, each tagged with sourceName", async () => {
    const direct = await createSource({
      tenantId: TENANT,
      name: "doc-totals-project",
      metadata: { test: true }
    });
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values (gen_random_uuid(), $1, 'direct-doc', 'c', 'SUCCESS')`,
      [direct.id]
    );

    const folderSeed = await seedWatchedFolderWithDocuments("doc-totals", 2);
    // Rename the source so we can assert sourceName = the new source name.
    // (The watched_folders.display_name is the folder label, not the source
    // name — listDocumentsBySource returns sources.name.)
    await pool.query(
      `update sources set name = $1 where id = $2`,
      [`folder-source-name`, folderSeed.sourceId]
    );

    const upload = await createSource({
      tenantId: TENANT,
      name: "doc-totals-upload-src",
      metadata: { test: true }
    });
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values (gen_random_uuid(), $1, 'up-doc', 'c', 'SUCCESS')`,
      [upload.id]
    );

    // Create the KB project + link folder + link upload.
    const create = await (await buildApp()).inject({
      method: "POST",
      url: "/api/kb-projects",
      query: { tenantId: TENANT },
      payload: { name: "doc-totals-project" }
    });
    const projectId = create.json().project.id as string;
    await (await buildApp()).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "folder",
        name: "doc-totals-folder",
        watched_folder_id: folderSeed.folderId
      }
    });
    await (await buildApp()).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "upload",
        name: "doc-totals-upload.md",
        upload_id: upload.id,
        file_name: "doc-totals-upload.md",
        file_size: 42,
        file_extension: ".md"
      }
    });

    const { listDocumentsBySource } = await import("../../db/repositories.js");
    const page = await listDocumentsBySource({
      sourceId: direct.id,
      tenantId: TENANT,
      limit: 100
    });
    const docs = page.documents;
    expect(docs.length).toBe(4); // 1 direct + 2 folder + 1 upload

    // Each doc should have a sourceName matching its source.
    const byTitle = new Map(docs.map((d) => [d.title, d]));
    expect(byTitle.get("direct-doc")?.sourceName).toBe("doc-totals-project");
    expect(byTitle.get("doc-doc-totals-0")?.sourceName).toBe("folder-source-name");
    expect(byTitle.get("doc-doc-totals-1")?.sourceName).toBe("folder-source-name");
    expect(byTitle.get("up-doc")?.sourceName).toBe("doc-totals-upload-src");
  });
});

describe("getProjectGraph — total across linked sources (Sprint 15)", () => {
  // Sprint 15: the Graph tab on the project overview was using
  // `ent.source_id = $1` which only counts entities from the audit
  // project's own source. Now it unions in the linked KB sources, so
  // the user sees the full knowledge graph for the project.

  it("returns an empty graph when the project has no KB project attached", async () => {
    const source = await createSource({
      tenantId: TENANT,
      name: "lonely-graph-project",
      metadata: { test: true }
    });
    const { getProjectGraph } = await import("../../db/repositories.js");
    const graph = await getProjectGraph({ sourceId: source.id, tenantId: TENANT });
    expect(graph).toEqual({ entities: [], events: [], edges: [] });
  });

  it("returns entities + events + edges from direct + folder + upload sources", async () => {
    // Set up three sources with the same shape as the user-facing flow.
    const direct = await createSource({
      tenantId: TENANT,
      name: "graph-totals-project",
      metadata: { test: true }
    });

    // 1. Direct: 1 doc / 1 event with 1 entity.
    const directDoc = randomUUID();
    const directEt = randomUUID();
    await pool.query(
      `insert into entity_types (id, source_id, scope, type, name)
       values ($1, $2, 'global', 'concept', 'concept-type')`,
      [directEt, direct.id]
    );
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values ($1, $2, 'direct-doc', 'c', 'SUCCESS')`,
      [directDoc, direct.id]
    );
    const directEvent = randomUUID();
    await pool.query(
      `insert into events (id, source_id, document_id, source_type, title, category, status, content)
       values ($1, $2, $3, 'document', 'direct-event', 'fact', 'CONFIRMED', 'e')`,
      [directEvent, direct.id, directDoc]
    );
    const directEntity = randomUUID();
    await pool.query(
      `insert into entities (id, source_id, entity_type_id, type, name, normalized_name)
       values ($1, $2, $3, 'concept', 'direct-entity', 'direct-entity')`,
      [directEntity, direct.id, directEt]
    );
    await pool.query(
      `insert into event_entities (id, event_id, entity_id) values (gen_random_uuid(), $1, $2)`,
      [directEvent, directEntity]
    );

    // 2. Folder: 1 doc / 1 event with 1 entity.
    const folderSource = await createSource({
      tenantId: TENANT,
      name: "graph-folder-source",
      metadata: { test: true }
    });
    const folderEt = randomUUID();
    await pool.query(
      `insert into entity_types (id, source_id, scope, type, name)
       values ($1, $2, 'global', 'concept', 'concept-type')`,
      [folderEt, folderSource.id]
    );
    const folderDoc = randomUUID();
    await pool.query(
      `insert into documents (id, source_id, title, content, parse_status)
       values ($1, $2, 'folder-doc', 'c', 'SUCCESS')`,
      [folderDoc, folderSource.id]
    );
    const folderEvent = randomUUID();
    await pool.query(
      `insert into events (id, source_id, document_id, source_type, title, category, status, content)
       values ($1, $2, $3, 'document', 'folder-event', 'fact', 'CONFIRMED', 'e')`,
      [folderEvent, folderSource.id, folderDoc]
    );
    const folderEntity = randomUUID();
    await pool.query(
      `insert into entities (id, source_id, entity_type_id, type, name, normalized_name)
       values ($1, $2, $3, 'concept', 'folder-entity', 'folder-entity')`,
      [folderEntity, folderSource.id, folderEt]
    );
    await pool.query(
      `insert into event_entities (id, event_id, entity_id) values (gen_random_uuid(), $1, $2)`,
      [folderEvent, folderEntity]
    );

    // 3. Create a watched folder that points to folderSource.
    const folder = await createFolder({
      tenantId: TENANT,
      path: `/tmp/graph-folder-${randomUUID()}`,
      displayName: `graph-folder-display`,
      recursive: true,
      filetypeFilter: {},
      metadata: { test: true, skipExtraction: true },
      enabled: true
    });
    await pool.query(
      `update watched_folders set source_id = $1 where id = $2`,
      [folderSource.id, folder.id]
    );

    // 4. Create the KB project + link folder.
    const create = await (await buildApp()).inject({
      method: "POST",
      url: "/api/kb-projects",
      query: { tenantId: TENANT },
      payload: { name: "graph-totals-project" }
    });
    const projectId = create.json().project.id as string;
    await (await buildApp()).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "folder",
        name: "graph-folder",
        watched_folder_id: folder.id
      }
    });

    const { getProjectGraph } = await import("../../db/repositories.js");
    const graph = await getProjectGraph({ sourceId: direct.id, tenantId: TENANT });

    // Direct entity + folder entity = 2 entities.
    expect(graph.entities.length).toBe(2);
    // Direct event + folder event = 2 events.
    expect(graph.events.length).toBe(2);
    // Each event has 1 entity → 2 edges.
    expect(graph.edges.length).toBe(2);

    const entityNames = graph.entities.map((e) => e.name).sort();
    expect(entityNames).toEqual(["direct-entity", "folder-entity"]);
  });
});

describe("getLinkedSourceIds (Sprint 15)", () => {
  // Helper used by the MCP sessions route. Without a KB project, returns
  // just the audit project's source. With a KB project, returns the
  // union of project + folder + upload sources.
  it("returns just the project source when no KB project is attached", async () => {
    const source = await createSource({
      tenantId: TENANT,
      name: "no-kb-source",
      metadata: { test: true }
    });
    const { getLinkedSourceIds } = await import("../../db/repositories.js");
    const ids = await getLinkedSourceIds({ sourceId: source.id, tenantId: TENANT });
    expect(ids).toEqual([source.id]);
  });

  it("returns project + folder + upload sources when KB project is attached", async () => {
    const direct = await createSource({
      tenantId: TENANT,
      name: "linked-totals-project",
      metadata: { test: true }
    });
    const folderSeed = await seedWatchedFolderWithDocuments("linked-totals", 1);
    const upload = await createSource({
      tenantId: TENANT,
      name: "linked-totals-upload-src",
      metadata: { test: true }
    });

    const create = await (await buildApp()).inject({
      method: "POST",
      url: "/api/kb-projects",
      query: { tenantId: TENANT },
      payload: { name: "linked-totals-project" }
    });
    const projectId = create.json().project.id as string;
    await (await buildApp()).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "folder",
        name: "linked-folder",
        watched_folder_id: folderSeed.folderId
      }
    });
    await (await buildApp()).inject({
      method: "POST",
      url: `/api/kb-projects/${projectId}/sources`,
      query: { tenantId: TENANT },
      payload: {
        source_type: "upload",
        name: "linked.md",
        upload_id: upload.id,
        file_name: "linked.md",
        file_size: 10,
        file_extension: ".md"
      }
    });

    const { getLinkedSourceIds } = await import("../../db/repositories.js");
    const ids = await getLinkedSourceIds({ sourceId: direct.id, tenantId: TENANT });
    expect(ids.sort()).toEqual([direct.id, folderSeed.sourceId, upload.id].sort());
  });
});
