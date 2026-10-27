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
 * Above this length we stop using the exact tokenizer.
 *
 * WHY (measured 2026-10-26): `estimateTokens()` was called on the
 * *whole* section content, and a section with no heading structure
 * (a spreadsheet dumped to markdown, a PDF, a scanned document) holds
 * the entire document. For a 380 MB workbook that is a single
 * `encode()` call over a ~100 MB string.
 *
 * gpt-tokenizer's `encode()` is QUADRATIC on repetitive text, which is
 * exactly what a spreadsheet of similar rows produces. Measured on this
 * machine:
 *
 *     8,000 identical CJK chars  ->  1,012 ms
 *    16,000 identical CJK chars  ->  3,463 ms   (2x the input, 3.4x the time)
 *    60,000 identical CJK chars  -> 48,931 ms
 *
 * versus linear for normal mixed text (32,000 chars -> 5 ms). The hot
 * frame is `addToMergeCache` <- `bytePairEncode` <- `encode`, which is
 * exactly what a CPU profile of a stuck ingest showed (93% of all CPU
 * in that call chain).
 *
 * The symptom was the whole HTTP server going silent: `/health` and
 * every `/api/watched-folders*` endpoint timed out for the duration,
 * which the user sees as "the UI stops loading".
 *
 * So above the threshold we use a cheap character-ratio estimate
 * instead of the exact tokenizer. Chunking only needs to know "is this
 * section over the limit, and roughly by how much" — an approximation
 * within ~10% is plenty, and it is O(1) in the tokenizer's cost.
 * Below the threshold we keep the exact count, because that is where
 * precision actually matters (a section right at the 512-token
 * boundary).
 *
 * The 16 KB limit is set so the exact path can never cost more than
 * ~3.5 s even on pathological repetitive input, and in practice on
 * real documents it is ~3 ms.
 *
 * The ratio: cl100k_base averages ~3.5 characters per token for
 * English and ~1.5 for CJK. We use 1.5 (the CJK-conservative value)
 * so a CJK-heavy section is never under-estimated — under-estimating
 * would let an oversized section through to the embedding API and
 * trigger an HTTP 400.
 */
const EXACT_TOKENIZER_MAX_CHARS = 16 * 1024;

/** Conservative chars-per-token ratio (CJK-heavy). */
const CHARS_PER_TOKEN = 1.5;

/**
 * Exact cl100k_base token count via gpt-tokenizer, for short texts.
 *
 * Math.max(1, ...) so an empty string is reported as 1 (matches the
 * "we did try to chunk this" invariant the chunking pipeline
 * expects).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 1;
  if (text.length > EXACT_TOKENIZER_MAX_CHARS) {
    // Cheap estimate for very large inputs. Ceil so we round UP and
    // never let an oversized section through.
    return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
  }
  return Math.max(1, encode(text).length);
}

/**
 * Exact token count, always using the tokenizer.
 *
 * Use this only for text that is known to be small (e.g. the final
 * chunk text handed to the embedding API). Never call it on a whole
 * document — that is what caused the main-thread stall.
 */
export function countTokensExact(text: string): number {
  if (text.length === 0) return 1;
  return Math.max(1, encode(text).length);
}
