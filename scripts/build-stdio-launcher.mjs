#!/usr/bin/env node
// build-stdio-launcher.mjs — Produce sag-mcp.exe, a stdio-only MCP server
// that the Trae / Claude / Cursor client can spawn directly via
// "command". End users do NOT have to start sag.exe first.
//
// Layout:
//   dist/sag-mcp.bundle.cjs                  — esbuild of src/mcp/server.ts only
//   dist/native-cache/<pkg>/<rel>            — raw native binaries
//   dist/sag-mcp.native-map.manifest.json    — index of native-cache
//   dist/sag-mcp.entry.cjs                   — bootstrap: copyFileSync natives,
//                                              runs the bundle's startMcpServer()
//   dist/sea-config-mcp.json                 — Node SEA config pointing at entry
//   dist/sag-mcp.blob                        — produced by `node --experimental-sea-config`
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
  appendFileSync,
  mkdirSync,
  rmSync,
  statSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

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
  // node-llama-cpp ships its prebuilt napi binary as a separate
  // sibling package (`@node-llama-cpp/win-x64`). Keep it external so
  // the stdio launcher can find the binary in the unpacked
  // node_modules tree at runtime, just like build-sea-bundle.mjs does
  // for the main SEA bundle.
  "node-llama-cpp",
];

// ESM externals — same as build-sea-bundle.mjs.
const EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  "onnxruntime-web",
  "@huggingface/jinja",
  // node-llama-cpp is ESM-only and uses top-level await in
  // `dist/bindings/utils/binariesGithubRelease.js`. esbuild's CJS
  // target refuses to bundle it. The plugin below handles the
  // transitive `@node-llama-cpp/*` namespace (the platform-specific
  // sub-packages), which is the actual source of the
  // "Top-level await is currently not supported with the cjs output
  // format" error.
  "node-llama-cpp",
  "@node-llama-cpp/*",
];

function log(...args) {
  console.log("[stdio-build]", ...args);
}

async function stepBundle() {
  log("esbuild: bundling src/mcp/server.ts only");
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
    plugins: [externalPlugin],
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
        if (ent.name === "test" || ent.name === "__tests__") continue;
        // Descend into EVERY nested node_modules package — mirroring
        // build-sea-bundle.mjs's walkModule. Without this, nested
        // installs like @xenova/transformers/node_modules/sharp
        // (sharp@0.32, which requires "color") never reach the cache,
        // and the embedding worker dies with MODULE_NOT_FOUND at
        // runtime (2026-10-27, v2).
        if (ent.name === "node_modules") {
          let sub;
          try { sub = readdirSync(full, { withFileTypes: true }); } catch { continue; }
          for (const subEnt of sub) {
            if (!subEnt.isDirectory() || subEnt.name.startsWith(".")) continue;
            walk(join(full, subEnt.name));
          }
          continue;
        }
        // Same llama filter as the backend: only JSON/LICENSE files,
        // never the llama.cpp source tree.
        if (ent.name === "llama") {
          let llEnts;
          try { llEnts = readdirSync(full, { withFileTypes: true }); } catch { continue; }
          for (const ll of llEnts) {
            if (ll.isFile() && (/\.json$/i.test(ll.name) || /^license/i.test(ll.name))) {
              const llFull = join(full, ll.name);
              out.set(relative(pkgDir, llFull), readFileSync(llFull));
            }
          }
          continue;
        }
        walk(full);
      } else if (ent.isFile()) {
        if (/\.(node|dll|so|dylib|bin|dat|onnx|json|js|cjs|mjs|wasm)$/i.test(ent.name)) {
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
  // Mirror build-sea-bundle.mjs's raw-binary layout: write each
  // native file into dist/native-cache/<pkg>/<rel> and emit a tiny
  // manifest sidecar. Avoids the V8 512 MB single-string ceiling
  // that the old single-JSON base64 map blew up against.
  const cacheDir = join(DIST, "native-cache");
  // Do NOT wipe: in the full release chain build-sea-bundle.mjs runs
  // FIRST and has already built the complete cache (nested node_modules
  // walk + the backend's full manifest). The old wipe-and-rebuild left
  // the cache PARTIAL — most notably dropping
  // @xenova/transformers/node_modules/sharp — while the backend
  // manifest still listed the full file set, so the runtime background
  // unpack hit ENOENT and the embedding worker died with
  // "Cannot find module 'color'" (2026-10-27, v2). Merge instead:
  // add only files that are missing (same node_modules source, so an
  // existing file is byte-identical).
  mkdirSync(cacheDir, { recursive: true });
  const manifest = { __root__: cacheDir, packages: {} };
  let totalBytes = 0;
  // Skip the GPU runtime packages (CUDA / Vulkan) — 0.60 GB of the
  // payload that most installs never touch. See the same block in
  // build-sea-bundle.mjs for the full rationale.
  const includeGpuPackages = process.env.SAG_INCLUDE_GPU_PACKAGES === "1";
  const GPU_PACKAGE_RE = /(^|\/)(win|linux|macos)-(x64|arm64)-(cuda|cuda-ext|vulkan)(\/|$)/;
  const seenDeps = new Set(allNativeDeps);
  // Index-based loop: the body may APPEND newly discovered nested deps.
  for (let depIdx = 0; depIdx < allNativeDeps.length; depIdx++) {
    const pkg = allNativeDeps[depIdx];
    if (!includeGpuPackages && GPU_PACKAGE_RE.test(pkg)) {
      log(`  - skipping GPU package (${pkg})`);
      continue;
    }
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
      // Merge mode (see above): never clobber a file the backend's
      // build already wrote — same node_modules source, same bytes.
      if (!existsSync(outPath)) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, buf);
        totalBytes += buf.length;
      }
      pkgMap[rel] = rel;
    }
    manifest.packages[pkg] = pkgMap;
    // Nested installs bundled inside this package (e.g.
    // @xenova/transformers/node_modules/sharp@0.32) can declare deps
    // the ROOT install doesn't have (color, simple-get, tar-fs…).
    // Their package.json files ride along in the walk above; union
    // their dependency names into the walk list so the manifest
    // carries them too — otherwise the nested copy SHADOWS the
    // top-level one at runtime (Node resolves the nested copy first)
    // and dies with "Cannot find module 'color'" (2026-10-27).
    for (const [rel, buf] of files) {
      if (!/(^|[\\/])package\.json$/.test(rel)) continue;
      let nestedJson;
      try { nestedJson = JSON.parse(buf.toString("utf8")); } catch { continue; }
      for (const dep of [
        ...Object.keys(nestedJson.dependencies || {}),
        ...Object.keys(nestedJson.optionalDependencies || {}),
      ]) {
        if (!seenDeps.has(dep)) {
          seenDeps.add(dep);
          allNativeDeps.push(dep);
        }
      }
    }
  }
  const bundlePath = join(DIST, "sag-mcp.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    const bundleDir = join(cacheDir, "__bundle__");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "sag-mcp.bundle.cjs"), bundleBuf);
    manifest.__bundle__ = "__bundle__/sag-mcp.bundle.cjs";
    totalBytes += bundleBuf.length;
    log("  + bundled sag-mcp.bundle.cjs");
  }
  // Chalk shim — same as build-sea-bundle.mjs. node-llama-cpp pulls
  // in chalk@5 (ESM-only); the SEA host runs everything through
  // CommonJS, so require('chalk') throws. Swap the v5 install
  // under node-llama-cpp/node_modules/chalk with a CJS-compatible
  // v4 copy from ora/node_modules/chalk.
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
    // Also overwrite the top-level `native-cache/chalk/` so module
    // resolution from inside the unpacked node-llama-cpp finds v4
    // before walking up to a parent v5.
    const chalkTopDst = join(cacheDir, "chalk");
    try { rmSync(chalkTopDst, { recursive: true, force: true }); } catch {}
    copyDirRobustChalk(chalkSrc, chalkTopDst);
    log("  + chalk v4 shim → native-cache/chalk/ (top-level)");
  }
  // The chalk shim replaced v5 files with the v4 copy AFTER the
  // package walk above recorded the v5 file list. Re-walk the shimmed
  // dirs so the manifest matches what's actually on disk — otherwise
  // the runtime unpacker logs ENOENT for every phantom v5 file
  // (user-visible as "[sag-mcp] copyFileSync failed for
  // chalk/source/utilities.js …" warnings on first boot).
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
  const manifestPath = join(DIST, "sag-mcp.native-map.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 0));
  log("  + manifest: dist/sag-mcp.native-map.manifest.json",
    `(${(statSync(manifestPath).size / 1024).toFixed(1)} KB)`);
  log(
    "✓ native-cache: dist/native-cache/",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked across ${Object.keys(manifest.packages).length} package(s))`,
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

  // Note: we used to `readFileSync(sag-mcp.native-map.json, "utf8")`
  // here so the entry could inline it. With node-llama-cpp added to
  // the externals, the base64 payload exceeds V8's 512 MB
  // single-string limit and the inlining crashed with
  // "Cannot create a string longer than 0x1fffffe8 characters". The
  // runtime now reads sag-mcp.native-map.json from disk at startup
  // (see the runtime block below) — the entry just needs to live
  // next to the .exe as a sibling file, exactly like SAG-backend's
  // SAG-backend.native-map.json sibling.

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
  // Read the manifest sidecar next to the exe (a few hundred KB).
  // The actual native binaries live under
  // exeDir/native-cache/<pkg>/<rel> as raw files (no base64) so
  // we can copyFileSync them straight into the per-machine
  // sandbox dir without ever inflating them into a V8 string. This
  // is the fix for the startup crash the old base64-JSON map hit
  // when node-llama-cpp pulled in 1.4 GB of native binaries.
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
  const sig = crypto
    .createHash("sha256")
    .update(manifestJson)
    .digest("hex")
    .slice(0, 12);
  const baseDir = path.join(os.tmpdir(), "sag-sea-native-" + sig);
  fs.mkdirSync(baseDir, { recursive: true });
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle_mcp__");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  // Fingerprint-based force-re-unpack: when the build script
  // patches packages (e.g. chalk v4 shim), the manifest's
  // __fingerprint__ changes but the file list doesn't. We
  // re-unpack the packages in PATCHED_PKGS whenever the
  // fingerprint diverges from the one we wrote on the last boot.
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
    for (const [rel, cachedRel] of Object.entries(files)) {
      const out = path.join(pkgDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // Skip files that already exist unless the manifest's
      // fingerprint changed (which means the build script swapped
      // files in the source cache after a prior boot, e.g. the
      // chalk v4 shim that replaces chalk@5). We always force-
      // re-unpack PATCHED_PKGS regardless of the fingerprint, so a
      // previous boot's v5 install doesn't stick around and break
      // the next boot's v4 require().
      const isPatched = PATCHED_PKGS.has(pkg);
      if (fs.existsSync(out) && !isPatched) {
        continue;
      }
      const src = path.join(sourceCacheDir, pkg, cachedRel);
      try {
        fs.copyFileSync(src, out);
      } catch (err) {
        // AV scanners on Windows occasionally hold a transient
        // lock on a .dll/.node file; skip rather than crash.
        console.warn("[" + exeBase + "] copyFileSync failed for", src, "—", err.message);
      }
    }
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
      );
    }
  }
  // Stage the bundle next to the unpacked natives so the entry's
  // BUNDLE_PATH lookup finds it. The manifest pins which cached
  // path holds the bundle (vs. the package files above).
  if (MANIFEST.__bundle__) {
    const bundleSrc = path.join(sourceCacheDir, MANIFEST.__bundle__);
    const bundleDst = path.join(bundleDir, "sag-mcp.bundle.cjs");
    if (!fs.existsSync(bundleDst)) {
      try {
        fs.copyFileSync(bundleSrc, bundleDst);
      } catch (err) {
        // Not wrapped by the per-package try/catch above; fail with an
        // actionable message instead of a raw ENOENT stack. Seen in
        // the field: a zip built without __bundle__/sag-mcp.bundle.cjs
        // crashed every mcp launch with an opaque copyfile error.
        process.stderr.write(
          "[" + exeBase + "] FATAL: cannot stage sag-mcp.bundle.cjs" + String.fromCharCode(10) +
          "[" + exeBase + "]   source: " + bundleSrc + String.fromCharCode(10) +
          "[" + exeBase + "]   reason: " + (err && err.message ? err.message : String(err)) + String.fromCharCode(10) +
          "[" + exeBase + "]   fix: re-unzip the portable package, or copy sag-mcp.bundle.cjs into resources/native-cache/__bundle__/ from the distribution." + String.fromCharCode(10),
        );
        process.exit(1);
      }
    }
  }
  // Persist the build fingerprint so the next boot detects
  // divergence and force-re-unpacks patched packages.
  if (MANIFEST.__fingerprint__) {
    fs.writeFileSync(fingerprintPath, MANIFEST.__fingerprint__);
  }
  return baseDir;
}

const NATIVE_DIR = unpackOnce();

// Where the exe lives on disk — used to default DATABASE_FILE so the
// stdio launcher shares the same SQLite file as the main binary. End
// users don't have to set any env var; they just put both .exe in the
// same folder. EXE_BASE is the basename without .exe, used to locate
// sibling json sidecars (SAG-mcp.native-map.json, etc.).
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
  // Match host node major with the Windows Node binary we ship in
  // the final .exe (see SAG_SEA_NODE_EXE in build-sea-bundle.mjs).
  const nodeExe = process.env.SAG_SEA_NODE_EXE || "node";
  log(`sea: generating stdio blob via ${nodeExe}`);
  // execFileSync (not execSync with shell:true): the project path
  // contains CJK characters and cmd.exe cannot parse them, so the
  // shell form failed with "The system cannot find the path specified"
  // even though the very same command worked from PowerShell.
  execFileSync(resolve(nodeExe), ["--experimental-sea-config", resolve(DIST, "sea-config-mcp.json")], {
    cwd: resolve(DIST),
    stdio: "inherit",
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
  stepNativeCache();
  stepEntry();
  stepConfig();
  stepBlob();
  log("DONE — run npm run build:stdio-launcher-exe to wrap into sag-mcp.exe.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});