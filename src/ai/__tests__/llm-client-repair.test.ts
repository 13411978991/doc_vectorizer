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
});
