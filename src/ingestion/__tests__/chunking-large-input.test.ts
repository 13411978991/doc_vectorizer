import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../chunking/markdown.js";
import { estimateTokens, countTokensExact } from "../chunking/text-utils.js";

describe("estimateTokens", () => {
  it("returns the exact count for small text", () => {
    const text = "hello world 你好世界";
    expect(estimateTokens(text)).toBe(countTokensExact(text));
  });

  it("returns at least 1 for empty text", () => {
    expect(estimateTokens("")).toBe(1);
  });

  it("does not run the exact tokenizer on huge inputs", () => {
    // 6 MB of text — well past the threshold. The exact tokenizer is
    // quadratic on repetitive text (60k identical CJK chars took 49 s
    // in isolation), and this pinned the main thread so long that
    // /health stopped answering — the "UI stops loading" bug.
    const huge = "中文内容test data row | ".repeat(300_000);
    expect(huge.length).toBeGreaterThan(5 * 1024 * 1024);

    const t0 = Date.now();
    const n = estimateTokens(huge);
    const ms = Date.now() - t0;

    expect(n).toBeGreaterThan(0);
    // Generous bound: the exact tokenizer took >60 s for this input.
    expect(ms).toBeLessThan(1000);
  });

  it("does not run the exact tokenizer on repetitive CJK input", () => {
    // The pathological case: gpt-tokenizer's encode() is quadratic on
    // repeated characters, which is what a spreadsheet of similar
    // rows looks like.
    const repetitive = "测".repeat(100_000);
    const t0 = Date.now();
    const n = estimateTokens(repetitive);
    const ms = Date.now() - t0;

    expect(n).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1000);
  });

  it("never under-estimates, so an oversized section is still split", () => {
    // The cheap estimate must round UP (CJK ratio) so a section that
    // is genuinely over the token limit is not let through to the
    // embedding API (which would 400).
    // Compare against a SHORT slice so the exact tokenizer stays cheap.
    const cjk = "测".repeat(8_000);
    expect(estimateTokens(cjk)).toBeGreaterThanOrEqual(countTokensExact(cjk));
  });
});

describe("chunkMarkdown", () => {
  it("splits a heading-less huge document into bounded sections", () => {
    // A spreadsheet dumped to markdown: no headings, so the whole
    // document lands in one section. This is the shape that stalled
    // the ingest pipeline.
    const rows = 200_000;
    const content = Array.from(
      { length: rows },
      (_, i) => `| 单元格${i} | 值${i} | 备注内容 |`
    ).join("\n");

    const t0 = Date.now();
    const result = chunkMarkdown(content, { mode: "heading_strict", maxTokens: 512 });
    const ms = Date.now() - t0;

    expect(result.sections.length).toBeGreaterThan(1);
    // Every section must be within the token budget.
    for (const s of result.sections) {
      expect(countTokensExact(s.rawContent)).toBeLessThanOrEqual(512);
    }
    // Previously this took 40+ s and blocked the event loop for the
    // whole duration. ~5 s for a 6 MB document is acceptable.
    expect(ms).toBeLessThan(30_000);
  }, 60_000);

  it("keeps the token-window mode working and bounded", () => {
    const content = Array.from(
      { length: 50_000 },
      (_, i) => `句子 ${i}。这是用于测试的中文句子。`
    ).join("\n");

    const t0 = Date.now();
    const result = chunkMarkdown(content, { mode: "token", maxTokens: 512, overlapTokens: 100 });
    const ms = Date.now() - t0;

    expect(result.sections.length).toBeGreaterThan(1);
    for (const s of result.sections) {
      expect(countTokensExact(s.rawContent)).toBeLessThanOrEqual(512);
    }
    expect(ms).toBeLessThan(60_000);
  }, 60_000);
});
