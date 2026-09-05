/**
 * KB Projects API — 知识库管理
 *
 * CRUD for kb_projects and kb_sources. Sources can be either watched_folder
 * (type=folder) or direct upload (type=upload). Multi-tenant via ?tenantId.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../db/pool.js";
import { logger } from "../observability/logger.js";
import { createSource, getSource } from "../db/repositories.js";

/**
 * Recompute and persist cached documents/chunks/entities counts for a KB
 * project. Folder-typed sources aggregate through watched_folders.source_id,
 * upload-typed sources go through their own dedicated source (auto-created
 * per KB project via getOrCreateUploadSource). Used by the add/remove source
 * handlers to keep the dashboard's document counts in sync.
 *
 * Notes:
 *  - Folder counts: documents/chunks/entities live in watched_folders.source_id.
 *  - Upload counts: documents/chunks/entities live in the KB project's
 *    dedicated upload source (named `kb-{kbProjectId}-uploads`).
 *  - Fire-and-forget safe: callers should not await this on the request path.
 *  - Multi-tenant safe: matches tenant_id on watched_folders + kb_projects.
 */
export async function aggregateAndCacheKbProjectCounts(
  kbProjectId: string,
  tenantId: string
): Promise<{
  documents: number;
  chunks: number;
  entities: number;
  uploadDocuments: number;
  uploadChunks: number;
  uploadEntities: number;
}> {
  // Counts split by source type. The kb_sources → watched_folders → source_id
  // path is covered by the existing unique + btree indexes; the upload side
  // resolves the per-project source via the stable name convention.
  const result = await pool.query<{
    folder_documents_count: string;
    folder_chunks_count: string;
    folder_entities_count: string;
    upload_documents_count: string;
    upload_chunks_count: string;
    upload_entities_count: string;
  }>(
    `with kb_folders as (
       select f.source_id
       from kb_sources s
       join watched_folders f on f.id = s.watched_folder_id
       where s.kb_project_id = $1
         and s.source_type = 'folder'
         and s.enabled = 1
         and f.tenant_id = $2
     ),
     upload_sources as (
       select s.upload_id as id
       from kb_sources s
       join kb_projects p on p.id = s.kb_project_id
       where s.kb_project_id = $1
         and s.source_type = 'upload'
         and s.upload_id is not null
         and p.tenant_id = $2
     )
     select
       (select count(*) from documents d where d.source_id in (select source_id from kb_folders)) as folder_documents_count,
       (select count(*) from chunks c where c.source_id in (select source_id from kb_folders)) as folder_chunks_count,
       (select count(*) from entities e where e.source_id in (select source_id from kb_folders)) as folder_entities_count,
       (select count(*) from documents d where d.source_id in (select id from upload_sources)) as upload_documents_count,
       (select count(*) from chunks c where c.source_id in (select id from upload_sources)) as upload_chunks_count,
       (select count(*) from entities e where e.source_id in (select id from upload_sources)) as upload_entities_count`,
    [kbProjectId, tenantId]
  );
  const row = result.rows[0] ?? {
    folder_documents_count: "0",
    folder_chunks_count: "0",
    folder_entities_count: "0",
    upload_documents_count: "0",
    upload_chunks_count: "0",
    upload_entities_count: "0"
  };
  const counts = {
    documents: parseInt(row.folder_documents_count, 10),
    chunks: parseInt(row.folder_chunks_count, 10),
    entities: parseInt(row.folder_entities_count, 10),
    uploadDocuments: parseInt(row.upload_documents_count, 10),
    uploadChunks: parseInt(row.upload_chunks_count, 10),
    uploadEntities: parseInt(row.upload_entities_count, 10)
  };

  await pool.query(
    `update kb_projects
        set cached_documents_count = $2,
            cached_chunks_count = $3,
            cached_entities_count = $4,
            cached_upload_documents_count = $5,
            cached_upload_chunks_count = $6,
            cached_upload_entities_count = $7,
            cached_updated_at = now()
      where id = $1 and tenant_id = $8`,
    [
      kbProjectId,
      counts.documents,
      counts.chunks,
      counts.entities,
      counts.uploadDocuments,
      counts.uploadChunks,
      counts.uploadEntities,
      tenantId
    ]
  );
  return counts;
}

/** Schedule a background aggregation; never throws to the caller. */
function scheduleKbCountRefresh(kbProjectId: string, tenantId: string): void {
  void aggregateAndCacheKbProjectCounts(kbProjectId, tenantId).catch((err) => {
    logger.warn(
      { err: (err as Error).message, kbProjectId, tenantId },
      "kb-projects: cached count refresh failed"
    );
  });
}

/**
 * Create a new per-upload source. Each upload gets its own independent
 * source (named `kb-upload-{kbProjectId}-{randomSuffix}`) so:
 *   - The kb_sources row can be deleted without affecting other uploads
 *     on the same KB project (cascade-delete only touches this source's
 *     documents, not the others).
 *   - The unique (kb_project_id, upload_id) constraint is no longer
 *     needed — migration 013 dropped it.
 *
 * Keeping this idempotent-by-distinct-name avoids accidental cross-upload
 * document collisions even if the caller forgets to provide a unique docId.
 */
export async function createUploadSource(
  kbProjectId: string,
  tenantId: string
): Promise<{ id: string }> {
  const created = await createSource({
    tenantId,
    name: `kb-upload-${kbProjectId}-${randomUUID()}`,
    description: `Auto-created upload source for KB project ${kbProjectId}`,
    metadata: { kbProjectId, kind: "kb-upload" }
  });
  return { id: created.id };
}

const tenantQuerySchema = z.object({ tenantId: z.string().min(1).optional() });

const kbProjectCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional()
});

const kbProjectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional()
});

const kbSourceCreateSchema = z.object({
  source_type: z.enum(["folder", "upload"]),
  name: z.string().min(1),
  watched_folder_id: z.string().uuid().optional(),
  upload_id: z.string().min(1).optional(),
  // Optional metadata captured for upload-type sources so the UI can
  // display file name + size without an extra roundtrip.
  file_name: z.string().min(1).optional(),
  file_size: z.number().int().nonnegative().optional(),
  file_extension: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional()
}).refine(
  (v) => v.source_type === "folder" ? !!v.watched_folder_id : !!v.upload_id,
  { message: "folder type requires watched_folder_id, upload type requires upload_id" }
);

function readTenant(request: FastifyRequest): string {
  const parsed = tenantQuerySchema.safeParse(request.query ?? {});
  if (parsed.success && parsed.data.tenantId) {
    return parsed.data.tenantId;
  }
  return process.env.DEFAULT_TENANT_ID || "default";
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

interface KbProjectRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  cached_documents_count?: string | number | null;
  cached_chunks_count?: string | number | null;
  cached_entities_count?: string | number | null;
  cached_upload_documents_count?: string | number | null;
  cached_upload_chunks_count?: string | number | null;
  cached_upload_entities_count?: string | number | null;
  cached_updated_at?: string | null;
}

interface KbSourceRow {
  id: string;
  kb_project_id: string;
  source_type: "folder" | "upload";
  name: string;
  watched_folder_id: string | null;
  upload_id: string | null;
  enabled: boolean;
  status: string;
  last_sync_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // joined fields
  folder_path?: string;
  folder_display_name?: string;
  // Optional upload metadata (kb_sources rows of type='upload').
  file_name?: string | null;
  file_size?: number | null;
  file_extension?: string | null;
}

function kbProjectFromRow(row: KbProjectRow) {
  const num = (v: string | number | null | undefined): number =>
    v === null || v === undefined ? 0 : parseInt(String(v), 10) || 0;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cachedDocumentsCount: num(row.cached_documents_count),
    cachedChunksCount: num(row.cached_chunks_count),
    cachedEntitiesCount: num(row.cached_entities_count),
    cachedUploadDocumentsCount: num(row.cached_upload_documents_count),
    cachedUploadChunksCount: num(row.cached_upload_chunks_count),
    cachedUploadEntitiesCount: num(row.cached_upload_entities_count),
    cachedUpdatedAt: row.cached_updated_at ?? null
  };
}

function kbSourceFromRow(row: KbSourceRow) {
  return {
    id: row.id,
    kbProjectId: row.kb_project_id,
    sourceType: row.source_type,
    name: row.name,
    watchedFolderId: row.watched_folder_id,
    uploadId: row.upload_id,
    enabled: row.enabled,
    status: row.status,
    lastSyncAt: row.last_sync_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    folderPath: row.folder_path,
    folderDisplayName: row.folder_display_name,
    // Optional upload metadata (only set for source_type='upload').
    fileName: row.file_name ?? null,
    fileSize: row.file_size === null || row.file_size === undefined ? null : parseInt(String(row.file_size), 10),
    fileExtension: row.file_extension ?? null
  };
}

export function registerKbProjectRoutes(app: FastifyInstance): void {
  // 列出所有 KB 项目
  // Dashboard list 页：直接读 cached_*（O(N) 内存扫描，无 JOIN）。
  // 文档增量由 addKbSource / deleteKbSource 末尾触发后台重算。
  app.get("/api/kb-projects", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const result = await pool.query(
      `select p.*,
              (select count(*) from kb_sources where kb_project_id = p.id) as source_count
       from kb_projects p
       where tenant_id = $1
       order by p.name`,
      [tenantId]
    );
    const projects = result.rows.map((r) => ({
      ...kbProjectFromRow(r),
      sourceCount: parseInt(r.source_count, 10)
    }));
    return { projects };
  });

  // 获取单个 KB 项目（含 sources）
  app.get("/api/kb-projects/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid kb project id"));
    }
    const projectRes = await pool.query(
      "select * from kb_projects where id = $1 and tenant_id = $2",
      [params.id, tenantId]
    );
    if (projectRes.rows.length === 0) {
      return reply.code(404).send(apiError("KB_PROJECT_NOT_FOUND", "kb project not found"));
    }
    const project = kbProjectFromRow(projectRes.rows[0] as KbProjectRow);

    const sourcesRes = await pool.query(
      `select s.*, f.path as folder_path, f.display_name as folder_display_name
       from kb_sources s
       left join watched_folders f on f.id = s.watched_folder_id
       where s.kb_project_id = $1
       order by s.created_at`,
      [params.id]
    );
    const sources = sourcesRes.rows.map((r) => kbSourceFromRow(r as KbSourceRow));

    return { project, sources };
  });

  // 创建 KB 项目
  app.post("/api/kb-projects", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const input = kbProjectCreateSchema.parse(request.body);
    try {
      const result = await pool.query(
        `insert into kb_projects (tenant_id, name, description, metadata)
         values ($1, $2, $3, $4)
         returning *`,
        [tenantId, input.name, input.description ?? null, input.metadata ?? {}]
      );
      return { project: kbProjectFromRow(result.rows[0] as KbProjectRow) };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return reply.code(409).send(apiError("DUPLICATE", "kb project with this name already exists"));
      }
      throw err;
    }
  });

  // 更新 KB 项目
  app.patch("/api/kb-projects/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid kb project id"));
    }
    const input = kbProjectUpdateSchema.parse(request.body);
    const result = await pool.query(
      `update kb_projects
       set name = coalesce($3, name),
           description = coalesce($4, description),
           metadata = coalesce($5, metadata),
           updated_at = now()
       where id = $1 and tenant_id = $2
       returning *`,
      [params.id, tenantId, input.name ?? null, input.description ?? null, input.metadata ?? null]
    );
    if (result.rows.length === 0) {
      return reply.code(404).send(apiError("KB_PROJECT_NOT_FOUND", "kb project not found"));
    }
    return { project: kbProjectFromRow(result.rows[0] as KbProjectRow) };
  });

  // 删除 KB 项目
  app.delete("/api/kb-projects/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid kb project id"));
    }
    const result = await pool.query(
      "delete from kb_projects where id = $1 and tenant_id = $2",
      [params.id, tenantId]
    );
    return { deleted: (result.rowCount ?? 0) > 0 };
  });

  // 添加 source 到 KB 项目
  app.post("/api/kb-projects/:id/sources", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid kb project id"));
    }
    const input = kbSourceCreateSchema.parse(request.body);
    // 验证 KB 项目存在
    const proj = await pool.query(
      "select id from kb_projects where id = $1 and tenant_id = $2",
      [params.id, tenantId]
    );
    if (proj.rows.length === 0) {
      return reply.code(404).send(apiError("KB_PROJECT_NOT_FOUND", "kb project not found"));
    }
    // 验证 folder 存在
    if (input.source_type === "folder" && input.watched_folder_id) {
      const folder = await pool.query(
        "select id from watched_folders where id = $1 and tenant_id = $2",
        [input.watched_folder_id, tenantId]
      );
      if (folder.rows.length === 0) {
        return reply.code(404).send(apiError("FOLDER_NOT_FOUND", "watched folder not found"));
      }
    }
    try {
      const result = await pool.query(
        `insert into kb_sources
          (kb_project_id, source_type, name, watched_folder_id, upload_id,
           file_name, file_size, file_extension, enabled, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning *`,
        [
          params.id,
          input.source_type,
          input.name,
          input.watched_folder_id ?? null,
          input.upload_id ?? null,
          input.file_name ?? null,
          input.file_size ?? null,
          input.file_extension ?? null,
          input.enabled ?? true,
          input.metadata ?? {}
        ]
      );
      // Refresh cached counts in the background so the dashboard reflects
      // the new aggregate immediately on the next list/refresh.
      scheduleKbCountRefresh(params.id, tenantId);
      return { source: kbSourceFromRow(result.rows[0] as KbSourceRow) };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return reply.code(409).send(apiError("DUPLICATE", "this source is already added to the kb project"));
      }
      throw err;
    }
  });

  // 从 KB 项目移除 source
  app.delete("/api/kb-projects/:id/sources/:sourceId", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string; sourceId: string };
    // For upload-type sources, also clean up the underlying documents.
    // Uploaded docs live in the KB project's per-project upload source
    // (named 'kb-{kbProjectId}-uploads'), so we cascade-delete via
    // documents.source_id. Folder-type sources don't need this — the
    // watcher keeps its own manifest and re-ingests the file on next sync.
    const meta = await pool.query<{ source_type: string; upload_id: string | null }>(
      `select source_type, upload_id
         from kb_sources
        where id = $1 and kb_project_id = $2
          and kb_project_id in (select id from kb_projects where tenant_id = $3)`,
      [params.sourceId, params.id, tenantId]
    );
    let documentsDeleted = 0;
    if (meta.rows.length > 0 && meta.rows[0].source_type === "upload" && meta.rows[0].upload_id) {
      const docsRes = await pool.query(
        `delete from documents where source_id = $1`,
        [meta.rows[0].upload_id]
      );
      documentsDeleted = docsRes.rowCount ?? 0;
    }
    const result = await pool.query(
      `delete from kb_sources
       where id = $1 and kb_project_id = $2
         and kb_project_id in (select id from kb_projects where tenant_id = $3)`,
      [params.sourceId, params.id, tenantId]
    );
    // Refresh cached counts only if something actually changed.
    if ((result.rowCount ?? 0) > 0) {
      scheduleKbCountRefresh(params.id, tenantId);
    }
    return { deleted: (result.rowCount ?? 0) > 0, documentsDeleted };
  });

  // Create a fresh upload source for the KB project. The client calls this
  // before uploading each file so the upload lands in its own independent
  // source (named `kb-upload-{kbProjectId}-{random}`). Cascade-delete on
  // the resulting kb_sources row then targets only this single file's
  // documents without disturbing other uploads on the same KB project.
  app.post("/api/kb-projects/:id/ensure-upload-source", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const params = request.params as { id: string };
    if (!params.id) {
      return reply.code(400).send(apiError("BAD_REQUEST", "invalid kb project id"));
    }
    const proj = await pool.query(
      "select id from kb_projects where id = $1 and tenant_id = $2",
      [params.id, tenantId]
    );
    if (proj.rows.length === 0) {
      return reply.code(404).send(apiError("KB_PROJECT_NOT_FOUND", "kb project not found"));
    }
    try {
      const { id: sourceId } = await createUploadSource(params.id, tenantId);
      return { sourceId, isNew: true };
    } catch (err) {
      logger.error(
        { err: (err as Error).message, kbProjectId: params.id, tenantId },
        "kb-projects: ensure upload source failed"
      );
      throw err;
    }
  });

  // 列出所有 available folders（供 KB source 选择）
  app.get("/api/kb-projects/available-folders", async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = readTenant(request);
    const result = await pool.query(
      `select id,
              source_id as "sourceId",
              display_name as "displayName",
              path,
              enabled,
              recursive,
              last_scan_at as "lastScanAt"
       from watched_folders
       where tenant_id = $1
       order by display_name`,
      [tenantId]
    );
    return { folders: result.rows };
  });
}
