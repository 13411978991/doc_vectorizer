/**
 * src/api/settings-routes.ts — User-facing settings endpoints.
 *
 *   GET /api/settings/ai   - read AI provider / chunking / search defaults
 *   PUT /api/settings/ai   - update AI provider / chunking / search defaults
 *   GET /api/settings/mcp  - read MCP server public settings (no secrets)
 *
 * The MCP settings handler is read-only — it's the source of truth for
 * the web UI's MCP config card; mutations go through the MCP service
 * layer (kept outside the v1 surface to avoid drift).
 */

import type { FastifyInstance } from "fastify";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import { aiSettingsSchema } from "./server-helpers.js";
import { config } from "../config/env.js";

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  // Surface the actual SAG server bind so the web UI can render the
  // HTTP / MCP HTTP endpoints the user needs to configure Agents
  // against. The host is reported as "0.0.0.0" verbatim (not normalized
  // to localhost) so a remote user sees the bind address, not a
  // loopback alias that won't work from another machine.
  app.get("/api/server/info", async () => ({
    httpHost: config.HTTP_HOST,
    httpPort: config.HTTP_PORT,
    mcpHttpPort: config.MCP_HTTP_PORT
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });
}
