import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { toLocalISO } from "../db/row-helpers.js";
import {
  archiveDocument,
  archiveSource,
  createSource,
  deleteDocument,
  deleteSource,
  getEntityDetail,
  getDocumentDetail,
  getEventDetail,
  getProjectGraph,
  getProjectStats,
  listChunksByDocument,
  listDocumentsBySource,
  listEntitiesByDocument,
  listEventsByDocument,
  listSources,
  restoreDocument,
  restoreSource,
  updateDocument,
  updateSource
} from "../db/repositories.js";
import { ingestionService } from "./ingestion-service.js";
import type { ChunkingMode, IngestProgressStage, IngestProgressUpdate } from "../types.js";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".md", ".txt"]);

type UploadJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

export interface UploadJobRecord {
  id: string;
  sourceId: string;
  fileName: string;
  title: string;
  status: UploadJobStatus;
  stage: IngestProgressStage;
  message: string;
  progress: number;
  chunkCount?: number;
  eventCount?: number;
  currentChunk?: number;
  totalChunks?: number;
  documentId?: string;
  traceId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class WebuiService {
  private readonly uploadJobs = new Map<string, UploadJobRecord>();

  async listProjects(input: {
    limit?: number;
    cursor?: string;
    includeArchived?: boolean;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    return listSources({
      tenantId,
      limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
      cursor: input.cursor,
      includeArchived: input.includeArchived ?? false
    });
  }

  async listSources(input: { limit?: number; cursor?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    return this.listProjects(input, tenantId);
  }

  async createProject(input: {
    name: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const name = input.name.trim();
    if (!name) {
      throw new Error("项目名称不能为空");
    }
    return createSource({
      tenantId,
      name,
      description: input.description?.trim() || undefined,
      metadata: {
        createdVia: "webui",
        semanticType: "project"
      }
    });
  }

  async updateProject(projectId: string, input: {
    name?: string;
    description?: string | null;
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await updateSource({
      sourceId: projectId,
      tenantId,
      name: input.name,
      description: input.description
    });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async archiveProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await archiveSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async restoreProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const project = await restoreSource({ sourceId: projectId, tenantId });
    if (!project) {
      throw new Error("项目不存在");
    }
    return project;
  }

  async deleteProject(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteSource({ sourceId: projectId, tenantId });
    if (!deleted) {
      throw new Error("项目不存在");
    }
    return { deleted: true };
  }

  async uploadDocument(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const fileName = input.fileName.trim();
    const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error("只支持上传 .md 和 .txt 文档");
    }
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes === 0) {
      throw new Error("上传文档为空");
    }
    if (bytes > MAX_UPLOAD_BYTES) {
      throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
    }
    if (!input.sourceId) {
      throw new Error("上传文档必须先选择项目");
    }
    const title = input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档";
    const result = await ingestionService.ingestDocument({
      sourceId: input.sourceId,
      title,
      content: input.content,
      extract: input.extract ?? true,
      chunking: input.chunking,
      metadata: {
        fileName,
        uploadedVia: "webui",
        uploadBytes: bytes
      }
    }, tenantId);
    const document = await getDocumentDetail({
      documentId: result.documentId,
      tenantId
    });
    return {
      ...result,
      document
    };
  }

  async createUploadJob(input: {
    title?: string;
    fileName: string;
    content: string;
    sourceId?: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
  }, tenantId = config.DEFAULT_TENANT_ID) {
    const upload = validateUploadInput(input);
    const now = toLocalISO();
    const job: UploadJobRecord = {
      id: randomUUID(),
      sourceId: upload.sourceId,
      fileName: upload.fileName,
      title: upload.title,
      status: "QUEUED",
      stage: "QUEUED",
      message: "等待处理",
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    this.uploadJobs.set(job.id, job);
    queueMicrotask(() => {
      void this.runUploadJob(job.id, {
        ...upload,
        extract: input.extract,
        chunking: input.chunking
      }, tenantId);
    });
    return job;
  }

  getUploadJob(jobId: string) {
    return this.uploadJobs.get(jobId) ?? null;
  }

  private async runUploadJob(jobId: string, input: {
    title: string;
    fileName: string;
    content: string;
    sourceId: string;
    extract?: boolean;
    chunking?: {
      mode?: ChunkingMode;
      maxTokens?: number;
      overlapTokens?: number;
    };
    uploadBytes: number;
  }, tenantId: string) {
    this.updateUploadJob(jobId, {
      status: "RUNNING",
      stage: "READING",
      message: "已读取文件，准备提交处理",
      progress: 5
    });
    try {
      const result = await ingestionService.ingestDocument({
        sourceId: input.sourceId,
        title: input.title,
        content: input.content,
        extract: input.extract ?? true,
        chunking: input.chunking,
        metadata: {
          fileName: input.fileName,
          uploadedVia: "webui",
          uploadBytes: input.uploadBytes
        }
      }, tenantId, (update) => this.updateUploadJob(jobId, {
        status: update.stage === "COMPLETED" ? "COMPLETED" : "RUNNING",
        ...update
      }));
      this.updateUploadJob(jobId, {
        status: "COMPLETED",
        stage: "COMPLETED",
        message: `处理完成：${result.chunkCount} 个切片，${result.eventCount} 个事件`,
        progress: 100,
        documentId: result.documentId,
        traceId: result.traceId,
        chunkCount: result.chunkCount,
        eventCount: result.eventCount
      });
    } catch (error) {
      this.updateUploadJob(jobId, {
        status: "FAILED",
        stage: "FAILED",
        message: "处理失败",
        progress: 100,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateUploadJob(jobId: string, patch: Partial<UploadJobRecord> & Partial<IngestProgressUpdate>) {
    const existing = this.uploadJobs.get(jobId);
    if (!existing) {
      return;
    }
    this.uploadJobs.set(jobId, {
      ...existing,
      ...patch,
      updatedAt: toLocalISO()
    });
  }

  async listDocuments(
    sourceId: string,
    input: { includeArchived?: boolean; limit?: number; cursor?: string } = {},
    tenantId = config.DEFAULT_TENANT_ID
  ) {
    // Hard upper bound to prevent UI from accidentally requesting the
    // entire database. UI typically uses 20-50 per page; 200 is the
    // ceiling for bulk loads (e.g. the Documents tab "load all" button).
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
    const page = await listDocumentsBySource({
      sourceId,
      tenantId,
      limit,
      includeArchived: input.includeArchived ?? false,
      cursor: input.cursor
    });
    return page;
  }

  async getProjectStats(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getProjectStats({ sourceId: projectId, tenantId });
  }

  async getProjectGraph(projectId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getProjectGraph({ sourceId: projectId, tenantId });
  }

  async updateDocument(documentId: string, input: { title?: string }, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await updateDocument({
      documentId,
      tenantId,
      title: input.title
    });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async archiveDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await archiveDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async restoreDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const document = await restoreDocument({ documentId, tenantId });
    if (!document) {
      throw new Error("文档不存在");
    }
    return document;
  }

  async deleteDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    const deleted = await deleteDocument({ documentId, tenantId });
    if (!deleted) {
      throw new Error("文档不存在");
    }
    return { deleted: true };
  }

  async getDocument(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getDocumentDetail({ documentId, tenantId });
  }

  async listChunks(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listChunksByDocument({ documentId, tenantId });
  }

  async listEvents(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEventsByDocument({ documentId, tenantId });
  }

  async listEntities(documentId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return listEntitiesByDocument({ documentId, tenantId });
  }

  async getEvent(eventId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEventDetail({ eventId, tenantId });
  }

  async getEntity(entityId: string, tenantId = config.DEFAULT_TENANT_ID) {
    return getEntityDetail({ entityId, tenantId });
  }
}

export const webuiService = new WebuiService();

function validateUploadInput(input: {
  title?: string;
  fileName: string;
  content: string;
  sourceId?: string;
}) {
  const fileName = input.fileName.trim();
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error("只支持上传 .md 和 .txt 文档");
  }
  const uploadBytes = Buffer.byteLength(input.content, "utf8");
  if (uploadBytes === 0) {
    throw new Error("上传文档为空");
  }
  if (uploadBytes > MAX_UPLOAD_BYTES) {
    throw new Error(`上传文档超过 ${MAX_UPLOAD_BYTES} 字节限制`);
  }
  if (!input.sourceId) {
    throw new Error("上传文档必须先选择项目");
  }
  return {
    fileName,
    title: input.title?.trim() || fileName.replace(/\.[^.]+$/, "") || "未命名文档",
    content: input.content,
    sourceId: input.sourceId,
    uploadBytes
  };
}
