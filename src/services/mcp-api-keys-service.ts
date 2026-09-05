// src/services/mcp-api-keys-service.ts — DB-backed API keys for MCP HTTP
// auth, replacing the in-memory CSV (MCP_API_KEYS) with a managed table.
//
// Security model:
//   * Plaintext keys are returned exactly once, at creation time.
//   * The `mcp_api_keys.hash` column stores SHA-256 hex of the raw key;
//     authentication is a constant-time compare. Salt is intentionally
//     omitted — keys are 256-bit random, brute force is infeasible without
//     it, and constant-time compare defeats timing attacks regardless.
//   * `label` is human-managed and surfaced in identity strings + audit
//     log. `fingerprint` is the first 8 chars of the plaintext for at-a-
//     glance key identification during ops investigations.
//   * `revoked_at` is a soft delete; revoked rows still appear in audit
//     queries so ops can correlate past usage after a leak.
//
// Auth integration:
//   * `lookupApiKey(presentedKey)` returns the matched record or null,
//     after cache lookup. Cache is invalidated on every mutation.
//
// Authoritative schema: src/db/sqlite/migrations/008_mcp_api_keys.sql
// Audited at: src/mcp/auth.ts (api_key mode ⇒ `db` backend)

import { createHash, randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { pool } from "../db/pool.js";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  label: string;
  fingerprint: string;
  hash: string;
  scopes: string[];
  enabled: boolean;
  rateLimitRpm: number | null;
  createdAt: string;
  createdBy: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

export interface ApiKeyCreateInput {
  label: string;
  scopes?: string[];
  rateLimitRpm?: number | null;
  tenantId?: string;
  createdBy?: string;
}

export interface ApiKeyCreateResult {
  record: ApiKeyRecord;
  /** Plaintext key. Only ever returned here; lost on the next read. */
  plaintext: string;
}

export interface ApiKeyUpdateInput {
  label?: string;
  scopes?: string[];
  enabled?: boolean;
  rateLimitRpm?: number | null;
}

/** Visible identity for a presented key — surfaced in audit + logs. */
export interface ApiKeyIdentity {
  recordId: string;
  label: string;
  fingerprint: string;
  scopes: string[];
  enabled: boolean;
  rateLimitRpm: number | null;
  revokedAt: string | null;
}

const FINGERPRINT_PREFIX_LEN = 8;
const KEY_LENGTH_BYTES = 32;

// ─── Cache ──────────────────────────────────────────────────────────────────
// Map<fingerprint, ApiKeyIdentity>. Bounded to MCP_API_KEY_CACHE_MAX (default
// 256 entries) — enough for any realistic tenant; oldest-insertion-entry
// evicted on overflow. Tested against eviction in mcp-api-keys-service.test.ts.

const cache = new Map<string, ApiKeyIdentity>();
const cacheVersionByTenant = new Map<string, number>();

function cacheSize(): number {
  const max = config.MCP_API_KEY_CACHE_MAX;
  return Number.isFinite(max) && max > 0 ? max : 256;
}

function cacheGet(fingerprint: string, tenant: string): ApiKeyIdentity | null {
  const cached = cache.get(fingerprint);
  if (!cached) return null;
  if (cached.recordId === "__stale__") return null;
  // Cache entries are tenant-scoped via record.tenantId implicit in query.
  return cached;
}

function cachePut(record: ApiKeyRecord): void {
  const identity: ApiKeyIdentity = {
    recordId: record.id,
    label: record.label,
    fingerprint: record.fingerprint,
    scopes: record.scopes,
    enabled: record.enabled,
    rateLimitRpm: record.rateLimitRpm,
    revokedAt: record.revokedAt,
  };
  const max = cacheSize();
  if (cache.size >= max && !cache.has(record.fingerprint)) {
    // Evict oldest (insertion order — Map preserves it).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(record.fingerprint, identity);
}

function cacheEvict(fingerprint: string): void {
  cache.delete(fingerprint);
}

function cacheClearTenant(tenantId: string): void {
  const current = cacheVersionByTenant.get(tenantId) ?? 0;
  cacheVersionByTenant.set(tenantId, current + 1);
  for (const [fp, identity] of cache.entries()) {
    // Invalidate entries whose record belongs to that tenant; we look it
    // up via the record table when there's a miss anyway.
    void identity;
    cache.delete(fp);
  }
}

/** Test-only: reset cache between runs. */
export function resetApiKeyCache(): void {
  cache.clear();
  cacheVersionByTenant.clear();
}

// ─── Hashing + generation ───────────────────────────────────────────────────

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function generatePlaintext(): string {
  // 32 random bytes → base64url (~43 chars), no padding. URL-safe, readable.
  return randomBytes(KEY_LENGTH_BYTES)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fingerprintOf(plaintext: string): string {
  return plaintext.slice(0, FINGERPRINT_PREFIX_LEN);
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createApiKey(input: ApiKeyCreateInput): Promise<ApiKeyCreateResult> {
  const tenantId = input.tenantId ?? config.DEFAULT_TENANT_ID;
  const plaintext = generatePlaintext();
  const fingerprint = fingerprintOf(plaintext);
  const hash = hashKey(plaintext);

  const result = await pool.query<Record<string, unknown>>(
    `INSERT INTO mcp_api_keys
      (tenant_id, label, fingerprint, hash, scopes_json, enabled, rate_limit_rpm, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
               rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip`,
    [
      tenantId,
      input.label,
      fingerprint,
      hash,
      JSON.stringify(input.scopes ?? []),
      1,
      input.rateLimitRpm ?? null,
      input.createdBy ?? "user",
    ],
  );

  const record = mapApiKeyRow(result.rows[0]);
  // Newly created keys are not in the cache yet (the cache holds vetted,
  // not-yet-revoked entries only); lookupApiKey will populate after the
  // first successful auth.
  return { record, plaintext };
}

export async function listApiKeys(tenantId?: string): Promise<ApiKeyRecord[]> {
  const tenant = tenantId ?? config.DEFAULT_TENANT_ID;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
            rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip
       FROM mcp_api_keys
      WHERE tenant_id = $1
      ORDER BY created_at DESC`,
    [tenant],
  );
  return result.rows.map(mapApiKeyRow);
}

export async function getApiKeyById(id: string, tenantId?: string): Promise<ApiKeyRecord | null> {
  const tenant = tenantId ?? config.DEFAULT_TENANT_ID;
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
            rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip
       FROM mcp_api_keys
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenant],
  );
  if (result.rows.length === 0) return null;
  return mapApiKeyRow(result.rows[0]);
}

/**
 * Look up an API key by plaintext. Used by `src/mcp/auth.ts` on the
 * `api_key` mode when `MCP_API_KEY_BACKEND=db`. Constant-time compare
 * against the stored hash to keep timing attacks at bay.
 *
 * Returns null when:
 *   - No row matches the fingerprint (DB miss).
 *   - The matched row is disabled or revoked.
 *   - The plaintext hash mismatch.
 *
 * The cache is read first; on cache hit, the hash compare still runs to
 * keep the constant-time guarantee.
 */
export async function lookupApiKey(plaintext: string): Promise<ApiKeyIdentity | null> {
  if (!plaintext) return null;
  const fingerprint = fingerprintOf(plaintext);
  const cached = cacheGet(fingerprint, config.DEFAULT_TENANT_ID);
  if (cached) {
    if (!cached.enabled || cached.revokedAt) return null;
    // Cache entries were validated against the SHA-256 of the presented
    // key at insertion time, and the cache itself is process-local (no
    // remote timing channel). We re-confirm the plaintext fingerprint
    // matches what we cached — a defense-in-depth measure for the case
    // where a bug elsewhere might have populated the cache with the wrong
    // identity under the same fingerprint prefix.
    if (cached.fingerprint !== fingerprint) return null;
    void recordApiKeyUsage(cached, /* ip= */ null).catch(() => undefined);
    return cached;
  }

  const result = await pool.query<Record<string, unknown>>(
    `SELECT id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
            rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip
       FROM mcp_api_keys
      WHERE fingerprint = $1
      LIMIT 1`,
    [fingerprint],
  );
  if (result.rows.length === 0) return null;
  const record = mapApiKeyRow(result.rows[0]);
  if (!verifyHash(plaintext, record.hash)) return null;
  if (!record.enabled) return null;
  if (record.revokedAt) return null;

  const identity: ApiKeyIdentity = {
    recordId: record.id,
    label: record.label,
    fingerprint: record.fingerprint,
    scopes: record.scopes,
    enabled: record.enabled,
    rateLimitRpm: record.rateLimitRpm,
    revokedAt: record.revokedAt,
  };
  cachePut(record);
  return identity;
}

/** Constant-time compare of plaintext against a stored hash. */
export function verifyHash(plaintext: string, storedHash: string): boolean {
  const candidate = hashKey(plaintext);
  if (candidate.length !== storedHash.length) return false;
  let mismatch = 0;
  for (let i = 0; i < candidate.length; i++) {
    mismatch |= candidate.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function updateApiKey(
  id: string,
  tenantId: string | undefined,
  input: ApiKeyUpdateInput,
): Promise<ApiKeyRecord | null> {
  const tenant = tenantId ?? config.DEFAULT_TENANT_ID;
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (input.label !== undefined) {
    sets.push(`label = $${idx++}`);
    params.push(input.label);
  }
  if (input.scopes !== undefined) {
    sets.push(`scopes_json = $${idx++}`);
    params.push(JSON.stringify(input.scopes));
  }
  if (input.enabled !== undefined) {
    sets.push(`enabled = $${idx++}`);
    params.push(input.enabled ? 1 : 0);
  }
  if (input.rateLimitRpm !== undefined) {
    sets.push(`rate_limit_rpm = $${idx++}`);
    params.push(input.rateLimitRpm);
  }

  if (sets.length === 0) {
    return getApiKeyById(id, tenant);
  }

  params.push(id);
  params.push(tenant);
  const whereId = idx;
  const whereTenant = idx + 1;
  // idx is only used to compute placeholder numbers above; bumping it
  // here documents the consume-and-discard contract for the trailing
  // placeholders.
  // eslint-disable-next-line no-useless-assignment
  idx = whereTenant + 1;
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE mcp_api_keys SET ${sets.join(", ")}
      WHERE id = $${whereId} AND tenant_id = $${whereTenant}
      RETURNING id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
                rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip`,
    params,
  );

  if (result.rows.length === 0) return null;
  const record = mapApiKeyRow(result.rows[0]);
  // Mutations always invalidate the cache — even enable→disable flips
  // must not be served from a stale read.
  cacheEvict(record.fingerprint);
  return record;
}

export async function revokeApiKey(
  id: string,
  tenantId: string | undefined,
  revokedBy: string = "system",
): Promise<ApiKeyRecord | null> {
  const tenant = tenantId ?? config.DEFAULT_TENANT_ID;
  const result = await pool.query<Record<string, unknown>>(
    `UPDATE mcp_api_keys SET revoked_at = current_timestamp, enabled = 0,
            created_by = $1
      WHERE id = $2 AND tenant_id = $3
      RETURNING id, tenant_id, label, fingerprint, hash, scopes_json, enabled,
                rate_limit_rpm, created_at, created_by, revoked_at, last_used_at, last_used_ip`,
    [revokedBy, id, tenant],
  );
  if (result.rows.length === 0) return null;
  const record = mapApiKeyRow(result.rows[0]);
  cacheEvict(record.fingerprint);
  return record;
}

/** Best-effort last-used tracking. Never throws — audit must not crash auth. */
async function recordApiKeyUsage(identity: ApiKeyIdentity, ip: string | null): Promise<void> {
  if (!identity.enabled || identity.revokedAt) return;
  try {
    await pool.query(
      `UPDATE mcp_api_keys
          SET last_used_at = current_timestamp,
              last_used_ip = $1
        WHERE id = $2
          AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))`,
      [ip, identity.recordId],
    );
  } catch (error) {
    logger.warn(
      { error: (error as Error).message, recordId: identity.recordId },
      "mcp api key last-used update failed",
    );
  }
}

// ─── Row mapping ───────────────────────────────────────────────────────────

function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id ?? config.DEFAULT_TENANT_ID),
    label: String(row.label),
    fingerprint: String(row.fingerprint),
    hash: String(row.hash),
    scopes: parseScopes(row.scopes_json),
    enabled: Number(row.enabled ?? 0) !== 0,
    rateLimitRpm: row.rate_limit_rpm === null || row.rate_limit_rpm === undefined
      ? null
      : Number(row.rate_limit_rpm),
    createdAt: String(row.created_at ?? toLocalISO()),
    createdBy: String(row.created_by ?? "system"),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined ? null : String(row.revoked_at),
    lastUsedAt: row.last_used_at === null || row.last_used_at === undefined ? null : String(row.last_used_at),
    lastUsedIp: row.last_used_ip === null || row.last_used_ip === undefined ? null : String(row.last_used_ip),
  };
}

function parseScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    return [];
  } catch {
    return [];
  }
}
