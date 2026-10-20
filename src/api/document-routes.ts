/**
 * src/api/document-routes.ts — Document CRUD + upload + per-document chunks/
 * events/entities views.
 *
 *   POST   /api/documents/upload                       - synchronous upload
 *   POST   /api/documents/upload/jobs                  - async upload (returns job)
 *   GET    /api/documents/upload/jobs/:jobId           - poll upload job
 *   GET    /api/documents/:documentId                  - read document
 *   PATCH  /api/documents/:documentId                  - rename
 *   POST   /api/documents/:documentId/archive          - archive
 *   POST   /api/documents/:documentId/restore          - restore
 *   DELETE /api/documents/:documentId                  - permanent delete
 *                                                        (requires ?permanent=true)
 *   GET    /api/documents/:documentId/chunks           - chunks under doc
 *   GET    /api/documents/:documentId/events           - events under doc
 *   GET    /api/documents/:documentId/entities         - entities under doc
 *
 * Two upload paths exist by design: /api/documents/upload is synchronous
 * for small jobs (returns 201 with the processed document); the /jobs
 * variant returns 202 with a job-id for long-running uploads that the
 * web UI polls via /jobs/:jobId.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { webuiService } from "../services/webui-service.js";
import { documentUpdateSchema, notFound, uploadSchema } from "./server-helpers.js";

export function registerDocumentRoutes(app: FastifyInstance): void {
  app.post("/api/documents/upload", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const result = await webuiService.uploadDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/api/documents/upload/jobs", async (request, reply) => {
    const input = uploadSchema.parse(request.body);
    const job = await webuiService.createUploadJob(input);
    return reply.code(202).send({ job });
  });

  app.get("/api/documents/upload/jobs/:jobId", async (request, reply) => {
    const params = request.params as { jobId: string };
    z.string().uuid().parse(params.jobId);
    const job = webuiService.getUploadJob(params.jobId);
    if (!job) {
      return reply.code(404).send(notFound("UPLOAD_JOB_NOT_FOUND", "上传任务不存在"));
    }
    return { job };
  });

  app.get("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const document = await webuiService.getDocument(params.documentId);
    if (!document) {
      return reply.code(404).send(notFound("DOCUMENT_NOT_FOUND", "文档不存在"));
    }
    return { document };
  });

  app.patch("/api/documents/:documentId", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    const input = documentUpdateSchema.parse(request.body);
    return {
      document: await webuiService.updateDocument(params.documentId, input)
    };
  });

  app.post("/api/documents/:documentId/archive", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.archiveDocument(params.documentId)
    };
  });

  app.post("/api/documents/:documentId/restore", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      document: await webuiService.restoreDocument(params.documentId)
    };
  });

  app.delete("/api/documents/:documentId", async (request, reply) => {
    const params = request.params as { documentId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.documentId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除文档必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteDocument(params.documentId);
  });

  app.get("/api/documents/:documentId/chunks", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      chunks: await webuiService.listChunks(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/events", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      events: await webuiService.listEvents(params.documentId)
    };
  });

  app.get("/api/documents/:documentId/entities", async (request) => {
    const params = request.params as { documentId: string };
    z.string().uuid().parse(params.documentId);
    return {
      entities: await webuiService.listEntities(params.documentId)
    };
  });
}
