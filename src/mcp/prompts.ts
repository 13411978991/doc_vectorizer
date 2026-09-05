// src/mcp/prompts.ts — Register MCP prompt templates exposed by SAG.
//
// Prompts are *reusable, parameterised system prompts* that an MCP client
// (Claude Desktop, Cursor, claude.ai) can show the user as a "/" slash
// command or pin to a button. Each one wires a specific "persona +
// workflow" combo so the same SAG instance can serve different teams
// without forking the config.
//
// Conventions:
//   - One argSchema per prompt (Zod), validated by the SDK before render.
//   - Argument names use camelCase for tool-friendly autocomplete.
//   - Prompts return a fixed-shape messages array (single user message
//     by default), most can be flipped to user+assistant pairs later.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMcpPrompts(server: McpServer): void {
  server.prompt(
    "audit-search-replay",
    "Re-run an audit search and explain the trace step by step.",
    {
      query: z.string().min(1).describe("The original question the user asked"),
      topK: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Optional max documents to include in the explanation (default 10)"),
    },
    ({ query, topK }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are an audit-explanation assistant.",
              "Run `sag_explain_search` for the query below, then narrate the",
              "search trace as if briefing a senior auditor who needs to",
              "understand WHY each candidate was or wasn't promoted.",
              "",
              `Query: ${query}`,
              `Top K (if specified): ${topK ?? "10"}`,
              "",
              "Structure the response as:",
              "1. The final top-K list (id, title, score).",
              "2. The reranker's verdict per candidate (why it was chosen, why it beat its neighbour).",
              "3. Any retrieval branch that returned zero hits (so the auditor can spot blind spots).",
              "4. Any explicit instruction the user added that the search ignored.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "contract-risk-scan",
    "Score a contract for legal/financial risk using SAG-retrieved events.",
    {
      contract: z
        .string()
        .min(1)
        .describe("Path or id of the contract to scan (call sag_search first to locate it)"),
    },
    ({ contract }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are a senior contracts counsel reviewing a single agreement.",
              "",
              `Contract ref: ${contract}`,
              "",
              "Workflow:",
              "1. Call `sag_search` to surface every event referencing this contract (signing, payment milestones, amendments).",
              "2. Call `sag_get_event` on each event to confirm dates, parties, amounts.",
              "3. Produce a risk score (0-100) per category: payment-delay, scope-creep, indemnity-gap, term-mismatch, governing-law.",
              "4. Conclude with a single-line action: APPROVE / RE-NEGOTIATE / ESCALATE.",
              "",
              "Be conservative — when the index doesn't show a milestone, assume it doesn't exist and note the gap.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "ingest-folder",
    "Bulk-ingest every file in a watched folder and surface ingest errors.",
    {
      folderId: z
        .string()
        .uuid()
        .describe("The watched folder to ingest (call list_watched_folders if unknown)"),
    },
    ({ folderId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are a data-curation assistant.",
              `Folder ID: ${folderId}`,
              "",
              "1. Call `list_watched_folders` to confirm the folder exists and capture its manifest.",
              "2. Call `trigger_sync` against that folder id.",
              "3. After sync completes, call `sag_search` with a query such as 'something unique about recent files' to verify the index now contains them.",
              "4. Report: total files attempted, total indexed, errors with file names.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "bilingual-summary",
    "Summarize a SAG-retrieved document in both English and Chinese.",
    {
      documentId: z.string().min(1).describe("Source id or title from a prior sag_search"),
    },
    ({ documentId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are a bilingual technical writer (English + Simplified Chinese).",
              `Document: ${documentId}`,
              "",
              "Workflow:",
              "1. Use sag_search with the document id / title to retrieve the source.",
              "2. Produce a 4-bullet English summary, then a 4-bullet Chinese summary that mirrors the same content.",
              "3. Highlight any term that doesn't translate cleanly.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "glossary-builder",
    "Build a domain glossary from SAG events returned for a topic.",
    {
      topic: z.string().min(1).describe("Domain or topic to mine (e.g. '采购付款', 'clinical trial')"),
      maxTerms: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Optional max terms to extract (default 25, max 100)"),
    },
    ({ topic, maxTerms }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are a knowledge-engineer building a domain glossary.",
              `Topic: ${topic}`,
              `Max terms: ${maxTerms ?? "25"}`,
              "",
              "1. Call sag_search with the topic to harvest the top 50 events.",
              "2. Cluster entity names; rank by frequency × centrality.",
              "3. Output a markdown table: term | definition (≤25 words) | example event id | frequency.",
              "4. Flag any term whose meaning depends on context (e.g. 'AGREEMENT' could be a verb or a noun).",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
