#!/usr/bin/env node
// build-sea-bundle.mjs — Produce a Node SEA-ready single CJS that ships
// its native modules inline.
//
// Layout of the output:
//   dist/sag.bundle.cjs        — esbuild output, native modules marked external
//   dist/sag.native-map.json   — base64-encoded contents of every non-source
//                                file under each native module
//   dist/sag.entry.cjs         — bootstrap: decodes natives into a stable
//                                tmp dir, patches Module._resolveFilename,
//                                loads sag.bundle.cjs
//   dist/sea-config.json       — points Node's SEA at sag.entry.cjs
//   dist/sag.blob              — the SEA blob produced by `node
//                                --experimental-sea-config sea-config.json`
//
// Run via:  npm run build:sea-bundle

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
import { argv } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");

// Native packages we keep external from esbuild so the bundler doesn't try
// to inline their gyp-driven .node files. At runtime we extract them to a
// stable per-machine tmp dir and patch require() to find them.
const DEFAULT_NATIVE_DEPS = [
  "better-sqlite3",
  "sqlite-vec",
  "onnxruntime-node",
  "sharp",
  "bindings",
];
// ESM packages that don't bundle cleanly under esbuild's CJS target —
// keep them external so the SEA runtime resolves them through Node's
// standard node_modules path, which means only one transformers env
// object exists (shared across the embedding client and the package
// internals). Without this, esbuild's IIFE wrapping separates the
// inner `env` getter from the import-side binding, so runtime config
// changes don't reach the pipeline.
const DEFAULT_EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  // transformers.js depends on these as direct deps. Copy them next
  // to transformers in the native-map so the ESM resolver finds them
  // when transformers' modules load.
  "onnxruntime-web",
  "@huggingface/jinja",
];
const BUNDLE_DEPS = ["__bundle__"];

function log(...args) {
  console.log("[sea-build]", ...args);
}

function pickDeps() {
  const flag = argv.indexOf("--include");
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1].split(",");
  return DEFAULT_NATIVE_DEPS;
}

const NATIVE_DEPS = pickDeps();

// Step 1: esbuild bundle with native modules kept external.
async function stepBundle() {
  log("esbuild: bundling with native externals →", NATIVE_DEPS.join(", "));
  await build({
    entryPoints: [join(DIST, "src/index.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: [
      ...NATIVE_DEPS,
      ...DEFAULT_EXTERNAL_ESM_DEPS,
      "pg-native",
      "sharp",
      "@embedded-postgres/*",
    ],
    outfile: join(DIST, "sag.bundle.cjs"),
    logLevel: "info",
    banner: {
      js: [
        "// SAG esbuild bundle — bootstrapped by sag.entry.cjs at runtime.",
        'var import_meta_url = require("url").pathToFileURL(__filename).href;',
      ].join("\n"),
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  log(
    "✓ bundle:",
    "dist/sag.bundle.cjs",
    `(${(statSync(join(DIST, "sag.bundle.cjs")).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

// Step 2: walk each native module dir, base64 every binary / JS file into
// a single JSON map. We deliberately skip dev-only test directories to
// keep the payload small.
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
  // Native deps get their full transitive native tree walked.
  // ESM packages we kept external in esbuild still need to live
  // somewhere the SEA bundle's require() can find them; otherwise the
  // bundle's `require("@xenova/transformers")` would resolve to nothing.
  const allNativeDeps = [
    ...collectNativeDeps(NATIVE_DEPS, new Set(), true),
    ...DEFAULT_EXTERNAL_ESM_DEPS
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
  const bundlePath = join(DIST, "sag.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    // __bundle__ stays in the native-map so unpackOnce() writes the
    // bundle bytes into %TEMP%/<sig>/__bundle__/sag.bundle.cjs. The base64
    // payload here is now just the bundle itself — NOT the whole map.
    map["__bundle__"] = {
      "sag.bundle.cjs": bundleBuf.toString("base64"),
      "__root__": DIST,
    };
    totalBytes += bundleBuf.length;
    log("  + bundled sag.bundle.cjs");
  }
  // Stage the embedding-worker bundle alongside the main bundle so
  // `new Worker(workerPath)` has a real file path to spawn. The
  // worker uses the same externals as the main bundle (better-sqlite3,
  // onnxruntime-node, transformers), so it resolves through the
  // unpacked node_modules tree.
  const workerPath = join(DIST, "sag.embedding-worker.cjs");
  if (existsSync(workerPath)) {
    const workerBuf = readFileSync(workerPath);
    map["__bundle__"] = map["__bundle__"] || { __root__: DIST };
    map["__bundle__"]["sag.embedding-worker.cjs"] = workerBuf.toString("base64");
    totalBytes += workerBuf.length;
    log("  + bundled sag.embedding-worker.cjs");
  }
  const out = join(DIST, "sag.native-map.json");
  writeFileSync(out, JSON.stringify(map));
  log(
    "✓ native-map:",
    "dist/sag.native-map.json",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked)`,
  );
}

// Step 3: write the SEA entry CJS. Embedding happens in a single template
// literal; the native map is JSON-encoded so the entry stays plain JS.
async function stepWorkerBundle() {
  // Stage the embedding-worker source next to sag.bundle.cjs so the
  // Worker constructor has a real file path to spawn. The worker
  // runs ONNX in isolation so the main Node process / HTTP server
  // / watcher stays responsive during heavy embedding batches.
  // esbuild bundles embedding-worker.ts into a CommonJS file that
  // we then copy next to the bundle output so unpackOnce() stages
  // it alongside sag.bundle.cjs in %TEMP%/sag-sea-native-<sig>/__bundle__/.
  // We rebuild the worker bundle here so its externals stay
  // consistent with sag.bundle.cjs (native + ESM externals).
  const workerOut = join(DIST, "sag.embedding-worker.cjs");
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(ROOT, "src/ai/embedding-worker.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: [
      ...NATIVE_DEPS,
      ...DEFAULT_EXTERNAL_ESM_DEPS,
      "pg-native",
      "sharp",
      "@embedded-postgres/*"
    ],
    outfile: workerOut,
    logLevel: "warning",
    banner: {
      js: [
        "// SAG embedding-worker — runs in worker_threads, isolates",
        "// onnxruntime from the main process. Spawned by",
        "// src/ai/embedding-worker-client.ts via node:worker_threads.",
        'var import_meta_url = require("url").pathToFileURL(__filename).href;'
      ].join("\n")
    },
    define: {
      "import.meta.url": "import_meta_url"
    }
  });
  log("✓ embedding-worker bundle:", "dist/sag.embedding-worker.cjs");
}

function stepEntry() {
  log("entry: writing");
  // Bundle the SQLite migration .sql files alongside native deps so the
  // SEA runtime can locate them next to sag.exe (the in-tree path the
  // migrate.ts default search uses doesn't exist once the project is
  // collapsed into sag.exe).
  const migrationsSrcDir = join(ROOT, "src/db/sqlite/migrations");
  const migrationsDstDir = join(DIST, "migrations");
  if (existsSync(migrationsSrcDir)) {
    mkdirSync(migrationsDstDir, { recursive: true });
    for (const f of readdirSync(migrationsSrcDir)) {
      if (f.endsWith(".sql")) {
        copyFileSync(join(migrationsSrcDir, f), join(migrationsDstDir, f));
      }
    }
    log(`✓ migration .sql files copied: ${readdirSync(migrationsDstDir).join(", ")}`);
  } else {
    log("! migrations source dir not found — runtime will fail");
  }
  // Bundle the Python file-converter script next to sag.exe so the runtime
  // can spawn it without depending on the user's source-tree layout.
  //
  // The Python / PowerShell helper scripts (`scripts-runtime/` in source,
  // e.g. extract-office.py, com-extract.ps1) are NOT shipped as a sibling
  // directory next to the exe. End users should not see the decryption
  // helpers on disk — they are compiled into the SEA bundle as base64
  // and unpacked into the native-cache directory at runtime.
  const scriptsRuntimeSrcDir = join(ROOT, "scripts-runtime");
  const scriptsMap = {};
  if (existsSync(scriptsRuntimeSrcDir)) {
    for (const f of readdirSync(scriptsRuntimeSrcDir)) {
      const full = join(scriptsRuntimeSrcDir, f);
      if (!existsSync(full)) continue;
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      scriptsMap[f] = readFileSync(full).toString("base64");
    }
    writeFileSync(join(DIST, "sag.scripts.json"), JSON.stringify(scriptsMap));
    log(`✓ scripts-runtime packed: ${Object.keys(scriptsMap).length} file(s) -> dist/sag.scripts.json`);
  } else {
    log("! scripts-runtime source dir not found — file converter will fail");
    writeFileSync(join(DIST, "sag.scripts.json"), JSON.stringify(scriptsMap));
  }


  // The native-map is now loaded at runtime via `require("node:sea").getAsset()`,
  // NOT inlined into entry.cjs. Inlining pushed entry to ~180 MB which
  // crashed V8's embedder-mode Script::Compile on Windows. Reading the
  // resource from the SEA bundle keeps entry under 5 KB.
  //
  // NOTE: we no longer write a giant `const NATIVE_MAP = ${mapJson}` literal
  // here. stepResources() below stages the JSON as a separate SEA asset.

  // Migrations get written to a sibling file (sag.migrations.json) at
  // build time rather than being inlined into entry.cjs. Even a 30 KB
  // inline string in the entry source crashes V8 during SEA startup on
  // Windows.
  const migrationsMap = {};
  if (existsSync(migrationsSrcDir)) {
    for (const f of readdirSync(migrationsSrcDir)) {
      if (f.endsWith(".sql")) {
        migrationsMap[f] = readFileSync(join(migrationsSrcDir, f)).toString("base64");
      }
    }
  }
  writeFileSync(join(DIST, "sag.migrations.json"), JSON.stringify(migrationsMap));
  log("✓ sag.migrations.json written");

  // Collect web fetch globals (Response, Request, Headers, fetch, etc.)
  // BEFORE generating the entry string. Node 22+ exposes these globally,
  // and the MCP SDK's StreamableHTTP transport uses them. When the bundle
  // runs inside `vm.runInContext`, those globals are not on the context,
  // so without this polyfill the SDK crashes with "Response is not defined".
  const webGlobals = {};
  for (const name of ["Response","Request","Headers","fetch","FormData",
                       "AbortController","AbortSignal","RequestInit",
                       "ReadableStream","WritableStream","TransformStream"]) {
    try {
      const v = globalThis[name];
      if (v !== undefined) webGlobals[name] = v;
    } catch { /* ignore */ }
  }

  const entry = `// AUTO-GENERATED by build-sea-bundle.mjs. Do not edit.
// SAG SEA bootstrap. Decodes native modules into a stable tmp dir and
// patches Module._resolveFilename so require('better-sqlite3') etc. work
// inside a SEA bundle.
//
// IMPORTANT: This file must stay small (< 10 KB). Anything inlined here
// gets re-compiled by V8 in embedder-mode Script::Compile at startup.
// A previous version of this entry inlined a ~180 MB native-map JSON,
// which crashed Windows V8 with "v8::ToLocalChecked Empty MaybeLocal".
// Native-map is now read at runtime from a sibling file
// "<exe-dir>/sag.native-map.json" (not a SEA resource — large SEA
// resources crash V8 the same way). Migrations are still small and
// stay inline base64.
"use strict";

// pdfjs-dist's legacy build references DOMMatrix / Path2D at module
// top-level (e.g. SCALE_MATRIX = new DOMMatrix()). When esbuild
// bundles pdfjs into sag.bundle.cjs those expressions run as soon as
// the bundle is required, before any real user code, and Node has no
// DOMMatrix global on Windows. Install no-op stubs so pdfjs can import
// without crashing; SAG only uses pdfjs for text extraction
// (disableFontFace:true, useSystemFonts:false), so canvas rendering
// paths that would actually use these classes never execute.
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

// Always-on log redirection. 黑洞.exe can be launched in three ways:
//   1) PowerShell "Start-Process ... -RedirectStandardOutput" — stdout
//      goes to whatever file the launcher picks; nothing to do here.
//   2) Double-click the .exe from Explorer — there is no console at
//      all, console.log output is dropped on Windows.
//   3) "& 'C:\path\黑洞.exe'" from a shell — stdout goes to the user's
//      terminal but is NOT captured to a file unless they explicitly
//      tee or redirect.
//
// The user has been bitten by case (3) repeatedly: they launch 黑洞.exe
// to ingest their audit folder, watch the sync run via the Web UI, and
// then want to inspect the per-file ingest timing — but no log file
// exists because they forgot the "-RedirectStandardOutput" flag.
//
// To make this trivially work for the user, we tee process.stdout and
// process.stderr into <exe-dir>/sd-out.log and <exe-dir>/sd-err.log as
// soon as the SEA bootstrap starts. The tees are append-mode so they
// accumulate across restarts (rotate via Windows PowerShell Get-Date
// if they get too large). We only tee when stdout is not already
// redirected to a regular file — if the user did pass
// -RedirectStandardOutput, the write streams go to their file and we
// avoid double-logging.
(function setupLogTees() {
  const EXE_DIR_LOGS = path.dirname(process.execPath);
  const outLogPath = path.join(EXE_DIR_LOGS, "sd-out.log");
  const errLogPath = path.join(EXE_DIR_LOGS, "sd-err.log");
  try {
    const isRedirected = (fd) => {
      try {
        // statSync on the underlying stream returns a regular file when
        // Windows redirected via -RedirectStandardOutput. Returns
        // something else (a pipe / TTY / null) otherwise. We treat
        // everything that's not a regular file as "needs tee".
        const s = fs.fstatSync(fd);
        return s.isFile();
      } catch {
        return false;
      }
    };
    if (!isRedirected(1)) {
      const outFd = fs.openSync(outLogPath, "a");
      // Replace stdout's write so every console.log/info emission
      // goes both to the original stdout (terminal, if any) AND to
      // sd-out.log. process.stdout keeps its underlying fd so
      // process.exit still flushes correctly.
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...rest) => {
        try { fs.writeSync(outFd, chunk); } catch {}
        return origStdoutWrite(chunk, ...rest);
      };
      // Surface where the log is going so the user can find it.
      try {
        origStdoutWrite(
          "[sag-boot] stdout tee -> " + outLogPath + " (pid=" + process.pid + ")" + String.fromCharCode(10)
        );
      } catch {}
    }
    if (!isRedirected(2)) {
      const errFd = fs.openSync(errLogPath, "a");
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => {
        try { fs.writeSync(errFd, chunk); } catch {}
        return origStderrWrite(chunk, ...rest);
      };
      try {
        process.stderr.write(
          "[sag-boot] stderr tee -> " + errLogPath + " (pid=" + process.pid + ")" + String.fromCharCode(10)
        );
      } catch {}
    }
  } catch (err) {
    // Logging setup is best-effort; never crash the boot.
    try {
      process.stdout.write(
        "[sag-boot] log tee setup failed: " + err.message + String.fromCharCode(10)
      );
    } catch {}
  }
})();

function unpackOnce() {
  // Read native-map from a sibling file next to the exe. We infer the
  // json basename from the exe's own basename, so renaming the binary
  // (e.g. sag.exe → 黑洞.exe) doesn't break the runtime lookup. The
  // native-map is 60+ MB of base64-encoded native modules — too large
  // for SEA's blob-as-resource mechanism without crashing V8 on Windows.
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const mapPath = path.join(exeDir, exeBase + ".native-map.json");
  if (!fs.existsSync(mapPath)) {
    throw new Error(
      exeBase + ".native-map.json is missing next to " + path.basename(process.execPath) + ".\\n" +
      "Make sure your distribution package contains both the exe AND its sibling .native-map.json.\\n" +
      "Expected at: " + mapPath,
    );
  }
  const mapJson = fs.readFileSync(mapPath, "utf8");
  const NATIVE_MAP = JSON.parse(mapJson);

  // Stable per-machine, per-version extraction dir so re-launches are
  // instant after the first boot. Prefer the exe directory
  // (<exe>/native-cache/<sig>/) so the unpack doesn't depend on system
  // %TEMP% (which is often tiny on Windows and not writable in some
  // locked-down environments). The env var SAG_NATIVE_CACHE_DIR lets
  // users override this (e.g. point at D:\sag-cache). Fall back to
  // os.tmpdir() only if the exe directory is not writable.
  const sig = crypto
    .createHash("sha256")
    .update(mapJson)
    .digest("hex")
    .slice(0, 12);
  const exeDirForCache = path.dirname(process.execPath);
  let baseDir;
  const envOverride = process.env.SAG_NATIVE_CACHE_DIR;
  const candidates = [];
  if (envOverride) candidates.push(path.join(envOverride, "sag-sea-native-" + sig));
  candidates.push(path.join(exeDirForCache, "native-cache", sig));
  candidates.push(path.join(os.tmpdir(), "sag-sea-native-" + sig));
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      // Probe writability by writing and removing a tiny file.
      const probe = path.join(c, ".sag-write-probe");
      fs.writeFileSync(probe, "1");
      fs.unlinkSync(probe);
      baseDir = c;
      break;
    } catch (err) {
      // Try the next candidate.
    }
  }
  if (!baseDir) {
    throw new Error(
      "could not find a writable native-cache directory. Tried: " +
        candidates.join(", ") +
        ". Set SAG_NATIVE_CACHE_DIR to override."
    );
  }

  // Layout on disk (so Node's built-in resolver finds everything):
  //   <baseDir>/node_modules/<pkg>/...           — every native dep (and its transitive deps)
  //   <baseDir>/__bundle__/sag.bundle.cjs        — the esbuild bundle
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle__");
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
      if (fs.existsSync(out)) {
        continue;
      }
      const text = /\.(js|cjs|mjs|json)$/i.test(rel);
      const data = text
        ? Buffer.from(b64, "base64").toString("utf8")
        : Buffer.from(b64, "base64");
      fs.writeFileSync(out, data);
    }
    // Drop a package.json if upstream omitted it. Required for Node to
    // treat the dir as a node_modules-resolvable package.
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

// Unpack the embedded file-converter scripts (Python + PowerShell
// helpers) into the native-cache directory so the runtime can spawn
// them without exposing them on the user's filesystem. We deliberately
// do NOT write them next to the exe — end users should never see the
// decryption helpers, and exposing them under exeDir/scripts/ would
// defeat that.
const SCRIPTS_DIR = path.join(NATIVE_DIR, "scripts");
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
{
  const EXE_BASE_FOR_SCRIPTS = path.basename(process.execPath, ".exe");
  const scriptsMapPath = path.join(path.dirname(process.execPath), EXE_BASE_FOR_SCRIPTS + ".scripts.json");
  if (!fs.existsSync(scriptsMapPath)) {
    // The helpers are essential for any encrypted / DLP-wrapped Office
    // file the watcher encounters. Falling back to an empty pack would
    // let xlsx extraction appear to work, then silently produce empty
    // output. Surface the missing asset loudly so the user can tell
    // their distribution is incomplete.
    throw new Error(
      EXE_BASE_FOR_SCRIPTS + ".scripts.json is missing next to " + path.basename(process.execPath) + ".\\n" +
      "Expected at: " + scriptsMapPath
    );
  }
  const scriptsJson = fs.readFileSync(scriptsMapPath, "utf8");
  const scriptsMap = JSON.parse(scriptsJson);
  for (const [name, b64] of Object.entries(scriptsMap)) {
    const out = path.join(SCRIPTS_DIR, name);
    if (fs.existsSync(out)) continue; // content-keyed cache; never overwrite
    fs.writeFileSync(out, Buffer.from(b64, "base64"));
  }
}
process.env.SAG_SCRIPTS_DIR = SCRIPTS_DIR;
// Also expose on globalThis (kept for any callers that DO see this realm)
// and write the path to <exeDir>/sd-scripts-dir.txt for the esbuild
// bundle. The bundle runs in a separate vm context from the SEA host
// entry — neither globalThis.X nor process.env.X mutations propagate
// from the host entry to the bundle. The file is the only cross-realm
// carrier we can rely on; the bundle's readScriptsDirFromFile() reads
// it on first call.
globalThis.SAG_SCRIPTS_DIR = SCRIPTS_DIR;
try {
  require("fs").writeFileSync(
    path.join(path.dirname(process.execPath), "sd-scripts-dir.txt"),
    SCRIPTS_DIR + String.fromCharCode(10),
    "utf8"
  );
} catch (err) {
  try { process.stderr.write("[sag-boot] sd-scripts-dir.txt write failed: " + err.message + String.fromCharCode(10)); } catch {}
}

// Drop migrations alongside the exe so migrate.ts can find them via
// MIGRATIONS_DIR at runtime. The migrations live as a sibling JSON file
// (not inline in entry.cjs) for the same reason as native-map: large
// inline strings in entry.cjs crash V8 on Windows during SEA startup.
// Basename is inferred from process.execPath so renaming the binary
// (e.g. sag.exe → 黑洞.exe) doesn't break the lookup.
const EXE_DIR = path.dirname(process.execPath);
const EXE_BASE = path.basename(process.execPath, ".exe");
const MIGRATIONS_DIR = path.join(EXE_DIR, "migrations");
const migrationsMapPath = path.join(EXE_DIR, EXE_BASE + ".migrations.json");
if (!fs.existsSync(migrationsMapPath)) {
  throw new Error(
    EXE_BASE + ".migrations.json is missing next to " + path.basename(process.execPath) + ".\\n" +
    "Expected at: " + migrationsMapPath,
  );
}
fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
const migrationsJson = fs.readFileSync(migrationsMapPath, "utf8");
const migrationsMap = JSON.parse(migrationsJson);
for (const [name, b64] of Object.entries(migrationsMap)) {
  fs.writeFileSync(path.join(MIGRATIONS_DIR, name), Buffer.from(b64, "base64"));
}
process.env.MIGRATIONS_DIR = MIGRATIONS_DIR;

const BUNDLE_PATH = path.join(NATIVE_DIR, "__bundle__", "sag.bundle.cjs");
const bundleSource = fs.readFileSync(BUNDLE_PATH, "utf8");

const bundleModule = new Module(BUNDLE_PATH, module);
bundleModule.filename = BUNDLE_PATH;
bundleModule.paths = [path.join(NATIVE_DIR, "node_modules")];
Module._cache[bundleModule.filename] = bundleModule;

// Run the bundle in the host realm (not a vm context) so the MCP SDK's
// StreamableHTTP transport can see Node v22's web fetch globals
// (Response, Request, Headers, fetch, ...). The legacy vm.createContext
// path would create an isolated JS realm without those globals.
bundleModule._compile(bundleSource, BUNDLE_PATH);
if (typeof bundleModule.exports === "function") module.exports = bundleModule.exports;
`;
  const entryPath = join(DIST, "sag.entry.cjs");
  writeFileSync(entryPath, entry);
  log(
    "✓ entry:",
    "dist/sag.entry.cjs",
    `(${(statSync(entryPath).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

function stepConfig() {
  const cfg = {
    main: "sag.entry.cjs",
    output: "sag.blob",
    disableExperimentalSEAWarning: true,
    // No SEA resources at all. Both sag.bundle.cjs (8 MB) and
    // sag.native-map.json (130 MB) ship as sibling files — large
    // SEA resources crash V8 on Windows during LoadEnvironment.
    resources: [],
  };
  const out = join(DIST, "sea-config.json");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  log("✓ sea-config: dist/sea-config.json");
}

function stepBlob() {
  log("sea: generating blob via node --experimental-sea-config");
  execSync("node --experimental-sea-config sea-config.json", {
    cwd: DIST,
    stdio: "inherit",
    shell: true,
  });
  const blob = join(DIST, "sag.blob");
  log(
    "✓ blob: dist/sag.blob",
    `(${(statSync(blob).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

(async () => {
  mkdirSync(DIST, { recursive: true });

  // Clean stale build artefacts so retries start fresh.
  for (const f of ["sag.bundle.cjs", "sag.native-map.json", "sag.entry.cjs", "sea-config.json", "sag.blob"]) {
    try { rmSync(join(DIST, f), { force: true }); } catch {}
  }

  await stepBundle();
  await stepWorkerBundle();
  stepNativeMap();
  stepEntry();
  stepConfig();
  stepBlob();
  log("DONE — run npm run build:windows-exe to finish.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
