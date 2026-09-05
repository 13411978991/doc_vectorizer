// src/mcp/auth/modes/none.ts — MCP_AUTH_MODE=none admission.
//
// The "none" mode accepts every request and uses the remote IP as the
// caller identity in audit logs + rate-limit bucket key. It exists
// purely so local dev / smoke tests don't need to set
// MCP_AUTH_TOKEN or MCP_API_KEYS.

import type { AuthOutcome } from "../../auth.js";

export function authorizeNone(remoteIp: string | null): AuthOutcome {
  return { ok: true, identity: remoteIp ?? "anonymous" };
}
