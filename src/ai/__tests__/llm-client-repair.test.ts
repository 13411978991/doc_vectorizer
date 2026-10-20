import { describe, expect, it } from "vitest";
import { repairOrParse } from "../llm-client.js";

/**
 * The LLM sometimes returns truncated JSON when it hits the max_tokens
 * limit mid-payload. `repairOrParse` is the safety net that should still
 * extract a usable object from a malformed response so the ingestion
 * pipeline doesn't fail.
 */
describe("repairOrParse", () => {
  it("returns parsed object when input is valid JSON", () => {
    const input = '{"events":[{"id":"e1","title":"hello"}]}';
    const result = repairOrParse(input) as { events: Array<{ id: string }> };
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("e1");
  });

  it("closes an unterminated string at EOF", () => {
    const input = '{"events":[{"id":"e1","title":"hel';
    const result = repairOrParse(input) as { events: Array<{ id: string; title: string }> };
    expect(result.events[0].id).toBe("e1");
    expect(result.events[0].title).toBe("hel");
  });

  it("strips trailing commas before closing braces", () => {
    const input = '{"events":[{"id":"e1",},]}';
    const result = repairOrParse(input) as { events: Array<{ id: string }> };
    expect(result.events).toHaveLength(1);
  });

  it("balances missing closing brackets and braces", () => {
    const input = '{"events":[{"id":"e1","title":"t"';
    const result = repairOrParse(input) as { events: Array<{ id: string; title: string }> };
    expect(result.events[0].id).toBe("e1");
    expect(result.events[0].title).toBe("t");
  });

  it("returns null when the input is unrecoverable garbage", () => {
    expect(repairOrParse("not json at all")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(repairOrParse("")).toBeNull();
  });

  it("preserves nested structures (the .xls 招聘岗位表 case)", () => {
    // Reproduces the LLM output we saw for 广东石油化工学院岗位表:
    // truncated at position ~504 with a half-finished array element.
    const input = JSON.stringify({
      events: [
        { id: "e1", title: "岗位招聘" },
        { id: "e2", title: "招聘流程" }
      ],
      entities: [
        { name: "广东石油化工学院", type: "org" },
        { name: "马克思主义学院", type: "org" }
      ]
    }).slice(0, -1); // chop the closing `}`
    const result = repairOrParse(input) as { events: Array<{ title: string }>; entities: unknown[] };
    expect(result.events).toHaveLength(2);
    expect(result.entities).toHaveLength(2);
  });

  it("escapes raw newline inside a string value (real MiniMax-M2.7 case)", () => {
    // Reproduces the failure from
    // 2020/03.2020年进出口年度审计(AEO)/资料清单-AEO符合性审计-0528.xlsx
    // — `extractEventsFromChunk: remote LLM failed, falling back to regex`
    // with err "Expected ',' or ']' after array element in JSON at
    // position 595". The model emitted a real LF inside a Chinese
    // string value (header + newline + body), which JSON.parse rejects
    // with that exact message. The repair must escape the LF so the
    // payload is salvageable instead of falling back to regex.
    const input =
      '{"events":[{"id":"e1","title":"行政中心","summary":"行政中心\n资料清单\n公司：欣旺达电子"}]}';
    const result = repairOrParse(input) as { events: Array<{ id: string; title: string; summary: string }> };
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("e1");
    expect(result.events[0].title).toBe("行政中心");
    // The newline is preserved as a real character in the parsed value
    // (the round-trip via \\n in the source string just unescapes it).
    expect(result.events[0].summary).toContain("行政中心");
  });

  it("escapes raw CR / TAB inside string values", () => {
    const input =
      '{"events":[{"id":"e1","title":"财务部","summary":"line1\r\nline2\tend"}]}';
    const result = repairOrParse(input) as { events: Array<{ summary: string }> };
    expect(result.events[0].summary).toContain("line1");
    expect(result.events[0].summary).toContain("line2");
  });

  it("strips stray ``` fences that survived stripThinkingBlocks", () => {
    // Some models open a json fence and never close it before the
    // token cap, or close it in the middle of a value.
    const input = '```json\n{"events":[{"id":"e1","title":"t"}]}\n```';
    const result = repairOrParse(input) as { events: Array<{ id: string }> };
    expect(result.events[0].id).toBe("e1");
  });

  it("strips control characters outside any string literal", () => {
    // A raw TAB between tokens (outside quotes) is illegal JSON.
    // The repair must drop it so the rest of the structure parses.
    const input = '{"events":\t[{"id":"e1"}]}';
    const result = repairOrParse(input) as { events: Array<{ id: string }> };
    expect(result.events[0].id).toBe("e1");
  });
});
