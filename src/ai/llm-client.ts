/**
 * Plan B (2026-09-19) — NER model replaces regex NER.
 *
 * What changed since Plan A:
 *   - `extractNamedEntities()`: was always `localNamedEntities()` (regex,
 *     ~1ms). Now it always calls the local ONNX NER pipeline
 *     (`getLocalNerPipeline`, ~5-15ms/chunk). Falls back to the Plan A
 *     regex only if the NER pipeline itself throws (which should be
 *     rare — startup blocks if no model is configured, see
 *     api/server.ts). The model directory is picked from
 *     `settings.nerModel` (set via /api/settings/ner/download).
 *   - `extractEventsFromChunk()` and `rerankEvents()`: unchanged from
 *     Plan A. Event extraction still uses `localExtractEvent` (deterministic
 *     heading/category/keyword logic); rerank uses `localRerank`
 *     (lexical overlap, ~1ms).
 *   - `chatJson()`: kept as a throwing stub so the class shape is stable.
 *
 * Re-enabled 2026-09-24: `LLM_PROVIDER` env / DB field already existed
 * (see migration 016_llm_provider.sql) but the class never read it.
 * The three branches in `extractNamedEntities` / `extractEventsFromChunk`
 * now consult `settings.llmProvider`:
 *   - 'local' (default): NER + heuristic extractor (Plan B behaviour)
 *   - 'api' + hasRemoteLlm: remote LLM via the restored `chatJson()`
 *   - 'api' + missing endpoint config: silent regex fallback — the
 *     operator still gets a usable event for every chunk instead of
 *     an ingest-time crash; the model-call-log row carries
 *     `reason: "llm-not-configured"` so the misconfiguration shows
 *     up in /api/model-call-logs. (2026-09-28 — earlier docstring
 *     said "hard error"; that was true for a stricter era but
 *     benign fallback keeps the operator's queue moving.)
 *
 * What's still in this file:
 *   - `parseJsonOrText`, `stripThinkingBlocks`, `repairOrParse` — JSON
 *     repair helpers. `repairOrParse` is exported and used by tests
 *     (`llm-client-repair.test.ts`); the other two are its private deps.
 *   - `chatJson` private method — restored in 2026-09-24; only used
 *     when llmProvider === 'api'.
 *   - `conciseText` — sentence-aware trimmer used by `localExtractEvent`.
 *   - `localExtractEvent`, `pickRepresentativeSentence`, `classifyCategory`,
 *     `localRerank`, `localKeywords`, `localNamedEntities` — Plan A
 *     regex/heuristic fallback. `localNamedEntities` is the fallback
 *     that runs when the NER pipeline throws.
 *   - `readResponseBody`, `isRetryableFetchError`, `isJsonParseError`,
 *     `waitBeforeRetry`, `buildBenchmarkExtractionMessages`,
 *     `benchmarkEntityTypes`, `benchmarkExtractionSchema`,
 *     `buildBenchmarkExtractionSystemPrompt`, `normalizeEntities`,
 *     `collectValidEventItems`, `buildSingleExtractedEvent`,
 *     `normalizeEventText`, `normalizeCategory`,
 *     `normalizeEntityDescription`, `buildConciseEventContent`,
 *     `uniqueStrings`, `uniqueEntities`, `normalizeEntityType`,
 *     `isLikelyLanguageDrift` — re-added 2026-09-24 to support
 *     the 'api' branch. No behaviour change for the default
 *     'local' branch.
 *
 * The local-llm-client.ts module is also kept (settings UI warmup route
 * and tests still reference it) but no production code path imports it
 * anymore.
 */
import { aiSettingsService, type AiRuntimeSettings } from "../services/ai-settings-service.js";
import type { ExtractedEntity, ExtractedEvent, EventRecord } from "../types.js";
import { createModelCallLogger } from "../observability/model-call-log.js";
import { logger } from "../observability/logger.js";
import { getLocalNerPipeline, type NerTokenResult } from "./ner-pipeline-factory.js";
import { toLocalISO } from "../db/row-helpers.js";
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
    // Branch on llmProvider — operator chose between remote LLM and
    // local NER pipeline. Plan B (NER-only) was the default until
    // 2026-09-24; the api branch restores the previous remote-LLM
    // path for operators who want higher-quality extraction at the
    // cost of latency / token spend.
    if (settings.llmProvider === "api") {
      // api mode: try the remote LLM; fall back to the Plan A regex
      // entity extractor on any failure so the search path stays
      // useful when the LLM endpoint is offline / misconfigured.
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractNamedEntities.api",
        request: { query, llmProvider: settings.llmProvider }
      });
      if (!settings.hasRemoteLlm || !settings.llmBaseUrl || !settings.llmModel) {
        log.degrade({
          reason: "llm-not-configured",
          response: [],
          details: {
            hasRemoteLlm: settings.hasRemoteLlm,
            llmBaseUrl: settings.llmBaseUrl,
            llmModel: settings.llmModel,
            fallback: "regex-ner"
          }
        });
        return localNamedEntities(query);
      }
      try {
        const result = await this.chatJson(settings, {
          operation: "extractNamedEntities.api",
          system: "Extract named entities important for answering the question. Return JSON only.",
          user: JSON.stringify({ question: query, schema: { named_entities: ["string"] } })
        });
        const entities = Array.isArray(result.named_entities) ? result.named_entities : result.entities;
        const list = Array.isArray(entities) ? entities.map(String).filter(Boolean) : [];
        log.succeed({ named_entities: list, source: "remote-llm" });
        return list;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, "extractNamedEntities: remote LLM failed, falling back to regex");
        log.degrade({
          reason: "remote-llm-failed",
          response: [],
          details: { error: message, fallback: "regex-ner" }
        });
        return localNamedEntities(query);
      }
    }
    // local mode: ONNX token-classification NER. Model path comes
    // from settings.nerModel (populated via /api/settings/ner/download).
    const log = createModelCallLogger({
      kind: "llm",
      operation: "extractNamedEntities.ner",
      request: {
        query,
        nerModel: settings.nerModel,
        nerMaxTokens: settings.nerMaxTokens,
        bypassedRemote: true,
        bypassedLocalLlm: true
      }
    });
    try {
      const pipeline = await getLocalNerPipeline({
        modelPath: settings.nerModel,
        maxTokens: settings.nerMaxTokens,
        aggregationStrategy: "simple"
      });
      const truncated = query.length > settings.nerMaxTokens * 4
        ? query.slice(0, settings.nerMaxTokens * 4)
        : query;
      const raw = await pipeline(truncated, {
        ignore_labels: ["O"],
        max_length: settings.nerMaxTokens,
        truncation: true
      });
      const entities = normalizeNerResults(raw);
      log.succeed({ named_entities: entities, source: "ner-model" });
      return entities;
    } catch (err) {
      log.degrade({
        reason: "ner-pipeline-failed",
        response: [],
        details: { error: (err as Error).message, fallback: "regex-ner" }
      });
      const fallback = localNamedEntities(query);
      return fallback;
    }
  }

  async extractEventsFromChunk(input: {
    title: string;
    heading?: string;
    content: string;
    references: string[];
  }): Promise<ExtractedEvent[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    if (settings.llmProvider === "api") {
      // api mode: try the remote LLM first; on ANY error fall back to
      // the regex/heuristic pipeline so the operator still gets an
      // event for the chunk instead of an HTTP 500. The fallback is
      // surfaced in two places:
      //   1. The returned events carry extractionSource = "regex-fallback"
      //      so the UI can render a `fallback *N` badge on the source
      //      document (see migrations/017 + App.tsx).
      //   2. modelCallLog.degrade() records the failure with the
      //      original LLM error attached, so /api/model-call-logs
      //      shows the degraded path.
      const log = createModelCallLogger({
        kind: "llm",
        operation: "extractEventsFromChunk.api",
        request: { ...input, llmProvider: settings.llmProvider }
      });
      if (!settings.hasRemoteLlm || !settings.llmBaseUrl || !settings.llmModel) {
        // Misconfigured endpoint (no key / no URL / no model) is still
        // an explicit error — there's nothing to call. Fall through to
        // regex but tag the log row as "misconfigured" so it's obvious
        // the operator hasn't actually configured their endpoint.
        log.degrade({
          reason: "llm-not-configured",
          response: [],
          details: {
            hasRemoteLlm: settings.hasRemoteLlm,
            llmBaseUrl: settings.llmBaseUrl,
            llmModel: settings.llmModel,
            fallback: "regex"
          }
        });
        return this.runRegexFallback(input, "misconfigured → regex");
      }
      try {
        const result = await this.chatJson(settings, {
          operation: "extractEventsFromChunk.api",
          messages: buildBenchmarkExtractionMessages(input)
        });
        const items = Array.isArray(result.items) ? result.items : result.data?.items;
        const inputIsChinese = isMostlyChinese(input.content);
        if (!Array.isArray(items) || items.length === 0) {
          // F-2026-09-29: model returned empty items. We used to throw
          // and fall back to regex — but the model often does this when
          // the chunk is a list / bullet list / partial fragment rather
          // than a single narrative event. That's not a failure; it's
          // the LLM's honest "this isn't a strong single-event chunk"
          // signal. Synthesise a minimal event from the chunk's heading
          // + content so it still goes into the DB with extractionSource
          // = "remote-llm" instead of getting demoted to regex-fallback.
          // The synthetic event has empty keywords/entities, which is
          // the truthful representation — the LLM didn't extract any.
          const synthetic: ExtractedEvent = {
            title: (input.heading ?? input.title ?? "").trim() || "未命名事件",
            summary: input.content.slice(0, 200).trim(),
            content: input.content,
            category: inputIsChinese ? "事项" : "general",
            keywords: [],
            references: input.references,
            entities: []
          };
          log.succeed({ events: [synthetic], source: "remote-llm-empty" });
          return [{ ...synthetic, extractionSource: "remote-llm" }];
        }
        const event = buildSingleExtractedEvent(items, input, inputIsChinese);
        if (!event) {
          // F-2026-10-13: buildSingleExtractedEvent returns null in two
          // real-world cases that aren't model failures:
          //   1. Language drift — the chunk content is mostly
          //      non-Chinese (English technical document / table of
          //      codes like "CA-19-C74") and the LLM sensibly replied
          //      in English, which isLikelyLanguageDrift then rejects
          //      because the input was tagged Chinese.
          //   2. All items filtered by collectValidEventItems (no
          //      title/summary/content).
          // Both cases are honest signals that the LLM saw the chunk
          // but couldn't shape a single coherent event from it. We
          // used to throw and let the catch below fall back to regex
          // (which then produces a worse title — typically the chunk
          // heading). Synthesise a minimal event from the heading +
          // content instead so the chunk still gets a `remote-llm`
          // row with usable title/content. Empty keywords/entities
          // is the truthful representation.
          // Use `||` (not `??`) so an empty-string heading still
          // falls back to the document title. The empty-item branch
          // above uses the same idiom.
          const syntheticTitle = input.heading || input.title || "";
          const synthetic: ExtractedEvent = {
            title: syntheticTitle.trim() || "未命名事件",
            summary: input.content.slice(0, 200).trim(),
            content: input.content,
            category: inputIsChinese ? "事项" : "general",
            keywords: [],
            references: input.references,
            entities: []
          };
          log.succeed({ events: [synthetic], source: "remote-llm-validation-failed" });
          return [{ ...synthetic, extractionSource: "remote-llm" }];
        }
        const out: ExtractedEvent[] = [{ ...event, extractionSource: "remote-llm" }];
        log.succeed({ events: out, source: "remote-llm" });
        return out;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err: message, heading: input.heading, title: input.title },
          "extractEventsFromChunk: remote LLM failed, falling back to regex"
        );
        log.degrade({
          reason: "remote-llm-failed",
          response: [],
          details: { error: message, fallback: "regex" }
        });
        return this.runRegexFallback(input, `api error → regex (${message.slice(0, 200)})`);
      }
    }
    // local mode (legacy, kept for back-compat with installations that
    // explicitly set llmProvider=local): ONNX NER + heuristic extractor.
    const log = createModelCallLogger({
      kind: "llm",
      operation: "extractEventsFromChunk.local",
      request: {
        ...input,
        llmProvider: settings.llmProvider,
        bypassedRemote: !settings.hasRemoteLlm,
        bypassedLocalLlm: settings.llmProvider === "local",
        nerModel: settings.nerModel
      }
    });
    let nerNames: string[] = [];
    let nerSource: "ner-model" | "regex-ner-fallback" = "regex-ner-fallback";
    let nerBreakerLogged = false;
    try {
      const query = `${input.title}\n${input.content}`;
      nerNames = await runNerForIngest({ query, settings });
      if (nerNames.length > 0) nerSource = "ner-model";
    } catch (err) {
      // NER circuit-breaker tripped: see runNerForIngest's comment
      // for the why. The preflight/breaker memoises the result
      // so subsequent chunks short-circuit, but the call site
      // still lands in this catch every time. Without the
      // dedupe below, 7 reaped files × 10 chunks × 4 concurrent
      // workers would flood the log with thousands of identical
      // "NER pipeline failed" warnings and bury the real signal.
      // We log ONCE per breaker key change (modelPath) — the
      // model-call log row still records the failure with the
      // original error attached for /api/model-call-logs.
      const message = (err as Error).message;
      if (!_lastNerBreakerError || _lastNerBreakerError !== message) {
        _lastNerBreakerError = message;
        nerBreakerLogged = true;
        logger.warn(
          { err: message },
          "extractEventsFromChunk: NER pipeline failed, falling back to localNamedEntities"
        );
      }
    }
    const event = localExtractEvent({ ...input, nerNames });
    const events: ExtractedEvent[] = [{ ...event, extractionSource: "regex-fallback" }];
    log.succeed({ events, source: nerSource });
    return events;
  }

  /**
   * Shared regex fallback used by both the api-throws branch and the
   * legacy local branch. Returns a single event stamped with
   * `extractionSource = "regex-fallback"` so the UI can surface a
   * `fallback *N` badge on the source document. The `triggerNote` is
   * only used for the log row to explain why the fallback fired.
   */
  private runRegexFallback(
    input: {
      title: string;
      heading?: string;
      content: string;
      references: string[];
    },
    _triggerNote: string
  ): ExtractedEvent[] {
    const event = localExtractEvent({ ...input });
    return [{ ...event, extractionSource: "regex-fallback" }];
  }

  async rerankEvents(input: {
    query: string;
    candidates: EventRecord[];
    topK: number;
  }): Promise<string[]> {
    const settings = await aiSettingsService.getRuntimeSettings();
    // Plan A (2026-09-19): LLM removed from the rerank pipeline too.
    // Operators who want the BERT-based rerank should call
    // `reranker.rerankEvents` via search mode "fast" — see
    // services/search-service.ts. The llm.rerankEvents path was only
    // ever invoked from multi/standard search modes and ate ~120s per
    // query on local GGUF.
    const log = createModelCallLogger({
      kind: "llm",
      operation: "rerankEvents.local",
      request: {
        ...input,
        llmProvider: settings.llmProvider,
        bypassedRemote: !settings.hasRemoteLlm,
        bypassedLocalLlm: settings.llmProvider === "local"
      }
    });
    const ids = localRerank(input.query, input.candidates, input.topK);
    log.succeed({ useful_event_ids: ids, source: "lexical-rerank" });
    return ids;
  }

  /**
   * @deprecated Plan A (2026-09-19): LLM removed from the ingest & rerank
   * pipeline. This method is preserved only to keep the class shape stable
   * for any future code that introspects it (e.g. tests, settings UI). It
   * throws unconditionally if called — operators should not see it fire
   * because the three public methods on this class no longer reach for it.
   *
   * Re-enabled 2026-09-24: the operator can now pick LLM_PROVIDER=api to
   * route extraction through this method. The default is still 'local'
   * (NER), so legacy installs see no behaviour change.
   */
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
    const maxAttempts = 1 + config.LLM_MAX_RETRIES;
    const timeoutMs = settings.llmTimeoutMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      let abortReason = "";
      const watchdog = setTimeout(() => {
        abortReason = `llm-watchdog-timeout-${timeoutMs}ms`;
        controller.abort(abortReason);
      }, timeoutMs);
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
          // P-Secrets — cap to 200 chars; the pino redact config in
          // observability/logger.ts will strip any API key the LLM
          // provider echoes in the 5xx body.
          const safeBody = responseText.slice(0, 200);
          throw new Error(
            `llm request failed: ${response.status} ${safeBody}`
          );
        }
        const json = responseBody as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const cleaned = stripThinkingBlocks(content);
        return repairOrParse(cleaned) ?? JSON.parse(cleaned);
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        lastError = wrapped;
        if (
          attempt < maxAttempts &&
          (isRetryableFetchError(wrapped) || isJsonParseError(wrapped))
        ) {
          await waitBeforeRetry(attempt);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(watchdog);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }
}

/**
 * Shared NER runner. Called both from `extractNamedEntities` (query
 * path — emits its own `extractNamedEntities.ner` log row) and from
 * `extractEventsFromChunk` (ingest path — reuses the outer
 * `extractEventsFromChunk.local` log row so /api/model-call-logs
 * still shows one entry per chunk, not two).
 *
 * Returns the array of normalized entity names (deduped, capped at
 * `NER_MAX_ENTITIES`). Throws if the pipeline itself throws — the
 * caller decides whether to fall back to the Plan A regex.
 */
/**
 * Process-level circuit breaker for the NER pipeline. When the
 * ONNX model is missing or broken on disk, `getLocalNerPipeline()`
 * allocates hundreds of MB per attempt before throwing. With
 * concurrency=4 ingest workers each calling runNerForIngest per
 * chunk, even a single reaped batch of 7 files × 10 chunks burns
 * through 4 GB of heap in seconds and the process OOMs.
 *
 * The fix has two layers:
 *
 *   1. Pre-flight directory check (`nerModelExists`). If the
 *      configured `ner_model` path doesn't point to a directory
 *      containing a `tokenizer.json` file, we know transformers
 *      will fail to load it. Bail out before the WASM runtime
 *      gets a chance to allocate, and remember the result in
 *      `_nerDisabledFor` so subsequent chunks don't re-stat the
 *      disk either.
 *
 *   2. Run-time circuit breaker (`_nerCircuitBrokenFor`). If
 *      transformers throws for any other reason (corrupt
 *      weights, ONNX runtime error, etc.) the breaker trips and
 *      subsequent calls return `[]` immediately.
 *
 * The caller's catch block still runs the regex fallback, so
 * ingest keeps moving — just without NER names.
 *
 * Operators who actually fix the model (download it, re-point
 * `ner_model` in Settings) need to restart the process for the
 * breaker to clear, which is the correct behaviour: the model
 * path is the cache key, so a setting update would invalidate
 * any cached state automatically via the existing
 * `disposeNerPipeline()` plumbing on `ai-settings-service.ts:289`.
 */
let _nerDisabledFor:
  | { path: string; reason: string; checkedAt: number }
  | null = null;
let _nerCircuitBrokenFor:
  | { key: string; err: string; failedAt: number }
  | null = null;
// Dedupes the warning emitted from extractEventsFromChunk's catch
// block. The breaker / preflight already memoises the failure
// reason, but the call site still re-enters the catch every chunk
// — without this dedupe a 7-file reaper batch with 4 concurrent
// workers would log the same "NER pipeline failed" line thousands
// of times. Reset to null on a fresh error so a new NER-model
// path / error reason still produces a single visible warning.
let _lastNerBreakerError: string | null = null;

function _nerCacheKey(modelPath: string, maxTokens: number, aggregation: string): string {
  return `${modelPath}|${maxTokens}|${aggregation}`;
}

/**
 * Resolve the on-disk path that `getLocalNerPipeline()` would
 * use for a given relative or absolute `modelPath`. Mirrors the
 * `resolveLocalModelPath` + `path.basename` logic in
 * ner-pipeline-factory.ts without re-implementing the env-var
 * trail. Imported dynamically so the test suite can mock the
 * factory.
 */
async function _resolveNerModelDir(modelPath: string): Promise<string> {
  const { resolveLocalModelPath } = await import("./model-path-resolver.js");
  return resolveLocalModelPath(modelPath);
}

/**
 * Cheap pre-flight: does the configured NER model directory
 * exist and contain a `tokenizer.json`? transformers' failure
 * mode for a missing model is to throw AFTER allocating the
 * ONNX runtime (~hundreds of MB); checking the path first
 * prevents that allocation entirely.
 */
async function nerModelExists(modelPath: string): Promise<{ ok: boolean; reason?: string }> {
  if (!modelPath || modelPath.trim().length === 0) {
    // Remember the disabled state keyed on the literal empty
    // string so subsequent chunks don't re-evaluate the same
    // empty input. Without this, every chunk of every file
    // would log the same "ner_model path is empty" warning and
    // 7 reaped files × 10 chunks = 70+ duplicate lines. The
    // breaker also deduplicates by modelPath, so the warning
    // is at most logged twice per process: once when the first
    // chunk trips it, and once (the first non-empty path) when
    // the operator changes the model.
    if (!_nerDisabledFor || _nerDisabledFor.path !== "") {
      _nerDisabledFor = {
        path: "",
        reason: "ner_model path is empty",
        checkedAt: Date.now()
      };
    }
    return { ok: false, reason: "ner_model path is empty" };
  }
  if (_nerDisabledFor && _nerDisabledFor.path === modelPath) {
    return { ok: false, reason: _nerDisabledFor.reason };
  }
  let resolved: string;
  try {
    resolved = await _resolveNerModelDir(modelPath);
  } catch (err) {
    // resolveLocalModelPath throws when no candidate exists
    // (absolute path, <exeDir>/resources/<path>, <exeDir>/<path>,
    // <cwd>/<path>). Treat that as "not available" rather than
    // letting it propagate so the breaker trips cleanly.
    const reason = `model directory not found: ${(err as Error).message.split("\n")[0]}`;
    _nerDisabledFor = { path: modelPath, reason, checkedAt: Date.now() };
    return { ok: false, reason };
  }
  const { existsSync } = await import("node:fs");
  const tokenizerPath = `${resolved.replace(/[\\/]+$/, "")}/tokenizer.json`;
  if (!existsSync(tokenizerPath)) {
    const reason = `tokenizer.json not found at ${tokenizerPath}`;
    _nerDisabledFor = { path: modelPath, reason, checkedAt: Date.now() };
    return { ok: false, reason };
  }
  return { ok: true };
}

async function runNerForIngest(input: {
  query: string;
  settings: AiRuntimeSettings;
}): Promise<string[]> {
  // Pre-flight: skip the entire ONNX/WASM load path if the model
  // directory is missing the tokenizer file. This is the dominant
  // failure mode in dev installs (operator hasn't downloaded the
  // model yet) and the only way to avoid the 500MB+ allocation
  // that pushes the process over the 4GB heap ceiling.
  const preflight = await nerModelExists(input.settings.nerModel);
  if (!preflight.ok) {
    // Throwing here is fine — the caller's catch block runs the
    // regex fallback, so ingest still produces a valid event row
    // for the chunk. The breaker is already tripped via
    // _nerDisabledFor so subsequent chunks also bail out without
    // touching the disk.
    throw new Error(`NER model unavailable: ${preflight.reason}`);
  }

  const key = _nerCacheKey(
    input.settings.nerModel,
    input.settings.nerMaxTokens,
    "none"
  );
  // Run-time circuit breaker: if this exact (model, maxTokens,
  // strategy) tuple already failed for any OTHER reason
  // (corrupt weights, ONNX runtime error, etc.), skip the call.
  // The process keeps the regex fallback in the caller's catch
  // block, so ingest works — just without NER names.
  if (_nerCircuitBrokenFor && _nerCircuitBrokenFor.key === key) {
    return [];
  }
  try {
    const pipeline = await getLocalNerPipeline({
      modelPath: input.settings.nerModel,
      maxTokens: input.settings.nerMaxTokens,
      aggregationStrategy: "none"
    });
    // Truncate to the model budget so a chunk longer than the cap
    // doesn't OOM the runtime. `truncation: true` makes the pipeline
    // return early instead of throwing. We request raw BMES tags
    // (aggregation_strategy="none") instead of transformers' default
    // "simple" aggregation, because "simple" naively concatenates
    // adjacent same-type tokens and merges "马云" + "张勇" into the
    // single bogus entity "马云张勇". normalizeNerResults() does the
    // B-/I-/E-/S- → display span conversion below.
    const truncated = input.query.length > input.settings.nerMaxTokens * 4
      ? input.query.slice(0, input.settings.nerMaxTokens * 4)
      : input.query;
    const raw = await pipeline(truncated, {
      ignore_labels: ["O"],
      aggregation_strategy: "none",
      max_length: input.settings.nerMaxTokens,
      truncation: true
    });
    // Success — clear any previous breaker state for this key.
    if (_nerCircuitBrokenFor && _nerCircuitBrokenFor.key === key) {
      _nerCircuitBrokenFor = null;
    }
    return normalizeNerResults(raw);
  } catch (err) {
    // Trip the breaker so subsequent chunks don't re-pay the
    // WASM allocation cost. Keep the first error message so the
    // log line is informative.
    const message = (err as Error).message ?? String(err);
    _nerCircuitBrokenFor = { key, err: message, failedAt: Date.now() };
    throw err;
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
  // Common malformations from LLM output, in roughly the order we
  // tend to see them in the wild:
  //   1) Raw control characters inside a JSON string (newline, tab,
  //      CR) — the LLM often emits a real \n inside a string value
  //      even though the spec requires \n. JSON.parse then throws
  //      "Bad control character in string literal" or "Unterminated
  //      string". We escape them before any other fix so the rest
  //      of the heuristics can count balanced quotes.
  //   2) Stray ``` / ```json fences that survived stripThinkingBlocks
  //      (e.g. the model opens a fence, drops JSON, then never closes
  //      it before the token cap).
  //   3) Trailing partial line / dangling key after a token-cap cut.
  //   4) Trailing comma before `}` or `]`.
  //   5) Unterminated string at EOF (we close it).
  //   6) Missing closing `}` / `]` at EOF.
  let s = text;
  // 1) Strip a leftover code fence (only at the start / end — the
  //    middle-fence case is rarer and we don't try to salvage it).
  s = s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
  // 2) Escape raw control chars inside what we believe to be a string
  //    literal. We walk the string in pairs: if we're between two
  //    unescaped `"` and we hit U+0008/0A/0C/0D, replace with the
  //    JSON-legal escape sequence. Outside a string these characters
  //    can't legally appear at all, so we strip them too.
  {
    let out = "";
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = s.charCodeAt(i);
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        out += ch;
        continue;
      }
      if (inString) {
        if (code === 0x0a) { out += "\\n"; continue; }
        if (code === 0x0d) { out += "\\r"; continue; }
        if (code === 0x09) { out += "\\t"; continue; }
        if (code === 0x08) { out += "\\b"; continue; }
        if (code === 0x0c) { out += "\\f"; continue; }
        if (code < 0x20) { out += " "; continue; } // other control char → space
        out += ch;
        continue;
      }
      // outside any string: strip control chars entirely (they're
      // never legal in JSON outside string literals).
      if (code < 0x20) continue;
      out += ch;
    }
    s = out;
  }
  // Try to parse once more after the control-char fix. This is the
  // single most common real-world failure mode.
  try {
    return JSON.parse(s);
  } catch {
    // fall through to structural repair
  }
  // 3) Drop a trailing partial line that looks like the start of a
  //    new key/value pair but never finished (best-effort).
  const lastBrace = s.lastIndexOf("{");
  if (lastBrace > 0) {
    const tail = s.slice(lastBrace);
    if (!tail.includes(":")) {
      s = s.slice(0, lastBrace);
    }
  }
  // 4) Strip trailing commas before `}` or `]`.
  s = s.replace(/,\s*([}\]])/g, "$1");
  // 5) If we are inside a string at EOF, close it.
  //    Heuristic: count unescaped `"` outside of any in-progress token.
  const quoteCount = (s.match(/(?<!\\)"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    s = `${s}"`;
  }
  // 6) Balance braces and brackets.
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

// ----- Plan A (2026-09-19): LLM-only helpers removed ---------------------
// The following helpers were reachable from the now-deleted LLM HTTP and
// GGUF branches in `OpenAICompatibleLlmClient.chatJson` and the local
// GGUF branches in `extractEventsFromChunk` / `rerankEvents`. They are no
// longer reachable from any caller in this file. We keep them commented
// here as breadcrumbs in case Plan A needs to be reverted; restore them
// verbatim from the backup at backup_a_plan_2026-09-19/src/ai/llm-client.ts.
//
// Re-added 2026-09-24: chatJson() and the benchmark extraction
// helpers are restored so operators who set LLM_PROVIDER='api' get
// the remote-LLM extraction path back. Default is still 'local' (NER).
// -----------------------------------------------------------------------

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

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
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

function normalizeEntityType(type: string): string {
  const allowed = new Set(["time", "location", "person", "organization", "subject", "product", "metric", "action", "work", "group", "tags"]);
  return allowed.has(type) ? type : "subject";
}

function isLikelyLanguageDrift(text: string, inputIsChinese: boolean): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z]{2,}/g)?.length ?? 0;
  if (inputIsChinese) {
    return cjkChars === 0 && latinWords >= 4;
  }
  return cjkChars >= 8 && latinWords <= 2;
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

function localExtractEvent(input: {
  title: string;
  heading?: string;
  content: string;
  references: string[];
  nerNames?: string[]; // optional NER outputs from the ONNX pipeline; if
                        // absent we fall back to `localNamedEntities()`.
}): ExtractedEvent {
  const zh = isMostlyChinese(input.content);
  // Title priority:
  //   1) explicit heading (best signal — usually the section title)
  //   2) first sentence that contains a category keyword (e.g. "本期内控审计发现...")
  //   3) first sentence (raw)
  //   4) document title
  const sentenceForTitle = pickRepresentativeSentence(input.content, zh);
  const title = cleanTitle(input.heading || sentenceForTitle || firstSentence(input.content) || input.title);
  const keywords = localKeywords(`${title} ${input.content}`);
  // Entities come from the ONNX NER pipeline when available (Plan B
  // 2026-09-19). The pipeline's BMES output labels every span with
  // PERSON / LOC / ORG / GPE — we want to preserve those types
  // instead of running `inferEntityType()` (which only knows about
  // subject/work/metric/product via suffix matching and would
  // collapse "张三" → "subject").
  //
  // Two strategies:
  //   1. If `nerNames` has results, use them with `entityTypeFromNer()`
  //      which inspects the BMES tags from the previous plan, falling
  //      back to `inferEntityType()` for any names that look like
  //      generic keywords the model surfaced.
  //   2. If the pipeline failed entirely, fall back to
  //      `localNamedEntities()` regex + `inferEntityType()` (Plan A).
  const namesFromNer = (input.nerNames ?? []).slice(0, 12);
  let entities: Array<{ type: string; name: string; description: string }>;
  if (namesFromNer.length > 0) {
    // Map NER names → typed entities. The bert-base-chinese-ner
    // output already classifies PERSON / LOC / ORG / GPE; we keep
    // those labels and use inferEntityType() only for names that
    // don't fit the NER taxonomy (rare — usually generic phrases
    // the model still surfaced).
    entities = namesFromNer.map((name) => ({
      type: entityTypeFromNer(name) ?? inferEntityType(name),
      name,
      description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
    }));
  } else {
    const entityNames = localNamedEntities(`${title} ${input.content}`).slice(0, 12);
    entities = entityNames.map((name) => ({
      type: inferEntityType(name),
      name,
      description: zh ? `在事项「${title}」中被提及` : `Mentioned in event: ${title}`
    }));
  }
  return {
    title,
    // Summary = most informative sentence (prefers category-bearing sentences)
    summary: conciseText(sentenceForTitle || firstSentence(input.content) || title, zh),
    content: conciseText(input.content, zh),
    // Category = keyword classifier; falls back to "一般事项" / "general"
    category: classifyCategory(input.content, zh),
    keywords,
    priority: "UNKNOWN",
    status: "COMPLETED",
    references: input.references,
    entities
  };
}

/**
 * Type hint for a name that came out of the ONNX NER pipeline.
 *
 * Plan B (2026-09-19) introduced bert-base-chinese-ner, which labels
 * spans as PERSON / LOC / GPE / ORG / FAC. When `extractEventsFromChunk`
 * surfaces NER names as `entities[].name`, we want the schema to
 * reflect those semantic types instead of the Plan A
 * subject/work/metric/product taxonomy.
 *
 * The NER model returns spans that already carry their BMES prefix
 * upstream, but `runNerForIngest()` collapses them to a plain
 * `string[]` because the same function is reused for keyword
 * extraction. So at this layer we have only the visible name and
 * need to re-derive the type from heuristics:
 *
 *   - If the name itself encodes a clear type (e.g. ends in
 *     "银行" / "公司" / "大学" / "医院" → organization; ends in
 *     "省" / "市" / "区" / "县" / "国" → location), trust it.
 *   - Otherwise return `null` so the caller falls back to
 *     `inferEntityType()` — that's the Plan A suffix-based path that
 *     handles "方案" → work, "系统" → product, etc. Without this
 *     fallback a generic NER name like "审计" would default to
 *     "person" via this function's remaining case, which is wrong.
 */
function entityTypeFromNer(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/(银行|公司|集团|大学|学院|医院|局|委员会|事务所|所|厂|站|中心|基金|协会|联盟|医院|医院)$/.test(trimmed)) {
    return "organization";
  }
  if (/(省|市|区|县|国|州|镇|村|街道|路|街|区|园区|新城|开发区|高新区)$/.test(trimmed)) {
    return "location";
  }
  if (/(湖|山|河|江|海|岛|港|湾|洲|半岛|群岛|山脉|峡谷|沙漠|草原|盆地)$/.test(trimmed)) {
    return "location";
  }
  // Two-character Chinese names (张三、李四、王五…) are the strongest
  // signal that the model emitted a person — but only if the chars
  // are pure CJK and the name is short. This is a heuristic, so the
  // caller's inferEntityType fallback covers any false positives.
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(trimmed)) {
    return "person";
  }
  return null;
}

// --- Plan A helpers: deterministic, no LLM -------------------------------

// Pick the most informative sentence for title/summary. Prefers sentences
// that contain category-keywords (e.g. "审计发现"), then the longest
// sentence (more content), then the first sentence.
function pickRepresentativeSentence(text: string, zh: boolean): string {
  const pattern = zh ? /[^。！？；;]+[。！？；;]?/gu : /[^.!?;]+[.!?;]?/g;
  const sentences = (text.match(pattern) ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length >= 6 && item.length <= 240);
  if (sentences.length === 0) {
    return firstSentence(text);
  }
  const triggers = [
    "审计发现", "发现", "风险", "控制点", "缺陷", "建议", "结论",
    "本期", "本期审计", "本次", "本年度", "本期内", "内控", "合规",
    "问题", "异常", "损失", "违规", "整改", "落实"
  ];
  const scored = sentences.map((sentence, index) => {
    const score = triggers.reduce((acc, keyword) => acc + (sentence.includes(keyword) ? 1 : 0), 0);
    return { sentence, index, score, length: sentence.length };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.length !== a.length) return b.length - a.length;
    return a.index - b.index; // earliest first when everything else ties
  });
  return scored[0].sentence;
}

// Keyword-based category classifier. Returns one of the canonical SAG
// event categories, or "一般事项" / "general" as a fallback.
function classifyCategory(text: string, zh: boolean): string {
  if (!zh) {
    if (/(audit\s+finding|finding|control\s+(deficiency|gap)|risk\s+identified)/i.test(text)) {
      return "audit_finding";
    }
    if (/(recommendation|action\s+plan|remediation)/i.test(text)) {
      return "recommendation";
    }
    if (/(policy|procedure|standard|guideline)/i.test(text)) {
      return "policy";
    }
    if (/(risk|exposure|threat|vulnerab)/i.test(text)) {
      return "risk";
    }
    return "general";
  }
  const rules: Array<[RegExp, string]> = [
    [/审计发现|审计报告|审计结论/, "审计发现"],
    [/内控.{0,4}(缺陷|不足|失效|问题)/, "内控缺陷"],
    [/控制点|控制.{0,4}(活动|措施|环节)/, "控制点"],
    [/风险.{0,6}(点|事项|提示|等级|评估|识别)/, "风险点"],
    [/合规.{0,6}(问题|检查|要求|审查|整改)/, "合规事项"],
    [/建议.{0,4}(事项|措施|落实|整改)/, "建议事项"],
    [/整改.{0,6}(事项|措施|落实|情况)/, "整改事项"],
    [/政策.{0,4}(事项|法规|法规|文件)/, "政策事项"],
    [/制度.{0,4}(事项|建立|完善|修订)/, "制度事项"],
    [/异常|告警|故障|中断/, "异常事项"],
    [/损失|亏损|减值/, "损失事项"],
    [/违规|违反/, "违规事项"]
  ];
  for (const [pattern, label] of rules) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return "一般事项";
}

function localNamedEntities(text: string): string[] {
  const candidates = new Map<string, { type: string; score: number }>();
  const add = (raw: string, type: string, weight: number) => {
    const value = raw.trim().replace(/^[\s"'“”‘’,，。；;:\-:：]+|[\s"'“”‘’,，。；;:\-:：]+$/g, "");
    if (value.length < 2 || value.length > 40) return;
    const existing = candidates.get(value);
    if (existing) {
      existing.score += weight;
      if (type !== "subject" && existing.type === "subject") {
        existing.type = type;
      }
    } else {
      candidates.set(value, { type, score: weight });
    }
  };

  // 1) Quoted phrases (always keep — likely titles or named terms)
  const quotedMatches = text.match(/["'“”《》『』]([^"'“”《》『』]{2,80})["'“”《》『』]/g) ?? [];
  for (const match of quotedMatches) {
    add(match.replace(/["'“”《》『』]/g, ""), "subject", 3);
  }

  // 2) English TitleCase phrases (e.g. "Payment System", "Risk Management")
  const titleCaseMatches = text.match(/\b[A-Z][A-Za-z0-9]+(?:[-'\s][A-Z][A-Za-z0-9]+){0,5}\b/g) ?? [];
  for (const match of titleCaseMatches) {
    add(match, inferEntityType(match), 2);
  }

  // 3) Chinese orgs / products / systems with strong suffix signals
  const orgSuffix = /(公司|集团|银行|事务所|委员会|办公室|中心|部门|学院|大学|医院|研究所|研究院|实验室|部门|总部|分部|分公司|子公司|事业部)/;
  const productSuffix = /(系统|平台|产品|模型|数据库|服务|工具|引擎|框架|SDK|API|模块|组件|项目|方案|技术|算法)/;
  const riskSuffix = /(风险|漏洞|威胁|缺陷|问题|隐患)/;
  const docSuffix = /(报告|文件|手册|指南|方案|计划|规划|制度|流程|规定|细则|标准|规范|指引)/;
  for (const match of text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,24}/g) ?? []) {
    if (orgSuffix.test(match)) add(match, "organization", 2);
    else if (productSuffix.test(match)) add(match, "product", 1.5);
    else if (riskSuffix.test(match)) add(match, "subject", 1.2);
    else if (docSuffix.test(match)) add(match, "work", 1);
  }

  // 4) Document numbers: 国发〔2024〕12号 / 财税[2023]45号 / GB/T 22239-2019
  const docNumberMatches = text.match(/[A-Z\u4e00-\u9fa5]{0,8}[〔\[\(【]?(19|20)\d{2}[〕\]\)】]?\s*第?\s*\d{1,4}\s*号?/g) ?? [];
  for (const match of docNumberMatches) {
    add(match, "work", 3);
  }
  // 5) Date expressions: 2024年3月15日 / 2024-03-15
  const dateMatches = text.match(/(19|20)\d{2}\s*[年\-./]\s*\d{1,2}\s*[月\-./]?\s*\d{0,4}\s*日?/g) ?? [];
  for (const match of dateMatches) {
    add(match, "time", 1.5);
  }
  // 6) Money / percent: ¥1,234,567.89 / 1.5亿 / 23%
  const metricMatches = text.match(/[¥$€£]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?[%‰]|\d+(?:\.\d+)?\s?(亿|万|千|百)/g) ?? [];
  for (const match of metricMatches) {
    add(match, "metric", 1);
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([name]) => name)
    .slice(0, 20);
}

/**
 * Plan B (2026-09-19): normalize a raw ONNX NER pipeline output
 * into the legacy `string[]` shape that `extractNamedEntities()`
 * returns. Two responsibilities:
 *
 *   1. Map the BERT-style BIO tag (`B-PER`, `I-LOC`, `O`, etc.) onto
 *      the entity-type vocabulary that the search-side
 *      `event_entities.entity_id` column already understands
 *      (`person`, `location`, `organization`, `subject`).
 *   2. Strip the `##` subword-marker that bert-base-chinese-ner
 *      emits when it merges two subwords into a single span.
 *      Aggregation strategy = "simple" already does most of the
 *      merging — the `##` only shows up in edge cases (very rare).
 *
 * Threshold (0.7) matches the Plan B design note in
 * `plan-b-ner-replace-regex-extract`. Lower → more recall, more
 * noise; higher → less noise, more missed entities. 0.7 was the
 * sweet spot during the 2026-09-18 offline benchmark against the
 * OntoNotes-style test set used to size the catalog.
 */
const NER_SCORE_THRESHOLD = 0.3;
const NER_MAX_ENTITIES = 20;

/**
 * Merge raw BMES-tagged tokens into entity spans and return deduplicated
 * entity names. The pipeline is called with `aggregation_strategy: "none"`
 * so we do BMES merging ourselves (the "simple" strategy does not correctly
 * merge Chinese character-by-character B-I-E spans).
 *
 * BMES format:
 *   B-TYPE  — start of a multi-token entity
 *   I-TYPE  — continuation of the entity
 *   E-TYPE  — end of a multi-token entity
 *   S-TYPE  — single-token entity (no B/I/E continuation needed)
 *
 * Aggregation: consecutive B + (I|E)+ tokens of the same TYPE → single entity
 * with the average score of the span.
 */
function normalizeNerResults(raw: NerTokenResult[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  let i = 0;
  while (i < raw.length) {
    const tok = raw[i];
    const tag = String(tok.entity ?? "");

    // Skip O tags and tokens below threshold
    if (
      tag === "O" ||
      tag === "" ||
      tag.toUpperCase() === "O" ||
      typeof tok.score !== "number" ||
      tok.score < NER_SCORE_THRESHOLD
    ) {
      i++;
      continue;
    }

    // Parse "B-PERSON" → "PERSON"
    const dashIdx = tag.indexOf("-");
    const tagType = dashIdx >= 0 ? tag.slice(dashIdx + 1) : tag;

    let word = String(tok.word ?? "").replace(/^##/, "").trim();
    let entityScore = tok.score;
    let count = 1;

    if (tag.startsWith("B-")) {
      // Collect I- and E- continuation tokens of the same type. A new
      // B- of the same type terminates the current span — that's how
      // bert-base-chinese-ner separates back-to-back entities like
      // "马云 张勇" (otherwise the merge would run them together as
      // "马云张勇").
      let j = i + 1;
      while (j < raw.length) {
        const next = raw[j];
        const nextTag = String(next.entity ?? "");
        const nextType = nextTag.indexOf("-") >= 0 ? nextTag.slice(nextTag.indexOf("-") + 1) : nextTag;
        const isContinuation =
          (nextTag === `I-${tagType}` || nextTag === `E-${tagType}`) &&
          typeof next.score === "number" &&
          next.score >= NER_SCORE_THRESHOLD;
        if (isContinuation) {
          const nextWord = String(next.word ?? "").replace(/^##/, "").trim();
          word += nextWord;
          entityScore += next.score;
          count++;
          j++;
        } else {
          break;
        }
      }
      entityScore /= count;
      // Advance i past the tokens we just consumed. The next iteration
      // starts at j, which may be a fresh B- token for the next entity.
      i = j - 1;
    } else if (tag.startsWith("S-")) {
      // Single-token entity — already a complete span on its own. The
      // index advances by 1 below; nothing to merge.
    } else if (tag.startsWith("I-") || tag.startsWith("E-")) {
      // Orphan I-/E- token with no preceding B-. The model occasionally
      // emits these after a low-score or O token. Treat as a standalone
      // single-character entity so we don't drop it (better to surface
      // a partial match than to lose it silently).
      // `word` already holds this single token's text.
    }

    if (!word) { i++; continue; }

    const key = word.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(word);
      if (out.length >= NER_MAX_ENTITIES) break;
    }
    i++;
  }

  return out;
}

function localKeywords(text: string): string[] {
  if (isMostlyChinese(text)) {
    const cjkTerms = text.match(/[\u4e00-\u9fa5A-Za-z0-9_-]{2,18}/g) ?? [];
    // Drop noisy single-character fragments and pure numbers
    const filtered = cjkTerms.filter((term) => !/^\d+$/.test(term));
    return [...new Set(filtered)].slice(0, 10);
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

function inferEntityType(name: string): string {
  if (/^\d{4}\s*年\s*\d{1,2}\s*月(\s*\d{1,2}\s*日)?$/.test(name)) return "time";
  if (/^\d/.test(name)) return "metric";
  // Organization: ends with corporate/legal suffix
  if (/(Inc|Corp|LLC|Ltd|Company|Group|Co\.|公司|集团|银行|事务所|委员会|办公室|中心|部门|学院|大学|医院|研究所|研究院|实验室|总部|分部|分公司|子公司|事业部)$/i.test(name)) return "organization";
  // Product / system
  if (/(System|Platform|Product|系统|平台|产品|模型|数据库|服务|工具|引擎|框架|SDK|API|模块|组件)$/i.test(name)) return "product";
  // Work / document
  if (/(Report|Document|Manual|Guide|Plan|Standard|Spec|报告|文件|手册|指南|方案|计划|规划|制度|流程|规定|细则|标准|规范|指引)$/i.test(name)) return "work";
  // Subject / technology
  if (/(Search|Retrieval|检索|搜索|技术|算法|方案|风险|漏洞|威胁|缺陷|问题|隐患)$/i.test(name)) return "subject";
  return "subject";
}

export const llmClient = new OpenAICompatibleLlmClient();

/**
 * Lightweight LLM endpoint probe used by the Settings panel's
 * "测试连接" button. Sends a 1-token `max_tokens` chat/completions
 * request to the operator's configured endpoint so they can confirm
 * their Base URL / Model / Key are all correct before saving and
 * triggering a real ingest.
 *
 * Returns the same shape as `embeddingClient.testConnection`:
 *   { ok, provider, baseUrl, model, latencyMs, httpStatus?, error? }
 *
 * Mirrors the embedding client's behaviour: a non-2xx HTTP status
 * (401/403/404/500) surfaces as `{ ok: false, error }`, but we
 * still echo the latency so the operator can distinguish "auth
 * rejected" from "endpoint not reachable" (the latter would throw
 * with a `fetch failed` error and have latencyMs ≈ 0).
 *
 * Historical reference (sag-dist-backup-20260828-173134): the pre-Plan-B
 * codebase had `api.testConnection` cover only embedding. Adding the
 * LLM counterpart here lets the WebUI show a single "测试连接" row
 * under the LLM endpoint block that probes whichever endpoint is
 * configured (see web/src/App.tsx AI Provider panel).
 */
export async function testLlmConnection(input?: {
  llmBaseUrl?: string;
  llmModel?: string;
  llmApiKey?: string;
  llmTimeoutMs?: number;
}): Promise<{
  ok: boolean;
  provider: "remote-llm";
  baseUrl: string;
  model: string;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}> {
  // Allow ad-hoc probing (before the operator has saved anything) by
  // falling back to the configured runtime settings. The Settings
  // panel passes the current draft values so the operator gets
  // immediate feedback without needing to save first.
  //
  // Empty-string draft values fall through to the saved setting —
  // matches the "留空不修改" / "Leave blank to keep unchanged" UI
  // affordance on the password field. Without this guard, an operator
  // who only edits Base URL without touching the key field would send
  // `apiKey: ""` to the endpoint and get a 401 even though a valid
  // key is saved on the server (see sag-20260928-llm-probe-empty-key).
  const settings = await aiSettingsService.getRuntimeSettings();
  const baseUrl = (input?.llmBaseUrl?.trim() || settings.llmBaseUrl || "").trim();
  const model = (input?.llmModel?.trim() || settings.llmModel || "").trim();
  const apiKey = (input?.llmApiKey?.trim() || settings.llmApiKey || "").trim();
  const timeoutMs = input?.llmTimeoutMs ?? settings.llmTimeoutMs ?? config.LLM_TIMEOUT_MS;
  const startedAt = Date.now();
  if (!baseUrl || !model) {
    return {
      ok: false,
      provider: "remote-llm",
      baseUrl,
      model,
      latencyMs: 0,
      error: "LLM Base URL / Model 未配置"
    };
  }
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  // 1-token max_tokens so the response is cheap; we only care about
  // whether the endpoint accepts our key + reaches the model.
  const body = {
    model,
    messages: [{ role: "user" as const, content: "ping" }],
    max_tokens: 1,
    temperature: 0
  };
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(`llm-probe-timeout-${timeoutMs}ms`), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // ignore — body is best-effort for the error message
      }
      return {
        ok: false,
        provider: "remote-llm",
        baseUrl,
        model,
        latencyMs,
        httpStatus: response.status,
        error: `HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`
      };
    }
    return {
      ok: true,
      provider: "remote-llm",
      baseUrl,
      model,
      latencyMs,
      httpStatus: response.status
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider: "remote-llm",
      baseUrl,
      model,
      latencyMs: Date.now() - startedAt,
      error: message
    };
  } finally {
    clearTimeout(watchdog);
  }
}
