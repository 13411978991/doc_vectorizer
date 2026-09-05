// src/mcp/http-server.ts — Expose the MCP server over HTTP (Streamable HTTP
// transport) with bearer/api-key auth + per-token rate limiting.
//
// Architecture:
//   ┌────────────┐  ┌────────────────────────────────────────────┐
//   │  MCP       │  │  Native Node http server on MCP_HTTP_PORT   │
//   │  Client    │─►│  /mcp (StreamableHTTPServerTransport)        │
//   └────────────┘  │   ├─ auth.ts        (bearer / api-key)        │
//                   │   ├─ rate-limit     (per identity+IP)         │
//                   │   └─ buildMcpServer (one transport per       │
//                   │       session, with tools/resources/prompts)│
//                   └─────────────────────────────────────────────┘
//
// Stateful session mode is the default: every initialize() request gets a
// fresh transport so each LLM client has its own server instance, and all
// subsequent requests from that client reuse the same transport via the
// mcp-session-id header. Sessions live forever in this process — fine for
// the use-case (LLM clients), since they're long-lived.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { buildMcpServer } from "./server.js";
import {
  authorizeHttpRequest,
  consumeRateQuota,
  logDenial,
} from "./auth.js";
import {
  recordAuditLog,
  AUDIT_LOG_ACTIONS,
} from "../services/audit-log-service.js";

const SESSION_HEADER = "mcp-session-id";

type Session = {
  id: string;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  identity: string;
};

const sessions = new Map<string, Session>();

/** Test-only: drop all sessions. */
export async function resetHttpMcpServer(): Promise<void> {
  for (const session of sessions.values()) {
    try { await session.transport.close(); } catch {}
  }
  sessions.clear();
}

/** Stats for observability / tests. */
export function httpMcpSessionStats(): {
  count: number;
  identities: Record<string, number>;
} {
  const identities: Record<string, number> = {};
  for (const session of sessions.values()) {
    identities[session.identity] = (identities[session.identity] ?? 0) + 1;
  }
  return { count: sessions.size, identities };
}

export async function startMcpHttpServer(): Promise<{
  port: number;
  host: string;
  path: string;
  close: () => Promise<void>;
}> {
  const host = config.HTTP_HOST;
  const port = config.MCP_HTTP_PORT;
  const mcpPath = config.MCP_HTTP_PATH;

  const server = createServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
      logger.error({ error, url: req.url }, "mcp http handler crashed");
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: "unexpected" } }));
      }
    });
  });

  // When the configured port is 0, the OS assigns the real port on
  // listen(). Capture it so callers (and tests) can construct URLs.
  let boundPort = port;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") boundPort = addr.port;
      server.off("error", onError);
      resolve();
    });
  });

  logger.info({ host, port: boundPort, path: mcpPath, mode: config.MCP_AUTH_MODE }, "SAG MCP http server listening");

  return {
    port: boundPort,
    host,
    path: mcpPath,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Always answer CORS preflight with permissive defaults — LLM clients
  // running in the browser (e.g. claude.ai) talk to the MCP server from
  // a different origin. We rely on Authorization / X-MCP-Key for auth,
  // not CORS.
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== config.MCP_HTTP_PATH) {
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such endpoint" } }));
    return;
  }

  // ── auth ──
  const remoteIp = req.socket?.remoteAddress ?? "unknown";
  const auth = await authorizeHttpRequest(req);
  if (!auth.ok) {
    logDenial(req, auth.reason);
    void recordAuditLog({
      entityType: "mcp_http_request",
      entityId: pickHeader(req.headers[SESSION_HEADER]) ?? "no-session",
      action: AUDIT_LOG_ACTIONS.HttpAuthDenied,
      actor: "anonymous",
      payload: {
        ip: remoteIp,
        method: req.method,
        url: req.url,
        mode: config.MCP_AUTH_MODE,
        reason: auth.reason,
      },
    });
    respondError(res, 401, "UNAUTHORIZED", auth.reason);
    return;
  }
  if (!consumeRateQuota(auth.identity, remoteIp)) {
    logDenial(req, "rate-limited");
    void recordAuditLog({
      entityType: "mcp_http_request",
      entityId: pickHeader(req.headers[SESSION_HEADER]) ?? "no-session",
      action: AUDIT_LOG_ACTIONS.HttpRateLimited,
      actor: auth.identity,
      payload: { ip: remoteIp, method: req.method, url: req.url },
    });
    respondError(res, 429, "RATE_LIMITED", "request rate limit exceeded; retry in a minute");
    return;
  }
  const identity = auth.identity;
  // Audit accepted requests too — but only after rate-limit, so a noisy
  // attacker doesn't fill the audit table with their misbehavior.
  void recordAuditLog({
    entityType: "mcp_http_request",
    entityId: pickHeader(req.headers[SESSION_HEADER]) ?? "no-session",
    action: AUDIT_LOG_ACTIONS.HttpAuthSuccess,
    actor: identity,
    payload: { ip: remoteIp, method: req.method, url: req.url },
  });

  // Only POST / GET / DELETE are valid per MCP spec.
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    respondError(res, 405, "METHOD_NOT_ALLOWED", `MCP ${req.method} not allowed`);
    return;
  }

  // ── body ──
  let body: unknown = undefined;
  if (req.method === "POST") {
    const raw = await readBody(req);
    if (raw) {
      try { body = JSON.parse(raw); }
      catch { respondError(res, 400, "BAD_REQUEST", "body is not valid JSON"); return; }
    }
  }

  // ── session routing ──
  const incomingSessionId = pickHeader(req.headers[SESSION_HEADER]);
  let session: Session | undefined;
  if (incomingSessionId) {
    session = sessions.get(incomingSessionId);
    if (!session) {
      respondError(res, 400, "UNKNOWN_SESSION", "session id not recognized; call initialize again");
      return;
    }
  } else if (req.method === "POST" && isInitialize(body)) {
    session = await createSession(identity);
  } else if (req.method !== "GET") {
    // Non-initialize POST without a session is rejected.
    respondError(res, 400, "MISSING_SESSION", "POST /mcp must carry mcp-session-id or be an initialize");
    return;
  }

  // No session yet AND method is GET — for SSE stream replay. We'll give a
  // fresh session-less transport; the SDK closes it right after if the
  // request didn't reference one.
  const transport = session
    ? session.transport
    : await createEphemeralTransport();

  // Capture tool-call start time / id so we can correlate duration in the
  // audit log without relying on the transport's internal request-id.
  const toolCall = isToolCall(body);
  const toolCallStartedAt = toolCall ? Date.now() : null;

  try {
    await transport.handleRequest(req, res, body as JSONRPCMessage | undefined);
  } catch (error) {
    logger.error({ error }, "mcp http transport failed");
    if (!res.writableEnded) {
      respondError(res, 500, "TRANSPORT", "MCP transport error");
    }
  } finally {
    // Ephemeral transports are throwaways; persistent ones stay in the map.
    if (!session) await transport.close().catch(() => undefined);
    if (toolCall && session) {
      void recordAuditLog({
        entityType: "mcp_http_tool_call",
        entityId: session.id,
        action: AUDIT_LOG_ACTIONS.HttpToolCall,
        actor: session.identity,
        payload: summarizeToolCall(body, toolCallStartedAt),
      });
    }
  }
}

/**
 * Detect a `tools/call` JSON-RPC request. We only log real tool
 * invocations — listing, notifications, etc. are noise.
 */
function isToolCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const msg = body as { method?: unknown };
  return msg.method === "tools/call";
}

/**
 * Build an audit payload for a tool invocation. Keep it bounded — large
 * args from `sag_ingest_document` (raw content) would otherwise bloat the
 * audit table.
 */
function summarizeToolCall(body: unknown, startedAt: number | null): Record<string, unknown> {
  const msg = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const name = typeof params.name === "string" ? params.name : "unknown";
  const durationMs = startedAt !== null ? Date.now() - startedAt : null;
  return {
    tool: name,
    jsonrpcId: typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null,
    argKeys: Object.keys(args),
    durationMs,
  };
}

async function createSession(identity: string): Promise<Session> {
  const id = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
  });
  transport.onclose = () => {
    const existing = sessions.get(id);
    sessions.delete(id);
    logger.debug({ sessionId: id }, "mcp session closed");
    if (existing) {
      void recordAuditLog({
        entityType: "mcp_http_session",
        entityId: id,
        action: AUDIT_LOG_ACTIONS.HttpSessionClosed,
        actor: existing.identity,
        payload: {
          lifetimeMs: Date.now() - existing.createdAt,
          reason: "transport_closed",
        },
      });
    }
  };
  transport.onerror = (error) => {
    logger.warn({ sessionId: id, error }, "mcp transport error");
  };
  await buildMcpServer().connect(transport);
  const session: Session = { id, transport, createdAt: Date.now(), identity };
  sessions.set(id, session);
  logger.info({ sessionId: id, identity }, "mcp session opened");
  void recordAuditLog({
    entityType: "mcp_http_session",
    entityId: id,
    action: AUDIT_LOG_ACTIONS.HttpSessionOpened,
    actor: identity,
    payload: { ip: "recorded-on-success" },
  });
  return session;
}

async function createEphemeralTransport(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await buildMcpServer().connect(transport);
  return transport;
}

function isInitialize(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const msg = body as { method?: unknown };
  return msg.method === "initialize";
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const total = chunks.reduce((acc, b) => acc + b.length, 0);
      if (total === 0) return resolve(undefined);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function setCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, mcp-session-id, authorization, x-mcp-key",
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id");
  res.setHeader("access-control-max-age", "86400");
}

function pickHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function respondError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: { code, message } }));
}
