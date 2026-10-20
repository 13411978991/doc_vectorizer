/**
 * Plan B (2026-09-19): NER model coverage for extractNamedEntities().
 *
 * Strategy: mock the NER pipeline factory so we don't need to ship a
 * real ONNX model in CI. The mock returns a pre-canned token-classification
 * result, then we verify:
 *   - E: extractNamedEntities calls the NER pipeline
 *   - F: NER pipeline throws → falls back to localNamedEntities (regex)
 *   - G: BIO tags are correctly mapped through normalizeNerResults
 *   - H: low-score entities are filtered out (< 0.7 threshold)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the NER pipeline factory so the test runs without an actual
// ONNX model. Returns a `vi.fn()` that we can configure per test.
const mockNerPipelineFn = vi.fn();
vi.mock("../ner-pipeline-factory.js", () => ({
  getLocalNerPipeline: (...args: unknown[]) => {
    mockNerPipelineFn(...args);
    return Promise.resolve((text: string) => {
      // Return a deterministic canned response — different texts get
      // different canned entities to make the assertions meaningful.
      if (text.includes("张三")) {
        return Promise.resolve([
          { entity: "B-PER", word: "张", score: 0.95, start: 0, end: 1 },
          { entity: "I-PER", word: "三", score: 0.94, start: 1, end: 2 },
          { entity: "B-LOC", word: "北京", score: 0.92, start: 5, end: 7 },
          { entity: "B-ORG", word: "腾讯", score: 0.88, start: 10, end: 12 },
          // Low-score entity that should be filtered out.
          { entity: "B-MISC", word: "无关词", score: 0.4, start: 20, end: 23 }
        ]);
      }
      if (text.includes("降级")) {
        // For fallback test: throw to simulate a broken ONNX runtime.
        throw new Error("ONNX runtime not available");
      }
      return Promise.resolve([]);
    });
  },
  disposeNerPipeline: () => Promise.resolve(),
  getLoadedNerInfo: () => null
}));

vi.mock("../../services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: () => Promise.resolve({
      nerModel: "models/fake-ner",
      nerMaxTokens: 512
    })
  }
}));

vi.mock("../../observability/model-call-log.js", () => ({
  createModelCallLogger: () => {
    const log = {
      _result: null as unknown,
      succeed(data: unknown) { this._result = { status: "succeed", data }; return this; },
      // Plan B (2026-09-19) added `degrade` to model-call-log.ts —
      // extractNamedEntities calls it when the NER pipeline throws
      // and we fall back to localNamedEntities (regex).
      degrade(data: unknown) { this._result = { status: "degrade", data }; return this; },
      fail(data: unknown) { this._result = { status: "fail", data }; return this; }
    };
    return log;
  }
}));

import { OpenAICompatibleLlmClient } from "../llm-client.js";

const client = new OpenAICompatibleLlmClient();

beforeEach(() => {
  mockNerPipelineFn.mockClear();
});

describe("extractNamedEntities (Plan B NER)", () => {
  it("E: calls the NER pipeline and returns the parsed entities", async () => {
    const entities = await client.extractNamedEntities("张三 在 北京 加入了 腾讯 公司");
    expect(mockNerPipelineFn).toHaveBeenCalledTimes(1);
    // 张三 / 北京 / 腾讯 should be returned; 无关词 dropped by score.
    expect(entities).toContain("张");
    expect(entities).toContain("三");
    expect(entities).toContain("北京");
    expect(entities).toContain("腾讯");
    expect(entities).not.toContain("无关词");
  });

  it("F: falls back to localNamedEntities (regex) when NER throws", async () => {
    const entities = await client.extractNamedEntities("降级 测试 文本 — 子公司 2024年3月15日");
    // Regex fallback should still extract things via suffix match.
    expect(entities.some((e) => e.includes("子公司"))).toBe(true);
    // Date pattern from regex.
    expect(entities.some((e) => /2024/.test(e))).toBe(true);
  });

  it("G: BIO tag prefix is stripped; only the entity word is returned", async () => {
    const entities = await client.extractNamedEntities("张三 在 北京 加入了 腾讯 公司");
    // We should see the raw entity words, not "B-PER" or "I-PER".
    for (const e of entities) {
      expect(e).not.toMatch(/^[BIO]-/);
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it("H: low-score entities (< 0.7) are filtered out", async () => {
    const entities = await client.extractNamedEntities("张三 在 北京 加入了 腾讯 公司");
    // 无关词 has score 0.4, must be filtered.
    expect(entities).not.toContain("无关词");
    // Sanity: high-score entities survived.
    expect(entities.length).toBeGreaterThan(0);
  });

  it("bonus: empty NER output returns an empty array", async () => {
    const entities = await client.extractNamedEntities("普通文本没有实体");
    expect(entities).toEqual([]);
  });
});