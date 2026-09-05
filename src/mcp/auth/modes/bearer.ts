// src/mcp/auth/modes/bearer.ts — Authorization: Bearer <token> admission.
//
// Single-tenant lightweight mode; the bearer is compared against
// MCP_AUTH_TOKEN constant-time to defeat timing attacks. If MCP_AUTH_TOKEN
// is unset we deny with a clear error instead of accepting everything —
// this catches accidental boot-in-prod-with-no-secret regressions.

import type { AuthOutcome } from "../../auth.js";
import { pickHeader, safeStringEquals } from "../header-utils.js";
import { config } from "../../../config/env.js";

type HeaderBag = Record<string, string | string[] | undefined>;

export function authorizeBearer(headers: HeaderBag): AuthOutcome {
  const expected = config.MCP_AUTH_TOKEN.trim();
  if (!expected) {
    return { ok: false, reason: "bearer mode requires MCP_AUTH_TOKEN to be set" };
  }
  const presented = extractBearer(headers);
  if (!presented) {
    return { ok: false, reason: "missing Authorization: Bearer header" };
  }
  if (!safeStringEquals(presented, expected)) {
    return { ok: false, reason: "bearer token mismatch" };
  }
  return { ok: true, identity: "bearer" };
}

function extractBearer(headers: HeaderBag): string | undefined {
  const header = pickHeader(headers, "authorization");
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}
