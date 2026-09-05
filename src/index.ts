// Force the process-wide timezone to Asia/Shanghai (UTC+8). All timestamps
// — SQLite `current_timestamp`, `datetime('now')`, pino log timestamps,
// and the custom toLocalISO() helper — will use East 8 time unless
// explicitly overridden by the caller.
process.env.TZ = "Asia/Shanghai";

// Startup banner — printed once when the SEA binary boots so users who
// launch 黑洞.exe from a shell (PowerShell / cmd) can immediately see
// who built it. Double-clicking from Explorer suppresses stdout entirely,
// so this only shows in a real terminal — that's intentional (the
// web UI doesn't need it).
try {
  // Use console.log directly (not the structured logger) so the line
  // shows up even when LOG_LEVEL is set to error.
  // eslint-disable-next-line no-console
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   SAG — 智能审计与检索工具                  ║
  ║   作者：钟远声                                ║
  ╚══════════════════════════════════════════════╝
`);
} catch {
  // Best-effort; never fail boot for a banner.
}

import { startHttpServer } from "./api/server.js";
import { logger } from "./observability/logger.js";
import { finishSyncRun, listFolders } from "./watcher/manifest-store.js";
import { watcherManager } from "./watcher/index.js";
import { config } from "./config/env.js";
import { closePool, initPool, resetPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { startMcpHttpServer } from "./mcp/http-server.js";
import { startEmbeddingWorkerLoop } from "./workers/embedding-worker.js";

// Finish any sync runs that the previous process left in "running".
// The most common cause is SIGKILL during development or OS-level
// termination; without this the "Recent sync" list clogs up with
// dozens of identical zero-progress rows that never move.
async function cleanupStaleSyncRuns(): Promise<number> {
  try {
    const { pool } = await import("./db/pool.js");
    const result = await pool.query(
      `select id, folder_id, started_at, stats_added, stats_updated, stats_deleted, stats_failed
       from watched_folder_runs
       where status = 'running'`
    );
    const stale = result.rows;
    if (stale.length === 0) {
      return 0;
    }
    logger.warn(
      { count: stale.length, runIds: stale.map((r) => r.id) },
      "watcher: finishing stale sync runs from previous process"
    );
    for (const row of stale) {
      try {
        await finishSyncRun(
          String(row.id),
          "completed",
          {
            filesAdded: Number(row.stats_added ?? 0),
            filesUpdated: Number(row.stats_updated ?? 0),
            filesDeleted: Number(row.stats_deleted ?? 0),
            filesFailed: Number(row.stats_failed ?? 0)
          },
          "aborted by process restart — recovered on next boot"
        );
      } catch (err) {
        logger.error(
          { runId: row.id, error: (err as Error).message },
          "watcher: failed to finalize stale sync run"
        );
      }
    }
    return stale.length;
  } catch (err) {
    logger.error(
      { error: (err as Error).message },
      "watcher: zombie-run cleanup failed; continuing boot anyway"
    );
    return 0;
  }
}

async function bootWatchedFolders(): Promise<void> {
  // Triple-gated autostart. Each env flag has the same effect: refuse
  // to start any watcher when this exe boots. The three names cover
  // the evolution of the env schema:
  //   - ALLOW_PROD_WATCHER: documented in .env.example since v1
  //   - STARTUP_SYNC: legacy name from the very first watcher release
  //   - WATCHER_AUTOSTART: current name (boolean, default false)
  // All three default to false so a brand-new install never auto-syncs
  // a multi-thousand-file folder out of the box. With even one enabled
  // folder, a misconfigured embedding key (or a real local-bge load
  // on the main thread) would otherwise pin 100% CPU and hang /health
  // for 5+ seconds — see 失败原因/2026-08-06-sag-main-thread阻塞.md.
  const autostart =
    config.ALLOW_PROD_WATCHER ||
    config.WATCHER_AUTOSTART ||
    config.STARTUP_SYNC;
  logger.info(
    {
      autostart,
      ALLOW_PROD_WATCHER: config.ALLOW_PROD_WATCHER,
      WATCHER_AUTOSTART: config.WATCHER_AUTOSTART,
      STARTUP_SYNC: config.STARTUP_SYNC
    },
    "watcher: boot phase"
  );
  if (!autostart) {
    logger.info("watcher: autostart disabled (set WATCHER_AUTOSTART=true to enable)");
    return;
  }
  try {
    // Cleanup BEFORE startAll: every restart would otherwise pile a
    // new "running" run on top of the previous (now-orphaned) ones.
    const cleaned = await cleanupStaleSyncRuns();
    if (cleaned > 0) {
      logger.info({ cleaned }, "watcher: stale sync runs recovered");
    }
    const folders = await listFolders(config.DEFAULT_TENANT_ID);
    const enabled = folders.filter((f) => f.enabled);
    if (enabled.length === 0) {
      logger.info("watcher: no enabled watched folders found at startup");
      return;
    }
    logger.info({ count: enabled.length }, "watcher: starting watchers at startup");
    // Pre-warm the embedding worker when local-bge is configured, so
    // the first ingest call doesn't pay the 5-15s ONNX pipeline load
    // synchronously on the main thread. Fire-and-forget — the worker
    // will also lazy-load on first embed call if this fails.
    if (
      config.EMBEDDING_PROVIDER === "local-bge" &&
      config.EMBEDDING_LOCAL_MODEL_PATH
    ) {
      void import("./ai/embedding-client.js").then((m) =>
        m.warmupLocalBgeWorker(config.EMBEDDING_LOCAL_MODEL_PATH)
      );
    }
    await watcherManager.startAll(enabled);
  } catch (error) {
    // The watcher must NEVER block the HTTP server from starting. Log and move on.
    logger.error({ error: (error as Error).message }, "watcher: failed to start watchers at startup");
  }
}

function installShutdownHandlers(): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "server: shutting down");
    try {
      await watcherManager.stopAll();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "watcher: stopAll on shutdown failed");
    }
    try {
      await closePool();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, "db: closePool on shutdown failed");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

installShutdownHandlers();

// ── Process-wide crash guards ──────────────────────────────────────────────
// Some native modules (most notably onnxruntime inside @xenova/transformers
// used for the local BGE embedding path) raise unrecoverable exceptions on
// tensor-shape mismatches (e.g. `Add_1` broadcast axis != 1). Those throw
// past the normal `try/catch` boundary as native aborts and would normally
// terminate the Node process — taking the HTTP server, all watchers, and
// any in-flight ingestion with them. Installing `uncaughtException` /
// `unhandledRejection` listeners lets us at least log the failure and
// keep the rest of the service responsive. The watcher and queue code can
// independently guard around the offending call site (see
// `localBgeEmbedding` in src/ai/embedding-client.ts).
process.on("uncaughtException", (error) => {
  logger.error(
    { err: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) },
    "process: uncaughtException — keeping process alive (may be native ONNX abort)"
  );
});
process.on("unhandledRejection", (reason) => {
  logger.error(
    { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : String(reason) },
    "process: unhandledRejection — keeping process alive"
  );
});

// Run migrations before serving any requests. SQLite keeps everything in
// ./data/sag.db so this just ensures schema is up to date.
// After migrations run, reset the pool so fresh connections pick up any
// table-rebuilding migrations (e.g. 005 that recreates events with a PK).
(async () => {
  try {
    await initPool();
    await migrate();
    await resetPool();
  } catch (error) {
    logger.error({ error: (error as Error).message }, "migration on startup failed");
    process.exit(1);
  }
  // Boot the background embedding-worker loop alongside the watcher
  // folders. The worker is a no-op while ingestDocument is healthy
  // (every chunk gets embedded inline) — but on a crash mid-file
  // it sweeps the chunks table for any `pending` rows left behind
  // and finishes them off, so a restart doesn't have to re-run the
  // whole file. See src/workers/embedding-worker.ts for the loop
  // design (claim / embed / release with 5-min lock timeout).
  //
  // Note: the earlier split into a separate 黑洞-ingest-worker.exe
  // OS process was rolled back on 2026-08-10 — the per-file
  // wall-clock saving on local ONNX was small (a few percent), and
  // shipping a second 87 MB exe was more friction than it was
  // worth. The in-process loop here already gives us crash recovery
  // (the only thing the document
  // 失败原因/2026-08-10-sag-分阶段双进程并行方案.md actually
  // measured as 5x in real testing). Re-introduce the child process
  // when per-stage work moves off the main thread (e.g. xlsx
  // parser into worker_threads).
  startEmbeddingWorkerLoop();
  void bootWatchedFolders();
})();

// ---------------------------------------------------------------------------
// MCP transport selection
//
// `MCP_TRANSPORT=stdio` (default) is handled by the dedicated `npm run mcp`
// command which runs `src/mcp/server.ts` against the local process. When
// `MCP_TRANSPORT=http` we additionally stand up a streamable HTTP endpoint
// on `MCP_HTTP_PORT` so remote / browser MCP clients can consume SAG.
const httpOnly = config.MCP_TRANSPORT === "http";

Promise.all([
  startHttpServer(),
  httpOnly
    ? startMcpHttpServer().catch((error) => {
        logger.error({ error }, "mcp http server failed");
        process.exit(1);
      })
    : Promise.resolve(),
]).catch((error) => {
  logger.error({ error }, "server failed");
  process.exit(1);
});

