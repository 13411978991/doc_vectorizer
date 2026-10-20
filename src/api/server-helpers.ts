/**
 * src/api/server-helpers.ts — Shared utilities and Zod schemas for the
 * Fastify REST routes under src/api/*.
 *
 * - `notFound(code, message)`: build the canonical `{error:{code,message}}`
 *   envelope for 404 responses.
 * - `readTenant(request)`: parse the `?tenantId=` query string and fall
 *   back to `config.DEFAULT_TENANT_ID` — single source of truth so every
 *   route handler agrees.
 * - `getErrorMessage(error)`: collapse Zod vs Error vs unknown into the
 *   user-facing message that bubbles up through SSE `error` events and
 *   the global error handler.
 * - `isAbortError(error)`: distinguish AbortError from other failures
 *   so the SSE stream path can avoid emitting a misleading error event
 *   when the client disconnects mid-stream.
 * - All Zod schemas (`ingestSchema`, `searchSchema`, `uploadSchema`,
 *   `projectSchema`, `projectUpdateSchema`, `documentUpdateSchema`,
 *   `createMcpSessionSchema`, `mcpMessageSchema`, `aiSettingsSchema`,
 *   `tenantQuerySchema`): shared between the inline registration in
 *   server.ts and the standalone registerXxxRoutes() entry points in
 *   the per-domain route files. Centralizing them here keeps validation
 *   consistent and avoids subtle drift between duplicated schemas.
 */

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { config, SUPPORTED_EMBEDDING_DIMENSIONS } from "../config/env.js";

export function notFound(code: string, message: string): {
  error: { code: string; message: string };
} {
  return { error: { code, message } };
}

const tenantQuerySchema = z.object({
  tenantId: z.string().min(1).optional()
});

export function readTenant(request: FastifyRequest): string {
  const parsed = tenantQuerySchema.safeParse(request.query ?? {});
  if (parsed.success && parsed.data.tenantId) {
    return parsed.data.tenantId;
  }
  return config.DEFAULT_TENANT_ID;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cheap RFC 4122 UUID format check. Used by routes whose path params
 * are loose enough to accept any string, but the DB layer expects a
 * UUID for the lookup column. Returning false here lets the route
 * short-circuit with a 404 / empty payload instead of letting the SQL
 * engine throw a less friendly error.
 *
 * Notes:
 *  - We intentionally do NOT validate the variant/version bits — a
 *    format check is enough to keep legacy / non-UUID rows (debug
 *    fixtures, hand-rolled test seeds) from reaching the DB layer.
 *  - Zod's `.uuid()` does more (it enforces the version bit) and is
 *    the right tool for *body* validation where the client is
 *    constructing the id. Path params are user-influenced but the
 *    underlying entity already exists, so the DB lookup is the
 *    canonical check.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Read a path parameter that the route registered in its URL pattern.
 * Returns null when the param is missing or not a string. We don't
 * validate UUID format here — the DB lookup will surface a 404 if
 * the id doesn't exist, and the route can decide whether to also
 * surface a 400 for malformed input.
 */
export function readUuidParam(request: FastifyRequest, key: string): string | null {
  const params = request.params as Record<string, string>;
  const raw = params[key];
  if (typeof raw !== "string") {
    return null;
  }
  return raw;
}

/**
 * Canonical error envelope used across every route. Centralised so the
 * shape is identical regardless of which `registerXxxRoutes` module is
 * handling the request.
 */
export function apiError(code: string, message: string): {
  error: { code: string; message: string };
} {
  return { error: { code, message } };
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    // Surface the failing field so the web UI can show something
    // actionable. Without this, every validation error collapses
    // to the generic "请求参数无效" / "Invalid request parameters"
    // and the user has no idea which field is wrong.
    const issue = error.issues[0];
    if (issue) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    }
    return "请求参数无效 (no issues)";
  }
  // Fall back to the original "request invalid" message but include
  // the error's class name so the next debugging session doesn't
  // have to guess. Most callers wrap a ZodError inside a Fastify
  // error envelope, so the instanceof check above misses those.
  const errorName = error && typeof error === "object" && "name" in error
    ? String((error as { name: unknown }).name)
    : typeof error;
  const errorMessage = error instanceof Error ? error.message : String(error);
  return `请求参数无效 (${errorName}: ${errorMessage})`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Schema for an AI endpoint base URL.
 *
 * Rejects non-http(s) schemes and forces https:// by default. The LLM
 * client (`src/ai/llm-client.ts`) ships the API key as
 * `Authorization: Bearer ...` on every outbound POST, so allowing
 * `http://...` here would silently downgrade the key to cleartext on
 * the wire. Audit finding F-3 (2026-09-28).
 *
 * Also enforces an SSRF denylist: URLs whose host resolves to a
 * private / loopback / link-local IP range are blocked, because the
 * /api/test-connection/llm probe is unauthenticated (audit F-1 in
 * the security review) and could otherwise be used as an outbound
 * proxy to scan the operator's internal network. The check is
 * host-literal only (no DNS lookup) so it doesn't introduce a slow
 * path; production operators behind a private proxy should point
 * `LLM_ENDPOINT_HOST_ALLOWLIST` at the proxy hostname.
 *
 * Override: a `LLM_ALLOW_INSECURE_HTTP_URLS=1` env var lets a developer
 * point at a cleartext dev gateway without rewriting the code.
 * Production deployments MUST leave it unset.
 */
const allowInsecureHttp = process.env.LLM_ALLOW_INSECURE_HTTP_URLS === "1";
const hostAllowList = (process.env.LLM_ENDPOINT_HOST_ALLOWLIST ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

/**
 * Returns true if the URL's host is in a private/loopback/link-local
 * range that the SAG backend should refuse to dial. Hostnames not on the
 * allow-list and not in the denylist are considered "public" and pass
 * the check.
 *
 * NOTE: this is host-string matching only. DNS-resolution-based
 * checks are intentionally avoided here so the validator stays cheap
 * (the probe is unauthenticated and could be hammered); the cost is
 * that a hostname that resolves to 127.0.0.1 via DNS would NOT be
 * blocked at the validator level. The `testLlmConnection()` /
 * `embeddingClient.testConnection()` runtimes use Node's built-in
 * `fetch()` which respects DNS resolution at request time, so a
 * DNS-pinning attacker still needs to control the operator's DNS to
 * bypass this. For belt-and-braces, the calling endpoints also
 * enforce a 10s timeout so a slow-resolving internal target can't be
 * used for slowloris-style DoS.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // Strip IPv6 brackets if present.
  const stripped = lower.replace(/^\[|\]$/g, "");
  // IPv6 literals: block ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local).
  if (stripped.includes(":")) {
    if (stripped === "::1") return true;
    if (/^fc[0-9a-f]{2}:/i.test(stripped)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(stripped)) return true;
    // Treat everything else (2000::/3 global) as public.
    return false;
  }
  // IPv4 dotted quad — split and test each octet.
  const ipv4Match = stripped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const o = ipv4Match.slice(1, 5).map(Number);
    if (o.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
    // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
    // 169.254.0.0/16, 0.0.0.0/8 (includes 0.0.0.0).
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 0) return true;
    return false;
  }
  // DNS hostname: allow if explicitly listed, otherwise the test
  // endpoint can't easily pre-resolve without DNS — we accept the
  // trade-off (see NOTE above).
  return false;
}

// Empty string is allowed because the operator may not have a remote
// endpoint configured yet (local-bge / local-LLM-only modes). Non-empty
// values are validated: scheme + SSRF denylist.
export const aiEndpointUrlSchema = z
  .string()
  .refine(
    (value) => {
      const trimmed = value.trim();
      if (!trimmed) return true; // empty is OK
      // Reject obvious non-http schemes (file://, gopher://, javascript:,
      // data:, etc.). http(s) only.
      if (!/^https?:\/\//i.test(trimmed)) return false;
      // If the scheme is http (not https), require the opt-in flag.
      if (/^http:\/\//i.test(trimmed) && !allowInsecureHttp) return false;
      // SSRA guard. Skip if LLM_ALLOW_PRIVATE_NETWORK=1 (for operators
      // who deliberately point at an internal gateway).
      const allowPrivateNetwork = process.env.LLM_ALLOW_PRIVATE_NETWORK === "1";
      if (allowPrivateNetwork) return true;
      try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        if (!host) return false;
        // Allow-list takes precedence over the denylist.
        if (hostAllowList.includes(host)) return true;
        // Hostname-literal denylist (no DNS lookup).
        return !isPrivateOrLoopbackHost(host);
      } catch {
        return false;
      }
    },
    allowInsecureHttp
      ? "AI endpoint URL must be a valid http(s) URL (optionally set LLM_ALLOW_PRIVATE_NETWORK=1 for internal gateways)"
      : "AI endpoint URL must be https:// and point at a public host (or set LLM_ALLOW_INSECURE_HTTP_URLS=1 + LLM_ALLOW_PRIVATE_NETWORK=1 for dev)"
  )
  .transform((value) => value.trim().replace(/\/$/, ""));

// Optional variant — same rules, but rejects `undefined` (i.e. the
// field may be present-and-valid, present-and-empty, or absent).
export const optionalAiEndpointUrlSchema = aiEndpointUrlSchema.optional();

// ─────────────────────────────────────────────────────────────────────────
// Zod schemas — previously inlined in server.ts; co-located here so any
// registerXxxRoutes file can import them without duplication.
// ─────────────────────────────────────────────────────────────────────────

export const ingestSchema = z.object({
  sourceId: z.string().uuid().optional(),
  // Optional pre-existing document id. When set, the ingest pipeline
  // reuses this id — used by maintenance scripts that want to re-extract
  // entities for an already-stored document without creating a duplicate
  // row. The watcher's normal ingest path omits this.
  documentId: z.string().uuid().optional(),
  title: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  extract: z.boolean().optional(),
  waitForCompletion: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

export const searchSchema = z.object({
  query: z.string().min(1),
  sourceIds: z.array(z.string().uuid()).min(1),
  strategy: z.enum(["vector", "multi"]).optional(),
  searchMode: z.enum(["standard", "fast"]).optional(),
  subStrategy: z.enum(["multi", "multi1", "hopllm"]).optional(),
  topK: z.number().int().positive().max(50).optional(),
  returnTrace: z.boolean().optional(),
  multi: z.object({
    entityTopK: z.number().int().positive().optional(),
    multiTopK: z.number().int().positive().optional(),
    keySimilarityThreshold: z.number().min(0).max(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    maxHops: z.number().int().min(0).max(10).optional(),
    maxEvents: z.number().int().positive().optional(),
    maxEventsA: z.number().int().positive().optional(),
    maxEventsB: z.number().int().min(0).optional(),
    maxHopRetries: z.number().int().positive().max(10).optional(),
    rerankTopK: z.number().int().positive().max(20).optional(),
    maxSections: z.number().int().positive().max(50).optional()
  }).optional()
});

export const uploadSchema = z.object({
  sourceId: z.string().uuid().optional(),
  title: z.string().min(1).optional(),
  fileName: z.string().min(1),
  content: z.string(),
  extract: z.boolean().optional(),
  chunking: z.object({
    mode: z.enum(["heading_strict", "token"]).optional(),
    maxTokens: z.number().int().min(64).max(8192).optional(),
    overlapTokens: z.number().int().min(0).max(4096).optional()
  }).optional()
});

export const projectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable()
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable()
});

export const documentUpdateSchema = z.object({
  title: z.string().min(1).optional()
});

export const createMcpSessionSchema = z.object({
  title: z.string().min(1).optional(),
  sourceIds: z.array(z.string().uuid()).optional()
});

export const mcpMessageSchema = z.object({
  content: z.string().min(1)
});

export const aiSettingsSchema = z.object({
  // "local" (the SHA256-hash pseudo-embedding) is intentionally not
  // accepted here. See src/types.ts:EmbeddingProvider for the why.
  embeddingProvider: z.enum(["api", "local-bge"]).default("api"),
  // F-3: require https:// (or http:// + opt-in flag) on the outbound
  // base URL. The embedding client sends the API key as
  // `Authorization: Bearer ...` on every call, so allowing plain
  // http:// here would silently leak the key on the wire. Empty
  // string is allowed — operators on local-bge / local-LLM modes
  // may not have a remote embedding endpoint configured.
  embeddingBaseUrl: optionalAiEndpointUrlSchema,
  // embeddingModel is irrelevant for "local-bge" — BGE loads from the
  // local model path and has no remote model identifier. Accept either
  // an omitted value or an empty string so the UI can save a "I only
  // use local-bge" config without fabricating a placeholder model name.
  // z.string() (without .min) accepts "" which is exactly what the
  // local-bge flow needs; for api / local we still require ≥1 char at
  // the service layer (see ai-settings-service.ts updateSettings).
  embeddingModel: z.string().optional(),
  embeddingDimensions: z.literal(SUPPORTED_EMBEDDING_DIMENSIONS),
  embeddingApiKey: z.string().optional(),
  clearEmbeddingApiKey: z.boolean().optional(),
  embeddingLocalModelPath: z.string().optional(),
  clearEmbeddingLocalModelPath: z.boolean().optional(),
  // LLM provider: mirrors embeddingProvider but kept as a separate
  // axis. When "local" is chosen the LocalLlmClient takes over the
  // chat/extraction path; the HTTP base URL / model name become
  // ignorable. Migration 016 introduced this; absent on old rows.
  llmProvider: z.enum(["api", "local"]).default("api"),
  // F-3: same https-only guard on the LLM endpoint. Empty string
  // accepted for the same reason as embeddingBaseUrl above.
  llmBaseUrl: optionalAiEndpointUrlSchema,
  // Same as embeddingModel: empty / omitted is fine — the service
  // falls back to the current DB row or env default.
  llmModel: z.string().optional(),
  llmApiKey: z.string().optional(),
  clearLlmApiKey: z.boolean().optional(),
  // GGUF path (relative to process.resourcesPath or repo-root).
  // Empty string means "use the existing DB value" unless
  // clearLlmLocalModelPath is true.
  llmLocalModelPath: z.string().optional(),
  clearLlmLocalModelPath: z.boolean().optional(),
  // Context window in tokens. The schema enforces a wide range;
  // the service layer clamps to the 256-32768 band.
  llmLocalContextSize: z.number().int().min(256).max(32768).optional(),
  // Plan B (2026-09-19): NER model fields. Same semantics as the
  // LLM path fields above — empty string is the "not configured"
  // signal. The runtime refuses to start until a non-empty path
  // lands in `ai_provider_settings.ner_model`.
  nerModel: z.string().optional(),
  clearNerModel: z.boolean().optional(),
  // Token cap for the NER pipeline. The schema enforces a tight
  // range because bert-base-chinese-ner was trained on 128-token
  // sequences and accuracy degrades past 512; the service clamps
  // to the same [64, 1024] window as the DB CHECK constraint.
  nerMaxTokens: z.number().int().min(64).max(1024).optional(),
  defaultSearchMode: z.enum(["standard", "fast"]).default("fast"),
  defaultSearchTopK: z.number().int().min(1).max(50).default(10),
  defaultChunkingMode: z.enum(["heading_strict", "token"]).default("heading_strict"),
  chunkTokenLimit: z.number().int().min(64).max(8192).default(1024),
  chunkOverlapTokens: z.number().int().min(0).max(4096).default(100)
});
