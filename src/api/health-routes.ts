/**
 * src/api/health-routes.ts — Liveness probe + model-call-log diagnostics.
 *
 * Two endpoints:
 *   GET /health           — fast, no remote calls. Always returns
 *                           {ok:true,service:"sag"}. Used by external
 *                           probes / load balancers.
 *   GET /api/test-connection — exercises the configured embedding
 *                           endpoint with a single 5-char probe text
 *                           and returns the structured result. Useful
 *                           from the Web UI before the user clicks
 *                           "Add watched folder": it surfaces auth or
 *                           network problems without firing a full
 *                           ingest.
 *   GET /api/diagnostics/embedding — same probe as test-connection
 *                           but exposed via the diagnostic surface so
 *                           the existing diagnostic UI can render it.
 *
 * The probe times out after EMBEDDING_TIMEOUT_MS so a hung endpoint
 * can't block the route forever.
 */

import type { FastifyInstance } from "fastify";
import { embeddingClient } from "../ai/embedding-client.js";

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({
    ok: true,
    service: "sag"
  }));

  app.get("/api/test-connection", async (_request, reply) => {
    const result = await embeddingClient.testConnection();
    reply.code(result.ok ? 200 : 503);
    return {
      embedding: result
    };
  });
}