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

  // Watermark — inject a light diagonal "sag" pattern into every
  // HTML response. Because this is a server-side onSend hook, it cannot be
  // removed by editing static web UI files. The watermark is a repeating
  // SVG background on the body element, styled as low-opacity diagonal
  // stripes.
  const watermarkStyle = [
    "<style id=\"sag-watermark\" data-injected-by=\"server\">",
    "body::after{",
    "content:\"\";",
    "position:fixed;",
    "top:0;left:0;",
    "width:100%;height:100%;",
    "pointer-events:none;",
    "z-index:99999;",
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='140'%3E%3Ctext x='0' y='70' fill='rgba(0,0,0,0.05)' font-size='16' font-family='sans-serif' transform='rotate(-30,140,70)'%3Esag%3C/text%3E%3C/svg%3E\");",
    "background-repeat:repeat;",
    "}",
    "</style>"
  ].join("");
  const injectWatermark = (html: string): string => {
    return html.replace("</head>", watermarkStyle + "</head>");
  };

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

  if (webDistDir && webIndexFile && fs.existsSync(webIndexFile)) {
    // Inject the watermark into the static index.html. We write the
    // watermarked version back to disk so @fastify/static serves it
    // on every request (including the root path). If someone edits
    // the file, the next server restart re-injects the watermark.
    const rawHtml = fs.readFileSync(webIndexFile, "utf8");
    const watermarkedHtml = injectWatermark(rawHtml);
    // Only write if the file doesn't already have the watermark
    // (avoid unnecessary disk writes on every boot).
    if (!rawHtml.includes("sag-watermark")) {
      fs.writeFileSync(webIndexFile, watermarkedHtml, "utf8");
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
      return reply.type("text/html").send(watermarkedHtml);
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
  const app = buildHttpServer();
  await app.listen({
    host: config.HTTP_HOST,
    port: config.HTTP_PORT
  });
  // Auto-open the web UI in the default browser. Disabled when
  // SAG_OPEN_BROWSER=false (CI, headless, custom launcher scripts).
  // We use the OS's default URL handler via `cmd /c start` (Windows)
  // and `xdg-open` / `open` (Linux/macOS) — no extra dependency.
  if (process.env.SAG_OPEN_BROWSER !== "false") {
    const url = `http://127.0.0.1:${config.HTTP_PORT}`;
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
