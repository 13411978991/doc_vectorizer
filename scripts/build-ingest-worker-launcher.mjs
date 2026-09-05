#!/usr/bin/env node
// build-ingest-worker-launcher.mjs — Produce 黑洞-ingest-worker.exe, a
// separate OS process that runs ONLY the embedding worker loop.
//
// Why a separate process? Inside a single Node process the
// chunking / embedding / event extraction stages all fight for the
// main thread. When the watcher is ingesting file N+1 the
// embedding-worker can only run on the gaps. Splitting the worker
// into its own process lets it run truly in parallel: while the
// watcher is busy parsing xlsx on file 5, the worker is finishing
// the embeddings of file 4.
//
// Layout mirrors build-stdio-launcher.mjs but:
//   - bundle entry: dist/src/workers/ingest-worker-entry.js
//   - exe name:    黑洞-ingest-worker.exe
//   - no MCP server, no HTTP server, no watcher — just the loop
//   - shares DATABASE_FILE with the parent (resolved relative to
//     install dir) so both processes hit the same SQLite file
//
// Parent (黑洞.exe) spawns this on startup. Disable with
// EMBEDDING_WORKER_SEPARATE_PROCESS=0.

import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");

// Same native deps as the main sag.exe — the worker uses
// better-sqlite3 to read the chunks table and needs the ONNX
// runtime to forward embeddings. sharp is a transitive dep of
// @xenova/transformers' image utils (the workers' dynamic import
// of @xenova/transformers pulls it in even if we don't use it).
const NATIVE_DEPS = [
  "better-sqlite3",
  "sqlite-vec",
  "onnxruntime-node",
  "sharp",
  "bindings",
];
const EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  "onnxruntime-web",
  "@huggingface/jinja",
];

function log(...args) {
  console.log("[ingest-worker-build]", ...args);
}

async function stepBundle() {
  log("esbuild: bundling src/workers/ingest-worker-entry.ts");
  await build({
    entryPoints: [join(DIST, "src/workers/ingest-worker-entry.js")],
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
    outfile: join(DIST, "sag-ingest-worker.bundle.cjs"),
    logLevel: "info",
    banner: {
      js: [
        "// SAG ingest-worker bundle — runs only the embedding loop.",
        'var import_meta_url = require("url").pathToFileURL(__filename).href;',
      ].join("\n"),
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  log(
    "✓ bundle:",
    "dist/sag-ingest-worker.bundle.cjs",
    `(${(statSync(join(DIST, "sag-ingest-worker.bundle.cjs")).size / 1024 / 1024).toFixed(2)} MB)`,
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
  const bundlePath = join(DIST, "sag-ingest-worker.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    map["__bundle__"] = {
      "sag-ingest-worker.bundle.cjs": bundleBuf.toString("base64"),
      "__root__": DIST,
    };
    totalBytes += bundleBuf.length;
    log("  + bundled sag-ingest-worker.bundle.cjs");
  }
  const out = join(DIST, "sag-ingest-worker.native-map.json");
  writeFileSync(out, JSON.stringify(map));
  log(
    "✓ native-map:",
    "dist/sag-ingest-worker.native-map.json",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked)`,
  );
}

function stepEntry() {
  log("entry: writing");

  const migrationsSrcDir = join(ROOT, "src/db/sqlite/migrations");
  const migrationsMap = {};
  if (existsSync(migrationsSrcDir)) {
    for (const f of readdirSync(migrationsSrcDir)) {
      if (f.endsWith(".sql")) {
        migrationsMap[f] = readFileSync(join(migrationsSrcDir, f)).toString("base64");
      }
    }
  }
  writeFileSync(join(DIST, "sag-ingest-worker.migrations.json"), JSON.stringify(migrationsMap));
  log("✓ sag-ingest-worker.migrations.json written");

  const entry = `// AUTO-GENERATED by build-ingest-worker-launcher.mjs. Do not edit.
// SAG ingest-worker SEA bootstrap. Spawned by 黑洞.exe on startup
// so the embedding loop runs in its own process and doesn't fight
// the main thread for CPU during a heavy watcher ingest.
//
// Entry point: dist/src/workers/ingest-worker-entry.js — calls
// startEmbeddingWorkerLoop() which is the same loop the parent
// would have run in-process before this split. Behaviour and
// logging are identical; the only difference is the OS process.
"use strict";

// DOMMatrix / Path2D polyfill — same rationale as build-sea-bundle.mjs.
// pdfjs's top-level expressions need DOMMatrix on Windows.
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

// Always-on log redirection. The worker .exe is launched with its
// stdout/stderr going through a pipe (we capture the parent's view
// via process.stderr / process.stdout in start-child). We also
// mirror to <exe-dir>/ingest-worker.log so when the user runs the
// .exe by hand (debugging) the log is on disk in a predictable
// spot. The parent doesn't rely on this file — it forwards the
// child's stdout/stderr to its own sd-out.log/sd-err.log.
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");
const crypto = require("crypto");

(function setupLogTees() {
  const EXE_DIR_LOGS = path.dirname(process.execPath);
  const outLogPath = path.join(EXE_DIR_LOGS, "ingest-worker.log");
  try {
    if (!fs.fstatSync(1).isFile()) {
      const outFd = fs.openSync(outLogPath, "a");
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        try { fs.writeSync(outFd, chunk); } catch {}
        return origStdoutWrite(chunk, ...rest);
      };
      try {
        origStdoutWrite(
          "[ingest-worker-boot] stdout tee -> " + outLogPath + " (pid=" + process.pid + ")" + String.fromCharCode(10)
        );
      } catch {}
    }
  } catch (err) {
    // best-effort
  }
})();

function unpackOnce() {
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const mapPath = path.join(exeDir, exeBase + ".native-map.json");
  if (!fs.existsSync(mapPath)) {
    process.stderr.write(
      "[" + exeBase + "] " + exeBase + ".native-map.json missing next to " + path.basename(process.execPath) + String.fromCharCode(10) +
      "[" + exeBase + "] expected at: " + mapPath + String.fromCharCode(10),
    );
    process.exit(1);
  }
  const mapJson = fs.readFileSync(mapPath, "utf8");
  const NATIVE_MAP = JSON.parse(mapJson);
  const sig = crypto.createHash("sha256").update(mapJson).digest("hex").slice(0, 12);
  const baseDir = path.join(os.tmpdir(), "sag-sea-native-iw-" + sig);
  fs.mkdirSync(baseDir, { recursive: true });
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle_iw__");
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
      if (fs.existsSync(out)) continue;
      const text = /\\.(js|cjs|mjs|json)$/i.test(rel);
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

const EXE_DIR = path.dirname(process.execPath);
const EXE_BASE = path.basename(process.execPath, ".exe");

if (!process.env.DATABASE_FILE) {
  process.env.DATABASE_FILE = path.join(EXE_DIR, "data", "sag.db");
}
if (!process.env.DEFAULT_TENANT_ID) {
  process.env.DEFAULT_TENANT_ID = "default";
}

const dbPath = process.env.DATABASE_FILE;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const MIGRATIONS_DIR = path.join(EXE_DIR, "migrations");
const migrationsMapPath = path.join(EXE_DIR, EXE_BASE + ".migrations.json");
if (!fs.existsSync(migrationsMapPath)) {
  // Migrations map missing is non-fatal: the parent already ran
  // them, and the worker only reads. But for fresh installs we'd
  // hit a missing chunks table — bail with a clear error.
  process.stderr.write("[" + EXE_BASE + "] " + EXE_BASE + ".migrations.json missing next to " + path.basename(process.execPath) + String.fromCharCode(10));
  process.exit(1);
}
fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
const migrationsJson = fs.readFileSync(migrationsMapPath, "utf8");
const migrationsMap = JSON.parse(migrationsJson);
for (const [name, b64] of Object.entries(migrationsMap)) {
  const target = path.join(MIGRATIONS_DIR, name);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, Buffer.from(b64, "base64"));
  }
}
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;
// Migrations are run by the parent (黑洞.exe) on startup; the
  // worker just reads. We don't open the DB here at all — the
  // bundle's getPool() opens it on first use, and that's where
  // the unpacked node_modules tree is in module.paths.
  // Opening here would force us to require() better-sqlite3 from
  // the entry, and the entry's module.paths is empty under SEA.
  process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;

const BUNDLE_PATH = path.join(NATIVE_DIR, "__bundle_iw__", "sag-ingest-worker.bundle.cjs");
const bundleSource = fs.readFileSync(BUNDLE_PATH, "utf8");

const bundleModule = new Module(BUNDLE_PATH, module);
bundleModule.filename = BUNDLE_PATH;
bundleModule.paths = [path.join(NATIVE_DIR, "node_modules")];
Module._cache[bundleModule.filename] = bundleModule;
bundleModule._compile(bundleSource, BUNDLE_PATH);

const start = bundleModule.exports && bundleModule.exports.main;
if (typeof start === "function") {
  start().catch((err) => {
    process.stderr.write("[ingest-worker] failed to start: " + (err && err.stack || err) + String.fromCharCode(10));
    process.exit(1);
  });
} else {
  process.stderr.write("[ingest-worker] bundle has no main export" + String.fromCharCode(10));
  process.exit(1);
}
`;
  const entryPath = join(DIST, "sag-ingest-worker.entry.cjs");
  writeFileSync(entryPath, entry);
  log(
    "✓ entry:",
    "dist/sag-ingest-worker.entry.cjs",
    `(${(statSync(entryPath).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

function stepConfig() {
  const cfg = {
    main: "sag-ingest-worker.entry.cjs",
    output: "sag-ingest-worker.blob",
    disableExperimentalSEAWarning: true,
    resources: ["sag-ingest-worker.bundle.cjs"],
  };
  const out = join(DIST, "sea-config-iw.json");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  log("✓ sea-config: dist/sea-config-iw.json");
}

function stepSeaBlob() {
  log("sea: generating ingest-worker blob");
  // SEA blob generation uses the host node binary, but we want to
  // inject into a copy of the same node.exe that the main build
  // uses. Reuse the path the stdio launcher build captured.
  const nodeExe = process.execPath;
  // node --experimental-sea-config reads sea-config-iw.json
  execSync(
    '"' + nodeExe + '" --experimental-sea-config sea-config-iw.json',
    { cwd: DIST, stdio: "inherit" }
  );
  log("✓ blob: dist/sag-ingest-worker.blob");
}

async function main() {
  mkdirSync(DIST, { recursive: true });
  await stepBundle();
  stepNativeMap();
  stepEntry();
  stepConfig();
  stepSeaBlob();
  log("DONE — run npm run build:ingest-worker-exe to wrap into 黑洞-ingest-worker.exe.");
}

main().catch((err) => {
  console.error("[ingest-worker-build]", err);
  process.exit(1);
});