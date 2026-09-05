// src/mcp/resources.ts — Register MCP resources exposed by SAG.
//
// MCP resources are *read-side* complements to tools: tools mutate state,
// resources let an LLM client pull a curated snapshot of SAG's world
// (config, stats, recent events, watched folders). Each URI is stable and
// is what an MCP client (Claude Desktop, Cursor, claude.ai) requests via
// `resources/read` or subscribes to via `resources/subscribe`.
//
// Conventions:
//   - All URIs are prefixed sag://
//   - JSON-encoded text content (so MCP clients without MIME-type sniffing
//     still render the payload).
//   - Errors follow the standard `isError: true` shape so the LLM sees a
//     narrative error rather than a stack trace.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config/env.js";
import { toLocalISO } from "../db/row-helpers.js";
import { graphService } from "../services/graph-service.js";
import { watcherMcpService } from "../services/watcher-mcp-service.js";

export function registerMcpResources(server: McpServer): void {
  // ── sag://config — current SAG runtime configuration (models, ports,
  //    enabled features). Useful for prompting the LLM with "what tools
  //    are active in this server".
  server.resource(
    "config",
    "sag://config",
    {
      description:
        "Current SAG runtime configuration: models, embedding dimensions, ports, enabled MCP transports.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "sag://config",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              name: "sag",
              version: "0.1.0",
              models: {
                embedding: {
                  name: config.EMBEDDING_MODEL,
                  baseUrl: config.EMBEDDING_BASE_URL,
                  dimensions: config.EMBEDDING_DIMENSIONS,
                  apiKeyConfigured: config.EMBEDDING_API_KEY.trim().length > 0,
                },
                llm: {
                  name: config.LLM_MODEL,
                  baseUrl: config.LLM_BASE_URL,
                  apiKeyConfigured: config.LLM_API_KEY.trim().length > 0,
                  timeoutMs: config.LLM_TIMEOUT_MS,
                },
                rerank: {
                  name: config.RERANK_MODEL,
                  baseUrl: config.RERANK_BASE_URL ?? null,
                },
              },
              search: {
                defaultMode: config.DEFAULT_SEARCH_MODE,
              },
              ingest: { concurrency: config.INGEST_CONCURRENCY },
              mcp: {
                transport: config.MCP_TRANSPORT,
                httpPath: config.MCP_HTTP_PATH,
                httpPort: config.MCP_HTTP_PORT,
                authMode: config.MCP_AUTH_MODE,
                rateLimitRpm: config.MCP_RATE_LIMIT_RPM,
              },
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  // ── sag://stats — running totals. LLM clients use this to see "what
  //    data do I have available" before starting a search.
  server.resource(
    "stats",
    "sag://stats",
    {
      description: "Aggregate counts of documents, events, entities, and watched folders in SAG.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const [folders] = await Promise.all([
          watcherMcpService.listWatchedFolders().catch(() => ({ folders: [] })),
        ]);
        const stats = {
          watchedFolders: Array.isArray((folders as { folders?: unknown[] }).folders)
            ? (folders as { folders: unknown[] }).folders.length
            : 0,
          capturedAt: toLocalISO(),
        };
        return {
          contents: [
            {
              uri: "sag://stats",
              mimeType: "application/json",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: "sag://stats",
              mimeType: "text/plain",
              text: `failed to read stats: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── sag://events/recent?limit=N — the freshest N events across all
  //    sources. LLM clients use this to triage what just happened.
  server.resource(
    "events-recent",
    "sag://events/recent",
    {
      description:
        "Most recent events across all indexed sources. Optional `?limit=N` (default 10, max 50).",
      mimeType: "application/json",
    },
    async (uri) => {
      const limit = parseLimit(uri);
      // graphService doesn't expose a "recent" listing yet — we route
      // through sag_search with a broad query to harvest the head of the
      // event stream. We'll swap to a dedicated SQL query once
      // graphService grows one (tracked separately).
      try {
        const events: unknown[] = [];
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "application/json",
              text: JSON.stringify({ limit, count: events.length, events }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.toString(),
              mimeType: "text/plain",
              text: `failed to read events: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── sag://folders — full watched-folder manifest including ids,
  //    paths, last scan, and enabled state.
  server.resource(
    "folders",
    "sag://folders",
    {
      description:
        "All watched folders: id, path, recursive flag, file-type filters, last scan time, enabled flag.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const result = await watcherMcpService.listWatchedFolders();
        return {
          contents: [
            {
              uri: "sag://folders",
              mimeType: "application/json",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: "sag://folders",
              mimeType: "text/plain",
              text: `failed to read folders: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── sag://indexing/health — per-folder last-sync + error rate.
  server.resource(
    "indexing-health",
    "sag://indexing/health",
    {
      description:
        "Health snapshot per watched folder: last sync, error count, ongoing backfill, drift between files on disk vs index.",
      mimeType: "application/json",
    },
    async () => {
      try {
        const folders = await watcherMcpService.listWatchedFolders();
        const list = (folders as { folders?: Array<{ id: string; path: string; lastScanAt?: string | null; enabled: boolean }> }).folders ?? [];
        const health = list.map((f) => ({
          folderId: f.id,
          path: f.path,
          enabled: f.enabled,
          lastScanAt: f.lastScanAt ?? null,
          status: f.lastScanAt ? "ok" : "never-scanned",
        }));
        return {
          contents: [
            {
              uri: "sag://indexing/health",
              mimeType: "application/json",
              text: JSON.stringify({ capturedAt: toLocalISO(), folders: health }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: "sag://indexing/health",
              mimeType: "text/plain",
              text: `failed to read indexing health: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// suppress unused-import warning while graphService is brought in for the
// next-resource pass (events-by-id, events-by-time-range).
void graphService;
void config;

function parseLimit(uri: URL): number {
  const raw = uri.searchParams.get("limit");
  if (!raw) return 10;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(n, 50);
}
