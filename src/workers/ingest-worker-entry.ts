/**
 * src/workers/ingest-worker-entry.ts — bootstrap for the embedding
 * worker process. Bundled standalone and wrapped into
 * 黑洞-ingest-worker.exe so the main 黑洞.exe can spawn it as a
 * child process and free its main thread.
 *
 * Lifecycle:
 *   1. Setup DB pool + migrations
 *   2. Load AI provider settings (loads BGE model on first use)
 *   3. Start the embedding-worker loop (claim / embed / release)
 *   4. Heartbeat every 30s with `embedding-worker: heartbeat` log
 *      so the parent can detect a dead child
 *   5. On SIGTERM / SIGINT, stop the loop and exit cleanly
 *
 * The parent (黑洞.exe) decides whether to spawn this child; the
 * default is YES so we always get the parallelism win. Set
 * EMBEDDING_WORKER_SEPARATE_PROCESS=0 to disable.
 *
 * NB: this file is bundled by esbuild into a CJS module, so the
 * export { main } at the bottom is what the SEA bootstrap calls
 * via `bundleModule.exports.main()`. The bootstrap entry's
 * require("better-sqlite3") doesn't work because SEA sets the
 * entry's module.paths to [] — better-sqlite3 is loaded later via
 * the bundle's own require chain where module.paths is patched
 * to include the unpacked node_modules tree.
 */

import { logger } from "../observability/logger.js";
import { startEmbeddingWorkerLoop } from "./embedding-worker.js";
import { aiSettingsService } from "../services/ai-settings-service.js";

const HEARTBEAT_MS = 30_000;

let stopLoop: (() => void) | null = null;

async function main(): Promise<void> {
  logger.info({ pid: process.pid }, "ingest-worker: booting");
  // Loading settings once up front warms the AI provider config cache
  // and (for local-bge) triggers the model load inside the worker.
  // If this throws, the parent should see the failure in sd-err.log.
  try {
    await aiSettingsService.getRuntimeSettings();
    logger.info("ingest-worker: AI settings loaded");
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "ingest-worker: AI settings load failed; exiting"
    );
    process.exit(1);
  }

  stopLoop = startEmbeddingWorkerLoop();

  const heartbeat = setInterval(() => {
    logger.info({ pid: process.pid }, "ingest-worker: heartbeat");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "ingest-worker: shutting down");
    if (stopLoop) {
      stopLoop();
      stopLoop = null;
    }
    clearInterval(heartbeat);
    // Give the in-flight ONNX forward up to 5s to finish cleanly
    // before yanking the process. Without this, a SIGTERM in the
    // middle of an ONNX run leaves the row locked until the
    // 5-min lock timeout — fine, but a clean flush is nicer.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, "ingest-worker: fatal");
  process.exit(1);
});

// Export so the SEA bundle (which compiles this entry as a CJS
// module) can be invoked by name from the bootstrap entry. The
// SEA entry does `bundleModule.exports.main()` — without this
// export, the bundle's `module.exports` has no `main` property
// and the process bails with "bundle has no main export".
export { main };