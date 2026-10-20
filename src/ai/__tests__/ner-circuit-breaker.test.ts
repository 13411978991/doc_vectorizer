/**
 * src/ai/__tests__/ner-circuit-breaker.test.ts — Regression test
 * for the NER OOM bug.
 *
 * Bug: when the ONNX NER model is missing on disk, every
 * `getLocalNerPipeline()` call allocates ~hundreds of MB of WASM
 * heap before throwing. With 4 concurrent chunks × 7 reaper-
 * requeued files, the process OOMs at 4 GB in ~3 seconds and
 * the server crashes. The old `runNerForIngest()` had no
 * breaker — it paid the full allocation cost on every chunk,
 * every file.
 *
 * Fix has two layers:
 *   1. Preflight (`nerModelExists`): bails on a missing
 *      tokenizer.json BEFORE the WASM runtime allocates.
 *   2. Run-time breaker: when transformers throws for any
 *      other reason, subsequent calls return [] immediately.
 *
 * Both layers share the same caller-visible contract: the
 * `extractEventsFromChunk` catch block runs the regex
 * fallback, so ingest keeps producing valid event rows.
 *
 * This test exercises the breaker end-to-end by mocking
 * `aiSettingsService.getRuntimeSettings()` to feed specific
 * `ner_model` paths into the runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleLlmClient } from "../llm-client.js";
import type { AiRuntimeSettings } from "../../services/ai-settings-service.js";

function makeSettings(nerModel: string): AiRuntimeSettings {
  return {
    embeddingProvider: "api",
    embeddingBaseUrl: "http://localhost:9999",
    embeddingModel: "x",
    embeddingDimensions: 1024,
    embeddingApiKey: "",
    embeddingLocalModelPath: "",
    hasRemoteEmbedding: false,
    llmProvider: "local", // forces the local NER + regex branch
    llmBaseUrl: "",
    llmModel: "",
    llmApiKey: "",
    llmLocalModelPath: "",
    llmLocalContextSize: 4096,
    llmTimeoutMs: 60_000,
    llmThreads: 4,
    hasRemoteLlm: false,
    nerModel,
    nerMaxTokens: 128,
    defaultSearchMode: "fast",
    defaultSearchTopK: 10,
    defaultChunkingMode: "heading_strict",
    chunkTokenLimit: 1024,
    chunkOverlapTokens: 100
  };
}

const SAMPLE_INPUT = {
  title: "test doc",
  heading: "h1",
  content: "张三 works at 阿里巴巴 in 杭州市 as a senior auditor.",
  references: []
};

let settingsSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  settingsSpy?.mockRestore();
  settingsSpy = null;
});

async function mockRuntimeSettings(nerModel: string): Promise<void> {
  const aiServiceModule = await import("../../services/ai-settings-service.js");
  // The static import resolved before vi.spyOn, so we have to
  // reach for the singleton and replace its method. The
  // `aiSettingsService` exported in the module is a stable
  // singleton, so monkey-patching the prototype is overkill —
  // we just replace the singleton's method.
  aiServiceModule.aiSettingsService.getRuntimeSettings = async () =>
    makeSettings(nerModel);
}

describe("NER circuit breaker + preflight", () => {
  it("preflight bails on missing model directory BEFORE invoking the ONNX factory (zero allocations)", async () => {
    await mockRuntimeSettings("Z:/definitely/does/not/exist/bert-base-chinese-ner");

    const factoryModule = await import("../ner-pipeline-factory.js");
    const spy = vi
      .spyOn(factoryModule, "getLocalNerPipeline")
      .mockImplementation(async () => {
        throw new Error("should never be called — preflight must bail first");
      });

    const client = new OpenAICompatibleLlmClient();
    for (let i = 0; i < 5; i++) {
      const events = await client.extractEventsFromChunk(SAMPLE_INPUT);
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBe(1);
      expect(events[0].extractionSource).toBe("regex-fallback");
    }

    // Factory was NEVER called — the preflight caught the
    // missing model BEFORE the WASM runtime could allocate.
    expect(spy).not.toHaveBeenCalled();
  });

  it("when the model directory EXISTS on disk but transformers throws, the run-time breaker trips after the first call", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ner-test-"));
    try {
      writeFileSync(join(dir, "tokenizer.json"), "{}");
      await mockRuntimeSettings(dir);

      const spy = vi
        .spyOn(await import("../ner-pipeline-factory.js"), "getLocalNerPipeline")
        .mockImplementation(async () => {
          throw new Error("simulated corrupt-weights failure");
        });

      const client = new OpenAICompatibleLlmClient();
      for (let i = 0; i < 5; i++) {
        const events = await client.extractEventsFromChunk(SAMPLE_INPUT);
        expect(events.length).toBe(1);
        expect(events[0].extractionSource).toBe("regex-fallback");
      }
      // Preflight passed (factory was called once), the
      // run-time breaker tripped on the throw, calls 2-5
      // skipped the factory entirely.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("NER fallback returns a regex-derived event (not empty) so ingest still makes progress", async () => {
    await mockRuntimeSettings("Z:/definitely/does/not/exist/another-fake");
    const client = new OpenAICompatibleLlmClient();
    const events = await client.extractEventsFromChunk(SAMPLE_INPUT);
    expect(events.length).toBe(1);
    expect(events[0].extractionSource).toBe("regex-fallback");
  });
});

