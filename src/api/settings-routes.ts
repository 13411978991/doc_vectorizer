/**
 * src/api/settings-routes.ts — User-facing settings endpoints.
 *
 *   GET /api/settings/ai   - read AI provider / chunking / search defaults
 *   PUT /api/settings/ai   - update AI provider / chunking / search defaults
 *   GET /api/settings/mcp  - read MCP server public settings (no secrets)
 *
 *   GET /api/settings/embedding/local-model/probe?path=...
 *     - verify the path points at a usable ONNX/transformers model dir
 *       (config.json + *.onnx present). Returns { ready, files[], reason }.
 *
 *   POST /api/settings/embedding/local-model/warmup
 *     - force a local-bge pre-load so the UI shows the load time and any
 *       error in real time instead of waiting for the first ingest call.
 *
 *   POST /api/settings/embedding/local-model/test
 *     - run a single probe embedding against the configured local model
 *       and return { dim, sample, tookMs } for UI sanity-check feedback.
 *
 * The MCP settings handler is read-only — it's the source of truth for
 * the web UI's MCP config card; mutations go through the MCP service
 * layer (kept outside the v1 surface to avoid drift).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { aiSettingsService } from "../services/ai-settings-service.js";
import { getPublicMcpSettings } from "../services/mcp-settings-service.js";
import { aiSettingsSchema } from "./server-helpers.js";
import { config } from "../config/env.js";
import { logger } from "../observability/logger.js";

/**
 * Catalog of well-known ONNX embedding models the UI can suggest.
 * Each entry's `repo` is the HuggingFace id; `dim` is the model's
 * native output dimension (drives EMBEDDING_DIMENSIONS compatibility).
 * The catalog intentionally stays small — every entry here is one we
 * have actually shipped in tests; user-supplied paths still work.
 */
const LOCAL_MODEL_CATALOG: Array<{
  id: string;
  label: string;
  repo: string;
  dim: 1024 | 4096;
  sizeHintMB: number;
}> = [
  {
    id: "bge-large-zh-v1.5",
    label: "BGE-large-zh-v1.5",
    repo: "Xenova/bge-large-zh-v1.5",
    dim: 1024,
    sizeHintMB: 1300
  },
  {
    id: "bge-base-zh-v1.5",
    label: "BGE-base-zh-v1.5",
    repo: "Xenova/bge-base-zh-v1.5",
    dim: 1024,
    sizeHintMB: 400
  },
  {
    id: "bge-small-zh-v1.5",
    label: "BGE-small-zh-v1.5",
    repo: "Xenova/bge-small-zh-v1.5",
    dim: 1024,
    sizeHintMB: 95
  },
  {
    id: "bge-m3",
    label: "BGE-M3 (multilingual)",
    repo: "Xenova/bge-m3",
    dim: 1024,
    sizeHintMB: 2200
  }
];

async function probeLocalModelDir(modelPath: string): Promise<{
  ready: boolean;
  files: string[];
  reason?: string;
}> {
  // A valid transformers.js model directory contains:
  //   - config.json (model config)
  //   - tokenizer.json / tokenizer_config.json
  //   - one or more *.onnx weight files
  // We accept either ONNX or quantized variants.
  //
  // Xenova exports the ONNX weights inside an `onnx/` subfolder (not
  // the model root) so we walk one level deep in addition to the root.
  // Anything deeper than that we leave alone — caller's responsibility
  // to flatten if needed.
  const trimmed = (modelPath ?? "").trim();
  if (!trimmed) {
    return { ready: false, files: [], reason: "path is empty" };
  }
  let stat;
  try {
    stat = await fs.stat(trimmed);
  } catch (error) {
    return { ready: false, files: [], reason: `path not accessible: ${(error as Error).message}` };
  }
  if (!stat.isDirectory()) {
    return { ready: false, files: [], reason: "path is not a directory" };
  }
  let rootNames: string[];
  try {
    rootNames = await fs.readdir(trimmed);
  } catch (error) {
    return { ready: false, files: [], reason: `readdir failed: ${(error as Error).message}` };
  }

  // Walk the immediate `onnx/` subfolder if present — that's where
  // Xenova-bge ships its weight files.
  let subNames: string[] = [];
  if (rootNames.includes("onnx")) {
    try {
      subNames = await fs.readdir(path.join(trimmed, "onnx"));
    } catch {
      // Subfolder unreadable — treat as "no weights at root" so the
      // user sees a clear "no .onnx weight file found" rather than a
      // cryptic readdir error.
    }
  }

  const allNames = [...rootNames, ...subNames.map((n) => `onnx/${n}`)];
  const hasConfig = rootNames.includes("config.json");
  const hasTokenizer = rootNames.some((n) => n.startsWith("tokenizer"));
  const hasWeights = subNames.some((n) => n.endsWith(".onnx") || n.endsWith(".onnx_data"));
  const ready = hasConfig && hasTokenizer && hasWeights;
  let reason: string | undefined;
  if (!hasConfig) reason = "missing config.json";
  else if (!hasTokenizer) reason = "missing tokenizer.json (or tokenizer_config.json)";
  else if (!hasWeights) reason = "no .onnx weight file found (looked in onnx/ subfolder too)";
  return { ready, files: allNames.sort(), reason };
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get("/api/settings/ai", async () => ({
    settings: await aiSettingsService.getPublicSettings()
  }));

  app.get("/api/settings/mcp", async () => ({
    settings: getPublicMcpSettings()
  }));

  // Surface the actual SAG server bind so the web UI can render the
  // HTTP / MCP HTTP endpoints the user needs to configure Agents
  // against. The host is reported as "0.0.0.0" verbatim (not normalized
  // to localhost) so a remote user sees the bind address, not a
  // loopback alias that won't work from another machine.
  app.get("/api/server/info", async () => ({
    httpHost: config.HTTP_HOST,
    httpPort: config.HTTP_PORT,
    mcpHttpPort: config.MCP_HTTP_PORT
  }));

  app.put("/api/settings/ai", async (request) => {
    const input = aiSettingsSchema.parse(request.body);
    return {
      settings: await aiSettingsService.updateSettings(input)
    };
  });

  // ── Local BGE embedding model helpers ───────────────────────────────────
  app.get("/api/settings/embedding/local-model/catalog", async () => ({
    catalog: LOCAL_MODEL_CATALOG,
    defaultLocalModelPath: "models/bge-large-zh-v1.5",
    supportedDimensions: [1024, 4096]
  }));

  app.get("/api/settings/embedding/local-model/probe", async (request) => {
    const q = request.query as { path?: unknown };
    const modelPath = typeof q.path === "string" ? q.path : "";
    const probe = await probeLocalModelDir(modelPath);
    return {
      path: modelPath,
      ...probe
    };
  });

  app.post("/api/settings/embedding/local-model/warmup", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string };
    const modelPath = (body.modelPath ?? "").trim();
    if (!modelPath) {
      return { ok: false, error: "modelPath is required" };
    }
    const t0 = Date.now();
    try {
      const { warmupLocalBgeWorker } = await import("../ai/embedding-client.js");
      await warmupLocalBgeWorker(modelPath);
      return { ok: true, tookMs: Date.now() - t0 };
    } catch (error) {
      logger.warn({ modelPath, error: (error as Error).message }, "settings: local-model warmup failed");
      return { ok: false, tookMs: Date.now() - t0, error: (error as Error).message };
    }
  });

  app.post("/api/settings/embedding/local-model/test", async (request) => {
    const body = (request.body ?? {}) as { modelPath?: string; text?: string };
    const modelPath = (body.modelPath ?? "").trim();
    const text = (body.text ?? "").trim() || "hello";
    if (!modelPath) {
      return { ok: false, error: "modelPath is required" };
    }
    const t0 = Date.now();
    try {
      const { localBgeEmbeddingInProcess } = await import("../ai/embedding-client.js");
      const vec = await localBgeEmbeddingInProcess(
        modelPath,
        [text],
        config.EMBEDDING_DIMENSIONS
      );
      const first = vec[0] ?? [];
      return {
        ok: true,
        tookMs: Date.now() - t0,
        dim: first.length,
        sample: Array.from(first.slice(0, 5)).map((v) => Number(v.toFixed(6)))
      };
    } catch (error) {
      logger.warn({ modelPath, error: (error as Error).message }, "settings: local-model test failed");
      return { ok: false, tookMs: Date.now() - t0, error: (error as Error).message };
    }
  });
}
