// src/ingestion/chunking/text-utils.ts — Pure markdown-stripping +
// token-estimation primitives. Lives separately from `markdown.ts`
// so callers that only need one of the two utilities (notably
// `section-factory.ts`) don't pull in the rest of the chunking
// subsystem. Keeping these pure / side-effect-free makes them
// trivially unit-testable.

import { encode } from "gpt-tokenizer/encoding/cl100k_base";

/**
 * Remove the subset of markdown formatting that would render as
 * visual markup (headings, bold, italics, code fences, links) so the
 * chunk's `content` field is plain prose suitable for downstream
 * embedding models.
 *
 * This is intentionally conservative — we don't try to render to HTML
 * because the chunk embedding clients (BGE / OpenAI / Bailian) expect
 * plain text. Anything that looks like a real word stays.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact cl100k_base token count via gpt-tokenizer. Used by the
 * chunking builders to decide whether a section needs splitting.
 * Math.max(1, ...) so an empty string is reported as 1 (matches the
 * "we did try to chunk this" invariant the chunking pipeline
 * expects).
 */
export function estimateTokens(text: string): number {
  return Math.max(1, encode(text).length);
}
