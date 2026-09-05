// src/mcp/auth/header-utils.ts — Header-parsing primitives shared between
// `modes/bearer.ts` (parses `Authorization: Bearer <token>`) and
// `modes/api-key.ts` (parses `X-MCP-Key: <key>`).
//
// `pickHeader` normalises Node's `(string | string[] | undefined) | lowercase
// duplicates` headers; `safeStringEquals` is the constant-time compare
// we use for token equality so an attacker can't probe the token space
// via response timings. Both are pure and side-effect-free so each mode
// can unit-test them without spinning up the full dispatcher.

import { timingSafeEqual } from "node:crypto";
import type { HeaderBag } from "../auth.js";

export function pickHeader(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

export function safeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}
