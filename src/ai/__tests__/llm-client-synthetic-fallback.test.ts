import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Locks the "buildSingleExtractedEvent returned null → synthetic event"
 * behaviour added on 2026-10-13.
 *
 * Regression: a chunk like "CA-19-C74" (mostly English audit code
 * table) used to be rejected by `isLikelyLanguageDrift` because the
 * input was tagged Chinese but the LLM sensibly replied in English.
 * The throw was caught and the chunk fell back to regex extraction
 * (the regex title then degenerated to the chunk heading, which
 * was useless for retrieval). The fix is to synthesise a minimal
 * event from the heading + content instead — same shape as the
 * existing "model returned empty items" path. This test pins both
 * the surface behaviour and the source label.
 */

// vi.mock() factories are hoisted above all top-level code, so the
// mock-fn references must be hoisted with vi.hoisted() (otherwise
// the factory hits a TDZ on the variable).
const { getRuntimeSettingsMock, fetchMock } = vi.hoisted(() => ({
  getRuntimeSettingsMock: vi.fn(async () => ({
    llmProvider: "api" as const,
    hasRemoteLlm: true,
    llmBaseUrl: "https://llm.example/v1",
    llmModel: "test-model",
    llmApiKey: "sk-test",
    llmTimeoutMs: 60_000,
    embeddingProvider: "local" as const,
    embeddingBaseUrl: "",
    embeddingModel: "",
    embeddingDimensions: 1024,
    embeddingApiKey: "",
    embeddingLocalModelPath: "",
    nerModel: "",
    nerMaxTokens: 512
  })),
  fetchMock: vi.fn()
}));

vi.mock("../../services/ai-settings-service.js", () => ({
  aiSettingsService: {
    getRuntimeSettings: getRuntimeSettingsMock
  }
}));

// Stub the global fetch so chatJson (which uses `fetch(url, ...)`
// under the hood) returns our canned response. This is more
// reliable than mutating `llmClient.chatJson` on the instance —
// the production code calls `this.chatJson(...)` via the prototype
// chain, so an instance property override wouldn't take effect.
vi.stubGlobal("fetch", fetchMock);

// Model-call log spy: we don't actually need a deep mock — the
// production code uses createModelCallLogger, which writes to a
// real logger. The DB call would normally be skipped because the
// logger no-ops when the model_call_logs table is missing. We
// tolerate that and only assert on the returned events.
import { llmClient } from "../llm-client.js";

beforeEach(() => {
  fetchMock.mockReset();
  getRuntimeSettingsMock.mockClear();
});

describe("extractEventsFromChunk — buildSingleExtractedEvent null → synthetic", () => {
  it("returns a synthetic event with the chunk heading as title (no regex fallback)", async () => {
    // The original failure: chunk was tagged Chinese (input.content
    // is mostly Chinese), but the LLM replied in English. That
    // triggers isLikelyLanguageDrift in buildSingleExtractedEvent
    // (cjkChars === 0 && latinWords >= 4) → null → throw → regex
    // fallback. The fix is to synthesise a minimal event with the
    // heading as the title instead.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    title: "CA-19-C74 audit procedure review",
                    summary: "Review the audit procedure for CA-19-C74 against the standard checklist of IT general controls.",
                    content: "Review the audit procedure for CA-19-C74 against the standard checklist of IT general controls.",
                    category: "audit",
                    keywords: ["CA-19-C74", "audit"],
                    entities: []
                  }
                ]
              })
            }
          }
        ]
      })
    });
    const events = await llmClient.extractEventsFromChunk({
      title: "CA-19-信息系统管理-测试底稿 2017年度",
      heading: "CA-19-C74",
      // Mix Chinese + English to keep isMostlyChinese() returning
      // true (so inputIsChinese=true), then the LLM's English
      // content trips the drift guard.
      content: [
        "本节为 CA-19-C74 测试底稿",
        "审计程序审查",
        "信息科技一般控制测试"
      ].join("\n"),
      references: []
    });
    expect(events).toHaveLength(1);
    expect(events[0].extractionSource).toBe("remote-llm");
    // The synthetic title is the heading, not a regex-fallback
    // mess. (The old behaviour would have produced a regex title
    // like "C74" or "CA-19" — strictly worse for retrieval.)
    expect(events[0].title).toBe("CA-19-C74");
  });

  it("falls back to the document title when the heading is empty", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    title: "X",
                    summary: "X",
                    content: "All Latin words here with no Chinese characters at all whatsoever",
                    category: "X",
                    keywords: [],
                    entities: []
                  }
                ]
              })
            }
          }
        ]
      })
    });
    const events = await llmClient.extractEventsFromChunk({
      title: "document-fallback-title",
      heading: "",
      // Mostly Chinese so isMostlyChinese=true; LLM then replies
      // in English which trips the drift guard.
      content: "本节内容主要是中文叙述但 LLM 回答用了英文。",
      references: []
    });
    expect(events).toHaveLength(1);
    expect(events[0].extractionSource).toBe("remote-llm");
    expect(events[0].title).toBe("document-fallback-title");
  });
});
