/**
 * src/api/project-routes.ts — Project CRUD + per-project stats / graph /
 * document listing.
 *
 *   GET    /api/projects                            - list projects (paginated)
 *   POST   /api/projects                            - create project
 *   PATCH  /api/projects/:projectId                 - rename / re-describe
 *   POST   /api/projects/:projectId/archive         - archive project
 *   POST   /api/projects/:projectId/restore         - restore archived project
 *   DELETE /api/projects/:projectId                - permanent delete (requires
 *                                                     ?permanent=true)
 *   GET    /api/sources/:sourceId/documents         - documents by source
 *   GET    /api/projects/:projectId/documents       - documents by project
 *   GET    /api/projects/:projectId/stats           - counts dashboard
 *   GET    /api/projects/:projectId/graph           - event/entity graph
 *
 * The three readonly "documents / stats / graph" handlers all delegate
 * to webuiService. Their bodies are 1–2 lines each; keep them inline
 * rather than spinning up a separate dashboard-routes file.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logger } from "../observability/logger.js";
import { webuiService } from "../services/webui-service.js";
import { projectSchema, projectUpdateSchema } from "./server-helpers.js";
import { attachFoldersToProject, detachFoldersFromProject } from "../watcher/manifest-store.js";
import { readTenant } from "./watched-folders.js";

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get("/api/projects", async (request) => {
    const query = request.query as { limit?: string; cursor?: string; includeArchived?: string };
    return {
      projects: await webuiService.listProjects({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor,
        includeArchived: query.includeArchived === "true"
      })
    };
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectSchema.parse(request.body);
    const project = await webuiService.createProject(input);
    return reply.code(201).send({ project });
  });

  app.patch("/api/projects/:projectId", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const input = projectUpdateSchema.parse(request.body);
    return {
      project: await webuiService.updateProject(params.projectId, input)
    };
  });

  app.post("/api/projects/:projectId/archive", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.archiveProject(params.projectId)
    };
  });

  app.post("/api/projects/:projectId/restore", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      project: await webuiService.restoreProject(params.projectId)
    };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const params = request.params as { projectId: string };
    const query = request.query as { permanent?: string };
    z.string().uuid().parse(params.projectId);
    if (query.permanent !== "true") {
      return reply.code(400).send({
        error: {
          code: "PERMANENT_CONFIRMATION_REQUIRED",
          message: "永久删除项目必须显式传入 permanent=true"
        }
      });
    }
    return webuiService.deleteProject(params.projectId);
  });

  app.get("/api/sources/:sourceId/documents", async (request) => {
    const params = request.params as { sourceId: string };
    const query = request.query as { includeArchived?: string; limit?: string; cursor?: string };
    z.string().uuid().parse(params.sourceId);
    const page = await webuiService.listDocuments(params.sourceId, {
      includeArchived: query.includeArchived === "true",
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor
    });
    return {
      documents: page.documents,
      nextCursor: page.nextCursor
    };
  });

  app.get("/api/projects/:projectId/documents", async (request) => {
    const params = request.params as { projectId: string };
    const query = request.query as { includeArchived?: string; limit?: string; cursor?: string };
    z.string().uuid().parse(params.projectId);
    const page = await webuiService.listDocuments(params.projectId, {
      includeArchived: query.includeArchived === "true",
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor
    });
    return {
      documents: page.documents,
      nextCursor: page.nextCursor
    };
  });

  app.get("/api/projects/:projectId/stats", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      stats: await webuiService.getProjectStats(params.projectId)
    };
  });

  app.get("/api/projects/:projectId/graph", async (request) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    return {
      graph: await webuiService.getProjectGraph(params.projectId)
    };
  });

  /**
   * POST /api/projects/:projectId/folders — attach existing watched folders
   * to a project. Two effects:
   *   1. `watched_folders.source_id` is rewritten to point at this project
   *      (folders that already belong to the project are skipped).
   *   2. Documents/chunks/events/entities indexed under the folders' old
   *      auto-sources get their `source_id` rewritten too, so this project
   *      immediately sees the data instead of staying empty.
   *
   * Designed for the "汇聚 project" use-case: build a few auto-sources
   * via standalone watched folders, then aggregate them under a project
   * and point MCP at that project.
   */
  app.post("/api/projects/:projectId/folders", async (request, reply) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const body = z.object({
      folderIds: z.array(z.string().uuid()).min(1).max(100)
    }).parse(request.body ?? {});
    const tenantId = readTenant(request);
    try {
      const result = await attachFoldersToProject({
        projectId: params.projectId,
        folderIds: body.folderIds,
        tenantId
      });
      logger.info(
        {
          projectId: params.projectId,
          folderIds: body.folderIds,
          attached: result.attached
        },
        "project-routes: attached folders to project"
      );
      return reply.code(200).send(result);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(
        { projectId: params.projectId, error: message },
        "project-routes: attach folders failed"
      );
      return reply.code(400).send({
        error: { code: "ATTACH_FOLDERS_FAILED", message }
      });
    }
  });

  /**
   * DELETE /api/projects/:projectId/folders — detach watched folders from a
   * project, restoring each folder's source_id back to its former value.
   * Mirror of the POST /api/projects/:projectId/folders endpoint.
   */
  app.delete("/api/projects/:projectId/folders", async (request, reply) => {
    const params = request.params as { projectId: string };
    z.string().uuid().parse(params.projectId);
    const body = z.object({
      folderIds: z.array(z.string().uuid()).min(1).max(100)
    }).parse(request.body ?? {});
    const tenantId = readTenant(request);
    try {
      const result = await detachFoldersFromProject({
        projectId: params.projectId,
        folderIds: body.folderIds,
        tenantId
      });
      logger.info(
        {
          projectId: params.projectId,
          folderIds: body.folderIds,
          detached: result.detached
        },
        "project-routes: detached folders from project"
      );
      return reply.code(200).send(result);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(
        { projectId: params.projectId, error: message },
        "project-routes: detach folders failed"
      );
      return reply.code(400).send({
        error: { code: "DETACH_FOLDERS_FAILED", message }
      });
    }
  });
}
