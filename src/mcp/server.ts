import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "../config/env.js";
import { ingestionService } from "../services/ingestion-service.js";
import { searchService } from "../services/search-service.js";
import { graphService } from "../services/graph-service.js";
import { logger } from "../observability/logger.js";
import { subscribeModelCallLogs, type ModelCallLogRecord } from "../observability/model-call-log.js";
import type { SearchProgressEvent } from "../types.js";
import { watcherMcpService } from "../services/watcher-mcp-service.js";
import { pool } from "../db/pool.js";
import {
  listSources,
  createSource,
  archiveSource,
  restoreSource,
  deleteSource,
  getProjectStats
} from "../db/repositories.js";
import { registerMcpResources } from "./resources.js";
import { registerMcpPrompts } from "./prompts.js";

export function buildMcpServer(): McpServer {
  // When SAG_MCP_SOURCE_ID is set in the env, this MCP server is locked
  // to a single project ("scoped mode"). Project-management tools that
  // would touch other rows (list/create/archive/delete/stats) are either
  // scoped to the locked project or rejected outright, so a sandboxed
  // Trae config can hand out a single project's MCP surface without
  // exposing the rest of the tenant.
  const scopedSourceId = readConfiguredSourceId();
  const server = new McpServer(
    {
      name: "sag",
      version: "0.1.0"
    },
    scopedSourceId
      ? {
          instructions:
            `This SAG MCP server is scoped to project ${scopedSourceId}. ` +
            `Tools sag_list_projects / sag_create_project / sag_archive_project / sag_delete_project / sag_project_stats ` +
            `are restricted to this project only. sag_ingest_document / sag_search / sag_explain_search ` +
            `implicitly target this project; passing a different sourceId is rejected.`,
        }
      : undefined,
  );

  registerMcpTools(server, { scopedSourceId });
  registerMcpResources(server);
  registerMcpPrompts(server);

  return server;
}

function registerMcpTools(server: McpServer, opts: { scopedSourceId?: string } = {}): void {
  const { scopedSourceId } = opts;
  const scopedMode = Boolean(scopedSourceId);
  server.tool(
    "sag_ingest_document",
    {
      title: z.string().min(1),
      content: z.string().min(1),
      // Optional project binding. When omitted, falls back to
      // SAG_MCP_SOURCE_ID in the env. With neither set, the server
      // rejects the call — see readConfiguredSourceId().
      sourceId: z.string().uuid().optional(),
      metadata: z.record(z.unknown()).optional(),
      extract: z.boolean().optional(),
      waitForCompletion: z.boolean().optional(),
      chunking: z.object({
        mode: z.enum(["heading_strict", "token"]).optional(),
        maxTokens: z.number().int().min(64).max(8192).optional(),
        overlapTokens: z.number().int().min(0).max(4096).optional()
      }).optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const sourceId = input.sourceId ?? readConfiguredSourceId();
        if (!sourceId) {
          return jsonContent({
            error: {
              code: "SAG_MCP_SOURCE_ID_REQUIRED",
              message:
                "Pass `sourceId` in the tool arguments, or set SAG_MCP_SOURCE_ID in the MCP server env. " +
                "The ingest tool refuses to operate without an explicit project scope."
            }
          });
        }
        // Scoped mode: silently override any caller-supplied sourceId so a
        // misbehaving client cannot ingest into a different project. The
        // caller's `sourceId` arg is ignored.
        const effectiveSourceId = scopedMode ? (scopedSourceId as string) : sourceId;
        const result = await ingestionService.ingestDocument({
          ...input,
          sourceId: effectiveSourceId
        });
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_search",
    {
      query: z.string().min(1),
      // Optional: scope the search. Multiple ids supported.
      // Coerce-friendly schema: some MCP clients (Trae IDE) serialise
      // arrays/numbers as strings when calling tools. Accept the JSON-
      // encoded form so users can still get hits until the client is fixed.
      sourceIds: z
        .union([
          z.array(z.string().uuid()),
          z.string().transform((raw, ctx) => {
            const trimmed = raw.trim();
            let parsed: unknown;
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
              try {
                parsed = JSON.parse(trimmed);
              } catch {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid JSON array" });
                return z.NEVER;
              }
              if (!Array.isArray(parsed)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "expected JSON array" });
                return z.NEVER;
              }
            } else if (trimmed.includes(",")) {
              // CSV fallback — Trae sometimes flattens an array into a single
              // comma-separated string instead of JSON-encoding it.
              parsed = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
            } else {
              // Single id passed as bare string.
              parsed = [trimmed];
            }
            const uuidArray = z.array(z.string().uuid()).safeParse(parsed);
            if (!uuidArray.success) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sourceIds entries must be UUIDs" });
              return z.NEVER;
            }
            return uuidArray.data;
          })
        ])
        .optional(),
      strategy: z.enum(["vector", "multi"]).optional(),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      // Coerce numbers from strings (Trae IDE sometimes serialises 5 → "5").
      topK: z
        .union([z.number().int().positive().max(50), z.string().transform((raw, ctx) => {
          const n = Number(raw);
          if (!Number.isInteger(n) || n <= 0 || n > 50) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: "topK must be an integer in [1, 50]" });
            return z.NEVER;
          }
          return n;
        })])
        .optional(),
      returnTrace: z.boolean().optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        // Resolution order: arg.sourceIds → env SAG_MCP_SOURCE_ID → unset (search whole tenant).
        // Scoped mode short-circuits the chain and pins the search to the
        // single locked project, ignoring any caller-supplied sourceIds.
        //
        // "Project mode": if the configured sourceId points at a project
        // that has watched folders bound to it (via watched_folders.source_id
        // = projectId), we expand the source list to include the original
        // sources of those folders. This lets the project aggregate search
        // results from its attached folders without copying documents.
        const argSourceIds = input.sourceIds ?? [];
        const envSourceId = readConfiguredSourceId();
        let sourceIds: string[];
        if (scopedMode) {
          // The MCP was started with SAG_MCP_SOURCE_ID pointing at a
          // specific project. Validate it up front so the user gets a
          // helpful error (with valid candidates) instead of the generic
          // "source not found" from the search layer.
          await assertSourceExists(scopedSourceId as string);
          sourceIds = await expandProjectToSources(scopedSourceId as string, config.DEFAULT_TENANT_ID);
        } else if (argSourceIds.length > 0) {
          // Caller supplied source ids. Validate each one — partial
          // matches used to throw a cryptic error; now the user gets a
          // concrete list of which ids are wrong.
          for (const id of argSourceIds) {
            await assertSourceExists(id);
          }
          sourceIds = argSourceIds;
        } else if (envSourceId) {
          await assertSourceExists(envSourceId);
          sourceIds = await expandProjectToSources(envSourceId, config.DEFAULT_TENANT_ID);
        } else {
          // No scope configured — fan out to every non-archived project in the
          // tenant. searchService.search requires a non-empty array, and
          // passing [] would silently return zero hits.
          const all = await listSources({
            tenantId: config.DEFAULT_TENANT_ID,
            limit: 500,
            includeArchived: false
          });
          sourceIds = all.map((p) => p.id);
          if (sourceIds.length === 0) {
            return jsonContent({
              error: { code: "NO_PROJECTS", message: "No active projects in tenant. Create one first." }
            });
          }
        }
        const result = await searchService.search(
          {
            ...input,
            sourceIds,
            strategy: input.strategy ?? "multi",
            returnTrace: true
          },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result);
      } finally {
        unsubscribe();
      }
    }
  );

  server.tool(
    "sag_explain_search",
    {
      query: z.string().min(1),
      sourceIds: z.array(z.string().uuid()).optional(),
      searchMode: z.enum(["standard", "fast"]).optional(),
      subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
      topK: z.number().int().positive().max(50).optional()
    },
    async (input, extra) => {
      const notificationEmitter = createMcpNotificationEmitter(extra);
      const unsubscribe = notificationEmitter ? pipeMcpModelCallLogs(notificationEmitter) : () => undefined;
      try {
        const argSourceIds = input.sourceIds ?? [];
        const envSourceId = readConfiguredSourceId();
        let sourceIds: string[];
        if (scopedMode) {
          await assertSourceExists(scopedSourceId as string);
          sourceIds = [scopedSourceId as string];
        } else if (argSourceIds.length > 0) {
          for (const id of argSourceIds) {
            await assertSourceExists(id);
          }
          sourceIds = argSourceIds;
        } else if (envSourceId) {
          await assertSourceExists(envSourceId);
          sourceIds = [envSourceId];
        } else {
          const all = await listSources({
            tenantId: config.DEFAULT_TENANT_ID,
            limit: 500,
            includeArchived: false
          });
          sourceIds = all.map((p) => p.id);
          if (sourceIds.length === 0) {
            return jsonContent({
              error: { code: "NO_PROJECTS", message: "No active projects in tenant. Create one first." }
            });
          }
        }
        const result = await searchService.search(
          { ...input, sourceIds, strategy: "multi", returnTrace: true },
          undefined,
          notificationEmitter ? createMcpProgressEmitter(notificationEmitter) : undefined
        );
        return jsonContent(result.trace ?? result);
      } finally {
        unsubscribe();
      }
    }
  );

  // ─── Tenant-wide tools (no source-id requirement) ───────────────────────
  // Let a stdio MCP client operate the whole SAG: list / create / archive /
  // delete projects, inspect watcher health, etc. These intentionally
  // bypass SAG_MCP_SOURCE_ID so a single client can drive multiple projects
  // without restarting.

  server.tool(
    "sag_get_event",
    {
      eventId: z.string().uuid()
    },
    async (input) => {
      const result = await graphService.getEvent(input.eventId);
      return jsonContent(result ?? { error: { code: "EVENT_NOT_FOUND", message: "Event not found" } });
    }
  );

  // ─── Tenant-wide tools (no source-id requirement) ───────────────────────
  // These let a stdio MCP client operate the whole SAG: list / create /
  // archive / delete projects, inspect per-project stats. They intentionally
  // bypass SAG_MCP_SOURCE_ID so a single client can drive multiple projects
  // without restarting. Use them carefully — they touch DB rows directly.

  server.tool(
    "sag_list_projects",
    {
      includeArchived: z.boolean().optional(),
      limit: z.number().int().positive().max(500).optional()
    },
    async (input) => {
      try {
        // In scoped mode (SAG_MCP_SOURCE_ID is set), list only the locked
        // project. The optional inputs are accepted but ignored — keeping
        // the same schema avoids surprising clients that try them.
        if (scopedMode) {
          const rows = await listSources({
            tenantId: config.DEFAULT_TENANT_ID,
            limit: 500,
            includeArchived: true
          });
          const row = rows.find((r) => r.id === scopedSourceId) || null;
          return jsonContent({
            projects: row ? [{
              id: row.id,
              name: row.name,
              description: row.description,
              archivedAt: row.archivedAt,
              metadata: row.metadata,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt
            }] : [],
            count: row ? 1 : 0,
            scoped: true,
            scopedSourceId
          });
        }
        const rows = await listSources({
          tenantId: config.DEFAULT_TENANT_ID,
          limit: input.limit ?? 200,
          includeArchived: input.includeArchived ?? false
        });
        return jsonContent({
          projects: rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            archivedAt: row.archivedAt,
            metadata: row.metadata,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
          })),
          count: rows.length
        });
      } catch (error) {
        return jsonContent({ error: { code: "LIST_PROJECTS_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "sag_create_project",
    {
      name: z.string().min(1),
      description: z.string().optional(),
      metadata: z.record(z.unknown()).optional()
    },
    async (input) => {
      try {
        if (scopedMode) {
          return jsonContent({
            error: {
              code: "SCOPED_MODE_NO_CREATE",
              message:
                "This MCP server is scoped to a single project (SAG_MCP_SOURCE_ID). " +
                "Project creation is disabled. Use the unscoped 'sag' server entry to create new projects."
            }
          });
        }
        const row = await createSource({
          tenantId: config.DEFAULT_TENANT_ID,
          name: input.name,
          description: input.description,
          metadata: input.metadata
        });
        return jsonContent({ project: row });
      } catch (error) {
        return jsonContent({ error: { code: "CREATE_PROJECT_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "sag_archive_project",
    {
      projectId: z.string().uuid(),
      restore: z.boolean().optional()
    },
    async (input) => {
      try {
        if (scopedMode && input.projectId !== scopedSourceId) {
          return jsonContent({
            error: {
              code: "SCOPED_MODE_WRONG_PROJECT",
              message: `This MCP server is scoped to project ${scopedSourceId}; refusing to act on ${input.projectId}.`
            }
          });
        }
        const row = input.restore
          ? await restoreSource({ sourceId: input.projectId, tenantId: config.DEFAULT_TENANT_ID })
          : await archiveSource({ sourceId: input.projectId, tenantId: config.DEFAULT_TENANT_ID });
        return jsonContent({ project: row ?? null });
      } catch (error) {
        return jsonContent({ error: { code: "ARCHIVE_PROJECT_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "sag_delete_project",
    {
      projectId: z.string().uuid(),
      confirm: z.literal(true).describe("Must be true. The tool refuses to run without explicit consent.")
    },
    async (input) => {
      try {
        if (scopedMode && input.projectId !== scopedSourceId) {
          return jsonContent({
            error: {
              code: "SCOPED_MODE_WRONG_PROJECT",
              message: `This MCP server is scoped to project ${scopedSourceId}; refusing to delete ${input.projectId}.`
            }
          });
        }
        const ok = await deleteSource({
          sourceId: input.projectId,
          tenantId: config.DEFAULT_TENANT_ID
        });
        return jsonContent({ deleted: ok });
      } catch (error) {
        return jsonContent({ error: { code: "DELETE_PROJECT_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "sag_project_stats",
    {
      projectId: z.string().uuid()
    },
    async (input) => {
      try {
        if (scopedMode && input.projectId !== scopedSourceId) {
          return jsonContent({
            error: {
              code: "SCOPED_MODE_WRONG_PROJECT",
              message: `This MCP server is scoped to project ${scopedSourceId}; refusing to read stats for ${input.projectId}.`
            }
          });
        }
        const stats = await getProjectStats({
          sourceId: input.projectId,
          tenantId: config.DEFAULT_TENANT_ID
        });
        return jsonContent(stats);
      } catch (error) {
        return jsonContent({ error: { code: "PROJECT_STATS_FAILED", message: (error as Error).message } });
      }
    }
  );

  // ─── Sprint 2: Watched folders MCP tools ────────────────────────────────
  // These are intentionally not bound to a single project: the watcher is a
  // cross-cutting feature that operates on local folders. The MCP source-id
  // binding (SAG_MCP_SOURCE_ID) is for search/ingest, not for the watcher.

  server.tool(
    "add_watched_folder",
    {
      path: z.string().min(1),
      recursive: z.boolean().optional(),
      filetypeFilter: z.object({
        whitelist: z.array(z.string()).optional(),
        blacklist: z.array(z.string()).optional(),
        maxBytes: z.number().int().positive().optional()
      }).optional(),
      displayName: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      sourceId: z.string().uuid().optional()
    },
    async (input) => {
      try {
        const result = await watcherMcpService.addWatchedFolder({
          path: input.path,
          recursive: input.recursive,
          filetypeFilter: input.filetypeFilter,
          displayName: input.displayName,
          metadata: input.metadata,
          sourceId: input.sourceId
        });
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "ADD_WATCHED_FOLDER_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "list_watched_folders",
    {},
    async () => {
      try {
        const result = await watcherMcpService.listWatchedFolders();
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "LIST_WATCHED_FOLDERS_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "trigger_sync",
    {
      folderId: z.string().uuid()
    },
    async (input) => {
      try {
        const result = await watcherMcpService.triggerSync({ folderId: input.folderId });
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "TRIGGER_SYNC_FAILED", message: (error as Error).message } });
      }
    }
  );

  // ─── Retry failed ingest(s) ─────────────────────────────────────────────
  // Two companion tools. `retry_failed_file` targets one specific
  // relPath; `retry_failed_files` is the bulk version that picks up every
  // manifest row currently in `failed` for the folder. Both are
  // non-blocking: they enqueue work into the same queue the watcher
  // uses, so the actual ingest happens in the background.
  server.tool(
    "retry_failed_file",
    {
      folderId: z.string().uuid(),
      relPath: z.string().min(1)
    },
    async (input) => {
      try {
        const result = await watcherMcpService.retryFailedFile({
          folderId: input.folderId,
          relPath: input.relPath
        });
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "RETRY_FAILED_FILE_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "retry_failed_files",
    {
      folderId: z.string().uuid()
    },
    async (input) => {
      try {
        const result = await watcherMcpService.retryFailedFiles({ folderId: input.folderId });
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "RETRY_FAILED_FILES_FAILED", message: (error as Error).message } });
      }
    }
  );

  server.tool(
    "remove_watched_folder",
    {
      folderId: z.string().uuid()
    },
    async (input) => {
      try {
        const result = await watcherMcpService.removeWatchedFolder({ folderId: input.folderId });
        return jsonContent(result);
      } catch (error) {
        return jsonContent({ error: { code: "REMOVE_WATCHED_FOLDER_FAILED", message: (error as Error).message } });
      }
    }
  );
}

function readConfiguredSourceId(): string | undefined {
  const sourceId = process.env.SAG_MCP_SOURCE_ID?.trim() || process.env.SAG_MCP_PROJECT_ID?.trim();
  if (!sourceId) return undefined;
  const parsed = z.string().uuid().safeParse(sourceId);
  if (!parsed.success) {
    throw new Error(
      "SAG_MCP_SOURCE_ID is set but not a valid UUID. Either unset it to search across all " +
      "projects in the tenant, or fix it to a project UUID."
    );
  }
  return parsed.data;
}

/**
 * Look up a source id in the DB and return a friendlier "not found" error
 * that lists active projects, so the user can fix their mcp.json config
 * without having to start the web UI. Returns the row when found.
 */
async function assertSourceExists(sourceId: string): Promise<{ id: string; name: string }> {
  const result = await pool.query<{ id: string; name: string }>(
    "select id, name from sources where id = $1 and archived_at is null limit 1",
    [sourceId]
  );
  if (result.rows.length > 0) {
    return { id: String(result.rows[0].id), name: String(result.rows[0].name) };
  }
  // Build a helpful "this id doesn't exist" message with candidates the
  // user can paste into their config. Cap at 10 to keep the response small.
  const candidates = await pool.query<{ id: string; name: string }>(
    "select id, name from sources where archived_at is null order by created_at desc limit 10"
  );
  const list = candidates.rows.map((r) => `  • ${String(r.id)}  (${String(r.name)})`).join("\n");
  const extra = candidates.rows.length > 0
    ? `\n\nActive projects (copy one into SAG_MCP_SOURCE_ID):\n${list}`
    : "\n\nNo active projects in the tenant — create one in the web UI first.";
  throw new Error(
    `SAG_MCP_SOURCE_ID ${sourceId} does not match any active project in the database. ` +
    `Either the project was deleted/archived, or the id was copied wrong in your MCP config.${extra}`
  );
}

/**
 * Expand a configured "project" id to the list of source ids that
 * actually contain documents for it. Walks `watched_folders.source_id =
 * projectId`, then for each folder, pulls the original source id from
 * `metadata.formerSourceId` (stamped at attach time) — that's where the
 * folder's documents/chunks/events live, NOT the project id (which we
 * just rewired to point at the project for KB-overview bookkeeping).
 *
 * The project itself is included so any source-side docs ingested under
 * the project (uploads, the project folder itself) still match.
 *
 * Returns [projectId] alone if no folders are attached.
 */
async function expandProjectToSources(projectId: string, tenantId: string): Promise<string[]> {
  // Folder metadata.attachedProjectId is the binding written by
  // attachFoldersToProject (see src/watcher/manifest-store.ts).
  // The folder's source_id stays pointing at its own auto-source so
  // the auto-source UI keeps its documents; the project's stats /
  // docs / events queries expand across attached folders via this
  // metadata key.
  const result = await pool.query<{ source_id: string }>(
    `
      select source_id
      from watched_folders
      where tenant_id = $1
        and json_extract(metadata, '$.attachedProjectId') = $2
    `,
    [tenantId, projectId]
  );
  const sources = new Set<string>([projectId]);
  for (const row of result.rows) {
    if (row.source_id) sources.add(row.source_id);
  }
  return [...sources];
}

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

type McpToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
};

type McpNotificationEmitter = (message: unknown) => void;

function createMcpNotificationEmitter(extra: McpToolExtra): McpNotificationEmitter | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || typeof extra.sendNotification !== "function") {
    return undefined;
  }

  let progress = 0;
  return (message: unknown) => {
    progress += 1;
    void extra.sendNotification?.({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: JSON.stringify(message)
      }
    }).catch((error: unknown) => {
      logger.warn({ error }, "failed to send MCP progress notification");
    });
  };
}

function createMcpProgressEmitter(emit: McpNotificationEmitter) {
  return (event: SearchProgressEvent) => {
    emit({
      kind: "sag_search_progress",
      event
    });
  };
}

function pipeMcpModelCallLogs(emit?: McpNotificationEmitter): () => void {
  if (!emit) {
    return () => undefined;
  }
  return subscribeModelCallLogs((log: ModelCallLogRecord) => {
    emit({
      kind: "sag_model_call_log",
      log
    });
  });
}

export async function startMcpServer(): Promise<void> {
  // Initialise the DB pool first. db/pool.ts exports a lazy Proxy that
  // throws if used before initPool() resolves; some tool registrations
  // (e.g. listSources during the scoped-source-id preflight) touch the
  // pool synchronously inside this function.
  const { initPool } = await import("../db/pool.js");
  await initPool();

  // When the stdio launcher is run from a Trae-spawned context (cwd is
  // often %TEMP% or empty), relative DATABASE_FILE paths would silently
  // create a fresh, empty database on every launch. Pin it to the
  // install dir so the stdio MCP server shares the same SQLite file as
  // sag.exe when both live in the same folder.
  if (!process.env.DATABASE_FILE) {
    const nodePath = await import("node:path");
    const exec = process.execPath || "";
    const looksLikeNode = /node(\.exe)?$/i.test(exec.split(/[\\/]/).pop() || "");
    const exeDir = looksLikeNode ? process.cwd() : nodePath.dirname(exec);
    process.env.DATABASE_FILE = nodePath.join(exeDir, "data", "sag.db");
  }
  if (!process.env.DEFAULT_TENANT_ID) {
    process.env.DEFAULT_TENANT_ID = "default";
  }
  const nodePath = await import("node:path");
  const nodeFs = await import("node:fs");
  nodeFs.mkdirSync(nodePath.dirname(process.env.DATABASE_FILE), { recursive: true });

  // Fail-fast check: in scoped mode (SAG_MCP_SOURCE_ID set), the UUID
  // must resolve to an existing project for this tenant. Catching it at
  // boot avoids surfacing the same error on every single tool call later.
  const scoped = readConfiguredSourceId();
  if (scoped) {
    const all = await listSources({
      tenantId: process.env.DEFAULT_TENANT_ID,
      limit: 500,
      includeArchived: false
    });
    const match = all.find((p) => p.id === scoped);
    if (!match) {
      // No active project matches the configured id — most likely the
      // project was deleted/archived or the user copied the id wrong.
      // List active projects (cap the dump) so the user can fix their
      // mcp.json config without opening the web UI.
      const sample = all.slice(0, 10);
      const list = sample.length > 0
        ? `\n\nActive projects (copy one into SAG_MCP_SOURCE_ID):\n` +
          sample.map((p) => `  • ${p.id}  (${p.name})`).join("\n")
        : "\n\nNo active projects in the tenant — create one in the web UI first.";
      throw new Error(
        `SAG_MCP_SOURCE_ID=${scoped} does not match any active project in tenant ` +
        `'${process.env.DEFAULT_TENANT_ID}'. The id might be deleted, archived, or ` +
        `copied wrong in your MCP config. Unset it to run unscoped, or fix it.${list}`
      );
    }
    logger.info({ projectId: scoped, projectName: match.name }, "mcp: scoped mode active");
  }

  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("SAG MCP stdio server started");
}

// Placeholder so that buildMcpServer compiles before the resources/prompts
// modules are filled in. These modules own the actual registerMcp{Prompts,
// Resources} implementations and import-side-effect nothing here.
export const __registerMcpResources = registerMcpResources;
export const __registerMcpPrompts = registerMcpPrompts;

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer().catch((error: unknown) => {
    logger.error({ error }, "mcp server failed");
    process.exit(1);
  });
}
