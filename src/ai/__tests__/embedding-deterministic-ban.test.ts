/**
 * src/ai/__tests__/embedding-deterministic-ban.test.ts
 *
 * Locks the contract: the SHA256 deterministic-embedding fallback
 * (the "local" provider) must NOT be reachable from the runtime
 * embedding client. It was removed on 2026-10-13 because the
 * 4-bucket hash encoding silently broke semantic search.
 *
 * 2026-10-13:
 *   - EmbeddingProvider type shrunk to "api" | "local-bge"
 *   - batchGenerate() throws on any value outside the union
 *   - settings-routes zod enum rejects "local"
 *   - testConnection() reports ok=false instead of fake-success
 *   - migrations/020 rewrites legacy DB rows to "local-bge"
 *
 * The test below forces a non-union value into the runtime
 * settings and verifies the throw — this is the backstop in
 * case migrations/020 is skipped or a test bypasses zod.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { getRuntimeSettingsMock } = vi.hoisted(() => ({
  getRuntimeSettingsMock: vi.fn()
}));

vi.mock("../../services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: getRuntimeSettingsMock
  }
}));

import { embeddingClient } from "../embedding-client.js";

beforeEach(() => {
  getRuntimeSettingsMock.mockReset();
});

describe("embeddingClient.batchGenerate — local-bge / api only", () => {
  it("throws when the DB carries the legacy 'local' provider", async () => {
    // Simulate the worst-case state: a DB row that survived
    // migrations/020 (maybe the migration didn't run, or a test
    // hand-wrote a row). The runtime MUST refuse to produce
    // hash embeddings and surface a clear error.
    getRuntimeSettingsMock.mockResolvedValueOnce({
      embeddingProvider: "local" as unknown as "api" | "local-bge",
      embeddingBaseUrl: "",
      embeddingModel: "deterministic-sha256",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      embeddingLocalModelPath: "",
      llmProvider: "api" as const,
      llmBaseUrl: "",
      llmModel: "offline",
      llmApiKey: "",
      llmTimeoutMs: 60_000,
      nerModel: "",
      nerMaxTokens: 512
    } as never);
    await expect(
      embeddingClient.batchGenerate(["hello"])
    ).rejects.toThrow(/no longer supported/);
  });

  it("throws when local-bge is selected but the model path is empty", async () => {
    // The runtime previously fell through to the 'api' branch
    // when local-bge had no path, which sent a fetch() to an
    // empty URL — useless error. We now refuse the call instead.
    getRuntimeSettingsMock.mockResolvedValueOnce({
      embeddingProvider: "local-bge" as const,
      embeddingBaseUrl: "",
      embeddingModel: "deterministic-sha256",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      embeddingLocalModelPath: "",
      llmProvider: "api" as const,
      llmBaseUrl: "",
      llmModel: "offline",
      llmApiKey: "",
      llmTimeoutMs: 60_000,
      nerModel: "",
      nerMaxTokens: 512
    });
    await expect(
      embeddingClient.batchGenerate(["hello"])
    ).rejects.toThrow(/embeddingLocalModelPath is empty/);
  });

  it("testConnection reports ok=false for the legacy 'local' provider", async () => {
    getRuntimeSettingsMock.mockResolvedValueOnce({
      embeddingProvider: "local" as unknown as "api" | "local-bge",
      embeddingBaseUrl: "",
      embeddingModel: "deterministic-sha256",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      embeddingLocalModelPath: "",
      llmProvider: "api" as const,
      llmBaseUrl: "",
      llmModel: "offline",
      llmApiKey: "",
      llmTimeoutMs: 60_000,
      nerModel: "",
      nerMaxTokens: 512
    } as never);
    const result = await embeddingClient.testConnection();
    expect(result.ok).toBe(false);
    // The error message must point the operator at the new
    // allowed values so the false "ready" badge from the old
    // local path never comes back.
    expect(result.error).toMatch(/no longer supported/);
    expect(result.error).toMatch(/api/);
    expect(result.error).toMatch(/local-bge/);
  });

  it("testConnection reports ok=false for local-bge with no path", async () => {
    getRuntimeSettingsMock.mockResolvedValueOnce({
      embeddingProvider: "local-bge" as const,
      embeddingBaseUrl: "",
      embeddingModel: "deterministic-sha256",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      embeddingLocalModelPath: "",
      llmProvider: "api" as const,
      llmBaseUrl: "",
      llmModel: "offline",
      llmApiKey: "",
      llmTimeoutMs: 60_000,
      nerModel: "",
      nerMaxTokens: 512
    });
    const result = await embeddingClient.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/embeddingLocalModelPath is empty/);
  });
});
