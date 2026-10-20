/**
 * src/api/server.ts — Fastify HTTP server composition.
 *
 * After the route-file split (commit splitting 705-line buildHttpServer),
 * `server.ts` no longer inlines handler bodies. It just:
 *   - Constructs the Fastify instance.
 *   - Calls `registerXxxRoutes(app)` for each domain module under `src/api/`.
 *   - Mounts the static web bundle when present.
 *   - Installs the 404 handler (HTTP `404` or `index.html` SPA fallback).
 *   - Installs the global error handler (Zod → 400, anything else → 500).
 *
 * Adding a new endpoint surface should mean writing a new `<domain>-routes.ts`
 * with a single `registerXxxRoutes(app)` entry point and adding the call
 * to `buildHttpServer()` here, NOT inlining 80 lines of `app.get(...)`.
 *
 * Authoritative code lives in:
 *   - server-helpers.ts (schemas + helpers)
 *   - health-routes.ts / diagnostic-routes.ts / settings-routes.ts
 *   - project-routes.ts / document-routes.ts / search-routes.ts
 *   - event-routes.ts / convert-routes.ts / mcp-session-routes.ts
 *   - watched-folders.ts / kb-projects.ts (existing)
 *   - mcp-audit.ts / mcp-api-keys.ts (existing)
 */

import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { config } from "../config/env.js";
import { initPool } from "../db/pool.js";
import { logger } from "../observability/logger.js";
import { getErrorMessage, notFound } from "./server-helpers.js";
import { registerHealthRoutes } from "./health-routes.js";
import { registerDiagnosticRoutes } from "./diagnostic-routes.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerEventRoutes } from "./event-routes.js";
import { registerSearchRoutes } from "./search-routes.js";
import { registerConvertRoutes } from "./convert-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerDocumentRoutes } from "./document-routes.js";
import { registerMcpSessionRoutes } from "./mcp-session-routes.js";
import { registerWatchedFoldersRoutes } from "./watched-folders.js";
import { registerKbProjectRoutes } from "./kb-projects.js";
import { registerMcpAuditRoutes } from "./mcp-audit.js";
import { registerMcpApiKeysRoutes } from "./mcp-api-keys.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerJobsRoutes } from "./jobs-routes.js";

const rootDir = process.cwd();
// Find the web/dist directory that ships with the exe. Look first next
// to the running executable (the SEA distribution path), then fall
// back to the dev path <cwd>/web/dist. Without this, end users would
// see a 404 on the SPA — the Fastify static mount only happens when
// index.html exists.
const exeDir = path.dirname(process.execPath);
const candidateDirs = [
  path.join(exeDir, "web", "dist"),
  path.join(rootDir, "web", "dist"),
];
const webDistDir = candidateDirs.find((d) => fs.existsSync(d));
const webIndexFile = webDistDir ? path.join(webDistDir, "index.html") : null;

export function buildHttpServer(): ReturnType<typeof Fastify> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      base: { service: "sag" }
    }
  });

  // Domain modules — keep alphabetical-ish so it's obvious where to slot
  // a new `<domain>-routes.ts`.
  registerHealthRoutes(app);
  registerDiagnosticRoutes(app);
  registerSettingsRoutes(app);
  registerEventRoutes(app);
  registerSearchRoutes(app);
  registerConvertRoutes(app);
  registerProjectRoutes(app);
  registerDocumentRoutes(app);
  registerMcpSessionRoutes(app);
  // External (added before the big split)
  registerWatchedFoldersRoutes(app);
  registerKbProjectRoutes(app);
  registerMcpAuditRoutes(app);
  registerMcpApiKeysRoutes(app);
  registerAdminRoutes(app);
  // Stage 1 productization: real-time jobs panel + per-file actions.
  registerJobsRoutes(app);

  if (webDistDir && webIndexFile && fs.existsSync(webIndexFile)) {
    // Strip any watermark that an earlier version may have written to the
    // on-disk html file. We re-write the clean version back so the
    // static handler serves it as-is.
    // Important: read+write as raw Buffer to avoid UTF-8/UTF-16 codepage
    // round-tripping that some Node.js builds (notably the SEA bundle on
    // Windows) silently perform when given the "utf8" string codec.
    const rawBuf = fs.readFileSync(webIndexFile);
    const rawHtml = rawBuf.toString("latin1"); // 1:1 byte mapping, no codec interpretation
    const cleanHtml = rawHtml.replace(
      /\n?\n?<style id="sag-watermark"[\s\S]*?<\/style>/,
      ""
    );
    if (Buffer.from(cleanHtml, "latin1").equals(rawBuf) === false) {
      fs.writeFileSync(webIndexFile, Buffer.from(cleanHtml, "latin1"));
    }
    app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      // The web bundle filename is content-hashed (e.g.
      // index-6QLtlANQ.js), so the asset itself is safe to cache
      // forever. The HTML, however, references whichever hash is
      // current; an old cached index.html that points at a deleted
      // .js asset (e.g. after a rebuild shipped a new hash) shows a
      // blank page with no console error — the browser silently 404s
      // the missing asset and never refetches. Force no-store on the
      // HTML so the user always gets the latest asset reference.
      cacheControl: false,
      setHeaders: (res, path) => {
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      }
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/health") {
        return reply.code(404).send(notFound("NOT_FOUND", "接口不存在"));
      }
      return reply.type("text/html").send(cleanHtml);
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof z.ZodError ? 400 : 500;
    const logPayload = { error, statusCode };
    if (statusCode >= 500) {
      logger.error(logPayload, "request failed");
    } else {
      logger.warn(logPayload, "request validation failed");
    }
    reply.code(statusCode).send({
      error: {
        code: statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_ERROR",
        message: getErrorMessage(error)
      }
    });
  });

  return app;
}

export async function startHttpServer(): Promise<void> {
  // P19/P22 fix: the pool MUST be initialized before any query.
  // The IIFE in index.ts that calls initPool() is not awaited (ESM
  // top-level await is incompatible with TypeScript's module-level
  // import semantics), so we re-initialize here to guarantee readiness.
  await initPool();

  // Plan B (2026-09-19): NER model gate. Plan A used a regex NER
  // fallback that "just worked" without configuration; Plan B uses
  // an ONNX model that has to be downloaded first. We refuse to
  // start the server until one is configured so operators get a
  // clear "go to Settings → NER → Download" error instead of a
  // silent regression to the Plan A regex (which we DO keep as a
  // runtime fallback for the rare case where the ONNX pipeline
  // throws during ingest, but not as the default).
  await assertNerConfigured();

  const app = buildHttpServer();
  // P1 fix: a process restart while files are mid-ingest leaves
  // manifest rows stuck in `syncing`. The new process is by
  // definition the only legitimate owner of in-flight ingest work,
  // so any such row is stale and must be reclaimable. We sweep
  // here — BEFORE HTTP starts accepting traffic — so retry-file
  // and list-failed-manifest see consistent state from request 1.
  //
  // Deliberately NOT routed through WatcherManager.startAll()
  // because startAll only runs when WATCHER_AUTOSTART=true, which
  // would silently leave autostart=false installs permanently
  // stuck on stale syncing rows.
  try {
    const { reapStaleSyncingManifests } = await import("../watcher/manifest-store.js");
    const { reaped, reapedPaths } = await reapStaleSyncingManifests();
    if (reaped > 0) {
      logger.warn(
        { reaped, sample: reapedPaths.slice(0, 5) },
        "watcher: reaped stale syncing rows from previous process"
      );
    }
    // P20 — same pattern for the runs table. `running` rows from
    // a crashed previous process are reported forever otherwise.
    const { reapStaleSyncRuns } = await import("../watcher/manifest-store.js");
    const { reaped: reapedRuns } = await reapStaleSyncRuns();
    if (reapedRuns > 0) {
      logger.warn(
        { reaped: reapedRuns },
        "watcher: reaped stale running runs from previous process"
      );
    }
  } catch (error) {
    // Don't block startup on a DB hiccup; the next ingest attempt
    // for those files will surface the stale state anyway.
    logger.error(
      { error: (error as Error).message },
      "watcher: stale-syncing reap failed (non-fatal)"
    );
  }
  // P-Tier2-#18 — refuse to bind to a non-loopback interface while
  // AUTH_MODE=none. Without this, a single misconfigured deployment
  // (HTTP_HOST=0.0.0.0 with the default no-auth mode) exposes every
  // endpoint to the LAN with no credential check. The original
  // comment block above the env var (env.ts:31-37) tells operators
  // to flip AUTH_MODE to bearer when they switch HTTP_HOST, but
  // there's no enforcement. Adding this guard converts a security
  // blog post waiting to happen into a startup error.
  if (config.AUTH_MODE === "none" && config.HTTP_HOST !== "127.0.0.1" && config.HTTP_HOST !== "localhost" && config.HTTP_HOST !== "::1") {
    throw new Error(
      `AUTH_MODE=none with HTTP_HOST=${config.HTTP_HOST} is not allowed. ` +
        `Bind to 127.0.0.1 (default) or set AUTH_MODE=bearer + SAG_AUTH_TOKEN.`
    );
  }

  // Scan for the first available port starting at HTTP_PORT.
  // The MCP server (本地文档检索-mcp.exe) auto-starts on the same
  // session and frequently claims 4173, so we try 4173 → 4174 → …
  // up to 4183 rather than failing the boot. We also patch
  // process.env.HTTP_PORT and propagate the chosen port through to
  // the browser-open URL + MCP HTTP port allocator so downstream
  // callers don't try to bind to the original (occupied) port.
  const BASE_PORT = config.HTTP_PORT;
  const MAX_PORT = BASE_PORT + 10;
  let chosenPort: number = BASE_PORT;
  let bound = false;
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    try {
      await app.listen({ host: config.HTTP_HOST, port });
      chosenPort = port;
      bound = true;
      break;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== "EADDRINUSE") {
        // Unexpected error — let it propagate.
        throw err;
      }
      // port is in use, try the next one.
    }
  }

  if (!bound) {
    throw new Error(
      `所有可用端口 (${BASE_PORT}–${MAX_PORT}) 均被占用，服务器无法启动`
    );
  }

  // Publish the actually-bound port to stdout as a parseable line.
  // The Electron desktop shell (electron/main.cjs) reads this from
  // its child stdout handler to follow a 4173→4174 fallback — without
  // it, Electron would poll 4173 forever while we actually listen on
  // 4174, hitting the 120s waitForBackendReady timeout. The marker
  // format is `SAG_BOUND_PORT=<integer>` and is always emitted,
  // even when we bound the original port, so Electron doesn't have
  // to disambiguate "marker not yet seen" from "marker is the
  // default". Stdout (not pino) because the SEA exe routes pino
  // logs through its own logger that may buffer / suppress in the
  // GUI subsystem build.
  process.stdout.write(`SAG_BOUND_PORT=${chosenPort}\n`);

  if (chosenPort !== BASE_PORT) {
    // Patch the env so that config.HTTP_PORT and the /health reporter
    // agree with what we're actually listening on.
    process.env.HTTP_PORT = String(chosenPort);
    logger.info(
      { wanted: BASE_PORT, chosen: chosenPort },
      "server: 4173 被占用，自动切换到备用端口"
    );
  }
  // Auto-open the web UI in the default browser. Disabled when
  // SAG_OPEN_BROWSER=false (CI, headless, custom launcher scripts).
  // We use the OS's default URL handler via `cmd /c start` (Windows)
  // and `xdg-open` / `open` (Linux/macOS) — no extra dependency.
  if (process.env.SAG_OPEN_BROWSER !== "false") {
    const url = `http://127.0.0.1:${chosenPort}`;
    // Give the Fastify listen() a tick to actually accept connections
    // before the browser races the request. Without this the browser
    // sometimes shows "This site can't be reached" on cold start.
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const { spawn } = await import("node:child_process");
      if (process.platform === "win32") {
        // `cmd /c start` takes the first quoted arg as the window title,
        // so we pass "" as title and the URL as the second arg. We pass
        // the args as a single string (rather than an array) and rely on
        // `shell: true` — `start` is a cmd builtin and PowerShell's
        // array-style arg escaping doesn't round-trip the empty-title
        // trick reliably.
        spawn(
          `cmd /c start "" "${url}"`,
          { detached: true, stdio: "ignore", shell: true, windowsHide: true }
        ).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      }
    } catch (error) {
      logger.warn(
        { url, error: (error as Error).message },
        "server: failed to auto-open browser (set SAG_OPEN_BROWSER=false to silence)"
      );
    }
  }
}

/**
 * Plan B (2026-09-19): refuse to start the HTTP server until a NER
 * model is configured AND loadable.
 *
 * Two failure modes are reported distinctly:
 *
 *   1. `nerModel` empty → "go download one" hint. The Web UI's
 *      /api/settings/ner/catalog endpoint exposes the catalog.
 *
 *   2. `nerModel` set but pipeline load fails → "files corrupt or
 *      missing" hint. Usually means a partial download; the Web
 *      UI's /api/settings/ner/download endpoint can re-fetch.
 *
 * Both throw synchronously, which causes startHttpServer() to
 * reject. The electron-main entry-point logs the error and exits
 * non-zero so operators see something tangible instead of a hung
 * process with a missing ingest.
 */
async function assertNerConfigured(): Promise<void> {
  // Plan B + dev/QA bypass: SAG_SKIP_NER_CHECK=1 lets the backend boot
  // even when no NER model is configured (or installed). Entity
  // extraction falls back to the Plan A regex heuristic for the
  // session, but the rest of the app — ingest, sync, embedding,
  // search — works normally. Intended for CI builds and for operators
  // debugging "backend refuses to start" issues without first
  // downloading a 110 MB model.
  if (process.env.SAG_SKIP_NER_CHECK === "1") {
    logger.warn(
      "SAG_SKIP_NER_CHECK=1 set — skipping Plan B NER check; entity " +
      "extraction will fall back to regex for this session"
    );
    // eslint-disable-next-line no-console
    console.log("[DEBUG] assertNerConfigured skipped due to SAG_SKIP_NER_CHECK=1");
    return;
  }
  // eslint-disable-next-line no-console
  console.log("[DEBUG] assertNerConfigured: SAG_SKIP_NER_CHECK not set, running NER check");
  // Dynamic imports to keep startHttpServer() synchronously cheap
  // before the pool is ready (mirrors the pattern used a few lines
  // up for reapStaleSyncingManifests).
  const { aiSettingsService } = await import("../services/ai-settings-service.js");
  const { getLocalNerPipeline } = await import("../ai/ner-pipeline-factory.js");
  const { isModelInstalled } = await import("../ai/model-path-resolver.js");
  const settings = await aiSettingsService.getRuntimeSettings();
  if (!settings.nerModel || settings.nerModel.trim().length === 0) {
    // No NER model configured — skip Plan B entirely. Entity extraction
    // will fall back to Plan A regex for this session. This lets the
    // backend boot on fresh installs or when the operator hasn't yet
    // downloaded a NER model, without needing SAG_SKIP_NER_CHECK=1.
    logger.warn(
      "No NER model configured — skipping Plan B entity extraction. " +
      "Entity extraction will fall back to regex for this session."
    );
    // eslint-disable-next-line no-console
    console.log("[DEBUG] assertNerConfigured: no nerModel configured, skipping NER check");
    return;
  }
  if (!isModelInstalled(settings.nerModel)) {
    throw new Error(
      `Plan B: configured NER model "${settings.nerModel}" is not installed ` +
      "(missing tokenizer.json or onnx/ directory). " +
      "Re-download via Settings → NER → Download."
    );
  }
  try {
    await getLocalNerPipeline({
      modelPath: settings.nerModel,
      maxTokens: settings.nerMaxTokens,
      aggregationStrategy: "none"
    });
    logger.info(
      { nerModel: settings.nerModel, nerMaxTokens: settings.nerMaxTokens },
      "ner: model loaded at startup"
    );
  } catch (err) {
    throw new Error(
      `Plan B: failed to load NER model "${settings.nerModel}": ${(err as Error).message}. ` +
      "Re-download via Settings → NER → Download."
    );
  }
}
