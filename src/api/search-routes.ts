/**
 * src/api/search-routes.ts — Document ingestion + search entry points.
 *
 *   POST /ingest                 - raw ingest (ingestionService.ingestDocument)
 *   POST /search                 - search (legacy alias)
 *   POST /api/search             - search (canonical web UI path)
 *   POST /api/search/stream      - search with SSE progress events
 *
 * The two synchronous /search + /api/search endpoints both go through
 * `searchService.search(input)` with identical bodies; the duplication
 * exists for backward compatibility with MCP test harnesses that hard-
 * code /search. The /api/search/stream variant emits SSE events for
 * the web UI's progressive rendering.
 */

import type { FastifyInstance } from "fastify";
import { config } from "../config/env.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { getErrorMessage, ingestSchema, searchSchema } from "./server-helpers.js";

export function registerSearchRoutes(app: FastifyInstance): void {
  app.post("/ingest", async (request, reply) => {
    const input = ingestSchema.parse(request.body);
    const result = await ingestionService.ingestDocument(input);
    return reply.code(201).send(result);
  });

  app.post("/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search", async (request) => {
    const input = searchSchema.parse(request.body);
    return searchService.search(input);
  });

  app.post("/api/search/stream", async (request, reply) => {
    const input = searchSchema.parse(request.body);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive"
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      const flush = (reply.raw as typeof reply.raw & { flush?: () => void }).flush;
      if (typeof flush === "function") {
        flush.call(reply.raw);
      }
    };

    try {
      const result = await searchService.search(input, config.DEFAULT_TENANT_ID, (event) => {
        send(event.type, event);
      });
      send("done", {
        type: "done",
        result
      });
    } catch (error) {
      send("error", {
        type: "error",
        message: getErrorMessage(error)
      });
    } finally {
      reply.raw.end();
    }
  });
}
