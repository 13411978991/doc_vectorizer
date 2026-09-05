// src/api/mcp-api-keys.ts — REST endpoints for managing DB-backed MCP API
// keys. Backed by src/services/mcp-api-keys-service.ts.
//
// Surface:
//   GET    /api/mcp/api-keys       — list (tenant-scoped, no plaintext)
//   POST   /api/mcp/api-keys       — create (returns plaintext ONCE)
//   GET    /api/mcp/api-keys/:id   — read metadata
//   PATCH  /api/mcp/api-keys/:id   — update label / scopes / enabled /
//                                    rate-limit-override
//   DELETE /api/mcp/api-keys/:id   — soft-revoke (sets revoked_at)
//
// Scoping defaults to config.DEFAULT_TENANT_ID; pass ?tenantId=... to
// scope explicitly. All inputs are Zod-validated.
//
// Importantly: the create path returns the plaintext key exactly once.
// Subsequent reads never see it again — only the SHA-256 hash lives in
// the table.

import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config/env.js";
import {
  createApiKey,
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "../services/mcp-api-keys-service.js";
import { recordAuditLog, AUDIT_LOG_ACTIONS } from "../services/audit-log-service.js";

const createSchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(z.string().min(1)).max(32).optional(),
  rateLimitRpm: z.number().int().positive().max(10_000).optional(),
  tenantId: z.string().min(1).optional(),
  createdBy: z.string().min(1).optional(),
});

const patchSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  scopes: z.array(z.string().min(1)).max(32).optional(),
  enabled: z.boolean().optional(),
  rateLimitRpm: z.number().int().min(0).max(10_000).optional(),
});

const listQuerySchema = z.object({
  tenantId: z.string().min(1).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

function parseTenant(req: FastifyRequest): string {
  const q = req.query as { tenantId?: string };
  return q?.tenantId && typeof q.tenantId === "string" && q.tenantId.length > 0
    ? q.tenantId
    : config.DEFAULT_TENANT_ID;
}

export function registerMcpApiKeysRoutes(app: FastifyInstance): void {
  app.get("/api/mcp/api-keys", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "invalid list query" },
      });
    }
    try {
      const tenant = parsed.data.tenantId ?? config.DEFAULT_TENANT_ID;
      const all = await listApiKeys(tenant);
      const limit = parsed.data.limit ? Math.min(Number.parseInt(parsed.data.limit, 10), 1000) : all.length;
      const sliced = all.slice(0, limit);
      // Always strip hash from list output; callers can request detail via
      // GET /:id which still omits the hash (and always does — no plain-
      // text is ever reissued).
      const safe = sliced.map(stripHash);
      return reply.code(200).send({ tenantId: tenant, count: safe.length, keys: safe });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "MCP_API_KEY_LIST_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });

  app.post("/api/mcp/api-keys", async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: parsed.error.issues.map((i) => i.message).join("; ") },
      });
    }
    try {
      const { record, plaintext } = await createApiKey(parsed.data);
      void recordAuditLog({
        entityType: "mcp_api_key",
        entityId: record.id,
        action: AUDIT_LOG_ACTIONS.ApiKeyCreated,
        actor: record.createdBy,
        payload: {
          label: record.label,
          fingerprint: record.fingerprint,
          scopes: record.scopes,
          rateLimitRpm: record.rateLimitRpm,
        },
      });
      return reply.code(201).send({
        key: stripHash(record),
        plaintext,
      });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "MCP_API_KEY_CREATE_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });

  app.get("/api/mcp/api-keys/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const paramsCheck = idParamSchema.safeParse(request.params ?? {});
    if (!paramsCheck.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "id must be a UUID" },
      });
    }
    const tenant = parseTenant(request);
    try {
      const key = await getApiKeyById(paramsCheck.data.id, tenant);
      if (!key) {
        return reply.code(404).send({
          error: { code: "MCP_API_KEY_NOT_FOUND", message: "api key not found" },
        });
      }
      return reply.code(200).send({ key: stripHash(key) });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "MCP_API_KEY_GET_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });

  app.patch("/api/mcp/api-keys/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const paramsCheck = idParamSchema.safeParse(request.params ?? {});
    if (!paramsCheck.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "id must be a UUID" },
      });
    }
    const bodyParsed = patchSchema.safeParse(request.body ?? {});
    if (!bodyParsed.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: bodyParsed.error.issues.map((i) => i.message).join("; ") },
      });
    }
    const tenant = parseTenant(request);
    try {
      const updated = await updateApiKey(paramsCheck.data.id, tenant, bodyParsed.data);
      if (!updated) {
        return reply.code(404).send({
          error: { code: "MCP_API_KEY_NOT_FOUND", message: "api key not found" },
        });
      }
      void recordAuditLog({
        entityType: "mcp_api_key",
        entityId: updated.id,
        action: AUDIT_LOG_ACTIONS.ApiKeyUpdated,
        actor: updated.createdBy,
        payload: {
          label: updated.label,
          enabled: updated.enabled,
          scopes: updated.scopes,
          rateLimitRpm: updated.rateLimitRpm,
        },
      });
      return reply.code(200).send({ key: stripHash(updated) });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "MCP_API_KEY_UPDATE_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });

  app.delete("/api/mcp/api-keys/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const paramsCheck = idParamSchema.safeParse(request.params ?? {});
    if (!paramsCheck.success) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "id must be a UUID" },
      });
    }
    const tenant = parseTenant(request);
    const bodyQ = (request.body ?? {}) as { revokedBy?: string };
    const revokedBy = typeof bodyQ.revokedBy === "string" && bodyQ.revokedBy.length > 0
      ? bodyQ.revokedBy
      : "user";
    try {
      const revoked = await revokeApiKey(paramsCheck.data.id, tenant, revokedBy);
      if (!revoked) {
        return reply.code(404).send({
          error: { code: "MCP_API_KEY_NOT_FOUND", message: "api key not found" },
        });
      }
      void recordAuditLog({
        entityType: "mcp_api_key",
        entityId: revoked.id,
        action: AUDIT_LOG_ACTIONS.ApiKeyRevoked,
        actor: revokedBy,
        payload: { label: revoked.label, fingerprint: revoked.fingerprint },
      });
      return reply.code(200).send({ key: stripHash(revoked) });
    } catch (error) {
      return reply.code(500).send({
        error: {
          code: "MCP_API_KEY_REVOKE_FAILED",
          message: (error as Error).message,
        },
      });
    }
  });
}

function stripHash(key: {
  id: string;
  tenantId: string;
  label: string;
  fingerprint: string;
  scopes: string[];
  enabled: boolean;
  rateLimitRpm: number | null;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}) {
  return {
    id: key.id,
    tenantId: key.tenantId,
    label: key.label,
    fingerprint: key.fingerprint,
    scopes: key.scopes,
    enabled: key.enabled,
    rateLimitRpm: key.rateLimitRpm,
    createdAt: key.createdAt,
    createdBy: key.createdBy,
    revokedAt: key.revokedAt,
    lastUsedAt: key.lastUsedAt,
    lastUsedIp: key.lastUsedIp,
  };
}
