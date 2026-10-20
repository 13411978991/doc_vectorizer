/**
 * src/api/event-routes.ts — Event + entity detail lookups.
 *
 *   GET /events/:eventId         - legacy single-event read (graphService)
 *   GET /api/events/:eventId     - web UI shape (webuiService.getEvent)
 *   GET /api/entities/:entityId  - web UI shape (webuiService.getEntity)
 *
 * The legacy /events/:id route returns the raw event object; the
 * /api/* variants wrap the response in `{entity|event}` and use the
 * canonical `notFound(...)` envelope on a 404.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { graphService } from "../services/graph-service.js";
import { webuiService } from "../services/webui-service.js";
import { notFound } from "./server-helpers.js";

export function registerEventRoutes(app: FastifyInstance): void {
  app.get("/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    const event = await graphService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "事件不存在"
        }
      });
    }
    return event;
  });

  app.get("/api/events/:eventId", async (request, reply) => {
    const params = request.params as { eventId: string };
    z.string().uuid().parse(params.eventId);
    const event = await webuiService.getEvent(params.eventId);
    if (!event) {
      return reply.code(404).send(notFound("EVENT_NOT_FOUND", "事件不存在"));
    }
    return event;
  });

  app.get("/api/entities/:entityId", async (request, reply) => {
    const params = request.params as { entityId: string };
    z.string().uuid().parse(params.entityId);
    const entity = await webuiService.getEntity(params.entityId);
    if (!entity) {
      return reply.code(404).send(notFound("ENTITY_NOT_FOUND", "实体不存在"));
    }
    return entity;
  });
}
