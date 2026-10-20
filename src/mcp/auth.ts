// src/mcp/auth.ts — MCP HTTP auth dispatcher + per-(identity, IP) rate-limit
// + http convenience wrapper + structured denial log.
//
// Split from this file:
//   src/mcp/auth/modes/none.ts    — authorizeNone
//   src/mcp/auth/modes/bearer.ts  — authorizeBearer + pickHeader + safeStringEquals
//   src/mcp/auth/modes/api-key.ts — authorizeApiKey (csv | db internally branched)
//
// Why split: `authorizeHeaders` previously inlined all three modes; with
// the db-backed API key branch added later the function ballooned to 61
// lines / cog 23 / cx 12. Splitting brought it back to ~10 lines with
// each mode independently unit-testable (e.g. `authorizeBearer` against
// a mocked HeaderBag, no SQLite required).

import type { IncomingMessage } from "node:http";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";
import { authorizeNone } from "./auth/modes/none.js";
import { authorizeBearer } from "./auth/modes/bearer.js";
import { authorizeApiKey } from "./auth/modes/api-key.js";

export type AuthOutcome =
  | { ok: true; identity: string }
  | { ok: false; reason: string };

export type HeaderBag = Record<string, string | string[] | undefined>;

const RATE_LIMIT_WINDOW_MS = 60_000;
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Test-only: clear in-memory rate-limit buckets between test runs.
 * Called by the MCP HTTP test setup so each suite starts with a fresh
 * bucket (avoids cross-test pollution).
 */
export function resetAuthState(): void {
  buckets.clear();
}

/**
 * Pick the right mode handler and dispatch. The mode is read once from
 * `config.MCP_AUTH_MODE` so behaviour is consistent within a single
 * request; the value is allowed to change between requests because
 * the test harness relies on that for backend switching.
 *
 * Returns the chosen mode's `AuthOutcome`; never throws — mode
 * implementations are expected to catch their own errors so the
 * caller always sees a structured `ok|reason` result.
 */
export async function authorizeHeaders(
  headers: HeaderBag,
  remoteIp: string | null,
): Promise<AuthOutcome> {
  const mode = config.MCP_AUTH_MODE;
  if (mode === "none") return authorizeNone(remoteIp);
  if (mode === "bearer") return authorizeBearer(headers);
  if (mode === "api_key") return authorizeApiKey(headers);
  return { ok: false, reason: `unknown auth mode: ${mode}` };
}

/** Convenience wrapper for Node http requests. Awaits DB-backed lookup. */
export async function authorizeHttpRequest(req: IncomingMessage): Promise<AuthOutcome> {
  return authorizeHeaders(req.headers, req.socket?.remoteAddress ?? null);
}

/**
 * Per-(identity, IP) token bucket. Returns true if the request should be
 * allowed, false if the bucket is exhausted. Resets at the top of each
 * minute. In-memory only — fine for a single-process SAG instance.
 */
export function consumeRateQuota(identity: string, ip: string): boolean {
  const limit = config.MCP_RATE_LIMIT_RPM;
  if (limit <= 0) return true;

  const key = `${identity}|${ip}`;
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  existing.count += 1;
  if (existing.count > limit) {
    return false;
  }
  return true;
}

/** Logs the outcome without leaking the token contents. */
export function logDenial(req: IncomingMessage, reason: string): void {
  logger.warn(
    {
      ip: req.socket?.remoteAddress ?? null,
      url: req.url,
      method: req.method,
      mode: config.MCP_AUTH_MODE,
      reason,
    },
    "mcp http auth denied",
  );
}
