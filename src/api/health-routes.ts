/**
 * src/api/health-routes.ts — Liveness probe + model-call-log diagnostics.
 *
 *   GET /health                       — fast, no remote calls. Used by
 *                                       external probes / load balancers.
 *                                       Returns the aggregate liveness
 *                                       snapshot (P21) so an outside
 *                                       observer can tell when a
 *                                       component has silently degraded
 *                                       (LLM not loaded, vec0 empty,
 *                                       disk full, watcher queue
 *                                       stalled).
 *   GET /api/test-connection          — exercises the configured
 *                                       embedding endpoint with a
 *                                       single 5-char probe.
 *   GET /api/diagnostics/embedding    — same probe exposed via the
 *                                       diagnostic surface for the UI.
 *
 * The probe times out after EMBEDDING_TIMEOUT_MS so a hung endpoint
 * can't block the route forever.
 */

import type { FastifyInstance } from "fastify";
import { embeddingClient } from "../ai/embedding-client.js";
import { isSqlitePool, pool } from "../db/pool.js";
import {
  getLoadedLocalLlmInfo,
  getLastLocalLlmLoadError
} from "../ai/local-llm-client.js";
import { watcherManager } from "../watcher/index.js";
import { z } from "zod";
import { aiEndpointUrlSchema } from "./server-helpers.js";

interface HealthSnapshot {
  ok: boolean;
  service: string;
  llm: {
    loaded: boolean;
    path?: string;
    label?: string;
    lastError?: string | null;
  };
  embedding: {
    loaded: boolean;
    model?: string;
  };
  watcher: {
    running: boolean;
    queue: { active: number; pending: number };
  };
  vec0?: {
    chunks: number;
    expected: number;
  };
  diskFreeMb?: number;
  diskLow?: boolean;
}

async function buildHealthSnapshot(): Promise<HealthSnapshot> {
  const llmInfo = getLoadedLocalLlmInfo();
  const llmError = getLastLocalLlmLoadError();

  // Embedding probe — cheap (single short string), catches broken
  // endpoint config the same way the UI does. Best-effort: if the
  // embedding client throws, surface that as `loaded: false`.
  let embeddingLoaded = false;
  let embeddingModel: string | undefined;
  try {
    const probe = await embeddingClient.testConnection();
    embeddingLoaded = probe.ok;
    embeddingModel = probe.model;
  } catch {
    embeddingLoaded = false;
  }

  // Watcher queue depth — read directly from the queue module so
  // we don't pull in the whole watcher subsystem.
  let watcherRunning = false;
  let queue = { active: 0, pending: 0 };
  try {
    watcherRunning = watcherManager.isAnyRunning();
    queue = watcherManager.getQueueDepth();
  } catch {
    // watcher not initialised in dev — ignore
  }

  // vec0 chunk count — only meaningful for SQLite, and only after at
  // least one ingest. We surface `chunks: 0, expected: 0` for a
  // fresh DB so the UI doesn't render a red badge on first launch.
  let vec0: HealthSnapshot["vec0"];
  if (isSqlitePool()) {
    try {
      const result = await pool.query(
        `select
           (select count(*) from chunk_vec0) as chunks,
           (select count(*) from chunks)    as expected`
      );
      vec0 = {
        chunks: Number(result.rows[0].chunks),
        expected: Number(result.rows[0].expected)
      };
    } catch {
      // table missing on a fresh DB; ignore
    }
  }

  // Disk free on the drive the data tree lives on. We sample the
  // C: / D: drive where the exe lives — os.totalmem doesn't help
  // here. A negative or near-zero free space is the most common
  // reason a previously-working install suddenly starts failing.
  let diskFreeMb: number | undefined;
  let diskLow = false;
  try {
    const probe = (await import("node:fs/promises")).statfs;
    const { statfs: statfsFn } = await import("node:fs/promises");
    void probe; // satisfy linter
    const stats = await statfsFn(process.execPath);
    diskFreeMb = Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
    diskLow = diskFreeMb < 512; // <512 MB is "danger low" for our use case
  } catch {
    // ignore — non-Windows / non-fs.statfs-capable host
  }

  // Top-level ok: false when ANY of the liveness sub-checks fail.
  // Specifically: LLM loaded:false is NOT an ok-failure when the
  // user hasn't configured local LLM (settings may legitimately be
  // "remote" provider). Treat `embedding not loaded` and
  // `disk free < 512MB` as hard failures.
  const ok = embeddingLoaded && !diskLow;

  return {
    ok,
    service: "sag",
    llm: {
      loaded: Boolean(llmInfo),
      path: llmInfo?.path,
      label: llmInfo?.label,
      lastError: llmError
    },
    embedding: {
      loaded: embeddingLoaded,
      model: embeddingModel
    },
    watcher: {
      running: watcherRunning,
      queue
    },
    vec0,
    diskFreeMb,
    diskLow
  };
}

export function registerHealthRoutes(app: FastifyInstance): void {
  // P21 — surface the full aggregate liveness snapshot, not just
  // a stub `{ok:true}`. Operators / load balancers / monitoring
  // systems can now SEE that LLM isn't loaded, that vec0 is empty,
  // that the disk is full — without having to ping a half-dozen
  // individual endpoints. The response is still fast (the only
  // potentially-slow step is the embedding probe, and we trust the
  // embeddingClient to time out quickly).
  app.get("/health", async () => buildHealthSnapshot());

  app.get("/api/test-connection", async (_request, reply) => {
    // Embedding probe (always runs). Both probes fire in parallel so
    // the Settings panel's single "测试连接" button can render both
    // results in one round-trip.
    const embeddingProbe = embeddingClient.testConnection();
    // LLM probe — only useful when the operator has configured the
    // api path (else the client short-circuits to "未配置").
    // Importing lazily so this endpoint stays usable even if the LLM
    // client bundle failed to load.
    const llmProbe = import("../ai/llm-client.js")
      .then(({ testLlmConnection }) => testLlmConnection())
      .catch((err: unknown) => ({
        ok: false,
        provider: "remote-llm" as const,
        baseUrl: "",
        model: "",
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err)
      }));
    const [embedding, llm] = await Promise.all([embeddingProbe, llmProbe]);
    // The overall HTTP code reflects whether either path is reachable;
    // an offline embedding endpoint with a perfectly healthy LLM still
    // surfaces a non-2xx so the operator's UI shows red on the embed
    // row instead of looking like everything is fine.
    const ok = embedding.ok && llm.ok;
    reply.code(ok ? 200 : 503);
    return { embedding, llm };
  });

  // Allow probing with a draft config the operator hasn't saved yet
  // (e.g. they type the key, click "测试连接", want immediate feedback
  // without round-tripping through PUT /api/settings/ai first).
  app.post("/api/test-connection/llm", async (request) => {
    // F-3 (2026-09-28): the LLM client sends the API key as
    // `Authorization: Bearer ...` on the outbound POST, so reject
    // non-https (and http) base URLs here too — otherwise an attacker
    // could probe an internal cleartext gateway without ever going
    // through PUT /api/settings/ai.
    const probeSchema = z.object({
      llmBaseUrl: aiEndpointUrlSchema.optional(),
      llmModel: z.string().optional(),
      llmApiKey: z.string().optional(),
      llmTimeoutMs: z.number().int().positive().optional()
    });
    const body = probeSchema.parse(request.body ?? {});
    const { testLlmConnection } = await import("../ai/llm-client.js");
    const llm = await testLlmConnection(body);
    return { llm };
  });
}