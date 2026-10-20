import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../markdown.js";

/**
 * heading_strict normally emits one section per heading. Documents that
 * have no heading structure (PDF/PPTX/image-OCR outputs end up as a
 * single flat block) used to produce one oversized section, which then
 * blew past the embedding API's context window. The fix: after building
 * heading_strict sections, split any that exceed the configured
 * `maxTokens`.
 */
describe("chunkMarkdown (heading_strict)", () => {
  it("splits a single-section document with no headings when it exceeds maxTokens", () => {
    // 50 paragraphs of 100 chars ≈ 5000 chars, which exceeds the
    // 300-token maxTokens ceiling well below the chunker would have
    // produced a single chunk otherwise.
    const big = Array.from({ length: 50 }, () => "x".repeat(100)).join("\n\n");
    const result = chunkMarkdown(big, { mode: "heading_strict", maxTokens: 300 });
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      // rough bound: each chunk should be well under 3000 chars
      expect(`${chunk.heading}\n${chunk.content}`.length).toBeLessThan(3000);
    }
  });

  it("leaves small single-section documents alone", () => {
    const tiny = "# Heading\n\nshort body";
    const result = chunkMarkdown(tiny, { mode: "heading_strict", maxTokens: 512 });
    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]?.heading).toBe("Heading");
  });
});