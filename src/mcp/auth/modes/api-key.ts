// src/mcp/auth/modes/api-key.ts — X-MCP-Key admission with two backends.
//
//   MCP_API_KEY_BACKEND=csv (default) — compares against MCP_API_KEYS,
//                                       backwards-compatible with the
//                                       original single-env behavior.
//   MCP_API_KEY_BACKEND=db             — looks up the row in
//                                       `mcp_api_keys` via the db-backed
//                                       service, supporting create /
//                                       revoke / label / per-key rate
//                                       limit overrides.
//
// The CSV path stays constant-time; the DB path is also constant-time
// (verifyHash in the service), so both backends inherit the timing-safe
// property.

import type { AuthOutcome } from "../../auth.js";
import { pickHeader, safeStringEquals } from "../header-utils.js";
import { config } from "../../../config/env.js";
import { lookupApiKey } from "../../../services/mcp-api-keys-service.js";

type HeaderBag = Record<string, string | string[] | undefined>;

export async function authorizeApiKey(headers: HeaderBag): Promise<AuthOutcome> {
  const presented = extractApiKey(headers);
  if (!presented) {
    return { ok: false, reason: "missing X-MCP-Key header" };
  }

  if (config.MCP_API_KEY_BACKEND === "db") {
    const record = await lookupApiKey(presented);
    if (!record) {
      return { ok: false, reason: "api key not recognized or revoked" };
    }
    return { ok: true, identity: `key:${record.label}:${record.fingerprint}…` };
  }

  // CSV backend
  const candidates = (config.MCP_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (candidates.length === 0) {
    return { ok: false, reason: "api_key mode (csv) requires MCP_API_KEYS to be non-empty" };
  }
  for (const candidate of candidates) {
    if (safeStringEquals(presented, candidate)) {
      const fingerprint = `key:${presented.slice(0, 4)}…`;
      return { ok: true, identity: fingerprint };
    }
  }
  return { ok: false, reason: "api key not recognized" };
}

function extractApiKey(headers: HeaderBag): string | undefined {
  const header = pickHeader(headers, "x-mcp-key");
  if (!header) return undefined;
  const value = header.trim();
  return value.length > 0 ? value : undefined;
}
