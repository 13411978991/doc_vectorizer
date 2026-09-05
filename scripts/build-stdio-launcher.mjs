#!/usr/bin/env node
// build-stdio-launcher.mjs — Produce sag-mcp.exe, a stdio-only MCP server
// that the Trae / Claude / Cursor client can spawn directly via
// "command". End users do NOT have to start sag.exe first.
//
// Layout:
//   dist/sag-mcp.bundle.cjs          — esbuild of src/mcp/server.ts only
//   dist/sag-mcp.native-map.json     — same native deps as sag.exe
//   dist/sag-mcp.entry.cjs           — bootstrap: unpacks natives, runs the
//                                      bundle's startMcpServer()
//   dist/sea-config-mcp.json         — Node SEA config pointing at entry
//   dist/sag-mcp.blob                — produced by `node --experimental-sea-config`
//
// Run via: npm run build:stdio-launcher
// After:  npm run build:stdio-launcher-exe (wraps blob into sag-mcp.exe)
//
// Shared with sag.exe:
//   - database file (DATABASE_FILE path is resolved relative to the
//     install dir at runtime, so both .exe siblings under the same folder
//     talk to the same SQLite DB)
//   - node_modules natives (extracted once into a stable tmp dir keyed by
//     blob hash; both .exe share the cache)

import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");

// Same native deps as the main sag.exe. Keep these in sync with
// build-sea-bundle.mjs.
const NATIVE_DEPS = [
  "better-sqlite3",
  "sqlite-vec",
  "onnxruntime-node",
  "sharp",
  "bindings",
];

// ESM externals — same as build-sea-bundle.mjs.
const EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  "onnxruntime-web",
  "@huggingface/jinja",
];

function log(...args) {
  console.log("[stdio-build]", ...args);
}

async function stepBundle() {
  log("esbuild: bundling src/mcp/server.ts only");
  await build({
    entryPoints: [join(DIST, "src/mcp/server.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: [
      ...NATIVE_DEPS,
      ...EXTERNAL_ESM_DEPS,
      "pg-native",
      "sharp",
      "@embedded-postgres/*",
    ],
    outfile: join(DIST, "sag-mcp.bundle.cjs"),
    logLevel: "info",
    banner: {
      js: [
        "// SAG-MCP esbuild bundle — stdio launcher.",
        'var import_meta_url = require("url").pathToFileURL(__filename).href;',
      ].join("\n"),
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  log(
    "✓ bundle:",
    "dist/sag-mcp.bundle.cjs",
    `(${(statSync(join(DIST, "sag-mcp.bundle.cjs")).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

function walkModule(pkgDir) {
  const out = new Map();
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "test" || ent.name === "__tests__" || ent.name === "node_modules") continue;
        walk(full);
      } else if (ent.isFile()) {
        if (/\.(node|dll|so|dylib|bin|dat|onnx|json|js|cjs|mjs)$/i.test(ent.name)) {
          out.set(relative(pkgDir, full), readFileSync(full));
        }
      }
    }
  }
  walk(pkgDir);
  return out;
}

function collectNativeDeps(pkgs, collected = new Set(), includeOptional = false) {
  for (const pkg of pkgs) {
    if (collected.has(pkg)) continue;
    collected.add(pkg);
    const pkgDir = join(ROOT, "node_modules", pkg);
    if (!existsSync(pkgDir)) continue;
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    let pkgJson;
    try { pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")); } catch { continue; }
    const deps = pkgJson.dependencies || {};
    collectNativeDeps(Object.keys(deps), collected, includeOptional);
    if (includeOptional) {
      const optDeps = pkgJson.optionalDependencies || {};
      collectNativeDeps(Object.keys(optDeps), collected, includeOptional);
    }
  }
  return Array.from(collected);
}

function stepNativeMap() {
  const allNativeDeps = [
    ...collectNativeDeps(NATIVE_DEPS, new Set(), true),
    ...EXTERNAL_ESM_DEPS
  ];
  log("native-map: walking", allNativeDeps.join(", "));
  const map = {};
  let totalBytes = 0;
  for (const pkg of allNativeDeps) {
    const pkgDir = join(ROOT, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      log(`  ! ${pkg} not installed — runtime will skip`);
      continue;
    }
    const files = walkModule(pkgDir);
    const pkgMap = {};
    for (const [rel, buf] of files) {
      pkgMap[rel] = buf.toString("base64");
      totalBytes += buf.length;
    }
    pkgMap["__root__"] = pkgDir;
    map[pkg] = pkgMap;
  }
  const bundlePath = join(DIST, "sag-mcp.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    map["__bundle__"] = {
      "sag-mcp.bundle.cjs": bundleBuf.toString("base64"),
      "__root__": DIST,
    };
    totalBytes += bundleBuf.length;
    log("  + bundled sag-mcp.bundle.cjs");
  }
  const out = join(DIST, "sag-mcp.native-map.json");
  writeFileSync(out, JSON.stringify(map));
  log(
    "✓ native-map:",
    "dist/sag-mcp.native-map.json",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked)`,
  );
}

function stepEntry() {
  log("entry: writing");

  // Migrations — same as sag.exe so the stdio launcher can run SQLite
  // migrations on first boot.
  const migrationsSrcDir = join(ROOT, "src/db/sqlite/migrations");
  const migrationsMap = {};
  if (existsSync(migrationsSrcDir)) {
    for (const f of readdirSync(migrationsSrcDir)) {
      if (f.endsWith(".sql")) {
        migrationsMap[f] = readFileSync(join(migrationsSrcDir, f)).toString("base64");
      }
    }
  }
  writeFileSync(join(DIST, "sag-mcp.migrations.json"), JSON.stringify(migrationsMap));
  log("✓ sag-mcp.migrations.json written");

  const mapJson = readFileSync(join(DIST, "sag-mcp.native-map.json"), "utf8");

  const entry = `// AUTO-GENERATED by build-stdio-launcher.mjs. Do not edit.
// SAG-MCP stdio launcher. End users run this via Trae's MCP "command"
// field; the parent process never has to start sag.exe separately.
//
// Differences from sag.exe:
//   - Entry point: dist/src/mcp/server.js (only the MCP server bits)
//   - No HTTP server, no web UI, no watcher
//   - Resolves DATABASE_FILE relative to the install dir so it shares the
//     same SQLite file as sag.exe when both live side-by-side
//   - Auto-runs migrations if the DB doesn't exist
"use strict";

// Same DOMMatrix / Path2D polyfill as build-sea-bundle.mjs — see that
// file for the rationale. Required so pdfjs-dist can be required at
// SEA bundle top-level on Windows without crashing.
if (typeof globalThis.DOMMatrix === "undefined") {
  class DOMMatrix {
    constructor() { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translate() { return this; }
    scale() { return this; }
    invertSelf() { return this; }
  }
  globalThis.DOMMatrix = DOMMatrix;
}
if (typeof globalThis.Path2D === "undefined") {
  globalThis.Path2D = class Path2D {};
}

const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const crypto = require("crypto");

function unpackOnce() {
  // Read native-map from a sibling file next to the exe. The build
  // script writes this file alongside the exe. We infer the json
  // basename from process.execPath so renaming the binary (e.g.
  // sag-mcp.exe → 黑洞-mcp.exe) doesn't break the runtime lookup.
  // Large SEA resources crash V8 on Windows, so the map is not embedded.
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const mapPath = path.join(exeDir, exeBase + ".native-map.json");
  if (!fs.existsSync(mapPath)) {
    process.stderr.write(
      "[" + exeBase + "] " + exeBase + ".native-map.json missing next to " + path.basename(process.execPath) + "\\n" +
      "[" + exeBase + "] expected at: " + mapPath + "\\n",
    );
    process.exit(1);
  }
  const mapJson = fs.readFileSync(mapPath, "utf8");
  const NATIVE_MAP = JSON.parse(mapJson);
  const sig = crypto
    .createHash("sha256")
    .update(mapJson)
    .digest("hex")
    .slice(0, 12);
  const baseDir = path.join(os.tmpdir(), "sag-sea-native-" + sig);
  fs.mkdirSync(baseDir, { recursive: true });
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle_mcp__");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });

  for (const [pkg, files] of Object.entries(NATIVE_MAP)) {
    if (pkg === "__root__") continue;
    const pkgDir = pkg === "__bundle__"
      ? bundleDir
      : path.join(nodeModulesDir, pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    for (const [rel, b64] of Object.entries(files)) {
      const out = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // Skip files that already exist with the right content. The
      // tmp dir is keyed by a content hash, so any two instances
      // unpacking the same blob always write the same bytes —
      // re-extracting is pure waste, and on Windows the second
      // instance trips EBUSY trying to overwrite a .dll/.node the
      // first instance still has mapped.
      //
      // Skip the cache check for the bundle: if a stale bundle was
      // written by an earlier EXE that pointed at a different blob
      // (e.g. env dim was 1024 then changed to 4096, blob rebuilt),
      // we want this run to refresh it.
      const isBundle = pkg === "__bundle__";
      if (!isBundle && fs.existsSync(out)) {
        continue;
      }
      const text = /\.(js|cjs|mjs|json)$/i.test(rel);
      const data = text
        ? Buffer.from(b64, "base64").toString("utf8")
        : Buffer.from(b64, "base64");
      fs.writeFileSync(out, data);
    }
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
      );
    }
  }
  return baseDir;
}

const NATIVE_DIR = unpackOnce();

// Where the exe lives on disk — used to default DATABASE_FILE so the
// stdio launcher shares the same SQLite file as the main binary. End
// users don't have to set any env var; they just put both .exe in the
// same folder. EXE_BASE is the basename without .exe, used to locate
// sibling json sidecars (黑洞-mcp.native-map.json, etc.).
const EXE_DIR = path.dirname(process.execPath);
const EXE_BASE = path.basename(process.execPath, ".exe");

// Default DATABASE_FILE if the user / Trae didn't provide one. Relative
// to the install dir, so two siblings (sag.exe + sag-mcp.exe) under
// ./data/ share the DB.
if (!process.env.DATABASE_FILE) {
  process.env.DATABASE_FILE = path.join(EXE_DIR, "data", "sag.db");
}

// Default DEFAULT_TENANT_ID if not set.
if (!process.env.DEFAULT_TENANT_ID) {
  process.env.DEFAULT_TENANT_ID = "default";
}

// Auto-run SQLite migrations on first boot. The sqlite-driver opens
// the database lazily; we poke it here so the schema is in place before
// the first MCP tool call.
const dbPath = process.env.DATABASE_FILE;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Inline migration runner — no require() needed at runtime. Mirrors the
// logic in src/db/migrate.ts but compiles into the entry bundle so it
// works inside SEA. We open better-sqlite3 (already in NATIVE_MAP) and
// apply any .sql files in MIGRATIONS_DIR that aren't yet recorded in
// the __migrations table.

const MIGRATIONS_DIR = path.join(EXE_DIR, "migrations");
const migrationsMapPath = path.join(EXE_DIR, EXE_BASE + ".migrations.json");
if (!fs.existsSync(migrationsMapPath)) {
  process.stderr.write("[" + EXE_BASE + "] " + EXE_BASE + ".migrations.json missing next to " + path.basename(process.execPath) + "\\n");
  process.exit(1);
}
fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
const migrationsJson = fs.readFileSync(migrationsMapPath, "utf8");
const migrationsMap = JSON.parse(migrationsJson);
for (const [name, b64] of Object.entries(migrationsMap)) {
  fs.writeFileSync(path.join(MIGRATIONS_DIR, name), Buffer.from(b64, "base64"));
}
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
try {
  const Database = require("better-sqlite3");
  const dbPath = process.env.DATABASE_FILE;
  const migrationsDir = MIGRATIONS_DIR;
  if (dbPath) {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    const applied = new Set(db.prepare("SELECT name FROM __migrations").all().map((r) => r.name));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.prepare("INSERT INTO __migrations (name) VALUES (?)").run(f);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        process.stderr.write("[sag-mcp] migration " + f + " failed: " + e.message + "\\n");
        break;
      }
    }
    db.close();
  }
} catch (err) {
  process.stderr.write("[sag-mcp] migration warning: " + (err && err.message) + "\\n");
}

const BUNDLE_PATH = path.join(NATIVE_DIR, "__bundle_mcp__", "sag-mcp.bundle.cjs");
const bundleSource = fs.readFileSync(BUNDLE_PATH, "utf8");

const bundleModule = new Module(BUNDLE_PATH, module);
bundleModule.filename = BUNDLE_PATH;
bundleModule.paths = [path.join(NATIVE_DIR, "node_modules")];
Module._cache[bundleModule.filename] = bundleModule;
bundleModule._compile(bundleSource, BUNDLE_PATH);

// The bundle exports { startMcpServer, buildMcpServer, ... } — an esbuild
// CJS module namespace. Pull startMcpServer off it and call.
const start = bundleModule.exports && bundleModule.exports.startMcpServer;
if (typeof start === "function") {
  start().catch((err) => {
    process.stderr.write("[sag-mcp] failed to start: " + (err && err.stack || err) + "\\n");
    process.exit(1);
  });
} else {
  process.stderr.write("[sag-mcp] bundle has no startMcpServer export\\n");
  process.exit(1);
}
`;
  const entryPath = join(DIST, "sag-mcp.entry.cjs");
  writeFileSync(entryPath, entry);
  log(
    "✓ entry:",
    "dist/sag-mcp.entry.cjs",
    `(${(statSync(entryPath).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

function stepConfig() {
  const cfg = {
    main: "sag-mcp.entry.cjs",
    output: "sag-mcp.blob",
    disableExperimentalSEAWarning: true,
    resources: ["sag-mcp.bundle.cjs"],
  };
  const out = join(DIST, "sea-config-mcp.json");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  log("✓ sea-config: dist/sea-config-mcp.json");
}

function stepBlob() {
  log("sea: generating stdio blob");
  execSync("node --experimental-sea-config sea-config-mcp.json", {
    cwd: DIST,
    stdio: "inherit",
    shell: true,
  });
  const blob = join(DIST, "sag-mcp.blob");
  log(
    "✓ blob: dist/sag-mcp.blob",
    `(${(statSync(blob).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

(async () => {
  mkdirSync(DIST, { recursive: true });

  for (const f of [
    "sag-mcp.bundle.cjs",
    "sag-mcp.native-map.json",
    "sag-mcp.entry.cjs",
    "sea-config-mcp.json",
    "sag-mcp.blob",
    "migrate-runner.cjs",
  ]) {
    try { rmSync(join(DIST, f), { force: true }); } catch {}
  }

  // migrate-runner.cjs — a tiny helper that imports migrate.ts compiled
  // output and runs all pending migrations. Lives next to sag-mcp.exe so
  // it can be required without any module-path gymnastics.
  writeFileSync(
    join(DIST, "migrate-runner.cjs"),
    `'use strict';
// AUTO-GENERATED by build-stdio-launcher.mjs.
// Boot-time migration runner. Required by sag-mcp.entry.cjs so the
// SQLite schema is in place before the first MCP tool call.
const path = require("path");
const Module = require("module");

// Resolve the compile JS at dist/src/db/migrate.js. The stdio launcher's
// bundle doesn't include the migrate module (we want a tiny bundle), so
// we just shell out via process.execPath.
const { spawnSync } = require("child_process");

// Use a tiny inline migration runner: open better-sqlite3 directly and
// apply the .sql files in MIGRATIONS_DIR in lexical order, recording each
// in a __migrations table. This avoids importing the TypeScript migrate.ts
// from a CJS-only SEA bundle.
const fs = require("fs");
const Database = require("better-sqlite3");

const dbPath = process.env.DATABASE_FILE;
if (!dbPath) {
  throw new Error("DATABASE_FILE not set");
}
const dir = path.dirname(dbPath);
fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(\`CREATE TABLE IF NOT EXISTS __migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);\`);

const migrationsDir = process.env.MIGRATIONS_DIR;
if (migrationsDir && fs.existsSync(migrationsDir)) {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied = new Set(
    db.prepare("SELECT name FROM __migrations").all().map((r) => r.name),
  );
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO __migrations (name) VALUES (?)").run(f);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error("migration " + f + " failed: " + err.message);
    }
  }
}
db.close();
`
  );

  await stepBundle();
  stepNativeMap();
  stepEntry();
  stepConfig();
  stepBlob();
  log("DONE — run npm run build:stdio-launcher-exe to wrap into sag-mcp.exe.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});