// src/api/mcp-audit.ts — REST endpoint for the MCP audit trail.
//
// `GET /api/mcp/audit-log` returns rows from the `audit_logs` table so
// ops can audit who's been hitting the MCP HTTP transport, who's been
// rate-limited, and which sessions opened / closed.
//
// Filtering is via standard query params. Defaults to the most recent
// 100 rows under the active tenant.
//
// The route is intentionally read-only — writes happen server-side
// from src/mcp/http-server.ts.

import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/env.js";
import { listAuditLogs } from "../services/audit-log-service.js";

const querySchema = z.object({
  tenantId: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  since: z.string().min(1).optional(),
  until: z.string().min(1).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

export function registerMcpAuditRoutes(app: FastifyInstance): void {
  app.get("/api/mcp/audit-log", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "invalid audit-log query" },
      });
    }

    const q = parsed.data;
    const tenantId = q.tenantId ?? config.DEFAULT_TENANT_ID;

    try {
      const rows = await listAuditLogs({
        tenantId,
        entityType: q.entityType,
        entityId: q.entityId,
        action: q.action,
        actor: q.actor,
        since: q.since,
        until: q.until,
        limit: q.limit ? Number.parseInt(q.limit, 10) : undefined,
      });
      return reply.code(200).send({
        tenantId,
        count: rows.length,
        rows,
      });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "AUDIT_LOG_READ_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });
}
