import { aiSettingsService, type AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEntity, ExtractedEvent, EventRecord } from "../types.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import { toLocalISO } from "../db/row-helpers.js";
import { logger } from "../observability/logger.js";
import { config } from "../config/env.js";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface LlmClient {
  extractNamedEntities(query: string): Promise<string[]>;
  extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]>;
  rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]>;
}

export class OpenAICompatibleLlmClient implements LlmClient {
  async extractNamedEntities(query: string): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractNamedEntities.local",
        request: { query }
      });
      const entities = localNamedEntities(query);
      log.succeed({ named_entities: entities });
      return entities;
    }
    const result = await this.chatJson(settings, {
      system: "Extract named entities important for answering the question. Return JSON only.",
      user: JSON.stringify({
        question: query,
        schema: { named_entities: ["string"] }
      })
    });
    const entities = Array.isArray(result.named_entities) ? result.named_entities : result.entities;
    return Array.isArray(entities) ? entities.map(String).filter(Boolean) : localNamedEntities(query);
  }

  async extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.local",
        request: input
      });
      const events = [localExtractEvent(input)];
      log.succeed({ events });
      return events;
    }
    const result = await this.chatJson(settings, {
      operation: "extractEventsFromChunk.benchmarkPipeline",
      messages: buildBenchmarkExtractionMessages(input)
    });
    const items = Array.isArray(result.items) ? result.items : result.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return [localExtractEvent(input)];
    }
    const inputIsChinese = isMostlyChinese(input.content);
    const event = buildSingleExtractedEvent(items, input, inputIsChinese);
    return event ? [event] : [localExtractEvent(input)];
  }

  async rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.hasRemoteLlm) {
      const log = createModelCallLogger({
        kind: "llm",
        operation: "rerankEvents.local",
        request: input
      });
      const ids = localRerank(input.query, input.candidates, input.topK);
      log.succeed({ useful_event_ids: ids });
      return ids;
    }
    // Cap candidates before sending to LLM: LLM does precise rerank,
    // not coarse ranking. Pre-filter to top `LLM_RERANK_CANDIDATES` by
    // local score, then truncate content to keep prompt small.
    // Tuned 2026-07-08: explicit ranking criteria + larger content window
    //   (240 -> 480) cut the multi/standard miss rate on the Downloads
    //   ground-truth set, especially for entity-bearing queries.
    const LLM_RERANK_CANDIDATES = 10;
    const CONTENT_LIMIT = 480;
    const preFiltered = [...input.candidates]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, LLM_RERANK_CANDIDATES);
    // Bound the rerank LLM call to avoid 60s+ outliers when the LLM API
    // stalls: race the chatJson call against a timeout. On timeout we fall
    // back to the deterministic local score rerank so multi/standard stays
    // responsive even during LLM API incidents.
    const RERANK_TIMEOUT_MS = 8000;
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, RERANK_TIMEOUT_MS);
    try {
      const result = await Promise.race([
        this.chatJson(settings, {
          system: [
            "You are a relevance ranker for retrieval-augmented question answering.",
            `Given a user question and ${LLM_RERANK_CANDIDATES} candidate document excerpts (events), return JSON with the ${input.topK} event ids most likely to contain the answer, ordered by usefulness (most useful first).`,
            "",
            "Apply these criteria in priority order:",
            "1. Direct match - the event explicitly states the answer to the question.",
            "2. Entity match - the event names the same entities (people, companies, products, places, technical terms) as the question.",
            "3. Topic match - the event is on the same topic/subject as the question.",
            "4. Specificity - prefer concrete facts and named entities over generic descriptions.",
            "",
            "Output format (JSON only, no commentary):",
            '{"useful_event_ids":["uuid1","uuid2",...]}',
            `Output exactly ${input.topK} ids from the candidates list. Maintain the order: most useful first.`
          ].join("\n"),
          user: JSON.stringify({
            question: input.query,
            candidates: preFiltered.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              content: candidate.content.slice(0, CONTENT_LIMIT),
              score: Number((candidate.score ?? 0).toFixed(4))
            })),
            output_schema: { useful_event_ids: ["uuid"] }
          })
        }).catch((err) => {
          if (timedOut) {
            throw new Error("rerank LLM call timed out");
          }
          throw err;
        }),
        new Promise<never>((_, reject) => {
          timeoutController.signal.addEventListener("abort", () => reject(new Error("rerank LLM call timed out")));
        })
      ]);
      const ids = result.useful_event_ids ?? result.event_ids;
      return Array.isArray(ids)
        ? ids.map(String).filter((id) => input.candidates.some((candidate) => candidate.id === id)).slice(0, input.topK)
        : localRerank(input.query, input.candidates, input.topK);
    } catch (error) {
      // On timeout or any LLM failure, fall back to deterministic local
      // lexical rerank so callers still get a result.
      logger.warn({ error: (error as Error).message }, "llm rerank failed; falling back to local");
      return localRerank(input.query, input.candidates, input.topK);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async chatJson(settings: AiRuntimeSettings, input: {
    system?: string;
    user?: string;
    messages?: ChatMessage[];
    operation?: string;
  }): Promise<Record<string, any>> {
    const url = `${settings.llmBaseUrl.replace(/\/$/, "")}/chat/completions`;
    const messages = input.messages ?? [
      { role: "system" as const, content: input.system ?? "" },
      { role: "user" as const, content: input.user ?? "" }
    ];
    const body = {
      model: settings.llmModel,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.1
    };

    let lastError: unknown;
    const maxAttempts = config.LLM_MAX_RETRIES + 1;
    // Resolve the per-call timeout from settings if exposed, else env.
    // Prefer the DB-backed value so a WebUI tweak sticks across
    // restarts (see sag_xlsx-LLM超时诊断-20260828.md §根因 #1).
    // Keep the local var so the closure below can label the abort
    // reason with the *actual* value the watchdog used (not a stale
    // env read at module-load time).
    const timeoutMs = settings.llmTimeoutMs ?? config.LLM_TIMEOUT_MS;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      // Tag the abort with a STRING reason (not an Error wrapper).
      //
      // History: the previous code passed `new Error("llm request
      // aborted: timed out after Xms")` as the abort reason. That
      // throws away the underlying AbortError that fetch produces on
      // abort — the surface-level `.message` becomes the wrapper
      // string, hiding whether the abort came from the watchdog, the
      // caller's signal, or fetch itself misbehaving. Downstream
      // logs ("llm request aborted: timed out after 120000ms") then
      // attribute every abort to the watchdog even when the actual
      // cause was DNS / TCP keep-alive / a stalled TLS handshake.
      //
      // String reasons are surfaced by Node fetch as
      // `AbortError: This operation was aborted ... [reason]`,
      // preserving both layers. We capture the watchdog timeout
      // separately in `abortReason` so the catch site below can
      // log which watchdog fired without re-deriving it from the
      // error chain.
      let abortReason = "";
      const timeout = setTimeout(() => {
        abortReason = `llm-watchdog-timeout-${timeoutMs}ms`;
        controller.abort(abortReason);
      }, timeoutMs);
      const log = createModelCallLogger({
        kind: "llm",
        operation: input.operation ?? "chatJson",
        request: {
          url,
          method: "POST",
          attempt,
          maxAttempts,
          headers: {
            "Content-Type": "application/json"
          },
          body
        }
      });
      let logged = false;
      try {
        const response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${settings.llmApiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const { responseText, responseBody } = await readResponseBody(response);
        if (!response.ok) {
          const error = new Error(`llm request failed: ${response.status} ${responseText.slice(0, 500)}`);
          log.fail(error, {
            status: response.status,
            body: responseBody
          });
          logged = true;
          lastError = error;
          if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
            await waitBeforeRetry(attempt);
            continue;
          }
          throw error;
        }
        const json = responseBody as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const cleaned = stripThinkingBlocks(content);
        // Try to repair truncated/malformed JSON (e.g. unterminated strings
        // or missing closing brackets when the model runs out of tokens).
        const parsed = repairOrParse(cleaned) ?? JSON.parse(cleaned);
        if (parsed === null || (typeof parsed === "string" && parsed === cleaned)) {
          // Surface what the LLM actually sent so the next run has evidence
          // to debug truncated-output cases (e.g. mid-value "name":"X" EOF).
          logger.warn(
            { inputLength: cleaned.length, tail: cleaned.slice(-200) },
            "llm-client repair failed",
          );
        }
        log.succeed({
          status: response.status,
          body: responseBody,
          parsed
        });
        return parsed;
      } catch (error) {
        // P0 — defensive Error wrapping. Node 22 undici has at least
        // one edge case where `fetch` resolves into the catch with a
        // raw `string` (rather than an AbortError) when the abort
        // fires after the connection has already closed. Throwing
        // such a string directly bypasses every downstream consumer's
        // `instanceof Error` checks and surfaces as the literal
        // `<no message: string>` token in the watcher's last_error
        // column (see sag_xlsx-no-message-string-20260828.md). The
        // sync-orchestrator already has a `String(message ?? "")`
        // fallback in `classifyErrorPhase`, but the more useful fix
        // is here: never let a non-Error leave this function.
        const wrapped =
          error instanceof Error ? error : new Error(String(error));
        lastError = wrapped;
        // Tag the abort context so log lines / DB last_error don't
        // collapse to "This operation was aborted". `controller.signal.reason`
        // is what we passed to abort(); `abortReason` is the watchdog
        // tag we set just before .abort(). Together they let a future
        // investigation distinguish "watchdog fired after Xms" from
        // "caller signal aborted early" from "fetch itself threw an
        // unrelated AbortError".
        const err = wrapped as Error & { name?: string; code?: string };
        const signalReason =
          (controller.signal as { reason?: unknown }).reason;
        const watchdogReason = abortReason || null;
        if (!logged) {
          log.fail(wrapped, {
            signalReason:
              typeof signalReason === "string"
                ? signalReason
                : signalReason instanceof Error
                ? signalReason.message
                : null,
            watchdogReason,
            errorName: err?.name ?? null,
            errorCode: err?.code ?? null,
            rawErrorType: typeof error
          });
          logged = true;
        } else if (watchdogReason) {
          // log.fail was already called with the HTTP-status metadata;
          // append the watchdog tag so both layers are visible.
          log.fail(wrapped, { watchdogReason });
        }
        if (
          attempt < maxAttempts &&
          (isRetryableFetchError(wrapped) || isJsonParseError(wrapped))
        ) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function parseJsonOrText(text: string): unknown {
  if (!text) {
    return null;
  }
  const stripped = stripThinkingBlocks(text);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    // Log what we got so we can see exactly what the model returned
    logger.warn({ preview: stripped.slice(0, 500) }, "parseJsonOrText: JSON.parse failed");
    return text;
  }
}

/**
 * Strip  ̲think ...  ̲/think  reasoning blocks the model may emit before
 * the JSON payload. Some chat models prepend ` ̲think...  ̲/think` to every
 * assistant turn even with `response_format=json_object`; without this strip
 * the JSON parser sees `<` and throws "Unexpected token '<'".
 *
 * Also unwraps a leading ```` ```json ... ``` ```` fence if the model wraps
 * the JSON in one despite the json_object hint.
 */
function stripThinkingBlocks(text: string): string {
  if (!text) return text;
  let cleaned = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "");
  cleaned = cleaned.replace(/<\|im_start\|>think[\s\S]*?<\|im_end\|>/gi, "");
  cleaned = cleaned.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }
  return cleaned;
}

/**
 * Best-effort repair for truncated or malformed JSON that LLMs sometimes
 * return when they hit the token limit mid-payload. We close unterminated
 * strings, strip trailing commas, and balance brackets/braces so the parser
 * can usually extract a partial object. Returns null if the input cannot be
 * salvaged, in which case the caller should re-raise the original error
 * (or retry the request).
 */
export function repairOrParse(text: string): unknown | null {
  if (!text) return null;
  // Quick path: it parses as-is.
  try {
    return JSON.parse(text);
  } catch {
    // fall through to repair
  }
  // Common malformations from LLM output:
  //   1) Unterminated string at the end (hit token cap).
  //   2) Trailing comma before `}` or `]`.
  //   3) Missing closing `}` / `]` / `"` at EOF.
  let s = text;
  // 1) Drop a trailing partial line that looks like the start of a new
  //    key/value pair but never finished (best-effort).
  const lastBrace = s.lastIndexOf("{");
  if (lastBrace > 0) {
    const tail = s.slice(lastBrace);
    if (!tail.includes(":")) {
      s = s.slice(0, lastBrace);
    }
  }
  // 2) Strip trailing commas before `}` or `]`.
  s = s.replace(/,\s*([}\]])/g, "$1");
  // 3) If we are inside a string at EOF, close it.
  //    Heuristic: count unescaped `"` outside of any in-progress token.
  const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    s = `${s}"`;
  }
  // 4) Balance braces and brackets.
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) {
    s = `${s}"`;
  }
  while (stack.length > 0) {
    s += stack.pop();
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function readResponseBody(response: Response): Promise<{ responseText: string; responseBody: unknown }> {
  const maybeText = (response as Response & { text?: () => Promise<string> }).text;
  if (typeof maybeText === "function") {
    const responseText = await maybeText.call(response);
    return {
      responseText,
      responseBody: parseJsonOrText(responseText)
    };
  }
  const responseBody = await (response as Response & { json: () => Promise<unknown> }).json();
  return {
    responseText: typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
    responseBody
  };
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Two flavours of "the connection was killed mid-request" arrive here:
  //   1. Standard `AbortError` (the WHATWG spec, name === "AbortError").
  //   2. Node 22+ undici fetch throws a plain `Error` (name === "Error")
  //      whose message starts with "llm request aborted" / "This
  //      operation was aborted" — see sag_xlsx-CA-19-LLM超时-20260818.md
  //      §3.2. Without matching on "aborted", our 60s LLM timeout would
  //      surface as a hard failure instead of being retried.
  // Match on both the name AND a substring of the message.
  if (error.name === "AbortError") return true;
  const msg = error.message ?? "";
  if (msg.includes("fetch failed")) return true;
  if (msg.toLowerCase().includes("aborted")) return true;
  return false;
}

function isJsonParseError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // `JSON.parse` throws SyntaxError; wrap the name in a "JSON parse" check
  // so we know to retry on truncated/malformed LLM output.
  return error.name === "SyntaxError" && error.message.includes("JSON");
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  const delayMs = Math.min(1_000, 100 * 2 ** Math.max(0, attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildBenchmarkExtractionMessages(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}): ChatMessage[] {
  const userInput = {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: [
          input.heading ? `# ${input.heading}` : "",
          input.content
        ].filter(Boolean).join("\n\n")
      }],
      meta: {
        source_type: "article",
        source_title: input.title,
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: benchmarkEntityTypes(),
        output_language: "Use the same main language as the input text. Chinese input must produce Chinese fields; English input must produce English fields."
      }
    },
    output_schema: benchmarkExtractionSchema()
  };
  return [
    { role: "system", content: buildBenchmarkExtractionSystemPrompt() },
    { role: "user", content: JSON.stringify(userInput) }
  ];
}

function benchmarkEntityTypes() {
  return [
    { type: "person", description: "人物、作者、用户、负责人等具体个人" },
    { type: "organization", description: "公司、机构、团体、政府部门、学校、团队等组织" },
    { type: "location", description: "地点、地域、国家、城市、场所、地址" },
    { type: "time", description: "日期、年份、时期、时间表达" },
    { type: "product", description: "产品、系统、平台、模型、软件、服务、数据库" },
    { type: "metric", description: "数字、指标、金额、比例、数量、评分、性能数据" },
    { type: "action", description: "动作、行为、流程、操作、状态变化" },
    { type: "work", description: "作品、文档、论文、项目、任务、计划" },
    { type: "group", description: "人群、角色群体、职业群体、用户群体" },
    { type: "subject", description: "主题、概念、领域、技术、专业术语、事件名称" },
    { type: "tags", description: "其他类型均不匹配时使用的标签实体" }
  ];
}

function benchmarkExtractionExampleInput() {
  return {
    type: "request",
    data: {
      items: [{
        id: 1,
        content: "# SAG 检索\n\nSAG 将文档切成 chunk，抽取单个融合事项和实体，再通过 entity-event 关系进行多跳检索。"
      }],
      meta: {
        source_type: "article",
        source_title: "SAG 说明",
        source_summary: "",
        previous_context: "",
        related_events: [],
        entity_types: benchmarkEntityTypes()
      }
    },
    output_schema: benchmarkExtractionSchema()
  };
}

function benchmarkExtractionExampleOutput() {
  return {
    type: "response",
    data: {
      items: [{
        title: "SAG 文档入库与多跳检索流程",
        summary: "SAG 通过 chunk、融合事项、实体和 entity-event 关系组织文档，以支持多跳检索。",
        content: "SAG 将文档切分为 chunk，并从每个 chunk 中抽取单个融合事项和关键实体，再利用 entity-event 关系进行多跳检索。",
        category: "检索流程",
        keywords: ["SAG", "chunk", "融合事项", "实体", "多跳检索"],
        priority: "UNKNOWN",
        status: "COMPLETED",
        references: [1],
        entities: [
          { type: "product", name: "SAG", description: "执行文档入库和多跳检索的系统" },
          { type: "subject", name: "chunk", description: "SAG 文档入库时形成的原文切片" },
          { type: "subject", name: "entity-event 关系", description: "SAG 多跳检索依赖的事项与实体连接关系" }
        ],
        is_valid: true,
        children: []
      }],
      meta: {
        reason: "识别出一个围绕 SAG 入库与检索的统一主题；覆盖 id1 的 chunk、事项、实体和多跳检索信息；无孤立有效片段。",
        confidence: 0.9
      }
    }
  };
}

function benchmarkExtractionSchema() {
  return {
    type: "object",
    required: ["type", "data"],
    properties: {
      type: { const: "response" },
      data: {
        type: "object",
        required: ["items", "meta"],
        properties: {
          items: {
            type: "array",
            minItems: 0,
            maxItems: 1,
            items: {
              type: "object",
              required: ["title", "summary", "content", "category", "keywords", "references", "entities", "is_valid"],
              properties: {
                title: { type: "string" },
                summary: { type: "string" },
                content: { type: "string" },
                category: { type: "string" },
                keywords: { type: "array", items: { type: "string" } },
                priority: { enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] },
                status: { enum: ["COMPLETED", "PROCESSING", "PENDING", "UNKNOWN"] },
                references: { type: "array", items: { type: "integer" } },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "name", "description"],
                    properties: {
                      type: { enum: benchmarkEntityTypes().map((entityType) => entityType.type) },
                      name: { type: "string" },
                      description: { type: "string" }
                    }
                  }
                },
                is_valid: { type: "boolean" },
                children: { type: "array", maxItems: 0 }
              }
            }
          },
          meta: {
            type: "object",
            required: ["reason"],
            properties: {
              reason: { type: "string" },
              confidence: { type: "number" }
            }
          }
        }
      }
    }
  };
}

function buildBenchmarkExtractionSystemPrompt(): string {
  const now = toLocalISO();
  return `
## Role
You are a SAG content extractor. Extract exactly one event and its entities from the raw content provided in the user message.

## Output (JSON only, no markdown)
{
  "type": "response",
  "data": {
    "items": [{
      "title": "...", "summary": "...", "content": "...",
      "category": "...", "keywords": ["..."],
      "priority": "HIGH|MEDIUM|LOW|UNKNOWN",
      "status": "COMPLETED|PROCESSING|PENDING|UNKNOWN",
      "references": [1],
      "entities": [{"type":"...", "name":"...", "description":"..."}],
      "is_valid": true, "children": []
    }],
    "meta": {"reason": "...", "confidence": 0.9}
  }
}

## Rules
- Fuse all valid fragments into a single event. If no useful content, set is_valid=false and items=[].
- references must cite all fragments used by the event and no others.
- entities: use only the provided entity_types; one entity per name; description explains its role in the event.
- Output language must match the input (Chinese → Chinese).
- Current time: ${now}
`.trim();
}

function normalizeEntities(raw: unknown, inputIsChinese: boolean): ExtractedEntity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const description = String(record.description ?? "").trim();
      return {
        type: normalizeEntityType(String(record.type ?? "subject")),
        name,
        description: normalizeEntityDescription(description, inputIsChinese)
      };
    })
    .filter((entity) => entity.name.length > 1);
}

function collectValidEventItems(items: unknown[]): Array<Record<string, unknown>> {
  const collected: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.is_valid !== false) {
      collected.push(record);
    }
    if (Array.isArray(record.children)) {
      collected.push(...collectValidEventItems(record.children));
    }
  }
  return collected;
}

function buildSingleExtractedEvent(
  items: unknown[],
  input: { title: string; heading?: string; content: string; references: string[] },
  inputIsChinese: boolean
): ExtractedEvent | null {
  const eventItems = collectValidEventItems(items);
  if (eventItems.length === 0) {
    return null;
  }

  const primary = eventItems[0];
  const content = buildConciseEventContent(eventItems, input.content, inputIsChinese);
  if (isLikelyLanguageDrift(content, inputIsChinese)) {
    return null;
  }
  const keywords = uniqueStrings(
    eventItems.flatMap((item) => Array.isArray(item.keywords) ? item.keywords.map(String) : [])
  );
  const entities = uniqueEntities(eventItems.flatMap((item) => normalizeEntities(item.entities, inputIsChinese)));
  const title = normalizeEventText(String(primary.title ?? ""), input.heading ?? input.title, inputIsChinese);
  const summary = normalizeEventText(String(primary.summary ?? ""), title, inputIsChinese);
  const category = normalizeCategory(primary.category, inputIsChinese);

  return {
    title,
    summary,
    content,
    category,
    keywords: keywords.length > 0 ? keywords : localKeywords(input.content),
    references: input.references,
    entities
  };
}

function normalizeEventText(value: string, fallback: string, inputIsChinese: boolean): string {
  const text = value.trim();
  if (!text || isLikelyLanguageDrift(text, inputIsChinese)) {
    return fallback;
  }
  return text;
}

function normalizeCategory(value: unknown, inputIsChinese: boolean): string {
  const fallback = inputIsChinese ? "一般事项" : "general";
  const category = value == null ? "" : String(value).trim();
  const hasChinese = /[\u4e00-\u9fa5]/.test(category);
  if (!category || isLikelyLanguageDrift(category, inputIsChinese) || (inputIsChinese && !hasChinese)) {
    return fallback;
  }
  return category;
}

function normalizeEntityDescription(description: string, inputIsChinese: boolean): string {
  if (!description || isLikelyLanguageDrift(description, inputIsChinese)) {
    return inputIsChinese ? "在当前事项中被提及" : "Mentioned in the current event";
  }
  return description;
}

function buildConciseEventContent(
  eventItems: Array<Record<string, unknown>>,
  fallbackContent: string,
  inputIsChinese: boolean
): string {
  const candidates = uniqueStrings(
    eventItems.flatMap((item) => [
      String(item.summary ?? "").trim(),
      String(item.content ?? "").trim()
    ]).filter(Boolean)
  );
  const raw = candidates.join(inputIsChinese ? "；" : "; ") || fallbackContent.trim();
  return conciseText(raw, inputIsChinese);
}

function conciseText(text: string, inputIsChinese: boolean): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const maxLength = inputIsChinese ? 180 : 360;
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  const sentencePattern = inputIsChinese ? /[^。！？；;]+[。！？；;]?/gu : /[^.!?;]+[.!?;]?/g;
  const sentences = cleaned.match(sentencePattern)?.map((item) => item.trim()).filter(Boolean) ?? [cleaned];
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences) {
    if (selected.length >= 3) {
      break;
    }
    if (length + sentence.length > maxLength && selected.length > 0) {
      break;
    }
    selected.push(sentence);
    length += sentence.length;
  }
  const result = selected.join(inputIsChinese ? "" : " ").trim();
  if (result.length <= maxLength) {
    return result;
  }
  return `${result.slice(0, maxLength - 1).trim()}…`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Set<string>();
  const result: ExtractedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.type}:${entity.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function localExtractEvent(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
}): ExtractedEvent {
  const zh = isMostlyChinese(input.content);
  const title = cleanTitle(input.heading || firstSentence(input.content) || input.title);
  const keywords = localKeywords(`${title} ${input.content}`);
  const entities = localNamedEntities(`${title} ${input.content}`).slice(0, 12).map((name) => ({
    type: inferEntityType(name),
    name,
    description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
  }));
  return {
    title,
    summary: conciseText(firstSentence(input.content) || title, zh),
    content: conciseText(input.content, zh),
    category: zh ? "一般事项" : "general",
    keywords,
    priority: "UNKNOWN",
    status: "COMPLETED",
    references: input.references,
    entities
  };
}

function localNamedEntities(text: string): string[] {
  const candidates = new Set<string>();
  const titleCaseMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[-\s][A-Z][A-Za-z0-9]+){0,4}\b/g) ?? [];
  for (const match of titleCaseMatches) {
    candidates.add(match.trim());
  }
  const quotedMatches = text.match(/["'“”]([^"'“”]{2,80})["'“”]/g) ?? [];
  for (const match of quotedMatches) {
    candidates.add(match.replace(/["'“”]/g, "").trim());
  }
  const cjkMatches = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}(?:公司|集团|大学|模型|系统|产品|项目|技术|平台|算法|数据库|方案)/g) ?? [];
  for (const match of cjkMatches) {
    candidates.add(match.trim());
  }
  return [...candidates].filter((item) => item.length > 1).slice(0, 20);
}

function localKeywords(text: string): string[] {
  if (isMostlyChinese(text)) {
    const cjkTerms = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}/g) ?? [];
    return [...new Set(cjkTerms)].slice(0, 10);
  }
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(token));
  return [...new Set(tokens)].slice(0, 10);
}

function localRerank(query: string, candidates: EventRecord[], topK: number): string[] {
  const queryTokens = new Set(localKeywords(query));
  return [...candidates]
    .sort((a, b) => {
      const overlapA = overlapScore(queryTokens, `${a.title} ${a.content}`);
      const overlapB = overlapScore(queryTokens, `${b.title} ${b.content}`);
      return (overlapB + (b.score ?? 0)) - (overlapA + (a.score ?? 0));
    })
    .slice(0, topK)
    .map((candidate) => candidate.id);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  const tokens = new Set(localKeywords(text));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function firstSentence(text: string): string {
  return text.trim().split(/(?<=[.!?。！？])\s+/u)[0]?.slice(0, 120) ?? "";
}

function cleanTitle(text: string): string {
  return text.replace(/^#+\s*/, "").trim().slice(0, 160) || "Untitled event";
}

function isMostlyChinese(text: string): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  return cjkChars > latinWords * 2;
}

function isLikelyLanguageDrift(text: string, inputIsChinese: boolean): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (inputIsChinese) {
    return cjkChars === 0 && latinWords >= 4;
  }
  return cjkChars >= 8 && latinWords <= 2;
}

function inferEntityType(name: string): string {
  if (/\d/.test(name)) return "metric";
  if (/(Inc|Corp|LLC|Ltd|Company|Group|公司|集团|大学|组织)$/i.test(name)) return "organization";
  if (/(System|Platform|Product|系统|平台|产品|模型|数据库)$/i.test(name)) return "product";
  if (/(Search|Retrieval|检索|搜索|算法|技术|方案)$/i.test(name)) return "subject";
  return "subject";
}

function normalizeEntityType(type: string): string {
  const allowed = new Set(["time", "location", "person", "organization", "subject", "product", "metric", "action", "work", "group", "tags"]);
  return allowed.has(type) ? type : "subject";
}

export const llmClient = new OpenAICompatibleLlmClient();
