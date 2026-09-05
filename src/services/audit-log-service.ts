// src/services/audit-log-service.ts — Append-only audit trail backed by
// the SQLite `audit_logs` table.
//
// The Postgres-flavoured `audit_log` (SAG project-wide) is the eventual
// destination when running against pgvector; this service writes to the
// SQLite `audit_logs` table that's part of the embedded default mode.
//
// Conventions:
//   - Every write is appended; there is no UPDATE / DELETE.
//   - Failures are logged at warn and swallowed — auditing must never
//     crash the calling request.
//   - The insert is parameterised to avoid SQL injection.
//
// This service feeds two call sites:
//   1. MCP HTTP auth/rate-limit events (src/mcp/http-server.ts).
//   2. Anything else that wants ops traceability — generic payload,
//      stable (entity_type, entity_id, action, actor) tuple.

import { randomUUID } from "node:crypto";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";

export interface AuditLogInsert {
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  payload?: Record<string, unknown>;
  tenantId?: string;
}

export interface AuditLogRecord {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export const AUDIT_LOG_ACTIONS = {
  HttpAuthSuccess: "http_auth_success",
  HttpAuthDenied: "http_auth_denied",
  HttpRateLimited: "http_rate_limited",
  HttpSessionOpened: "http_session_opened",
  HttpSessionClosed: "http_session_closed",
  HttpToolCall: "http_tool_call",
  ApiKeyCreated: "api_key_created",
  ApiKeyUpdated: "api_key_updated",
  ApiKeyRevoked: "api_key_revoked",
} as const;

export async function recordAuditLog(entry: AuditLogInsert): Promise<void> {
  if (!config.MCP_AUDIT_LOG_ENABLED) return;
  try {
    // SQLite's `current_timestamp` is second-precision; explicit ISO
    // strings give millisecond ordering so listAuditLogs("newest first")
    // is stable across rapid-fire inserts in tests.
    const createdAt = toLocalISO();
    await pool.query(
      `INSERT INTO audit_logs
        (id, tenant_id, entity_type, entity_id, action, actor, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        entry.tenantId ?? config.DEFAULT_TENANT_ID,
        entry.entityType,
        entry.entityId,
        entry.action,
        entry.actor,
        entry.payload ? JSON.stringify(entry.payload) : null,
        createdAt,
      ],
    );
  } catch (error) {
    logger.warn(
      {
        error: (error as Error).message,
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
      },
      "audit log insert failed; dropping record",
    );
  }
}

export interface AuditLogFilter {
  entityType?: string;
  entityId?: string;
  action?: string;
  actor?: string;
  since?: string;
  until?: string;
  limit?: number;
  tenantId?: string;
}

/**
 * Read-side helper for `GET /api/mcp/audit-log` and any future report UIs.
 * Returns rows in newest-first order. Pagination is offset-based; callers
 * that need true infinite scroll can extend with a `before` cursor later.
 */
export async function listAuditLogs(filter: AuditLogFilter): Promise<AuditLogRecord[]> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.tenantId) {
    where.push("tenant_id = ?");
    params.push(filter.tenantId);
  }
  if (filter.entityType) {
    where.push("entity_type = ?");
    params.push(filter.entityType);
  }
  if (filter.entityId) {
    where.push("entity_id = ?");
    params.push(filter.entityId);
  }
  if (filter.action) {
    where.push("action = ?");
    params.push(filter.action);
  }
  if (filter.actor) {
    where.push("actor = ?");
    params.push(filter.actor);
  }
  if (filter.since) {
    where.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until) {
    where.push("created_at <= ?");
    params.push(filter.until);
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);

  const sql =
    `SELECT id, tenant_id, entity_type, entity_id, action, actor, payload_json, created_at
       FROM audit_logs
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC
       LIMIT ${limit}`;

  const result = await pool.query<Record<string, unknown>>(sql, params);
  return result.rows.map(mapAuditRow);
}

function mapAuditRow(row: Record<string, unknown>): AuditLogRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? "default"),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    action: String(row.action),
    actor: String(row.actor),
    payload: parsePayload(row.payload_json),
    createdAt: String(row.created_at),
  };
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: value };
  }
}

/** Test-only: clear rows between tests. */
export async function clearAuditLogs(tenantId: string): Promise<void> {
  await pool.query("DELETE FROM audit_logs WHERE tenant_id = ?", [tenantId]);
}
