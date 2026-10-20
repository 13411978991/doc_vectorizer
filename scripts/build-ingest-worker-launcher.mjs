#!/usr/bin/env node
// build-ingest-worker-launcher.mjs — Produce SAG-ingest-worker.exe, a
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
//   - exe name:    SAG-ingest-worker.exe
//   - no MCP server, no HTTP server, no watcher — just the loop
//   - shares DATABASE_FILE with the parent (resolved relative to
//     install dir) so both processes hit the same SQLite file
//
// Parent (SAG-backend.exe) spawns this on startup. Disable with
// EMBEDDING_WORKER_SEPARATE_PROCESS=0.

import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
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
  // node-llama-cpp is reachable from `aiSettingsService` (which
  // exports `getLoadedLocalLlmInfo`). The ingest worker doesn't
  // actually call into the LLM, but it transitively imports
  // local-llm-client to satisfy the type, and that file imports
  // node-llama-cpp. Without this entry the bundled worker would
  // crash on first call to `getAiProviderSettings` with a
  // "Cannot find module 'node-llama-cpp'" error.
  "node-llama-cpp",
];
const EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  "onnxruntime-web",
  "@huggingface/jinja",
  "node-llama-cpp",
  "@node-llama-cpp/*",
];

function log(...args) {
  console.log("[ingest-worker-build]", ...args);
}

async function stepBundle() {
  log("esbuild: bundling src/workers/ingest-worker-entry.ts");
  // Same onResolve plugin trick as build-sea-bundle.mjs — esbuild's
  // `external` field doesn't accept glob patterns, so we use a regex
  // filter to mark every `@node-llama-cpp/*` path as external and
  // avoid the top-level-await parse error in the platform sub-package.
  const externalPlugin = {
    name: "sag-external-glob",
    setup(build) {
      build.onResolve({ filter: /@node-llama-cpp\// }, (args) => {
        if (args.path.startsWith("@node-llama-cpp/")) return { external: true };
        return null;
      });
    }
  };
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
    plugins: [externalPlugin],
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

function stepNativeCache() {
  const allNativeDeps = [
    ...collectNativeDeps(NATIVE_DEPS, new Set(), true),
    ...EXTERNAL_ESM_DEPS
  ];
  log("native-cache: walking", allNativeDeps.join(", "));
  // Mirror the build-sea-bundle.mjs / build-stdio-launcher.mjs
  // raw-binary layout: write each native file into
  // dist/native-cache/<pkg>/<rel> and emit a tiny manifest. Avoids
  // the V8 512 MB single-string ceiling the old base64-JSON map
  // blew up against (especially with node-llama-cpp added).
  const cacheDir = join(DIST, "native-cache");
  if (existsSync(cacheDir)) rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const manifest = { __root__: cacheDir, packages: {} };
  let totalBytes = 0;
  for (const pkg of allNativeDeps) {
    const pkgDir = join(ROOT, "node_modules", pkg);
    if (!existsSync(pkgDir)) {
      log(`  ! ${pkg} not installed — runtime will skip`);
      continue;
    }
    const files = walkModule(pkgDir);
    if (files.size === 0) {
      manifest.packages[pkg] = {};
      continue;
    }
    const pkgMap = {};
    for (const [rel, buf] of files) {
      const outPath = join(cacheDir, pkg, rel);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      pkgMap[rel] = rel;
      totalBytes += buf.length;
    }
    manifest.packages[pkg] = pkgMap;
  }
  const bundlePath = join(DIST, "sag-ingest-worker.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    const bundleDir = join(cacheDir, "__bundle__");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "sag-ingest-worker.bundle.cjs"), bundleBuf);
    manifest.__bundle__ = "__bundle__/sag-ingest-worker.bundle.cjs";
    totalBytes += bundleBuf.length;
    log("  + bundled sag-ingest-worker.bundle.cjs");
  }
  // Chalk shim — same as build-sea-bundle.mjs. node-llama-cpp
  // pulls in chalk@5 (ESM-only); the SEA host runs everything
  // through CommonJS, so require('chalk') throws. Swap the v5
  // install under node-llama-cpp/node_modules/chalk with a
  // CJS-compatible v4 copy from ora/node_modules/chalk.
  const chalkSrc = join(ROOT, "node_modules", "ora", "node_modules", "chalk");
  const chalkDst = join(cacheDir, "node-llama-cpp", "node_modules", "chalk");
  mkdirSync(dirname(chalkDst), { recursive: true });
  if (existsSync(chalkSrc)) {
    function copyDirRobustChalk(src, dst) {
      mkdirSync(dst, { recursive: true });
      for (const ent of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, ent.name);
        const d = join(dst, ent.name);
        if (ent.isDirectory()) copyDirRobustChalk(s, d);
        else if (ent.isFile()) {
          try { copyFileSync(s, d); } catch { /* AV lock — skip */ }
        }
      }
    }
    try { rmSync(chalkDst, { recursive: true, force: true }); } catch {}
    copyDirRobustChalk(chalkSrc, chalkDst);
    log("  + chalk v4 shim → native-cache/node-llama-cpp/node_modules/chalk/");
    const chalkTopDst = join(cacheDir, "chalk");
    try { rmSync(chalkTopDst, { recursive: true, force: true }); } catch {}
    copyDirRobustChalk(chalkSrc, chalkTopDst);
    log("  + chalk v4 shim → native-cache/chalk/ (top-level)");
  }
  // The chalk shim replaced v5 files with the v4 copy AFTER the
  // package walk above recorded the v5 file list. Re-walk the shimmed
  // dirs so the manifest matches what's actually on disk — otherwise
  // the runtime unpacker logs ENOENT for every phantom v5 file.
  for (const shimKey of ["chalk", "node-llama-cpp/node_modules/chalk"]) {
    const shimDir = join(cacheDir, shimKey);
    if (existsSync(shimDir) && manifest.packages[shimKey]) {
      const rewalked = walkModule(shimDir);
      const pkgMap = {};
      for (const [rel] of rewalked) pkgMap[rel] = rel;
      manifest.packages[shimKey] = pkgMap;
    }
  }
  // Manifest is written LAST, after every post-walk patch (chalk shim),
  // so it always describes the final on-disk state.
  const manifestPath = join(DIST, "sag-ingest-worker.native-map.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 0));
  log("  + manifest: dist/sag-ingest-worker.native-map.manifest.json",
    `(${(statSync(manifestPath).size / 1024).toFixed(1)} KB)`);
  log(
    "✓ native-cache: dist/native-cache/",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked across ${Object.keys(manifest.packages).length} package(s))`,
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
// SAG ingest-worker SEA bootstrap. Spawned by SAG.exe on startup
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
  // Read the manifest sidecar (a few hundred KB) + raw-binary tree
  // from exeDir/native-cache/. Same approach as build-sea-bundle.mjs
  // / build-stdio-launcher.mjs — see the comments there for why we
  // moved away from a single base64 JSON map.
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const manifestPath = path.join(exeDir, exeBase + ".native-map.manifest.json");
  const sourceCacheDir = path.join(exeDir, "native-cache");
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(
      "[" + exeBase + "] " + exeBase + ".native-map.manifest.json missing next to " + path.basename(process.execPath) + String.fromCharCode(10) +
      "[" + exeBase + "] expected at: " + manifestPath + String.fromCharCode(10),
    );
    process.exit(1);
  }
  if (!fs.existsSync(sourceCacheDir)) {
    process.stderr.write(
      "[" + exeBase + "] native-cache/ dir missing next to " + path.basename(process.execPath) + String.fromCharCode(10) +
      "[" + exeBase + "] expected at: " + sourceCacheDir + String.fromCharCode(10),
    );
    process.exit(1);
  }
  const manifestJson = fs.readFileSync(manifestPath, "utf8");
  const MANIFEST = JSON.parse(manifestJson);
  const sig = crypto.createHash("sha256").update(manifestJson).digest("hex").slice(0, 12);
  const baseDir = path.join(os.tmpdir(), "sag-sea-native-iw-" + sig);
  fs.mkdirSync(baseDir, { recursive: true });
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle_iw__");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  // Fingerprint-based force-re-unpack: see build-sea-bundle.mjs
  // for the rationale. When the build script patches a package
  // (e.g. the chalk v4 shim that replaces chalk@5), the manifest's
  // __fingerprint__ changes but the file list doesn't. Without this
  // check, if (fs.existsSync(out)) continue; below would skip the
  // v4 file and the runtime would still load v5 (which throws
  // "chalk.blue is not a function" at the first llama.cpp status
  // log).
  const fingerprintPath = path.join(baseDir, ".fingerprint");
  let forceReUnpack = false;
  if (MANIFEST.__fingerprint__) {
    if (fs.existsSync(fingerprintPath)) {
      const prev = fs.readFileSync(fingerprintPath, "utf8");
      if (prev !== MANIFEST.__fingerprint__) forceReUnpack = true;
    } else {
      forceReUnpack = true;
    }
  }
  const PATCHED_PKGS = new Set([
    "chalk",
    "node-llama-cpp/node_modules/chalk",
  ]);

  for (const [pkg, files] of Object.entries(MANIFEST.packages || {})) {
    const pkgDir = path.join(nodeModulesDir, pkg);
    fs.mkdirSync(pkgDir, { recursive: true });
    const isPatched = PATCHED_PKGS.has(pkg);
    for (const [rel, cachedRel] of Object.entries(files)) {
      const out = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (fs.existsSync(out) && !isPatched) continue;
      const src = path.join(sourceCacheDir, pkg, cachedRel);
      try {
        fs.copyFileSync(src, out);
      } catch (err) {
        console.warn("[ingest-worker] copyFileSync failed for", src, "—", err.message);
      }
    }
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
      );
    }
  }
  if (MANIFEST.__bundle__) {
    const bundleSrc = path.join(sourceCacheDir, MANIFEST.__bundle__);
    const bundleDst = path.join(bundleDir, "sag-ingest-worker.bundle.cjs");
    if (!fs.existsSync(bundleDst)) {
      fs.copyFileSync(bundleSrc, bundleDst);
    }
  }
  if (MANIFEST.__fingerprint__) {
    fs.writeFileSync(fingerprintPath, MANIFEST.__fingerprint__);
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
// Migrations are run by the parent (SAG.exe) on startup; the
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
  stepNativeCache();
  stepEntry();
  stepConfig();
  stepSeaBlob();
  log("DONE — run npm run build:ingest-worker-exe to wrap into SAG-ingest-worker.exe.");
}

main().catch((err) => {
  console.error("[ingest-worker-build]", err);
  process.exit(1);
});