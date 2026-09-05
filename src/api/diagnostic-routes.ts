/**
 * src/api/diagnostic-routes.ts — Read-only diagnostics endpoints.
 *
 *   GET /api/model-call-logs      - tail the in-process model-call log
 *   GET /sources                  - legacy KB list (graphService.listSources)
 *   GET /api/sources              - web UI shape (webuiService.listSources)
 *
 * Note: the `/sources` (no /api prefix) variant is the legacy endpoint
 * kept for backward compatibility with the original MCP test harness.
 * Both `GET /sources` and `GET /api/sources` are intentionally
 * registered — the web UI uses /api/sources today.
 */

import type { FastifyInstance } from "fastify";
import { listModelCallLogs } from "../observability/model-call-log.js";
import { graphService } from "../services/graph-service.js";
import { webuiService } from "../services/webui-service.js";

export function registerDiagnosticRoutes(app: FastifyInstance): void {
  app.get("/api/model-call-logs", async (request) => {
    const query = request.query as { after?: string };
    const after = query.after ? Number(query.after) : 0;
    return listModelCallLogs(Number.isFinite(after) ? after : 0);
  });

  app.get("/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await graphService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });

  app.get("/api/sources", async (request) => {
    const query = request.query as { limit?: string; cursor?: string };
    return {
      sources: await webuiService.listSources({
        limit: query.limit ? Number(query.limit) : undefined,
        cursor: query.cursor
      })
    };
  });
}
