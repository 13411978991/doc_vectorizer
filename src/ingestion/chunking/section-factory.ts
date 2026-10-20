// src/ingestion/chunking/section-factory.ts — SectionDraft construction
// primitives shared by `buildHeadingStrictSections`, `buildSections`,
// and `buildTokenWindowSections`. Each builder used to inline the
// `{id, orderIndex, heading, content, rawContent, tokenCount}` object
// literal; bumping a field meant chasing three call sites. Centralizing
// here means each builder is now "what's unique about this strategy?"
// instead of "do I remember every required field?".
//
// Also exposes `ensureFallbackSection` for the "if no sections were
// produced and the content is non-empty, treat the whole input as a
// single section" branch that the two heading-based builders share.
//
// The `SectionDraft` interface declared below is structurally identical
// to the one in `markdown.ts` — kept local to avoid a circular import
// (markdown.ts → section-factory.ts for createSection, section-factory.ts
// would need to import types back from markdown.ts).

import { randomUUID } from "node:crypto";
import { estimateTokens, stripMarkdown } from "./text-utils.js";

export interface SectionDraft {
  id: string;
  orderIndex: number;
  heading: string;
  content: string;
  rawContent: string;
  tokenCount: number;
}

export interface ChunkDraft {
  id: string;
  rank: number;
  heading: string;
  content: string;
  rawContent: string;
  sectionIds: string[];
}

export interface ChunkingResult {
  sections: SectionDraft[];
  chunks: ChunkDraft[];
}

export interface SectionFactoryInput {
  orderIndex: number;
  heading: string;
  rawContent: string;
  /** Override `content` (the markdown-stripped view). Defaults to stripMarkdown(rawContent). */
  content?: string;
}

/**
 * Build a fully-shaped `SectionDraft`. The `content` field defaults to
 * `stripMarkdown(rawContent)` so callers can omit it — every existing
 * call site in `markdown.ts` previously did this inline.
 */
export function createSection(input: SectionFactoryInput): SectionDraft {
  return {
    id: randomUUID(),
    orderIndex: input.orderIndex,
    heading: input.heading,
    content: input.content ?? stripMarkdown(input.rawContent),
    rawContent: input.rawContent,
    tokenCount: estimateTokens(input.rawContent),
  };
}

/**
 * If `sections` is empty but `content` has any non-whitespace
 * characters, append a single "Introduction" section covering the
 * whole input. Returns the (possibly appended) array for chaining.
 *
 * Used by the heading-based builders when the input has no headings
 * at all — instead of returning `[]`, return one section so callers
 * never have to special-case "no chunks from this input".
 */
export function ensureFallbackSection(
  sections: SectionDraft[],
  content: string,
): SectionDraft[] {
  if (sections.length > 0 || !content.trim()) return sections;
  return [
    ...sections,
    createSection({
      orderIndex: 0,
      heading: "Introduction",
      rawContent: content.trim(),
    }),
  ];
}
