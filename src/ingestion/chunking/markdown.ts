import { randomUUID } from "node:crypto";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import type { ChunkingMode } from "../../types.js";
import { estimateTokens, stripMarkdown } from "./text-utils.js";
import {
  createSection,
  ensureFallbackSection,
  type SectionDraft,
  type ChunkDraft,
  type ChunkingResult,
} from "./section-factory.js";

// `SectionDraft`, `ChunkDraft`, `ChunkingResult` moved to
// `./section-factory.ts` so `createSection` + `ensureFallbackSection`
// can use them without a cyclic import. Re-exported here for
// back-compat with downstream importers (e.g. `extractor.ts`,
// `ingestion-service.ts`).
export type { SectionDraft, ChunkDraft, ChunkingResult } from "./section-factory.js";

export interface ChunkMarkdownOptions {
  mode?: ChunkingMode;
  maxTokens?: number;
  overlapTokens?: number;
}

export function chunkMarkdown(content: string, options: ChunkMarkdownOptions = {}): ChunkingResult {
  const mode = options.mode ?? (options.maxTokens == null && options.overlapTokens == null ? "heading_strict" : "token");
  const maxTokens = normalizeTokenCount(options.maxTokens ?? 512, 64, 8192);
  if (mode === "heading_strict") {
    // heading_strict normally emits one section per heading span, which
    // can leave a single section holding an entire document when the
    // source has no heading structure (e.g. PDFs / image-OCR /
    // PPTX-without-headings). Without further splitting, that one chunk
    // blows past the embedding model's context window and the API
    // returns 400. Split any oversized section here.
    const rawSections = buildHeadingStrictSections(content);
    const sections: SectionDraft[] = [];
    for (const section of rawSections) {
      if (estimateTokens(section.rawContent) > maxTokens) {
        sections.push(...splitLargeSection(section, maxTokens));
      } else {
        sections.push(section);
      }
    }
    return {
      sections,
      chunks: sections.map((section, index) => buildChunk([section], index))
    };
  }
  const sections = buildTokenWindowSections(content, options);
  return {
    sections,
    chunks: sections.map((section, index) => buildChunk([section], index))
  };
}

function buildHeadingStrictSections(content: string): SectionDraft[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SectionDraft[] = [];
  let headings: Array<{ level: number; title: string; line: string }> = [];
  let contentLines: string[] = [];

  function flush(): void {
    if (headings.length === 0 && contentLines.every((line) => !line.trim())) {
      contentLines = [];
      return;
    }
    const headingContent = headings.map((heading) => heading.line).join("\n");
    const body = contentLines.join("\n").trim();
    const rawContent = [headingContent, body].filter(Boolean).join("\n").trim();
    if (!rawContent) {
      headings = [];
      contentLines = [];
      return;
    }
    const mainHeading = headings.length > 0
      ? headings.reduce((best, heading) => heading.level < best.level ? heading : best, headings[0]).title
      : "Introduction";
    sections.push(createSection({
      orderIndex: sections.length,
      heading: mainHeading,
      rawContent
    }));
    headings = [];
    contentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      headings = [{
        level: headingMatch[1].length,
        title: headingMatch[2].trim(),
        line
      }];
      continue;
    }
    contentLines.push(line);
  }
  flush();

  return ensureFallbackSection(sections, content);
}

function buildTokenWindowSections(content: string, options: ChunkMarkdownOptions): SectionDraft[] {
  const maxTokens = normalizeTokenCount(options.maxTokens ?? 512, 64, 8192);
  const overlapTokens = normalizeTokenCount(options.overlapTokens ?? 100, 0, maxTokens - 1);
  // Tokenize the WHOLE document up front? No — that is exactly the
  // main-thread stall we removed from estimateTokens(). `encode()` on a
  // 100 MB document keeps gpt-tokenizer's BPE merge cache growing for
  // minutes and pins the event loop, so /health stops answering and
  // the UI appears frozen.
  //
  // Instead we walk the text in CHARACTER windows sized from the token
  // budget, and only run the exact tokenizer on the small per-window
  // text. The window is then trimmed to the real token limit, which is
  // cheap because the window is bounded.
  //
  // The character window uses the same conservative chars-per-token
  // ratio as text-utils.ts (1.5), so the initial window slightly
  // OVER-estimates the token count — the exact trim below then brings
  // it back under the limit.
  const CHARS_PER_TOKEN = 1.5;
  const windowChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_TOKEN));
  const overlapChars = Math.max(0, Math.floor(overlapTokens * CHARS_PER_TOKEN));
  const stride = Math.max(1, windowChars - overlapChars);

  const sections: SectionDraft[] = [];
  if (content.length === 0) {
    return [];
  }

  for (let start = 0; start < content.length; start += stride) {
    let end = Math.min(start + windowChars, content.length);
    let rawContent = content.slice(start, end).trim();
    // Trim to the real token limit.
    //
    // The window is bounded (≤ ~12k chars), so estimateTokens() stays
    // on the exact fast path. But we must NOT scan one character at a
    // time: the original loop re-tokenized the whole window on every
    // single-character decrement, so trimming a 468-token CJK window
    // down to 512 meant ~30 full tokenizer passes. Over 1,762 windows
    // that was 50,000 encode() calls — 30 s of main-thread time on a
    // 1 MB document.
    //
    // A binary search over the cut point does it in log2(window) ≈ 14
    // passes instead.
    if (rawContent.length > 0 && estimateTokens(rawContent) > maxTokens) {
      let lo = start + 1;
      let hi = end;
      let best = start;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = content.slice(start, mid).trim();
        if (candidate.length > 0 && estimateTokens(candidate) <= maxTokens) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      end = best;
      rawContent = content.slice(start, end).trim();
    }
    if (!rawContent) {
      if (end >= content.length) {
        break;
      }
      continue;
    }
    sections.push(createSection({
      orderIndex: sections.length,
      heading: extractFirstHeading(rawContent) ?? "Introduction",
      rawContent
    }));
    if (end >= content.length) {
      break;
    }
  }
  return sections;
}

function normalizeTokenCount(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(Math.trunc(value), max));
}

function extractFirstHeading(text: string): string | null {
  for (const line of text.split("\n")) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      return headingMatch[2].trim();
    }
  }
  return null;
}

function buildSections(content: string): SectionDraft[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: SectionDraft[] = [];
  let heading = "Introduction";
  let buffer: string[] = [];

  function flush(): void {
    const raw = buffer.join("\n").trim();
    if (!raw) {
      return;
    }
    sections.push(createSection({
      orderIndex: sections.length,
      heading,
      rawContent: raw
    }));
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[2].trim();
      buffer.push(line);
      continue;
    }
    if (!line.trim() && buffer.length > 0) {
      buffer.push(line);
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  return ensureFallbackSection(sections, content);
}

function splitLargeSection(section: SectionDraft, maxTokens: number): SectionDraft[] {
  const paragraphs = section.rawContent.split(/\n{2,}/);
  const result: SectionDraft[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  for (const paragraph of paragraphs) {
    const paragraphTokens = estimateTokens(paragraph);
    if (paragraphTokens > maxTokens) {
      if (buffer.length > 0) {
        result.push(cloneSection(section, buffer.join("\n\n"), result.length));
        buffer = [];
        tokens = 0;
      }
      for (const fragment of splitTextByTokenLimit(paragraph, maxTokens)) {
        result.push(cloneSection(section, fragment, result.length));
      }
      continue;
    }
    if (buffer.length > 0 && tokens + paragraphTokens > maxTokens) {
      result.push(cloneSection(section, buffer.join("\n\n"), result.length));
      buffer = [];
      tokens = 0;
    }
    buffer.push(paragraph);
    tokens += paragraphTokens;
  }
  if (buffer.length > 0) {
    result.push(cloneSection(section, buffer.join("\n\n"), result.length));
  }
  return result;
}

function splitTextByTokenLimit(text: string, maxTokens: number): string[] {
  const sentences = splitBySentenceBoundary(text);
  const chunks: string[] = [];
  // Accumulate into an ARRAY, not a string.
  //
  // `buffer += sentence` re-copies the whole accumulated string on
  // every sentence. For a paragraph of 200k table rows that is O(N^2)
  // in bytes copied — several seconds of pure memcpy on the main
  // thread, with no progress visible in the logs.
  let buffer: string[] = [];
  let bufferTokens = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    const joined = buffer.join("");
    if (joined.trim()) chunks.push(joined.trim());
    buffer = [];
    bufferTokens = 0;
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > maxTokens) {
      flush();
      chunks.push(...forceSplitByTokenLimit(sentence, maxTokens));
      continue;
    }
    if (buffer.length === 0 || bufferTokens + sentenceTokens <= maxTokens) {
      buffer.push(sentence);
      bufferTokens += sentenceTokens;
      continue;
    }
    flush();
    buffer.push(sentence);
    bufferTokens = sentenceTokens;
  }

  flush();
  return chunks.filter(Boolean);
}

function splitBySentenceBoundary(text: string): string[] {
  const parts = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]?|\n+/gu) ?? [text];
  return parts.filter((part) => part.length > 0);
}

function forceSplitByTokenLimit(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  // Character budget per chunk, derived from the token budget with the
  // same conservative CJK ratio text-utils.ts uses.
  //
  // The previous version called estimateTokens(remaining) on the WHOLE
  // remaining string on every iteration, and findPrefixLengthByTokenLimit
  // then did log2(N) more estimates over shrinking prefixes. For a
  // multi-megabyte paragraph that is O(N^2) tokenizer work — the
  // dominant cost of the "UI stops loading" stall.
  //
  // Instead: take a character window sized from the token budget,
  // then trim it to the real token limit with the exact tokenizer.
  // The window is bounded (≤ ~12k chars), so the exact check is cheap.
  const CHARS_PER_TOKEN = 1.5;
  const windowChars = Math.max(1, Math.floor(maxTokens * CHARS_PER_TOKEN));

  while (remaining) {
    if (remaining.length <= windowChars) {
      // Small enough that the exact count is affordable.
      if (estimateTokens(remaining) <= maxTokens) {
        chunks.push(remaining);
        break;
      }
      // Too big even at the window size — fall through to the trim.
      let cut = findPrefixLengthByTokenLimit(remaining, maxTokens);
      if (cut <= 0) cut = 1;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trimStart();
      continue;
    }

    // Large input: use the cheap ratio to pick a starting cut, then
    // trim with the exact tokenizer on the bounded window.
    let cut = windowChars;
    while (cut > 1 && estimateTokens(remaining.slice(0, cut)) > maxTokens) {
      cut = Math.floor(cut * 0.9);
    }
    if (cut <= 0) cut = 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }

  return chunks.filter(Boolean);
}

function findPrefixLengthByTokenLimit(text: string, maxTokens: number): number {
  let low = 0;
  let high = text.length;
  let best = 0;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    const tokens = estimateTokens(candidate);
    if (tokens <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best;
}

function cloneSection(section: SectionDraft, rawContent: string, offset: number): SectionDraft {
  return {
    id: randomUUID(),
    orderIndex: section.orderIndex + offset / 1000,
    heading: section.heading,
    content: stripMarkdown(rawContent),
    rawContent,
    tokenCount: estimateTokens(rawContent)
  };
}

function buildChunk(sections: SectionDraft[], rank: number): ChunkDraft {
  const heading = sections.find((section) => section.heading)?.heading ?? "Untitled";
  return {
    id: randomUUID(),
    rank,
    heading,
    content: sections.map((section) => section.content).join("\n").trim(),
    rawContent: sections.map((section) => section.rawContent).join("\n\n"),
    sectionIds: sections.map((section) => section.id)
  };
}

// `stripMarkdown` + `estimateTokens` moved to `./text-utils.ts` so
// `section-factory.ts` can reuse them without a cyclic import. Re-exported
// here for back-compat with any downstream importers.
export { stripMarkdown, estimateTokens } from "./text-utils.js";
