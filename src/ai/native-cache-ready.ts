// src/ai/native-cache-ready.ts — Boot-time gate that keeps embedding
// (and anything else needing optional native packages) from running
// before the SEA background native-cache unpack has finished.
//
// WHY this exists
// ───────────────
// In the SEA build the heavy native packages (@xenova/transformers,
// onnxruntime-node, sharp, node-llama-cpp, …) are copied into the
// per-machine native-cache dir by an ASYNC background pass so the HTTP
// server can bind immediately. Before this gate, the boot sequence
// raced itself:
//
//   1. Backend boots, orphan-requeue reaper finds pending files.
//   2. Ingestion starts → localBgeEmbedding() → spawns the worker.
//   3. The worker does require("@xenova/transformers") — but the
//      background pass hasn't copied it yet → worker dies.
//   4. The caller falls back to the in-process ONNX path, which also
//      can't resolve @xenova/transformers — or worse, resolves it
//      half-copied and blocks the main thread for minutes.
//   5. Result: "UI stops loading after a restart" — the exact symptom
//      reported 2026-10-27.
//
// The background pass writes two stamp files into
// %SAG_NATIVE_CACHE_DIR%:
//   .sag-unpack-embedding-ready  — after the small embedding-critical
//                                  tier (transformers / onnxruntime /
//                                  sharp / jinja) has been copied.
//   .sag-unpack-complete         — after the FULL pass (~6,800 files).
//
// We wait for EITHER (the complete stamp also satisfies older builds
// that predate the embedding-ready stamp). In dev mode (no
// SAG_NATIVE_CACHE_DIR set) we return immediately.
//
// The wait is BOUNDED: if the unpack is wedged (AV lock loop, disk
// full, …) we give up after a generous cap and let the caller proceed
// — fail-open, so a broken unpack degrades to the old behaviour
// instead of hanging the app forever.

import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "../observability/logger.js";

const POLL_INTERVAL_MS = 500;
const LOG_EVERY_MS = 30_000;
// The priority tier copies in seconds even under AV scanning; the full
// pass takes a couple of minutes on a slow disk. 15 minutes is far
// beyond either, so reaching the cap means the unpack is truly wedged.
const MAX_WAIT_MS = 15 * 60 * 1000;

let readyPromise: Promise<void> | null = null;

/**
 * Resolves once the SEA background native-cache unpack has finished the
 * embedding-critical tier (or the whole pass). Memoized: every caller
 * shares one waiter, and once resolved it stays resolved for the life
 * of the process.
 */
export function waitForNativeCacheReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const cacheDir = process.env.SAG_NATIVE_CACHE_DIR;
    if (!cacheDir) return; // dev mode — no SEA staging, nothing to wait for
    const embeddingStamp = path.join(cacheDir, ".sag-unpack-embedding-ready");
    const completeStamp = path.join(cacheDir, ".sag-unpack-complete");
    const isReady = () => existsSync(embeddingStamp) || existsSync(completeStamp);
    if (isReady()) return;
    const started = Date.now();
    logger.info(
      { cacheDir },
      "native-cache background unpack in progress — deferring embedding until the embedding-critical tier lands"
    );
    let lastLog = 0;
    while (!isReady()) {
      const waited = Date.now() - started;
      if (waited > MAX_WAIT_MS) {
        logger.warn(
          { cacheDir, waitedMs: waited },
          "native-cache unpack did not finish within the wait cap — proceeding anyway (fail-open)"
        );
        return;
      }
      if (waited - lastLog >= LOG_EVERY_MS) {
        lastLog = waited;
        logger.info(
          { waitedMs: waited },
          "native-cache unpack still running — embedding deferred"
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    logger.info(
      { waitedMs: Date.now() - started },
      "native-cache embedding tier ready — embedding enabled"
    );
  })();
  return readyPromise;
}
