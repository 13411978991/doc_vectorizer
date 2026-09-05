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

// ─────────────────────────────────────────────────────────────────────────
// Zod schemas — previously inlined in server.ts; co-located here so any
// registerXxxRoutes file can import them without duplication.
// ─────────────────────────────────────────────────────────────────────────

export const ingestSchema = z.object({
  sourceId: z.string().uuid().optional(),
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
  embeddingProvider: z.enum(["api", "local", "local-bge"]).default("api"),
  embeddingBaseUrl: z.string(),
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.literal(SUPPORTED_EMBEDDING_DIMENSIONS),
  embeddingApiKey: z.string().optional(),
  clearEmbeddingApiKey: z.boolean().optional(),
  embeddingLocalModelPath: z.string().optional(),
  clearEmbeddingLocalModelPath: z.boolean().optional(),
  llmBaseUrl: z.string().optional(),
  llmModel: z.string().min(1).optional(),
  llmApiKey: z.string().optional(),
  clearLlmApiKey: z.boolean().optional(),
  defaultSearchMode: z.enum(["standard", "fast"]).default("fast"),
  defaultSearchTopK: z.number().int().min(1).max(50).default(10),
  defaultChunkingMode: z.enum(["heading_strict", "token"]).default("heading_strict"),
  chunkTokenLimit: z.number().int().min(64).max(8192).default(1024),
  chunkOverlapTokens: z.number().int().min(0).max(4096).default(100)
});
