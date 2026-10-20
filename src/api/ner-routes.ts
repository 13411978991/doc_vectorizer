/**
 * src/api/ner-routes.ts — Plan B (2026-09-19) NER model settings routes.
 *
 * Mirrors `settings-routes.ts` shape for the GGUF LLM:
 *   - GET  /api/settings/ner/catalog     — list available models
 *   - GET  /api/settings/ner/installed   — list on-disk models
 *   - POST /api/settings/ner/download    — SSE stream of download progress
 *   - POST /api/settings/ner/download/cancel — kill in-flight download
 *   - GET  /api/settings/ner/probe       — is `modelPath` loadable?
 *   - POST /api/settings/ner/warmup      — preload into the singleton
 *   - POST /api/settings/ner/dispose     — drop cached pipeline
 *
 * Why SSE instead of a single POST? The user-visible download takes
 * 1-3 minutes for a 100 MB model. SSE lets the Web UI render a live
 * progress bar without polling. The pattern is identical to the LLM
 * download SSE in settings-routes.ts (see activeBgeDownloads there
 * for the cancel/pause pattern).
 *
 * Why spawn curl.exe instead of using fetch()? HuggingFace serves
 * large files with redirects and per-chunk resume that node-fetch
 * doesn't handle elegantly. `curl.exe` is already on every Windows
 * box (we use it for the LLM download too) and has battle-tested
 * retry/resume flags.
 *
 * Auth: the parent Fastify app already enforces auth on /api/*
 * routes, so these endpoints inherit the same gate.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync, mkdirSync, createWriteStream, rmSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { aiSettingsService } from "../services/ai-settings-service.js";
import {
  disposeNerPipeline,
  getLocalNerPipeline,
  type NerTokenResult
} from "../ai/ner-pipeline-factory.js";
import { isModelInstalled } from "../ai/model-path-resolver.js";
import { getModelsInstallDir } from "./settings-routes.js";
import { logger } from "../observability/logger.js";

/**
 * Catalog of NER models the Web UI can pick from. Kept in source
 * (not DB) so the catalog is always available even on a fresh
 * install before any model has been downloaded. Mirrors
 * LOCAL_LLM_CATALOG in settings-routes.ts.
 *
 * `files` lists every file the loader needs. We fetch each one
 * with curl in the order listed; an aggregator like
 * transformers.js's snapshot_download would also work but pulls in
 * a Python-style API we don't want to reimplement here.
 *
 * `mirrors` are tried in order; the first URL that returns 2xx
 * wins. The Chinese hf-mirror.com mirror is listed first because
 * operators behind the GFW can't reach huggingface.co directly.
 */
interface NerCatalogEntry {
  id: string;
  label: string;
  repo: string;            // e.g. "Xenova/bert-base-chinese-ner"
  modelType: "bert" | "roberta";
  sizeHintMB: number;
  f1Score: number;
  recommended?: boolean;
  files: string[];         // files inside the repo, e.g. "config.json"
  mirrors: string[];       // base URLs ending in "/"
  notes: string;
}

const NER_CATALOG: NerCatalogEntry[] = [
  {
    id: "bert-base-chinese-ner",
    label: "BERT-base-Chinese-NER",
    repo: "Xenova/bert-base-chinese-ner",
    modelType: "bert",
    sizeHintMB: 110,
    f1Score: 0.94,
    recommended: true,
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "vocab.txt",
      "special_tokens_map.json",
      "onnx/model_quantized.onnx"
    ],
    mirrors: [
      "https://hf-mirror.com/Xenova/bert-base-chinese-ner/resolve/main/",
      "https://huggingface.co/Xenova/bert-base-chinese-ner/resolve/main/"
    ],
    notes: "F1 ~94% · ~110 MB · 5-15 ms/sentence · 中文默认推荐"
  },
  {
    id: "roberta-base-chinese-ner",
    label: "RoBERTa-base-Chinese-NER",
    repo: "Xenova/roberta-base-chinese-ner",
    modelType: "roberta",
    sizeHintMB: 125,
    f1Score: 0.945,
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "vocab.txt",
      "special_tokens_map.json",
      "onnx/model_quantized.onnx"
    ],
    mirrors: [
      "https://hf-mirror.com/Xenova/roberta-base-chinese-ner/resolve/main/",
      "https://huggingface.co/Xenova/roberta-base-chinese-ner/resolve/main/"
    ],
    notes: "F1 ~94.5% · ~125 MB · 5-15 ms/sentence · 与 BERT 互为对照"
  }
];

/**
 * State for an in-flight NER download. Kept in a module-level map
 * so the cancel endpoint can find the running child process without
 * threading state through every layer. Mirrors activeBgeDownloads
 * in settings-routes.ts.
 */
interface ActiveNerDownload {
  modelId: string;
  abortController: AbortController;
  startedAt: number;
  // Currently-downloaded file. Used by the cancel endpoint to
  // distinguish "we're between files" (safe to abort) from
  // "we're mid-stream" (the curl child is the source of truth).
  currentFile: string | null;
  currentChild: import("node:child_process").ChildProcess | null;
}

const activeNerDownloads = new Map<string, ActiveNerDownload>();

/** Manifest written after a successful download. Lets us skip files
 *  that are already present (idempotent re-download after cancel). */
const NER_MANIFEST_FILE = "sag-ner-manifest.json";

interface NerManifest {
  modelId: string;
  repo: string;
  downloadedAt: string;
  files: Record<string, { size: number; sha256?: string }>;
}

export function registerNerRoutes(app: FastifyInstance): void {
  /**
   * GET /api/settings/ner/catalog — list available models.
   * Returns the static catalog plus the on-disk "already installed"
   * status for each, so the UI can render both dropdowns and the
   * download progress in a single round-trip.
   */
  app.get("/api/settings/ner/catalog", async () => {
    const items = NER_CATALOG.map((entry) => {
      const installedDir = path.join(getModelsInstallDir(), entry.id);
      return {
        ...entry,
        installed: isModelInstalled(`models/${entry.id}`),
        installedPath: installedDir
      };
    });
    return { items };
  });

  /**
   * GET /api/settings/ner/installed — list everything on disk.
   * The Web UI uses this when rendering the "switch model" dropdown
   * to skip downloading a model that's already present.
   */
  app.get("/api/settings/ner/installed", async () => {
    const baseDir = getModelsInstallDir();
    if (!existsSync(baseDir)) return { models: [] };
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(baseDir, { withFileTypes: true });
    const models = entries
      .filter((e) => e.isDirectory() && isModelInstalled(`models/${e.name}`))
      .map((e) => ({
        id: e.name,
        label: e.name,
        path: `models/${e.name}`,
        absolutePath: path.join(baseDir, e.name),
        catalogEntry: NER_CATALOG.find((c) => c.id === e.name) ?? null
      }));
    return { models };
  });

  /**
   * POST /api/settings/ner/download — start an SSE download.
   *
   * Body: `{ modelId: "bert-base-chinese-ner" }`. The response is a
   * Server-Sent Events stream with `event:` lines and JSON `data:`
   * lines. The client opens it with `fetch().then(r => r.body)` and
   * a `TextDecoder`/`ReadableStream` parser — the same pattern the
   * Web UI already uses for the BGE / GGUF downloads.
   *
   * SSE event types:
   *   - "start"      — { modelId, files: [{ name, size? }] }
   *   - "file:done"  — { file, bytes, tookMs }
   *   - "progress"   — { file, bytes, total }
   *   - "done"       — { path, tookMs }
   *   - "error"      — { message, fatal }
   *
   * Cancellation: the cancel endpoint fires the AbortController,
   * which kills the in-flight curl child (if any) and short-circuits
   * the file loop. Partial files are deleted so the next download
   * starts from scratch.
   */
  app.post("/api/settings/ner/download", async (request, reply) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = body.modelId?.trim() ?? "";
    const entry = NER_CATALOG.find((e) => e.id === modelId);
    if (!entry) {
      reply.code(400);
      return { ok: false, error: `unknown modelId: ${modelId}` };
    }
    if (activeNerDownloads.has(modelId)) {
      reply.code(409);
      return { ok: false, error: `download for ${modelId} already in progress` };
    }

    const baseDir = getModelsInstallDir();
    const targetDir = path.join(baseDir, modelId);
    mkdirSync(targetDir, { recursive: true });

    const abortController = new AbortController();
    const state: ActiveNerDownload = {
      modelId,
      abortController,
      startedAt: Date.now(),
      currentFile: null,
      currentChild: null
    };
    activeNerDownloads.set(modelId, state);

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.writeHead(200);

    const send = (event: string, payload: Record<string, unknown>) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    void (async () => {
      try {
        send("start", { modelId, files: entry.files.map((f) => ({ name: f })) });

        // Probe the on-disk size of each file (HTTP HEAD) so the UI
        // can render an accurate progress bar. If HEAD isn't
        // supported by the mirror, we fall back to "unknown size"
        // and skip the progress event for that file.
        const fileSizes = await probeFileSizes(entry);

        // Load the manifest if a previous download was cancelled mid-
        // way so we can resume from the last completed file.
        const existingManifest = readManifest(targetDir);
        const manifest: NerManifest = {
          modelId,
          repo: entry.repo,
          downloadedAt: new Date().toISOString(),
          files: existingManifest?.files ?? {}
        };

        for (const file of entry.files) {
          if (abortController.signal.aborted) break;
          const targetPath = path.join(targetDir, file);
          const expectedSize = fileSizes[file];
          // Skip files that already exist and match the expected
          // size. This makes cancel + restart idempotent.
          if (expectedSize && existsSync(targetPath)) {
            const onDisk = statSync(targetPath).size;
            if (onDisk === expectedSize) {
              send("file:done", { file, bytes: onDisk, tookMs: 0, skipped: true });
              manifest.files[file] = { size: onDisk };
              continue;
            }
          }
          state.currentFile = file;
          const tookMs = await downloadOneFile(entry, file, targetPath, expectedSize, abortController.signal, state, (bytes) => {
            send("progress", { file, bytes, total: expectedSize });
          });
          if (abortController.signal.aborted) break;
          const onDisk = statSync(targetPath).size;
          manifest.files[file] = { size: onDisk };
          send("file:done", { file, bytes: onDisk, tookMs });
        }

        if (abortController.signal.aborted) {
          send("error", { message: "cancelled by user", fatal: false });
        } else {
          // Persist manifest so a future cancel+restart knows which
          // files are already on disk.
          writeFileSync(path.join(targetDir, NER_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
          send("done", { path: `models/${modelId}`, tookMs: Date.now() - state.startedAt });
        }
      } catch (err) {
        send("error", { message: (err as Error).message, fatal: true });
        logger.error({ modelId, error: (err as Error).message }, "ner: download failed");
      } finally {
        activeNerDownloads.delete(modelId);
        reply.raw.end();
      }
    })();

    // Returning reply keeps Fastify happy; the actual response is
    // written above via reply.raw.
    return reply;
  });

  /**
   * POST /api/settings/ner/download/cancel — abort an in-flight
   * download. Idempotent: cancelling a model that isn't downloading
   * is a 404 (helps the Web UI distinguish "user clicked cancel
   * twice" from "model finished downloading between clicks").
   */
  app.post("/api/settings/ner/download/cancel", async (request) => {
    const body = (request.body ?? {}) as { modelId?: string };
    const modelId = body.modelId?.trim() ?? "";
    const state = activeNerDownloads.get(modelId);
    if (!state) return { ok: false, error: "no active download for this model" };
    state.abortController.abort();
    // Best-effort kill of the in-flight curl child. Killing curl
    // mid-stream is what tells us "the partial file is bad" — the
    // download loop will detect the abort on the next iteration.
    if (state.currentChild && state.currentChild.exitCode === null) {
      state.currentChild.kill();
    }
    return { ok: true };
  });

  /**
   * GET /api/settings/ner/probe?path=models/<name> — check if a
   * model directory is loadable. The Web UI uses this to show a
   * green tick next to a working install vs a red cross next to a
   * half-downloaded directory.
   */
  app.get("/api/settings/ner/probe", async (request) => {
    const query = (request.query ?? {}) as { path?: string };
    const modelPath = query.path?.trim() ?? "";
    if (!modelPath) return { ok: false, error: "path is required" };
    if (!isModelInstalled(modelPath)) {
      return { ok: false, error: "model not installed (missing tokenizer.json or onnx/)" };
    }
    try {
      await getLocalNerPipeline({ modelPath, maxTokens: 512 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * POST /api/settings/ner/warmup — preload the pipeline. The Web
   * UI calls this after the operator picks a model from the
   * dropdown so the next ingest call doesn't pay the 5-15s ONNX
   * load latency. Mirrors /api/settings/llm/local-model/warmup.
   */
  app.post("/api/settings/ner/warmup", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; maxTokens?: number };
    const modelPath = body.modelPath?.trim() ?? "";
    if (!modelPath) return { ok: false, error: "modelPath is required" };
    if (!isModelInstalled(modelPath)) {
      return { ok: false, error: "model not installed" };
    }
    await disposeNerPipeline();
    const took0 = Date.now();
    try {
      await getLocalNerPipeline({
        modelPath,
        maxTokens: body.maxTokens ?? 512,
        aggregationStrategy: "simple"
      });
      return { ok: true, tookMs: Date.now() - took0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * POST /api/settings/ner/dispose — drop the cached pipeline so
   * the next call reloads. Mirrors /api/settings/llm/local-model/dispose.
   */
  app.post("/api/settings/ner/dispose", async () => {
    await disposeNerPipeline();
    return { ok: true };
  });

  /**
   * POST /api/settings/ner/test — run NER on arbitrary text and return
   * entity-level results with scores. Used by the Settings panel "试运行"
   * button so operators can verify the model is working before running a
   * full ingest.
   *
   * Body: `{ text: string }`
   * Response: `{ entities: Array<{ entity, word, score }>, tookMs }`
   *
   * Implementation: same call pattern as llm-client.ts extractNamedEntities
   * (which is the function ingest uses). Uses the cached singleton pipeline
   * so there's no model-load cost after the first call.
   */
  app.post("/api/settings/ner/test", async (request) => {
    const body = (request.body ?? {}) as { text?: string };
    const text = (body.text ?? "").trim();
    if (!text) return { entities: [], tookMs: 0 };

    const settings = await aiSettingsService.getRuntimeSettings();
    if (!settings.nerModel) {
      return { entities: [], tookMs: 0, error: "no ner model configured" };
    }

    const startedAt = Date.now();
    const pipeline = await getLocalNerPipeline({
      modelPath: settings.nerModel,
      maxTokens: settings.nerMaxTokens,
      aggregationStrategy: "simple"
    });

    // Truncate to model budget (same logic as extractNamedEntities).
    const truncated = text.length > settings.nerMaxTokens * 4
      ? text.slice(0, settings.nerMaxTokens * 4)
      : text;

    let raw: NerTokenResult[] = [];
    try {
      // Use aggregation_strategy="none" so we get the raw BMES
      // (B-PERSON / I-PERSON / E-PERSON / S-ORG / O) tags instead of
      // transformers' default "simple" aggregation which naively
      // concatenates adjacent same-type tokens. With "simple",
      // "马云与张勇" came back as a single "马云张勇" person entity
      // because the model didn't emit a fresh B-PERSON tag between
      // the two names. With "none" we drive the BMES → display span
      // conversion ourselves below and can split on every new B-/S-.
      raw = (await pipeline(truncated, {
        aggregation_strategy: "none",
        max_length: settings.nerMaxTokens,
        truncation: true,
        ignore_labels: []
      })) as NerTokenResult[];
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "ner-test pipeline threw");
      return { entities: [], tookMs: Date.now() - startedAt, error: (err as Error).message };
    }
    const tookMs = Date.now() - startedAt;

    // Map raw BMES tokens to display entities and span them using the
    // BMES prefixes:
    //
    //   B-TYPE → start a new span, keep accumulating while we see
    //            I-TYPE or E-TYPE tokens; stop on the next B-TYPE,
    //            S-TYPE, O, or different type.
    //   I-TYPE / E-TYPE → continuation of the current span (an
    //            orphan with no preceding B- is treated as a single-
    //            token span so we don't silently drop it).
    //   S-TYPE → single-token span, no continuation.
    //   O      → boundary, close any open span and move on.
    //
    // The bert-base-chinese-ner model (BMES, 73 labels) usually emits
    // B-TYPE + (I|E)+-TYPE for multi-char entities and S-TYPE for
    // single-char ones. Filter O tokens and tokens below the score
    // threshold (0.3) BEFORE grouping so a low-score span doesn't
    // leak partial chars into the next span.
    type DisplayEntity = { entity: string; word: string; score: number; rawTag: string };
    type OpenSpan = { entity: string; word: string; scoreSum: number; tokenCount: number; rawTag: string };
    const spans: OpenSpan[] = [];
    let open: OpenSpan | null = null;
    const closeOpen = () => {
      if (!open) return;
      const score = Math.round((open.scoreSum / open.tokenCount) * 100) / 100;
      spans.push({
        entity: open.entity,
        word: open.word,
        scoreSum: score,
        tokenCount: 1,
        rawTag: open.rawTag
      });
      open = null;
    };
    for (const tok of raw) {
      const tag = String(tok.entity ?? "").toUpperCase();
      const word = String(tok.word ?? "").replace(/^##/, "").trim();
      if (!word) continue;
      if (typeof tok.score !== "number" || tok.score < 0.3) continue;
      if (tag === "O" || tag === "") {
        closeOpen();
        continue;
      }
      const dashIdx = tag.indexOf("-");
      if (dashIdx < 0) continue;
      const prefix = tag.slice(0, dashIdx); // "B" | "I" | "E" | "S"
      const tagType = tag.slice(dashIdx + 1); // "PERSON" | "LOC" | "ORG" | ...
      let displayType = "subject";
      if (tagType === "PER" || tagType === "PERSON") displayType = "person";
      else if (tagType === "LOC" || tagType === "GPE" || tagType === "FAC") displayType = "location";
      else if (tagType === "ORG") displayType = "organization";

      if (prefix === "S") {
        // Single-token entity — close any open span first.
        closeOpen();
        spans.push({
          entity: displayType,
          word,
          scoreSum: tok.score,
          tokenCount: 1,
          rawTag: tag
        });
      } else if (prefix === "B") {
        // New entity begins — close whatever was open, then start fresh.
        closeOpen();
        open = {
          entity: displayType,
          word,
          scoreSum: tok.score,
          tokenCount: 1,
          rawTag: tag
        };
      } else if (prefix === "I" || prefix === "E") {
        if (open && open.entity === displayType) {
          // Continuation of the current span.
          open.word += word;
          open.scoreSum += tok.score;
          open.tokenCount += 1;
          if (prefix === "E") {
            closeOpen();
          }
        } else {
          // Orphan I/E with no matching open span (or different type).
          // Promote to a single-token span rather than dropping it.
          closeOpen();
          spans.push({
            entity: displayType,
            word,
            scoreSum: tok.score,
            tokenCount: 1,
            rawTag: tag
          });
        }
      }
    }
    closeOpen();

    // Dedupe by lowercased word; preserve first-seen order so the
    // response reads naturally with the first occurrence of each
    // entity surfaced before later repeats.
    const seen = new Set<string>();
    const entities: DisplayEntity[] = [];
    for (const span of spans) {
      const key = span.word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entities.push({
        entity: span.entity,
        word: span.word,
        score: span.scoreSum,
        rawTag: span.rawTag
      });
    }

    return {
      entities: entities.map(({ entity, word, score }) => ({ entity, word, score })),
      tookMs
    };
  });
}

/**
 * Probe every file's expected size with an HTTP HEAD. Some mirrors
 * don't support HEAD (returning 405) — in that case the entry is
 * missing from the result map and the downloader skips progress
 * events for that file. Curl is the same tool we use for download,
 * so behaviour stays consistent across the two paths.
 */
async function probeFileSizes(
  entry: NerCatalogEntry
): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const file of entry.files) {
    const size = await probeOneFileSize(entry, file);
    if (size !== null) sizes[file] = size;
  }
  return sizes;
}

function probeOneFileSize(entry: NerCatalogEntry, file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const args = ["-sIL", "-o", "/dev/null", "-w", "%{http_code} %{size_download}"];
    const triedMirrors = entry.mirrors;
    let lastErr: unknown = null;
    let mirrorIdx = 0;

    const tryMirror = () => {
      if (mirrorIdx >= triedMirrors.length) {
        lastErr instanceof Error ? void lastErr : null;
        resolve(null);
        return;
      }
      const base = triedMirrors[mirrorIdx++];
      const url = base + file;
      const child = spawn("curl.exe", [...args, url], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
      child.on("error", (e) => { lastErr = e; });
      child.on("close", () => {
        const trimmed = out.trim();
        const m = trimmed.match(/^(\d+)\s+(\d+)$/);
        if (m && m[1] === "200") {
          resolve(Number(m[2]));
        } else if (m && m[1].startsWith("3")) {
          // Redirect — recurse with the Location. We don't try to
          // parse Location here because curl already followed it
          // (curl -L was passed). Just resolve the final body size.
          resolve(Number(m[2]));
        } else {
          tryMirror();
        }
      });
    };
    tryMirror();
  });
}

async function downloadOneFile(
  entry: NerCatalogEntry,
  file: string,
  targetPath: string,
  expectedSize: number | undefined,
  abortSignal: AbortSignal,
  state: ActiveNerDownload,
  onProgress: (bytes: number) => void
): Promise<number> {
  const startedAt = Date.now();
  // Try each mirror in order until one returns 2xx. The HF mirror
  // works for most operators; if both fail the error propagates to
  // the SSE handler which sends `error: { message, fatal: true }`.
  let lastErr: Error | null = null;
  for (const base of entry.mirrors) {
    if (abortSignal.aborted) break;
    const url = base + file;
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const args = [
        "-fL",
        "--retry", "3",
        "--retry-delay", "2",
        "-C", "-",                              // resume support
        "--create-dirs",
        "-o", targetPath,
        url
      ];
      const child = spawn("curl.exe", args, { stdio: ["ignore", "pipe", "pipe"] });
      state.currentChild = child;
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      // Poll the file size while curl writes to disk — there is no
      // good cross-platform way to stream curl's progress events
      // into node without writing a custom protocol handler.
      let lastBytes = 0;
      const ticker = setInterval(() => {
        try {
          const stat = statSync(targetPath);
          if (stat.size !== lastBytes) {
            lastBytes = stat.size;
            onProgress(stat.size);
          }
        } catch { /* file may not exist yet */ }
      }, 250);

      const onAbort = () => {
        if (child.exitCode === null) child.kill();
      };
      if (abortSignal.aborted) onAbort();
      abortSignal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearInterval(ticker);
        abortSignal.removeEventListener("abort", onAbort);
        lastErr = err;
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        clearInterval(ticker);
        abortSignal.removeEventListener("abort", onAbort);
        if (code === 0) {
          // Final progress event so the UI snaps to 100%.
          try { onProgress(statSync(targetPath).size); } catch { /* ignore */ }
          resolve({ ok: true });
        } else if (abortSignal.aborted) {
          // User cancelled — wipe the partial file so a future
          // download doesn't see a corrupted target.
          try { rmSync(targetPath, { force: true }); } catch { /* ignore */ }
          resolve({ ok: false, error: "cancelled" });
        } else {
          lastErr = new Error(`curl exited ${code}: ${stderr.slice(-200)}`);
          resolve({ ok: false, error: lastErr.message });
        }
      });
    });
    if (result.ok) {
      // Sanity check: if the mirror reported an expected size, make
      // sure what we downloaded is in the same ballpark (within 1%).
      // A wildly different size means the mirror served a different
      // file (e.g. an HTML error page masquerading as the JSON).
      if (expectedSize && existsSync(targetPath)) {
        const onDisk = statSync(targetPath).size;
        if (Math.abs(onDisk - expectedSize) / expectedSize > 0.01) {
          rmSync(targetPath, { force: true });
          lastErr = new Error(
            `size mismatch for ${file}: expected ${expectedSize}, got ${onDisk}; mirror may have served an HTML page`
          );
          continue;
        }
      }
      return Date.now() - startedAt;
    }
    if (result.error === "cancelled") return Date.now() - startedAt;
  }
  throw lastErr ?? new Error("all mirrors failed");
}

function readManifest(targetDir: string): NerManifest | null {
  const manifestPath = path.join(targetDir, NER_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const text = readFileSync(manifestPath, "utf8");
    return JSON.parse(text) as NerManifest;
  } catch {
    return null;
  }
}