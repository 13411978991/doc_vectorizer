/**
 * src/api/mcp-session-routes.ts — MCP session CRUD + send-message + streaming.
 *
 *   POST   /api/mcp/sessions                              - create session
 *   GET    /api/mcp/sessions                              - list sessions
 *   GET    /api/projects/:projectId/mcp/sessions          - list sessions
 *                                                            visible under a
 *                                                            project (resolves
 *                                                            linked sources)
 *   GET    /api/mcp/sessions/:sessionId                   - session detail
 *   POST   /api/mcp/sessions/:sessionId/clear             - clear history
 *   DELETE /api/mcp/sessions/:sessionId                   - delete session
 *   POST   /api/mcp/sessions/:sessionId/messages          - run user turn
 *                                                            (sync)
 *   POST   /api/mcp/sessions/:sessionId/messages/stream   - SSE streaming
 *
 * The streaming endpoint is the most subtle: it owns an AbortController
 * wired to both `request.raw.on("aborted", ...)` and `reply.raw.on("close",
 * ...)`, so a client disconnect aborts mid-run without leaving the
 * session in a stuck state. Errors that look like AbortError are
 * suppressed (the client is already gone).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config/env.js";
import { mcpAgentService } from "../services/mcp-agent-service.js";
import {
  createMcpSessionSchema,
  getErrorMessage,
  isAbortError,
  mcpMessageSchema,
  notFound,
  readTenant,
} from "./server-helpers.js";

export function registerMcpSessionRoutes(app: FastifyInstance): void {
  app.post("/api/mcp/sessions", async (request, reply) => {
    const input = createMcpSessionSchema.parse(request.body);
    const session = await mcpAgentService.createSession(input);
    return reply.code(201).send({ session });
  });

  app.get("/api/mcp/sessions", async () => ({
    sessions: await mcpAgentService.listSessions()
  }));

  app.get("/api/projects/:projectId/mcp/sessions", async (request) => {
    const params = request.params as { projectId: string };
    const tenantId = readTenant(request);
    z.string().uuid().parse(params.projectId);
    // Sprint 15: resolve the audit project + its linked KB sources
    // (watched folders + uploaded files) so that MCP sessions started
    // against any of them show up under the project. Without this, a
    // session created via the bottom card's MCP config (which uses the
    // audit project's source id) would not see sessions created against
    // the watched folder's source id, and vice versa.
    const { getLinkedSourceIds } = await import("../db/repositories.js");
    const sourceIds = await getLinkedSourceIds({
      sourceId: params.projectId,
      tenantId
    });
    return {
      sessions: await mcpAgentService.listSessions({ sourceIds })
    };
  });

  app.get("/api/mcp/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.getSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.post("/api/mcp/sessions/:sessionId/clear", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const detail = await mcpAgentService.clearSession(params.sessionId);
    if (!detail) {
      return reply.code(404).send(notFound("MCP_SESSION_NOT_FOUND", "MCP 会话不存在"));
    }
    return detail;
  });

  app.delete("/api/mcp/sessions/:sessionId", async (request) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    return mcpAgentService.deleteSession(params.sessionId);
  });

  app.post("/api/mcp/sessions/:sessionId/messages", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const result = await mcpAgentService.runUserMessage({
      sessionId: params.sessionId,
      content: input.content
    });
    return reply.code(201).send(result);
  });

  app.post("/api/mcp/sessions/:sessionId/messages/stream", async (request, reply) => {
    const params = request.params as { sessionId: string };
    z.string().uuid().parse(params.sessionId);
    const input = mcpMessageSchema.parse(request.body);
    const abortController = new AbortController();
    let completed = false;
    const abortRun = () => {
      if (!completed) {
        abortController.abort();
      }
    };
    request.raw.on("aborted", abortRun);
    reply.raw.on("close", abortRun);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      if (abortController.signal.aborted || reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await mcpAgentService.runUserMessage({
        sessionId: params.sessionId,
        content: input.content,
        signal: abortController.signal
      }, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        send("error", {
          type: "error",
          message: getErrorMessage(error)
        });
      }
    } finally {
      completed = true;
      request.raw.off("aborted", abortRun);
      reply.raw.off("close", abortRun);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });
}
