#!/usr/bin/env node
// build-sea-bundle.mjs — Produce a Node SEA-ready single CJS that ships
// its native modules inline.
//
// Layout of the output:
//   dist/sag.bundle.cjs                              — esbuild output, native modules marked external
//   dist/native-cache/<pkg>/<rel>                    — every native dep's raw binary payload,
//                                                      mirrors node_modules path layout
//   dist/sag.native-map.manifest.json                 — index of every native-cache file
//   dist/sag.entry.cjs                                — bootstrap: copyFileSync natives into a
//                                                      stable tmp dir, patch Module._resolveFilename,
//                                                      load sag.bundle.cjs
//   dist/sea-config.json                              — points Node's SEA at sag.entry.cjs
//   dist/sag.blob                                     — the SEA blob produced by Node SEA
//                                                      (node --experimental-sea-config sea-config.json)
//
// History: we used to base64 every native file into a single
// `sag.native-map.json`. With node-llama-cpp added that payload hit
// 1.4 GB of base64 text, which both (a) tripped V8's 512 MB
// single-string ceiling during `JSON.stringify` at build time and
// (b) tripped the same ceiling during `readFileSync → JSON.parse`
// at runtime, crashing the SEA exe on startup. The new layout keeps
// binaries as raw files (no encode/decode round-trip) and a tiny
// manifest for the index.
//
// Run via:  npm run build:sea-bundle

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
import { join, dirname, basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { argv } from "node:process";
import { createHash } from "node:crypto";

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
  // node-llama-cpp ships a prebuilt napi binary inside the sibling
  // `@node-llama-cpp/<platform>` packages (declared in
  // node-llama-cpp's own optionalDependencies). Walk the namespace
  // so the SEA runtime unpacks whichever platform-specific sub-dir
  // is installed. Uninstalled platforms only carry a `*.moved.txt`
  // marker file — see walkModule() for the filter that drops those.
  "node-llama-cpp",
  "@node-llama-cpp",
  // P31 fix: @xenova/transformers pins its OWN nested sharp@0.32.x
  // (which requires `color@^4`) under
  // node_modules/@xenova/transformers/node_modules/sharp. The nested
  // sharp's transitive deps must be walked into the native-cache
  // manifest, or the runtime throws `Cannot find module 'color'` the
  // moment anything inside transformers.js touches an image. We
  // include the package itself so collectNativeDeps recurses into the
  // nested tree; DEFAULT_EXTERNAL_ESM_DEPS keeps esbuild from inlining
  // it (separate concern).
  "@xenova/transformers",
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
  // node-llama-cpp is ESM-only (the package's `package.json`
  // exports map pins `"type": "module"`). esbuild's CJS target can't
  // bundle it cleanly — the IIFE wrapping would split the inner
  // `Llama` / `getLlama` getters from the import-side bindings and
  // subsequent inference calls would no-op. Keep it external so
  // Node's standard ESM resolver handles the import.
  "node-llama-cpp",
  // The platform-specific sub-packages (`@node-llama-cpp/win-x64`,
  // `@node-llama-cpp/mac-arm64-metal`, etc.) are also ESM with
  // top-level await — esbuild CJS would refuse to bundle them with
  // "Top-level await is currently not supported". Mark every
  // `node_modules/@node-llama-cpp/*` subpackage as external.
  "@node-llama-cpp/win-x64",
  "@node-llama-cpp/win-x64-cuda",
  "@node-llama-cpp/win-x64-cuda-ext",
  "@node-llama-cpp/win-x64-vulkan",
  "@node-llama-cpp/win-arm64",
  "@node-llama-cpp/mac-x64",
  "@node-llama-cpp/mac-arm64-metal",
  "@node-llama-cpp/linux-x64",
  "@node-llama-cpp/linux-x64-cuda",
  "@node-llama-cpp/linux-x64-cuda-ext",
  "@node-llama-cpp/linux-x64-vulkan",
  "@node-llama-cpp/linux-arm64",
  "@node-llama-cpp/linux-armv7l",
  "@node-llama-cpp/linux-riscv64",
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
  // esbuild's `external` field doesn't support glob patterns, so we
  // use a `onResolve` plugin to mark every `@node-llama-cpp/*` path
  // as external. Without this, esbuild walks the transitive
  // `require("@node-llama-cpp/win-x64")` from
  // `node-llama-cpp/dist/index.js` and tries to bundle the platform
  // sub-package — its top-level `await import(...)` then fails under
  // the "cjs" output format ("Top-level await is currently not
  // supported"). The platform sub-package is loaded at runtime by
  // node-llama-cpp itself via a regular `require(...)` after the
  // SEA runtime unpacks the native-map into a stable tmp dir.
  const externalPlugin = {
    name: "sag-external-glob",
    setup(build) {
      // Match both the bare specifier `@node-llama-cpp/win-x64` and
      // the resolved file path
      // `@node-llama-cpp/win-x64/dist/index.js`. Without anchoring
      // the alternation, esbuild reaches the .js file before the
      // plugin callback fires and emits its top-level-await parse
      // error before we can mark it external.
      build.onResolve({ filter: /@node-llama-cpp\// }, (args) => {
        if (args.path.startsWith("@node-llama-cpp/")) return { external: true };
        return null;
      });
    }
  };
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
    plugins: [externalPlugin],
    outfile: join(DIST, "sag.bundle.cjs"),
    // esbuild 0.28 only accepts boolean for `metafile`. We capture
    // the JSON via the result.metafile property (returned by the
    // promise) and write it ourselves, since the implicit sidecar
    // write seems to be skipped when the outfile has a `.cjs`
    // extension.
    metafile: true,
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
  }).then((result) => {
    if (result && result.metafile) {
      const out = join(DIST, "sag.bundle.cjs.meta.json");
      writeFileSync(out, JSON.stringify(result.metafile));
      log("✓ metafile:", out);
    }
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
//
// P13 fix: the previous "skip node_modules" rule dropped every
// transitive dep that pnpm had nested under another package
// (e.g. node-llama-cpp/node_modules/slice-ansi/node_modules/is-fullwidth-code-point).
// We now keep walking into a transitive node_modules ONLY when the
// directory name matches a package collectNativeDeps() already
// discovered — so we never pull a random dev-only dependency,
// but we DO pull the ones the runtime will require() at module
// load time.
function walkModule(pkgDir) {
  const out = new Map();
  // P13 fix (round 2): the old `allowNested = new Set(NATIVE_DEPS)` only
  // descended into nested node_modules when the sub-dir name was a known
  // native dep (e.g. `sharp/node_modules/sharp`). That misses transitive
  // branches like `sharp/node_modules/@napi-rs/canvas/node_modules/@napi-rs/canvas-win32-x64-msvc/`,
  // `@xenova/transformers/node_modules/sharp/node_modules/color/...`, or
  // `node-llama-cpp/node_modules/log-symbols/node_modules/color-convert/`.
  // Each one of those is a real require() path the runtime walks and
  // silently crashes on at boot with MODULE_NOT_FOUND.
  //
  // We now descend into EVERY package we find under any nested
  // `node_modules`, recursively. The previous "skip test/__tests__" and
  // "skip the 33 MB node-llama-cpp/llama/ source tree" guards stay in
  // place. The runtime also gets a separate fingerprint step to
  // tolerate a bit of dead weight in the cache (a few hundred KB of
  // extra *.mjs / *.json from optionalDependencies that we don't
  // actually require). It's cheap insurance for the entire NER cascade.
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // If a transient error happens (rare, e.g. AV scanner holding a
      // handle on a .dll during the walk), skip the subtree rather
      // than crash the entire build.
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "test" || ent.name === "__tests__") continue;
        // Descend into EVERY nested node_modules. The old version only
        // re-entered packages that were already in NATIVE_DEPS, which
        // left the color / @napi-rs/canvas / simple-swizzle cascade
        // (Plan B NER's transitive chain) sitting in pnpm's nested
        // `node_modules/<a>/node_modules/<b>/` tree, invisible to the
        // bundle manifest.
        if (ent.name === "node_modules") {
          let sub;
          try {
            sub = readdirSync(full, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const subEnt of sub) {
            if (!subEnt.isDirectory()) continue;
            // Skip `@*` org-less placeholder dirs and dev-only junk
            // that pnpm sometimes leaves behind.
            if (subEnt.name.startsWith(".")) continue;
            walk(join(full, subEnt.name));
          }
          continue;
        }
        // node-llama-cpp ships the entire llama.cpp source tree under
        // node-llama-cpp ships the entire llama.cpp source tree under
        // `node_modules/node-llama-cpp/llama/` (CMakeLists, .c, .cpp,
        // .h, generated build files — 33 MB on Windows). None of that
        // is needed at runtime: the actual napi binding + DLLs live in
        // the sibling `@node-llama-cpp/win-x64/bins/win-x64/` package
        // and the JS lives in `dist/`. The runtime, however, does
        // expect the small config files inside `llama/` to exist
        // (`binariesGithubRelease.json`, `llama.cpp.info.json`) so
        // we descend into the `llama/` subdir but only pick up JSON
        // and LICENSE files — never the source tree or prebuilt
        // bundle binaries.
        if (ent.name === "llama") {
          // Pick up the small config files inside
          // node-llama-cpp/llama/ (binariesGithubRelease.json,
          // llama.cpp.info.json) but skip the multi-gigabyte
          // source tree.
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
        // The `@node-llama-cpp/<platform>` packages leave a
        // `<platform>.moved.txt` sentinel when the binary was moved
        // out to a sibling package. Skip those markers and any other
        // `.moved.*` / `.txt` tracking files — we only want the
        // binary payloads.
        if (/\.moved\.txt$/i.test(ent.name)) continue;
        // .wasm included for @xenova/transformers which ships ONNX
        // Runtime Web as four .wasm variants next to transformers.min.js.
        // Without these the runtime pipeline silently produces
        // empty/garbage token outputs (model loads but tokenizer can't
        // decode).
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
  // P13 fix: pnpm (and sometimes npm with hoisting disabled) lays
  // transitive deps out as a forest rather than a flat tree — e.g.
  // `node_modules/node-llama-cpp/node_modules/slice-ansi/node_modules/is-fullwidth-code-point`.
  // The old version of this function only read
  // `ROOT/node_modules/<pkg>/package.json`, so anything that lived
  // under a nested install was invisible to the bundle, the
  // runtime then failed with "Cannot find package 'is-fullwidth-code-point'"
  // the moment anything actually required it.
  //
  // We walk every installed `<pkg>/package.json` we can find under
  // any `node_modules/` ancestor of ROOT and merge them into the
  // collected set. The earlier "root first" loop is preserved as a
  // fast path so the simple flat layout (one node_modules) doesn't
  // re-scan the whole tree.
  const discovered = new Set();
  for (const pkg of pkgs) {
    if (collected.has(pkg)) continue;
    collected.add(pkg);
    // Locate every install location of this package and read its
    // dependencies. The first hit wins for discovery (we don't
    // double-walk); nested copies can declare slightly different
    // deps so we look at ALL of them and union the result.
    const candidates = findAllInstallLocations(pkg);
    for (const pkgDir of candidates) {
      const pkgJsonPath = join(pkgDir, "package.json");
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      } catch {
        continue;
      }
      const deps = pkgJson.dependencies || {};
      for (const dep of Object.keys(deps)) discovered.add(dep);
      if (includeOptional) {
        const optDeps = pkgJson.optionalDependencies || {};
        for (const dep of Object.keys(optDeps)) discovered.add(dep);
      }
    }
  }
  // Recurse only into deps we haven't seen yet.
  const newDeps = [...discovered].filter((d) => !collected.has(d));
  if (newDeps.length > 0) {
    collectNativeDeps(newDeps, collected, includeOptional);
  }
  return Array.from(collected);
}

/**
 * Walk every `node_modules/<pkg>/package.json` under ROOT (depth-
 * limited) and return the directories that look like valid installs.
 * Cheap (filesystem walk only, no JSON parse) and bounded so a
 * runaway `node_modules` loop can't exhaust memory.
 */
function findAllInstallLocations(pkg) {
  const matches = [];
  const MAX_DEPTH = 8; // pnpm nest depth; far past anything we ship
  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    const candidate = join(dir, "node_modules", pkg);
    if (existsSync(join(candidate, "package.json"))) {
      matches.push(candidate);
      // P32 fix: do NOT return on the first hit. A nested install of
      // the same package can declare different transitive deps (e.g.
      // @xenova/transformers/node_modules/sharp@0.32 requires `color`
      // while the root sharp@0.35 does not). If we stop at the root
      // install we miss the nested one's deps and the runtime
      // crashes with `Cannot find module 'color'` the moment transformers
      // touches an image. Continue the walk so nested copies are also
      // discovered; collectNativeDeps unions their dependency lists.
    }
    // P33 fix: when walking under a node_modules dir, also descend into
    // scoped-package subdirs (e.g. `node_modules/@xenova/transformers`).
    // The original loop descends into every immediate child of the
    // current `node_modules`, which means at dir=`node_modules/@xenova`
    // it tries `<dir>/node_modules` (does not exist — @xenova is not a
    // package, it's an org namespace). We add a second pass that, for
    // each `<scope>/<name>` subdir found inside the current
    // `node_modules`, walks `<scope>/<name>` as if it were a normal
    // package dir — letting the recursive descent reach the nested
    // `node_modules` inside the scoped package (which is where pnpm
    // places peer-of-peer dependencies like
    // `@xenova/transformers/node_modules/sharp`).
    let entries;
    try {
      entries = readdirSync(join(dir, "node_modules"), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const sub = join(dir, "node_modules", ent.name);
      walk(sub, depth + 1);
      // Scoped namespace: also walk into each scoped member as its own
      // package root so we reach `<scope>/<name>/node_modules/...`.
      if (ent.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(sub, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of scoped) {
          if (!s.isDirectory() || s.name.startsWith(".")) continue;
          walk(join(sub, s.name), depth + 1);
        }
      }
    }
  }
  walk(ROOT, 0);
  return matches;
}

function stepNativeMap() {
  // Fast iteration path: SAG_FAST_BUILD=1 skips the 1.7 GB native-cache
  // rebuild when the cache is already populated. This is purely a local
  // development affordance — release builds always rebuild from
  // scratch because operators may have wiped their cache or run on a
  // different node version. Without this flag, the rebuild can take
  // ~220s on Windows because we're copying 1.7 GB of node_modules
  // every time, which dominates the iteration cost. Native-cache
  // content only changes when package.json deps change, NOT when
  // source TS changes, so this is safe to reuse across many TS-only
  // iterations. If the cache doesn't exist yet (e.g. fresh checkout,
  // after a clean, or the user has never run a full build), we fall
  // back to the full rebuild so the cache gets populated.
  const nativeCacheDir = join(DIST, "native-cache");
  if (process.env.SAG_FAST_BUILD === "1") {
    const manifestPath = join(DIST, "sag.native-map.manifest.json");
    if (existsSync(manifestPath)) {
      log("fast-build: keeping existing native-cache (delete dist/native-cache to force rebuild)");
      // P29 fix: even when we skip the heavy native-cache walk, the
      // freshly rebuilt sag.bundle.cjs (from stepBundle) MUST be
      // mirrored into dist/native-cache/__bundle__/sag.bundle.cjs and
      // the manifest's __bundle__ pointer re-emitted, otherwise the
      // runtime unpack step ships the stale pre-fix bundle and the
      // SEA exe loads code from before the last TS edit. This was the
      // root cause of rebuild-vec0 schema-error regressions that
      // survived the build because the cache short-circuited.
      try {
        const bundlePath = join(DIST, "sag.bundle.cjs");
        if (existsSync(bundlePath)) {
          const bundleDir = join(nativeCacheDir, "__bundle__");
          mkdirSync(bundleDir, { recursive: true });
          copyFileSync(bundlePath, join(bundleDir, "sag.bundle.cjs"));
          log("  + refreshed dist/native-cache/__bundle__/sag.bundle.cjs");
        }
        // Refresh the embedding worker too, and keep the manifest's
        // __embeddingWorker__ pointer. Without this the fast-build path
        // would drop the worker from the manifest and the runtime
        // would fall back to in-process ONNX (the "UI stops loading"
        // freeze). See the note at the manifest write site.
        const workerPath = join(DIST, "sag.embedding-worker.cjs");
        if (existsSync(workerPath)) {
          const bundleDir = join(nativeCacheDir, "__bundle__");
          mkdirSync(bundleDir, { recursive: true });
          copyFileSync(workerPath, join(bundleDir, "sag.embedding-worker.cjs"));
          log("  + refreshed dist/native-cache/__bundle__/sag.embedding-worker.cjs");
        }
        // Same for the DB-write worker (see the note at the bundle
        // build site) — the fast-build path must keep it staged.
        const dbWritePath = join(DIST, "sag.db-write-worker.cjs");
        if (existsSync(dbWritePath)) {
          const bundleDir = join(nativeCacheDir, "__bundle__");
          mkdirSync(bundleDir, { recursive: true });
          copyFileSync(dbWritePath, join(bundleDir, "sag.db-write-worker.cjs"));
          log("  + refreshed dist/native-cache/__bundle__/sag.db-write-worker.cjs");
        }
        const raw = readFileSync(manifestPath, "utf8");
        const manifest = JSON.parse(raw);
        manifest.__bundle__ = "__bundle__/sag.bundle.cjs";
        if (existsSync(workerPath)) {
          manifest.__embeddingWorker__ = "__bundle__/sag.embedding-worker.cjs";
        }
        if (existsSync(dbWritePath)) {
          manifest.__dbWriteWorker__ = "__bundle__/sag.db-write-worker.cjs";
        }
        // P30 fix: after refreshing the bundle, the per-machine cache
        // fingerprint MUST be recomputed too. Without this, the
        // manifest's __fingerprint__ still describes the pre-refresh
        // file tree, and the runtime at boot sees "fingerprint
        // matches the per-machine cache, reuse it" and ships the
        // STALE bundle from <baseDir>/__bundle__/sag.bundle.cjs —
        // the very pre-fix code the fast-build was trying to ship.
        // Recompute by walking the cache (same algorithm the slow
        // path uses at line 868).
        const fpLines = [];
        function walkForFp(dir, rel = "") {
          let ents;
          try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const ent of ents) {
            if (ent.isDirectory()) {
              walkForFp(join(dir, ent.name), rel + ent.name + "/");
            } else if (ent.isFile()) {
              try {
                const buf = readFileSync(join(dir, ent.name));
                const h = createHash("sha256").update(buf).digest("hex").slice(0, 16);
                fpLines.push(rel + ent.name + " " + h);
              } catch { /* AV lock — skip */ }
            }
          }
        }
        walkForFp(nativeCacheDir);
        // P32 — include scripts-runtime/ + migrations/ source content in
        // the fingerprint. The runtime unpacks com-extract.ps1 et al into
        // <baseDir>/scripts/ with an existsSync guard (never overwrite),
        // so a changed ps1 with an unchanged native-cache fingerprint
        // would silently keep running the OLD helper from the previous
        // per-machine cache. Hashing the scripts-runtime source files
        // into the fingerprint forces a fresh <baseDir> whenever any
        // helper script changes, which is exactly what we want after
        // editing com-extract.ps1 (e.g. the WPS ProgID fix).
        for (const extraDir of ["scripts-runtime", "migrations"]) {
          const extraPath = join(ROOT, extraDir);
          if (existsSync(extraPath)) walkForFp(extraPath, extraDir + "/");
        }
        manifest.__fingerprint__ = createHash("sha256")
          .update(fpLines.sort().join("\n"))
          .digest("hex")
          .slice(0, 16);
        log("  + recomputed fingerprint:", manifest.__fingerprint__);
        writeFileSync(manifestPath, JSON.stringify(manifest));
      } catch (e) {
        log("! fast-build bundle refresh failed:", e.message);
      }
      // Re-emit the staged metadata files so downstream tooling
      // (build-windows-exe, dist-package deploy) sees a coherent
      // tree even though we skipped the heavy walk.
      return;
    }
  }
  // Native deps get their full transitive native tree walked.
  // ESM packages we kept external in esbuild still need to live
  // somewhere the SEA bundle's require() can find them; otherwise the
  // bundle's `require("@xenova/transformers")` would resolve to nothing.
  const collected = new Set();
  collectNativeDeps(NATIVE_DEPS, collected, true);
  // Supplement with esbuild's metafile so we pick up packages the
  // externals pull in via raw require() / import without declaring
  // them in their own package.json. The classic offender is
  // @node-llama-cpp/<platform> which uses slice-ansi, log-symbols,
  // etc. without listing them as deps. Without the metafile
  // supplement the runtime throws "Cannot find package 'slice-ansi'"
  // the first time it tries to load a model.
  //
  // esbuild 0.28 writes the metafile as `<outfile>.meta.json` next
  // to the bundle. The outfile is `dist/sag.bundle.cjs`, so the
  // metafile lands at `dist/sag.bundle.cjs.meta.json`.
  //
  // The metafile alone is NOT enough: externals like
  // @node-llama-cpp/<platform> load their own transitive deps at
  // runtime via require(), and the metafile doesn't follow those.
  // We do a textual scan of every JS file under the externals we
  // care about and collect the `require("...")` / `import ... from
  // "..."` specifiers we find. This catches the slice-ansi family.
  //
  // We use two simple regexes rather than a single gnarly one —
  // readability matters more than micro-optimising a build-time scan.
  //   REQUIRE_REGEX matches `require("...")` and `require('...')`.
  //   FROM_REGEX matches any `"..."` or `'...'` that immediately
  //     follows `from ` — which catches `import X from "..."`,
  //     `export ... from "..."`, and bare re-exports.
  //   Side-effect imports (`import "pkg"`) are caught by FROM_REGEX
  //     with `from` omitted — no, they're not, so we add a third
  //     import-only regex that looks for `import "..."` directly.
  const REQUIRE_REGEX = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const FROM_REGEX = /from\s+['"]([^'"]+)['"]/g;
  const SIDE_EFFECT_IMPORT_REGEX = /import\s+['"]([^'"]+)['"]/g;
  function scanExternalsForRequires() {
    const seen = new Set();
    const fileCountByPkg = {};
    function findInNodeModules(name) {
      const top = join(ROOT, "node_modules", name);
      if (existsSync(join(top, "package.json"))) return top;
      // Search every existing node_modules subdir (npm's hoisting
      // algorithm can put a dep anywhere in the tree).
      for (const parent of seen) {
        const nested = join(ROOT, "node_modules", parent, "node_modules", name);
        if (existsSync(join(nested, "package.json"))) return nested;
      }
      // Last resort: walk the whole tree.
      const rootNm = join(ROOT, "node_modules");
      function walk(dir) {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); }
        catch { return null; }
        for (const ent of entries) {
          if (ent.isDirectory() && ent.name === "node_modules") {
            const cand = join(dir, ent.name, name);
            if (existsSync(join(cand, "package.json"))) return cand;
          } else if (ent.isDirectory()) {
            const sub = walk(join(dir, ent.name));
            if (sub) return sub;
          }
        }
        return null;
      }
      return walk(rootNm);
    }
    function collectSpec(spec) {
      if (!spec) return;
      if (spec.startsWith(".")) return;
      if (spec.startsWith("node:")) return;
      if (findInNodeModules(spec)) {
        seen.add(spec);
      } else {
        const root = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (findInNodeModules(root)) {
          seen.add(root);
        }
      }
    }
    function walkForRequires(dir, pkgKey) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const ent of entries) {
        if (ent.isDirectory()) {
          if (["node_modules", "test", "__tests__", "llama"].includes(ent.name)) continue;
          walkForRequires(join(dir, ent.name), pkgKey);
        } else if (ent.isFile() && /\.(c?js|mjs|ts)$/i.test(ent.name)) {
          fileCountByPkg[pkgKey] = (fileCountByPkg[pkgKey] || 0) + 1;
          let content;
          try { content = readFileSync(join(dir, ent.name), "utf8"); }
          catch { continue; }
          let m;
          REQUIRE_REGEX.lastIndex = 0;
          while ((m = REQUIRE_REGEX.exec(content)) !== null) {
            collectSpec(m[1]);
          }
          FROM_REGEX.lastIndex = 0;
          while ((m = FROM_REGEX.exec(content)) !== null) {
            collectSpec(m[1]);
          }
          SIDE_EFFECT_IMPORT_REGEX.lastIndex = 0;
          while ((m = SIDE_EFFECT_IMPORT_REGEX.exec(content)) !== null) {
            collectSpec(m[1]);
          }
        }
      }
    }
    for (const pkg of [...NATIVE_DEPS, ...DEFAULT_EXTERNAL_ESM_DEPS]) {
      const pkgDir = join(ROOT, "node_modules", pkg);
      if (!existsSync(pkgDir)) continue;
      walkForRequires(pkgDir, pkg);
    }
    return Array.from(seen);
  }
  const scannedRequires = scanExternalsForRequires();
  const newOnes = scannedRequires.filter(p => !collected.has(p));
  log("scanExternalsForRequires found", scannedRequires.length, "package(s); new ones:", newOnes.length, "->", newOnes.join(", "));
  for (const pkg of scannedRequires) {
    collected.add(pkg);
  }
  const metafilePath = join(DIST, "sag.bundle.cjs.meta.json");
  if (existsSync(metafilePath)) {
    try {
      const meta = JSON.parse(readFileSync(metafilePath, "utf8"));
      const inputs = meta.inputs || {};
      for (const inputPath of Object.keys(inputs)) {
        // inputPath looks like "node_modules/.../pkg/file.js". Pull
        // out the leading "node_modules/<scope?>/<name>/" segment.
        const m = inputPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
        if (m) {
          collected.add(m[1]);
        } else if (inputPath.startsWith("node_modules/")) {
          // Scoped or unscoped without further nesting: fall back to
          // the second path component.
          collected.add(inputPath.split("/").slice(1, 3).join("/"));
        }
      }
    } catch (err) {
      log("metafile parse failed (continuing without it):", err.message);
    }
  } else {
    log("metafile not found at", metafilePath, "- run stepBundle first");
  }
  const allNativeDeps = [
    ...Array.from(collected),
    ...DEFAULT_EXTERNAL_ESM_DEPS
  ];
  log("native-map: walking", allNativeDeps.length, "package(s)");
  // We extract native binaries as raw files under
  // `dist/native-cache/<pkg>/<rel-path>` instead of base64-encoding
  // them into a single JSON map. Reasons:
  //
  //   1. The previous `JSON.stringify(map)` blew up at ~600 MB
  //      base64 string — well past V8's 512 MB single-string limit.
  //   2. The runtime's old `readFileSync(nativeMap, "utf8") +
  //      JSON.parse(...)` had the same ceiling issue and crashed
  //      the SEA exe on startup.
  //   3. With raw files the runtime can `copyFileSync(src, dst)`
  //      per entry — no string allocation, no JSON parser, no
  //      base64 round-trip. Throughput also improves because we
  //      skip the encode/decode dance entirely.
  //
  // We also write a small `sag.native-map.manifest.json` that
  // declares the file layout so the runtime knows what to copy
  // where. The manifest is a few hundred KB at most.
  if (existsSync(nativeCacheDir)) rmSync(nativeCacheDir, { recursive: true, force: true });
  mkdirSync(nativeCacheDir, { recursive: true });
  // NOTE: the rmSync above wipes EVERYTHING under dist/native-cache,
  // including the `__bundle__/sag.embedding-worker.cjs` that
  // stepWorkerBundle() staged a moment earlier. That is why the
  // embedding worker never reached the installed app: the file was
  // written, then deleted, then the manifest (built from this
  // directory) had no record of it. The runtime unpack therefore had
  // nothing to copy out, the client could not find the worker, and
  // every embedding call fell back to in-process ONNX on the MAIN
  // thread — which is what froze the HTTP server during ingest.
  //
  // We re-stage the worker right after the wipe (below) and register
  // it in the manifest so it survives to the installed app.
  const workerBundleOut = join(DIST, "sag.embedding-worker.cjs");
  const workerStagePath = join(nativeCacheDir, "__bundle__", "sag.embedding-worker.cjs");
  if (existsSync(workerBundleOut)) {
    mkdirSync(join(nativeCacheDir, "__bundle__"), { recursive: true });
    copyFileSync(workerBundleOut, workerStagePath);
    log("✓ embedding-worker re-staged after native-cache wipe:", workerStagePath);
  } else {
    log("  ! dist/sag.embedding-worker.cjs missing — local-BGE will fall back to in-process ONNX");
  }
  // The DB-write worker needs the same treatment: it is spawned as a
  // child process and the pool resolves it from __bundle__/. Without
  // this the SEA build could never find it and every document write
  // fell back to the main thread.
  const dbWriteBundleOut = join(DIST, "sag.db-write-worker.cjs");
  const dbWriteStagePath = join(nativeCacheDir, "__bundle__", "sag.db-write-worker.cjs");
  if (existsSync(dbWriteBundleOut)) {
    mkdirSync(join(nativeCacheDir, "__bundle__"), { recursive: true });
    copyFileSync(dbWriteBundleOut, dbWriteStagePath);
    log("✓ db-write-worker re-staged after native-cache wipe:", dbWriteStagePath);
  } else {
    log("  ! dist/sag.db-write-worker.cjs missing — DB writes stay on the main thread");
  }
  // Layout:
  //   dist/native-cache/<pkg>/<rel>      — raw binary, mirrors node_modules layout
  //   dist/native-cache/manifest.json    — index of every <pkg>/<rel>
  // Manifest schema:
  //   { "__root__": "<absolute path to the cache dir>",
  //     "packages": { "<pkg>": { "<rel>": "<relative path under cache dir>" } } }
  const manifest = { __root__: nativeCacheDir, packages: {} };
  let totalBytes = 0;
  // GPU runtime binaries that most deployments never use.
  //
  // node-llama-cpp ships one platform package per accelerator:
  //   win-x64-cuda      (138 MB, mostly ggml-cuda.dll)
  //   win-x64-cuda-ext  (350 MB, the CUDA fallback DLL)
  //   win-x64-vulkan    (52 MB,  ggml-vulkan.dll)
  //
  // Together they are 0.60 GB of the 1.00 GB native-cache — 60% of the
  // cold-boot copy — on a machine that has no NVIDIA GPU. Windows AV
  // scans every one of those DLLs as it lands, so the first boot either
  // crawls for many minutes or hangs outright (observed 2026-10-26: the
  // unpack stopped at 2,795 files and never finished).
  //
  // They are only needed for local GGUF inference on an NVIDIA/Vulkan
  // GPU. The embedding path (local-bge / ONNX) does not use them, and
  // the local-LLM path can be re-enabled per install by shipping them
  // back in. So we exclude them from the default payload.
  //
  // Set SAG_INCLUDE_GPU_PACKAGES=1 to keep them (for a machine that
  // really does run a local GGUF model on an NVIDIA GPU).
  const includeGpuPackages = process.env.SAG_INCLUDE_GPU_PACKAGES === "1";
  const GPU_PACKAGE_RE = /(^|\/)(win|linux|macos)-(x64|arm64)-(cuda|cuda-ext|vulkan)(\/|$)/;
  for (const pkg of allNativeDeps) {
    if (!includeGpuPackages && GPU_PACKAGE_RE.test(pkg)) {
      log(`  - skipping GPU package (${pkg}) — set SAG_INCLUDE_GPU_PACKAGES=1 to keep it`);
      continue;
    }
    // Some packages (notably slice-ansi, which @node-llama-cpp uses
    // without declaring) only exist as a nested install under
    // another package's node_modules subdir. Walk every possible
    // location; the first one with a real package.json wins.
    const candidates = [
      join(ROOT, "node_modules", pkg),
      // eslint-disable-next-line no-unused-vars
      ...Array.from(collected).map((p) => join(ROOT, "node_modules", p, "node_modules", pkg)),
    ];
    let pkgDir = null;
    for (const c of candidates) {
      if (existsSync(join(c, "package.json"))) {
        pkgDir = c;
        break;
      }
    }
    if (!pkgDir) {
      log(`  ! ${pkg} not installed — runtime will skip`);
      continue;
    }
    const files = walkModule(pkgDir);
    if (files.size === 0) {
      // Package is installed but had no in-scope files. We still
      // emit an empty entry so the runtime can detect "package
      // wanted but absent" vs "package wanted and zero files".
      manifest.packages[pkg] = {};
      continue;
    }
    const pkgMap = {};
    for (const [rel, buf] of files) {
      const outRel = rel; // mirror node_modules path
      const outPath = join(nativeCacheDir, pkg, outRel);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, buf);
      pkgMap[rel] = outRel;
      totalBytes += buf.length;
    }
    manifest.packages[pkg] = pkgMap;
  }
  // Add the bundle to the cache too so the runtime unpack step
  // produces a working tree without needing a separate bundle copy.
  const bundlePath = join(DIST, "sag.bundle.cjs");
  if (existsSync(bundlePath)) {
    const bundleBuf = readFileSync(bundlePath);
    const bundleDir = join(nativeCacheDir, "__bundle__");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "sag.bundle.cjs"), bundleBuf);
    manifest.__bundle__ = "__bundle__/sag.bundle.cjs";
    totalBytes += bundleBuf.length;
    log("  + bundled sag.bundle.cjs");
  }
  // Register the embedding worker in the manifest so the RUNTIME
  // unpack copies it into the per-machine native-cache dir
  // (<exe>/native-cache/<hash>/__bundle__/sag.embedding-worker.cjs).
  //
  // Without this the worker file existed only in the build tree and
  // never reached the installed app. The client then logged
  //   "embedding worker terminated: boot timeout"
  //   "local-bge worker unavailable - falling back to in-process embedding"
  // and every embedding call ran ONNX on the MAIN thread. That is the
  // direct cause of the "UI stops loading" symptom: one 122-chunk
  // workbook spent 383 s in chunkEmbedding + 320 s in sectionEmbedding
  // + 444 s in eventPrep ON the event loop, so /health and every
  // watched-folders endpoint timed out for the whole duration. The
  // worker exists precisely to isolate that work in a worker_thread.
  //
  // It is carried as a dedicated manifest field (mirroring
  // __bundle__) rather than as a manifest *package*, because the
  // runtime unpack copies packages into <base>/node_modules/<pkg>/ —
  // a "__bundle__" pseudo-package would land in
  // node_modules/__bundle__/, not next to the bundle where the client
  // looks for it.
  {
    const workerRel = "sag.embedding-worker.cjs";
    const workerSrc = join(nativeCacheDir, "__bundle__", workerRel);
    if (existsSync(workerSrc)) {
      const workerBuf = readFileSync(workerSrc);
      manifest.__embeddingWorker__ = "__bundle__/" + workerRel;
      totalBytes += workerBuf.length;
      log("  + registered embedding-worker in manifest: __bundle__/" + workerRel);
    } else {
      log("  ! embedding-worker NOT staged — local-BGE will fall back to in-process ONNX");
    }
  }
  // Same treatment for the DB-write worker: the pool spawns it as a
  // child process and looks it up in __bundle__/. Registered as a
  // dedicated manifest field (not a package) for the same reason.
  {
    const dbWriteRel = "sag.db-write-worker.cjs";
    const dbWriteSrc = join(nativeCacheDir, "__bundle__", dbWriteRel);
    if (existsSync(dbWriteSrc)) {
      const dbWriteBuf = readFileSync(dbWriteSrc);
      manifest.__dbWriteWorker__ = "__bundle__/" + dbWriteRel;
      totalBytes += dbWriteBuf.length;
      log("  + registered db-write-worker in manifest: __bundle__/" + dbWriteRel);
    } else {
      log("  ! db-write-worker NOT staged — DB writes stay on the main thread");
    }
  }
  // Embed a content fingerprint in the manifest so the runtime
  // `unpackOnce` knows when the native-cache has been patched
  // (e.g. the chalk v4 shim that replaces chalk@5) and must
  // re-copy specific files even if the manifest's package list
  // itself hasn't changed. We hash every file under native-cache
  // and include the short hash here. The runtime compares it
  // against the actual unpacked files' mtimes/hashes and triggers
  // a re-unpack of patched packages when they diverge.
  //
  // CRITICAL: this fingerprint MUST be computed AFTER the chalk
  // shim (and any other post-step that mutates native-cache).
  // Otherwise the fingerprint will still describe the pre-shim
  // v5 install, and the runtime won't detect that chalk needs
  // to be re-unpacked with the v4 shim applied.
  // Chalk shim: node-llama-cpp v3.20 imports chalk@5 (ESM-only) but
  // the SEA host runs the JS through CommonJS `Module._compile`,
  // where `require('chalk')` of an ESM-only module throws
  // "chalk.blue is not a function" the first time llama.cpp tries
  // to colorize a status line. Fix: replace the v5 install under
  // node-llama-cpp/node_modules/chalk with a CJS-compatible chalk
  // v4 (which we copy from `ora/node_modules/chalk`, where v4
  // lives as a transitive dep of any modern console-kit). The
  // top-level `chalk` in the cache stays at v5 for transformers
  // and other consumers; only the node-llama-cpp-private copy
  // gets downgraded.
  const chalkSrc = join(ROOT, "node_modules", "ora", "node_modules", "chalk");
  const chalkDst = join(nativeCacheDir, "node-llama-cpp", "node_modules", "chalk");
  // Make sure the destination's parent dir exists. walkModule
  // above only created `nativeCacheDir/node-llama-cpp/`, not its
  // node_modules/ subdir, so we have to mkdir the parent here.
  mkdirSync(dirname(chalkDst), { recursive: true });
  if (existsSync(chalkSrc)) {
    // The copy must be VERIFIED. A per-file `catch {}` (added for
    // AV locks) silently produced an EMPTY chalk/ dir on 2026-10-29:
    // the manifest was then regenerated from the empty dir, so the
    // pack gate failed with "chalk/source/index.js missing" — and a
    // build that "succeeded" left an unusable cache behind. Now the
    // copy errors are collected and the build fails loudly, and we
    // verify the expected file count afterwards.
    const chalkCopyErrors = [];
    function copyDirRobustChalk(src, dst) {
      mkdirSync(dst, { recursive: true });
      for (const ent of readdirSync(src, { withFileTypes: true })) {
        const s = join(src, ent.name);
        const d = join(dst, ent.name);
        if (ent.isDirectory()) copyDirRobustChalk(s, d);
        else if (ent.isFile()) {
          try { copyFileSync(s, d); } catch (err) { chalkCopyErrors.push(`${s}: ${err.message}`); }
        }
      }
    }
    function countFilesChalk(dir) {
      let n = 0;
      const walk = (d) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name);
          if (ent.isDirectory()) walk(p);
          else n += 1;
        }
      };
      try { walk(dir); } catch { /* unreadable -> 0 */ }
      return n;
    }
    const chalkExpected = countFilesChalk(chalkSrc);
    try { rmSync(chalkDst, { recursive: true, force: true }); } catch {}
    copyDirRobustChalk(chalkSrc, chalkDst);
    log("  + chalk v4 shim → native-cache/node-llama-cpp/node_modules/chalk/");
    // Also overwrite the top-level `native-cache/chalk/` (v5) with
    // v4. Node's module resolution starts at the importing file
    // and walks up parent dirs; if a sibling `node-llama-cpp`
    // already exists in `<baseDir>/node_modules/`, the import from
    // `node-llama-cpp/dist/utils/withProgressLog.js` resolves to
    // `<baseDir>/node_modules/chalk` (v5) before it ever reaches
    // `<baseDir>/node_modules/node-llama-cpp/node_modules/chalk`.
    // Replacing BOTH copies makes the resolution deterministic.
    const chalkTopDst = join(nativeCacheDir, "chalk");
    try { rmSync(chalkTopDst, { recursive: true, force: true }); } catch {}
    copyDirRobustChalk(chalkSrc, chalkTopDst);
    log("  + chalk v4 shim → native-cache/chalk/ (top-level)");
    // Verify both copies actually landed. A silently-empty chalk/
    // directory is fatal: the manifest is regenerated from these dirs,
    // so an empty copy means the shipped package is broken.
    for (const dir of [chalkDst, chalkTopDst]) {
      const got = countFilesChalk(dir);
      if (got !== chalkExpected) {
        throw new Error(
          `chalk v4 shim incomplete: ${got}/${chalkExpected} files in ${dir}` +
          (chalkCopyErrors.length
            ? `\n  copy errors:\n    - ${chalkCopyErrors.slice(0, 5).join("\n    - ")}`
            : "\n  (no copy errors recorded — the source dir may have changed)") +
          "\n  Close any AV/Explorer window holding the files and rebuild."
        );
      }
    }
    // CRITICAL: re-walk the chalk packages on disk so the
    // manifest's file list reflects the v4 install we just wrote,
    // not the v5 install walkModule captured earlier. Without
    // this the manifest says "chalk source/utilities.js exists"
    // (v5) while the disk says "source/util.js exists" (v4), and
    // the runtime unpack fails with ENOENT. We update the
    // manifest entries in place so the writeFileSync below picks
    // them up.
    const chalkPkgMap = {};
    const chalkShimPkgDir = join(nativeCacheDir, "node-llama-cpp", "node_modules", "chalk");
    for (const target of [join(nativeCacheDir, "chalk"), chalkShimPkgDir]) {
      if (existsSync(target)) {
        const files = walkModule(target);
        for (const [rel] of files) {
          chalkPkgMap[rel] = rel;
        }
      }
    }
    // Replace the chalk manifest entries wholesale — the
    // v5 entries captured by the earlier walkModule contain
    // files that don't exist in the v4 install (e.g.
    // source/utilities.js), and the runtime will ENOENT
    // trying to copy them.
    manifest.packages["chalk"] = chalkPkgMap;
    // chalk v4.1.2 declares `ansi-styles ^4.1.0` and
    // `supports-color ^7.1.0` as runtime dependencies. chalk v5
    // embedded them as source/vendor/* and dropped the
    // dependency declarations, which means our transitive
    // scanner never adds them to the manifest and the runtime
    // never stages them into the unpacked node_modules. When
    // the v4 shim is in place, chalk then requires("ansi-styles")
    // at load time and throws MODULE_NOT_FOUND for both, leaving
    // the exported function with no color methods (chalk.blue
    // === undefined). The fix is to copy chalk v4's runtime
    // deps from ora/node_modules (where npm hoists them) into
    // the same dir as the chalk install, AND register them in
    // the manifest so the runtime unpacks them.
    const chalkV4Deps = ["ansi-styles", "supports-color"];
    for (const dep of chalkV4Deps) {
      // Look in ora/node_modules first (where v4 lives), then
      // the workspace node_modules.
      const depSrc = [
        join(ROOT, "node_modules", "ora", "node_modules", dep),
        join(ROOT, "node_modules", dep),
      ].find((p) => existsSync(join(p, "package.json")));
      if (!depSrc) continue;
      // Write under the same parent as the chalk install, but
      // give the manifest entry the bare package name so the
      // runtime copies it to <baseDir>/node_modules/<dep>/.
      const depDst = join(nativeCacheDir, dep);
      function copyDirShim(src, dst) {
        mkdirSync(dst, { recursive: true });
        for (const ent of readdirSync(src, { withFileTypes: true })) {
          const s = join(src, ent.name);
          const d = join(dst, ent.name);
          if (ent.isDirectory()) copyDirShim(s, d);
          else if (ent.isFile()) {
            try { copyFileSync(s, d); } catch { /* AV lock — skip */ }
          }
        }
      }
      try { rmSync(depDst, { recursive: true, force: true }); } catch {}
      copyDirShim(depSrc, depDst);
      const depFiles = walkModule(depDst);
      const depMap = {};
      for (const [rel] of depFiles) depMap[rel] = rel;
      manifest.packages[dep] = depMap;
      // Also seed a manifest entry for the chalk-private copy
      // so node-llama-cpp/node_modules/chalk can find its
      // sibling ansi-styles via Node's module resolution
      // algorithm. Without this the chalk shim under
      // node-llama-cpp loads but its requires resolve to the
      // top-level ansi-styles (which works) — we add the
      // private alias for symmetry / safety.
      const chalkSiblingDep = join(nativeCacheDir, "node-llama-cpp", "node_modules", dep);
      if (existsSync(dirname(chalkSiblingDep))) {
        try { rmSync(chalkSiblingDep, { recursive: true, force: true }); } catch {}
        copyDirShim(depSrc, chalkSiblingDep);
        const siblingFiles = walkModule(chalkSiblingDep);
        const siblingMap = {};
        for (const [rel] of siblingFiles) siblingMap[rel] = rel;
        manifest.packages["node-llama-cpp/node_modules/" + dep] = siblingMap;
      }
    }
    if (!manifest.packages["node-llama-cpp/node_modules/chalk"]) {
      manifest.packages["node-llama-cpp/node_modules/chalk"] = {};
    }
    // node-llama-cpp/node_modules/chalk mirrors the top-level
    // chalk install wholesale — no extra files of its own.
    manifest.packages["node-llama-cpp/node_modules/chalk"] = chalkPkgMap;
  }
  // Compute the fingerprint AFTER every post-step that mutates
  // native-cache (chalk shim, etc.). The runtime uses this to
  // detect divergence and force-re-unpack packages whose source
  // content changed without a manifest file-list change.
  const fpLines = [];
  function walkForFingerprint(dir, rel = "") {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.isDirectory()) {
        walkForFingerprint(join(dir, ent.name), rel + ent.name + "/");
      } else if (ent.isFile()) {
        try {
          const buf = readFileSync(join(dir, ent.name));
          const h = createHash("sha256").update(buf).digest("hex").slice(0, 16);
          fpLines.push(rel + ent.name + " " + h);
        } catch { /* AV lock — skip */ }
      }
    }
  }
  walkForFingerprint(nativeCacheDir);
  // P32 — include scripts-runtime/ + migrations/ source content in the
  // fingerprint (see the fast-build path for the full rationale: the
  // runtime's existsSync guard on <baseDir>/scripts/ means a changed
  // helper ps1 needs a fresh <baseDir> to take effect).
  for (const extraDir of ["scripts-runtime", "migrations"]) {
    const extraPath = join(ROOT, extraDir);
    if (existsSync(extraPath)) walkForFingerprint(extraPath, extraDir + "/");
  }
  manifest.__fingerprint__ = createHash("sha256")
    .update(fpLines.sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  const manifestPath = join(DIST, "sag.native-map.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 0));
  log(
    "  + manifest: dist/sag.native-map.manifest.json",
    `(${(statSync(manifestPath).size / 1024).toFixed(1)} KB) fingerprint=${manifest.__fingerprint__}`,
  );
  log(
    "✓ native-cache:",
    "dist/native-cache/",
    `(${(totalBytes / 1024 / 1024).toFixed(2)} MB unpacked across ${Object.keys(manifest.packages).length} package(s))`,
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
  // Stage next to sag.bundle.cjs inside native-cache/__bundle__/.
  // embedding-worker-client's first lookup is
  // <exeDir>/native-cache/__bundle__/sag.embedding-worker.cjs — until
  // this copy existed, the worker file only sat in dist/ and never
  // shipped, so local-BGE fell back to in-process ONNX in the MAIN
  // process and a native ONNX crash killed the whole backend
  // (observed as desktop "闪退" on the local-model test button,
  // exit code 0xC06D007F).
  const bundleStage = join(DIST, "native-cache", "__bundle__");
  mkdirSync(bundleStage, { recursive: true });
  copyFileSync(workerOut, join(bundleStage, "sag.embedding-worker.cjs"));
  log("✓ embedding-worker staged:", "dist/native-cache/__bundle__/sag.embedding-worker.cjs");

  // The DB-write worker gets the same treatment. Without a staged
  // .cjs entry the pool could only look for `src/workers/db-write-
  // worker-entry.ts` (dev-only paths), so in the SEA build it ALWAYS
  // failed with "db-write-worker entry not found" and every document
  // write landed on the main thread (2026-10-29: one error per
  // ingested document, visible in the log as a repeating warning).
  const dbWriteOut = join(DIST, "sag.db-write-worker.cjs");
  await build({
    entryPoints: [join(ROOT, "src/workers/db-write-worker-entry.ts")],
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
    outfile: dbWriteOut,
    logLevel: "warning",
    banner: {
      js: [
        "// SAG db-write-worker — runs as a child process, keeps bulk",
        "// SQLite writes off the main thread. Spawned by",
        "// src/services/db-write-worker-pool.ts.",
        'var import_meta_url = require("url").pathToFileURL(__filename).href;'
      ].join("\n")
    },
    define: {
      "import.meta.url": "import_meta_url"
    }
  });
  log("✓ db-write-worker bundle:", "dist/sag.db-write-worker.cjs");
  copyFileSync(dbWriteOut, join(bundleStage, "sag.db-write-worker.cjs"));
  log("✓ db-write-worker staged:", "dist/native-cache/__bundle__/sag.db-write-worker.cjs");
}

// unpackOnce — module-level copy used at BUILD time only. The
// runtime copy lives inside the entry template literal (sag.entry.cjs
// has its own function declaration that's part of the runtime
// payload). Don't delete this without also updating the runtime
// copy further down — if you delete it the build-time call from
// SCRIPTS_DIR below throws ReferenceError.
function unpackOnce() {
  const exeDir = dirname(process.execPath);
  const exeBase = basename(process.execPath, ".exe");
  const manifestPath = join(exeDir, exeBase + ".native-map.manifest.json");
  const sourceCacheDir = join(exeDir, "native-cache");
  if (!existsSync(manifestPath)) {
    throw new Error(
      exeBase + ".native-map.manifest.json is missing next to " + basename(process.execPath) + " " +
      "(and native-cache/ dir is also expected next to the exe). " +
      "Expected at: " + manifestPath,
    );
  }
  if (!existsSync(sourceCacheDir)) {
    throw new Error(
      "native-cache/ dir is missing next to " + basename(process.execPath) + ". " +
      "Expected at: " + sourceCacheDir,
    );
  }
  const manifestJson = readFileSync(manifestPath, "utf8");
  const MANIFEST = JSON.parse(manifestJson);
  // The manifest carries a __fingerprint__ that the build script
  // computes by hashing every file in the source-cache dir. If
  // the runtime's previously-unpacked tree was built with a
  // different fingerprint (e.g. because the build script swapped
  // the chalk v5 install for v4 after the user already booted the
  // exe once), we need to detect that and force-re-unpack the
  // packages that the build marked as "patched" via PATCHED_PKGS.
  // Without this check, the if (existsSync(out)) continue; below
  // would skip the v4 file and the runtime would still load v5
  // (which throws "chalk.blue is not a function" at the first
  // llama.cpp status log).
  const fingerprintPath = join(baseDir, ".fingerprint");
  let forceReUnpack = false;
  if (MANIFEST.__fingerprint__) {
    if (existsSync(fingerprintPath)) {
      const prev = readFileSync(fingerprintPath, "utf8");
      if (prev !== MANIFEST.__fingerprint__) forceReUnpack = true;
    } else {
      forceReUnpack = true;
    }
  }
  const sig = crypto
    .createHash("sha256")
    .update(manifestJson)
    .digest("hex")
    .slice(0, 12);
  let baseDir;
  const envOverride = process.env.SAG_NATIVE_CACHE_DIR;
  const candidates = [];
  if (envOverride) candidates.push(join(envOverride, "sag-sea-native-" + sig));
  candidates.push(join(exeDir, "native-cache", sig));
  candidates.push(join(os.tmpdir(), "sag-sea-native-" + sig));
  for (const c of candidates) {
    try {
      mkdirSync(c, { recursive: true });
      const probe = join(c, ".sag-write-probe");
      writeFileSync(probe, "1");
      rmSync(probe);
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
  const nodeModulesDir = join(baseDir, "node_modules");
  const bundleDir = join(baseDir, "__bundle__");
  mkdirSync(nodeModulesDir, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });
  // Packages that we patch in the source cache after writing the
  // manifest (e.g. the chalk v4 shim replaces v5). The unpack must
  // re-copy these every boot, even when the source-cache signature
  // (and therefore the manifest hash) hasn't changed, because the
  // previous boot may have written a v5 file that fails the v4
  // contract. Always-overwrite keeps the unpacks honest without
  // needing the fingerprint dance.
  const FORCE_OVERWRITE = new Set([
    "chalk",
    "node-llama-cpp/node_modules/chalk",
  ]);
  for (const [pkg, files] of Object.entries(MANIFEST.packages || {})) {
    const pkgDir = join(nodeModulesDir, pkg);
    mkdirSync(pkgDir, { recursive: true });
    // isPatched = package is in the FORCE_OVERWRITE set. We
    // unconditionally force-re-unpack these because their
    // on-disk content can diverge from the manifest's file
    // list (e.g. chalk v5 → v4 shim, where the manifest lists
    // v5 source/utilities.js but the disk now has v4 source/util.js).
    const isPatched = FORCE_OVERWRITE.has(pkg);
    for (const [rel, cachedRel] of Object.entries(files)) {
      const out = join(pkgDir, rel);
      mkdirSync(dirname(out), { recursive: true });
      if (existsSync(out) && !isPatched) continue;
      const src = join(sourceCacheDir, pkg, cachedRel);
      try {
        copyFileSync(src, out);
      } catch (err) {
        throw new Error(
          "failed to copy " + src + " -> " + out + ": " + err.message +
          "\nThis usually means Windows AV or SmartScreen is locking the .node/.dll file. " +
          "Add the native-cache/ dir to your AV exclusion list and try again."
        );
      }
    }
    if (!existsSync(join(pkgDir, "package.json"))) {
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
      );
    }
  }
  if (MANIFEST.__bundle__) {
    const bundleSrc = join(sourceCacheDir, MANIFEST.__bundle__);
    const bundleDst = join(bundleDir, "sag.bundle.cjs");
    if (!existsSync(bundleDst)) {
      copyFileSync(bundleSrc, bundleDst);
    }
  }
  // Persist the build fingerprint so the next boot can detect
  // divergence and force-re-unpack the packages that the build
  // script marked as patched (e.g. the chalk v4 shim).
  if (MANIFEST.__fingerprint__) {
    writeFileSync(fingerprintPath, MANIFEST.__fingerprint__);
  }
  return baseDir;
}

// stepEntry is the only place that generates the entry template
// literal. Important: the entry string contains its OWN runtime copy
// of unpackOnce (it's part of sag.entry.cjs when the SEA host boots).
// Do NOT delete that — sag.exe needs to call it on every boot.
function stepEntry() {
  log("entry: writing");
  // unpackOnce is intentionally NOT called at build time: the
  // manifest sidecar / native-cache dir only land next to the
  // produced exe at the very end of the build pipeline, after the
  // SEA blob is injected. The runtime copy of unpackOnce() below
  // resolves the path inside sag.exe's process context.
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
  // HISTORY: scripts-runtime/ files were once compiled into the SEA
  // bundle as base64 (`sag.scripts.json`) and unpacked at boot into
  // native-cache. That hid the readers from operators, which made
  // per-environment customization (encrypted-DLP bypass, custom
  // OCR pipelines, COM-only environments) require an exe rebuild.
  //
  // CURRENT: scripts-runtime/ + sag-readers/ are STAGED as plain files
  // under `<exe-dir>/sag-readers/` next to sag.exe. Operators can edit
  // them in place without rebuilding, and the runtime
  // (`src/watcher/external-reader.ts`) dispatches to them first, falling
  // back to the in-process TS parsers if nothing accepts the file. The
  // spec at sag-readers/SPEC.md defines the contract.
  //
  // We still emit `sag.scripts.json` (empty object) so any older runtime
  // fallback path that reads it doesn't crash — but it's a no-op.
  const scriptsRuntimeSrcDir = join(ROOT, "scripts-runtime");
  const sagReadersSrcDir = join(ROOT, "sag-readers");
  const scriptsMap = {};
  if (existsSync(scriptsRuntimeSrcDir)) {
    for (const f of readdirSync(scriptsRuntimeSrcDir)) {
      const full = join(scriptsRuntimeSrcDir, f);
      if (!existsSync(full)) continue;
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      scriptsMap[f] = readFileSync(full).toString("base64");
    }
    log(`✓ scripts-runtime source staged (legacy fallback): ${Object.keys(scriptsMap).length} file(s)`);
  }
  if (existsSync(sagReadersSrcDir)) {
    const readerFiles = readdirSync(sagReadersSrcDir).filter((f) =>
      existsSync(join(sagReadersSrcDir, f)) && statSync(join(sagReadersSrcDir, f)).isFile()
    );
    log(`✓ sag-readers/ source staged: ${readerFiles.length} file(s) -> ${readerFiles.join(", ")}`);
  } else {
    log("! sag-readers/ source dir not found — runtime will fall back to in-process parsers only");
  }
  writeFileSync(join(DIST, "sag.scripts.json"), JSON.stringify(scriptsMap));


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

  // Compute the COMPLETE require-closure of the embedding roots over the
  // manifest's package set. It is injected into the runtime entry as the
  // background-unpack priority tier; the ".sag-unpack-embedding-ready"
  // stamp is written only after ALL of these packages are in place, so
  // the app's embedding gate never opens on a half-copied tree.
  //
  // Why computed (not hand-listed): the first hand-written list forgot
  // onnxruntime-web — @xenova/transformers requires it from
  // src/backends/onnx.js — so the stamp landed while the worker still
  // crashed, and the load failure was cached for the whole process
  // lifetime (2026-10-27, v2 smoke test).
  //
  // Why nested package.jsons are walked too: the manifest flattens
  // nested installs into the PARENT package's file list (e.g.
  // @xenova/transformers carries node_modules/sharp@0.32 inside its own
  // cache tree). A nested copy can declare deps the root install does
  // not — sharp@0.32 declares `color`, root sharp@0.35 does not — and
  // the worker dies with "Cannot find module 'color'" if the tier only
  // follows root package.jsons (2026-10-27, v2 smoke test round 2).
  const EMBEDDING_ROOTS = ["@xenova/transformers", "onnxruntime-node", "onnxruntime-web", "sharp", "@huggingface/jinja"];
  const embeddingPriority = [];
  {
    const manifestForClosure = JSON.parse(readFileSync(join(DIST, "sag.native-map.manifest.json"), "utf8"));
    const pkgSet = manifestForClosure.packages || {};
    const seen = new Set();
    const queue = [...EMBEDDING_ROOTS];
    // Collect every package.json under a cache-tree package dir: the
    // root one plus each nested node_modules copy (bounded depth —
    // pnpm nests at most a few levels).
    const collectPkgJsonPaths = (pkgRoot) => {
      const found = [];
      const walk = (dir, depth) => {
        if (depth > 6) return;
        const own = join(dir, "package.json");
        if (existsSync(own)) found.push(own);
        let ents;
        try { ents = readdirSync(join(dir, "node_modules"), { withFileTypes: true }); } catch { return; }
        for (const ent of ents) {
          if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
          const sub = join(dir, "node_modules", ent.name);
          if (ent.name.startsWith("@")) {
            // Scoped namespace: each member is a package dir.
            let scoped;
            try { scoped = readdirSync(sub, { withFileTypes: true }); } catch { continue; }
            for (const s of scoped) {
              if (s.isDirectory() && !s.name.startsWith(".")) walk(join(sub, s.name), depth + 1);
            }
          } else {
            walk(sub, depth + 1);
          }
        }
      };
      walk(pkgRoot, 0);
      return found;
    };
    while (queue.length) {
      const pkg = queue.shift();
      if (seen.has(pkg) || !pkgSet[pkg]) continue;
      seen.add(pkg);
      embeddingPriority.push(pkg);
      for (const pjPath of collectPkgJsonPaths(join(DIST, "native-cache", pkg))) {
        let pkgJson;
        try {
          pkgJson = JSON.parse(readFileSync(pjPath, "utf8"));
        } catch { continue; }
        for (const dep of [
          ...Object.keys(pkgJson.dependencies || {}),
          ...Object.keys(pkgJson.optionalDependencies || {}),
        ]) {
          if (!seen.has(dep)) queue.push(dep);
        }
      }
    }
  }
  log(
    "entry: embedding priority tier =",
    embeddingPriority.length,
    "package(s):",
    embeddingPriority.join(", "),
  );

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

const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Node built-ins (path, fs, os, crypto) MUST be required before the
// runtime copy of unpackOnce() below, because that function reads
// them from its enclosing scope. V8's TDZ would otherwise throw
// "Cannot access 'path' before initialization" the moment sag.exe
// calls unpackOnce() at boot.

// unpackOnce — runtime copy. Reads the manifest sidecar + raw-binary
// tree next to the exe and stages them into a per-machine sandbox dir.
// This MUST stay in sync with the module-level unpackOnce() in this
// file: any change here (file layout, sig strategy, etc.) needs to
// mirror the build-time copy or sag.exe will look for files at the
// wrong paths after the first boot.
function unpackOnce() {
  const exeDir = path.dirname(process.execPath);
  const exeBase = path.basename(process.execPath, ".exe");
  const manifestPath = path.join(exeDir, exeBase + ".native-map.manifest.json");
  const sourceCacheDir = path.join(exeDir, "native-cache");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      exeBase + ".native-map.manifest.json is missing next to " + path.basename(process.execPath) + " " +
      "(and native-cache/ dir is also expected next to the exe). " +
      "Expected at: " + manifestPath,
    );
  }
  if (!fs.existsSync(sourceCacheDir)) {
    throw new Error(
      "native-cache/ dir is missing next to " + path.basename(process.execPath) + ". " +
      "Expected at: " + sourceCacheDir,
    );
  }
  const manifestJson = fs.readFileSync(manifestPath, "utf8");
  const MANIFEST = JSON.parse(manifestJson);
  const sig = crypto
    .createHash("sha256")
    .update(manifestJson)
    .digest("hex")
    .slice(0, 12);
  let baseDir;
  const envOverride = process.env.SAG_NATIVE_CACHE_DIR;
  const candidates = [];
  if (envOverride) candidates.push(path.join(envOverride, "sag-sea-native-" + sig));
  candidates.push(path.join(exeDir, "native-cache", sig));
  candidates.push(path.join(os.tmpdir(), "sag-sea-native-" + sig));
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
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
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const bundleDir = path.join(baseDir, "__bundle__");
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  // The bulk native-package copy runs in the BACKGROUND (see
  // unpackNativePackagesInBackground below) so the HTTP server can bind
  // immediately. Here we copy the packages the bundle requires AT
  // MODULE LOAD — if one is missing the process dies with
  // "Cannot find module 'X'" before the server binds.
  //
  // The set is the CLOSURE over the bundle's own top-level requires,
  // resolved from each package's "dependencies" in package.json. A
  // hand-maintained list is not enough: better-sqlite3 pulls in
  // "bindings", which pulls in "file-uri-to-path", and each of those
  // is required at load time too. We discovered that the hard way
  // ("Cannot find module 'bindings'" at boot).
  //
  // The roots are the bare specifiers the bundle requires directly:
  //   ajv, ajv-formats, pg-native, better-sqlite3, sqlite-vec
  //
  // Everything else (the big optional trees: node-llama-cpp,
  // onnxruntime, transformers, …) is copied in the background pass.
  //
  // WHY the split: Windows AV scans every .dll / .node as it lands.
  // Copying the node-llama-cpp DLLs can block for minutes — and because
  // the whole unpack used to run at module load, the server never got a
  // chance to bind. The user saw "nothing loads" on first run, and if
  // the copy stalled on a locked file the app hung forever (observed
  // 2026-10-26: the unpack stopped at 2,795 files and never finished).
  const EAGER_ROOTS = ["ajv", "ajv-formats", "pg-native", "better-sqlite3", "sqlite-vec"];
  const eagerPackages = new Set();
  {
    const queue = [...EAGER_ROOTS];
    while (queue.length) {
      const pkg = queue.shift();
      if (eagerPackages.has(pkg)) continue;
      eagerPackages.add(pkg);
      // Resolve this package's dependencies from the SOURCE cache's
      // package.json (the per-machine copy may not exist yet).
      let pkgJson;
      try {
        pkgJson = JSON.parse(
          fs.readFileSync(path.join(sourceCacheDir, pkg, "package.json"), "utf8")
        );
      } catch {
        continue;
      }
      for (const dep of Object.keys(pkgJson.dependencies || {})) {
        // Only follow deps that are actually shipped in the cache.
        if (MANIFEST.packages[dep] && !eagerPackages.has(dep)) {
          queue.push(dep);
        }
      }
      // optionalDependencies matter too: sqlite-vec loads its native
      // extension from the optional "sqlite-vec-windows-x64"
      // package, and without it the DB boots without vector support
      // ("sqlite-vec load failed: Cannot find module
      // 'sqlite-vec-windows-x64/vec0.dll'").
      for (const dep of Object.keys(pkgJson.optionalDependencies || {})) {
        if (MANIFEST.packages[dep] && !eagerPackages.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }
  for (const [pkg, files] of Object.entries(MANIFEST.packages || {})) {
    const pkgDir = path.join(nodeModulesDir, pkg);
    if (!eagerPackages.has(pkg)) {
      try {
        fs.mkdirSync(pkgDir, { recursive: true });
      } catch {
        /* the background pass creates it */
      }
      continue;
    }
    try {
      fs.mkdirSync(pkgDir, { recursive: true });
      for (const [rel, cachedRel] of Object.entries(files)) {
        const out = path.join(pkgDir, rel);
        if (fs.existsSync(out)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(path.join(sourceCacheDir, pkg, cachedRel), out);
      }
      if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
        fs.writeFileSync(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
        );
      }
    } catch (err) {
      // A locked file here is fatal — the bundle cannot run without it.
      throw new Error(
        "failed to stage required package " + pkg + ": " + err.message +
        " (This usually means Windows AV is locking the .node/.dll file. " +
        "Add the native-cache/ dir to your AV exclusion list and try again.)"
      );
    }
  }
  if (MANIFEST.__bundle__) {
    const bundleSrc = path.join(sourceCacheDir, MANIFEST.__bundle__);
    const bundleDst = path.join(bundleDir, "sag.bundle.cjs");
    // P30 fix: always overwrite the runtime bundle. The previous
    // existsSync-only guard meant a stale %TEMP%/sag-sea-native-<sig>/
    // __bundle__/sag.bundle.cjs from a prior build would never be
    // refreshed even when the manifest's package list changed (e.g.
    // admin-routes schema fix). The bundle is small (~9 MB) and the
    // I/O cost is dwarfed by the rest of unpackOnce, so just sync it.
    try {
      fs.copyFileSync(bundleSrc, bundleDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.bundle.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  // Copy the embedding worker next to the bundle.
  //
  // embedding-worker-client.ts looks for
  //   <exeDir>/native-cache/__bundle__/sag.embedding-worker.cjs
  // and, if it is missing, logs
  //   "local-bge worker unavailable - falling back to in-process embedding"
  // and runs ONNX on the MAIN thread. That fallback blocks the event
  // loop for the whole embedding batch, so /health and every
  // watched-folders endpoint time out while a workbook is ingested —
  // which is exactly the "UI stops loading" symptom.
  //
  // Always overwrite (same reasoning as the bundle above): a stale
  // worker from a previous build must not survive a version change.
  if (MANIFEST.__embeddingWorker__) {
    const workerSrc = path.join(sourceCacheDir, MANIFEST.__embeddingWorker__);
    const workerDst = path.join(bundleDir, "sag.embedding-worker.cjs");
    try {
      fs.copyFileSync(workerSrc, workerDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.embedding-worker.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  // Copy the DB-write worker next to the bundle.
  //
  // db-write-worker-pool.ts spawns this bundle as a child process and
  // resolves it from <base>/__bundle__/. Without the copy the pool can
  // only look for the dev-mode .ts source, so a packaged build ALWAYS
  // failed with "db-write-worker entry not found" and every document's
  // bulk write landed on the main thread (2026-10-29: one warning per
  // ingested document, and the main thread stayed busy during writes).
  if (MANIFEST.__dbWriteWorker__) {
    const dbWriteSrc = path.join(sourceCacheDir, MANIFEST.__dbWriteWorker__);
    const dbWriteDst = path.join(bundleDir, "sag.db-write-worker.cjs");
    try {
      fs.copyFileSync(dbWriteSrc, dbWriteDst);
    } catch (err) {
      throw new Error(
        "failed to refresh __bundle__/sag.db-write-worker.cjs: " + err.message +
        " (This usually means Windows AV is locking the file. " +
        "Add the native-cache/ dir to your AV exclusion list.)"
      );
    }
  }
  return { baseDir, manifest: MANIFEST };
}

// ── Background unpack of the bulk native packages ───────────────────
//
// The runtime unpack above copies the bundle + worker (small, critical)
// synchronously so the server can start immediately. The remaining
// ~6,800 native files are copied in the BACKGROUND.
//
// The manifest is passed in rather than re-read: it is a local const
// inside unpackOnce(), so a sibling function cannot see it (we tried —
// the pass died immediately with "MANIFEST is not defined").
//
// Everything here is ASYNC on purpose. The synchronous copy blocks the
// event loop for the whole copy — and when Windows AV holds a large
// .dll, that block can last minutes. With a synchronous copy the
// server could not answer /health for that whole time, which is
// exactly the "UI stops loading" symptom. The async version keeps the
// event loop free: the server answers while the copy proceeds behind
// it.
//
// A file the AV holds is retried a few times and then SKIPPED (not
// fatal) — the optional package it belongs to simply stays
// unavailable, which is far better than an app that never starts.
// Each copy has a timeout so one wedged file cannot stall the pass.
async function unpackNativePackagesInBackground(baseDir, MANIFEST) {
  const sourceCacheDir = path.join(path.dirname(process.execPath), "native-cache");
  const nodeModulesDir = path.join(baseDir, "node_modules");
  const stamp = path.join(baseDir, ".sag-unpack-complete");
  const fsp = fs.promises;
  let skipped = 0;
  let copied = 0;
  const MAX_ATTEMPTS = 3;
  const COPY_TIMEOUT_MS = 20_000;
  // Log the start so a failure to even begin is visible. The pass runs
  // before the log tees are installed, so this goes to the raw stdout.
  console.log("[sag-boot] native-cache background unpack starting...");
  const copyWithTimeout = async (src, dst) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("copy timed out")), COPY_TIMEOUT_MS);
      // NOTE: do NOT unref() this timer. An unref'd timer does not keep
      // the event loop alive, and — critically — it does not fire
      // while the loop is otherwise idle. The pass would then hang
      // forever on a wedged copy instead of timing out. (Measured: an
      // unref'd timer scheduled for 3 s never fired; the process had
      // nothing else pending.) The timer is always cleared in the
      // finally block, so it cannot keep the process alive beyond the
      // copy it guards.
    });
    try {
      await Promise.race([fsp.copyFile(src, dst), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Embedding-critical packages FIRST. The orphan-requeue reaper (and
  // any user-triggered sync) starts embedding within seconds of boot;
  // if the worker cannot require @xenova/transformers because its files
  // are still mid-copy, embedding falls back to the in-process ONNX
  // path and blocks the main event loop — the exact "UI stops loading
  // after a restart" symptom (2026-10-27). Copying this tier first
  // shrinks the window from minutes (full pass) to seconds, and the
  // stamp written after the tier is what the app's native-cache-ready
  // gate waits on.
  //
  // The tier is the COMPLETE require-closure of the embedding roots,
  // computed at build time from each package's package.json
  // (dependencies + optionalDependencies) over the manifest's package
  // set. A hand-written list is not enough: the first attempt forgot
  // onnxruntime-web (@xenova/transformers requires it from
  // src/backends/onnx.js), the stamp landed early, the worker crashed
  // on the missing package, and the load failure got cached for the
  // whole process lifetime.
  const EMBEDDING_FIRST_SET = new Set(__EMBEDDING_PRIORITY_JSON__);
  const EMBEDDING_FIRST = (pkg) => EMBEDDING_FIRST_SET.has(pkg);
  const copyOnePackage = async (pkg, files) => {
    const pkgDir = path.join(nodeModulesDir, pkg);
    try {
      await fsp.mkdir(pkgDir, { recursive: true });
    } catch {
      return;
    }
    for (const [rel, cachedRel] of Object.entries(files)) {
      const out = path.join(pkgDir, rel);
      if (fs.existsSync(out)) continue;
      const src = path.join(sourceCacheDir, pkg, cachedRel);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await fsp.mkdir(path.dirname(out), { recursive: true });
          await copyWithTimeout(src, out);
          copied++;
          break;
        } catch (err) {
          if (attempt === MAX_ATTEMPTS) {
            skipped++;
            continue;
          }
          // AV lock — back off briefly and retry.
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }
    try {
      if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
        await fsp.writeFile(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: pkg, version: "0.0.0", main: "index.js", type: "commonjs" }, null, 2),
        );
      }
    } catch {
      /* best-effort */
    }
    // Progress line, so a stall is visible in the log instead of
    // looking like a frozen app.
    console.log(
      "[sag-boot] native-cache: " + copied + " copied, " + skipped + " skipped (at " + pkg + ")"
    );
  };
  const allEntries = Object.entries(MANIFEST.packages || {});
  const firstTier = allEntries.filter((entry) => EMBEDDING_FIRST(entry[0]));
  const restTier = allEntries.filter((entry) => !EMBEDDING_FIRST(entry[0]));
  for (const entry of firstTier) {
    await copyOnePackage(entry[0], entry[1]);
  }
  // Signal that the embedding-critical tier has landed. The app's
  // waitForNativeCacheReady() gate resolves on this stamp (or on the
  // final .sag-unpack-complete stamp written by older builds).
  try {
    fs.writeFileSync(path.join(baseDir, ".sag-unpack-embedding-ready"), "1");
  } catch {
    /* best-effort */
  }
  console.log("[sag-boot] native-cache: embedding-critical packages ready");
  for (const entry of restTier) {
    await copyOnePackage(entry[0], entry[1]);
  }
  try {
    fs.writeFileSync(stamp, MANIFEST.__fingerprint__ || "1");
  } catch {
    /* best-effort */
  }
  console.log(
    "[sag-boot] native-cache background unpack done: " + copied +
    " file(s) copied, " + skipped + " skipped"
  );
}

const UNPACKED = unpackOnce();
const NATIVE_DIR = UNPACKED.baseDir;

// Kick off the heavy native-package copy in the background so the HTTP
// server can bind immediately. Failures here are non-fatal: the
// optional native packages that did not make it simply stay absent.
void unpackNativePackagesInBackground(NATIVE_DIR, UNPACKED.manifest).catch((err) => {
  console.error("[sag-boot] native-cache background unpack failed:", err && err.message);
  try {
    process.stderr.write(
      "[sag-boot] native-cache background unpack failed: " +
        ((err && err.stack) || String(err)) + String.fromCharCode(10)
    );
  } catch {
    /* ignore */
  }
});

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

const Module = require("module");

// Always-on log redirection. SAG.exe can be launched in three ways:
//   1) PowerShell "Start-Process ... -RedirectStandardOutput" — stdout
//      goes to whatever file the launcher picks; nothing to do here.
//   2) Double-click the .exe from Explorer — there is no console at
//      all, console.log output is dropped on Windows.
//   3) "& 'C:\path\SAG.exe'" from a shell — stdout goes to the user's
//      terminal but is NOT captured to a file unless they explicitly
//      tee or redirect.
//
// The user has been bitten by case (3) repeatedly: they launch SAG.exe
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
        try {
          return origStdoutWrite(chunk, ...rest);
        } catch (err) {
          // EPIPE: the parent (the Electron shell) closed the pipe.
          //
          // This MUST be swallowed. The original code let it throw, and
          // because the wrapper runs on EVERY log line, the throw was
          // itself logged — which produced a new EPIPE, which was
          // logged again, forever. A single run generated 41,933
          // EPIPE stack traces (76 MB of log) and burned CPU on the
          // error path instead of doing real work.
          //
          // The file tee above still works, so the log file keeps
          // receiving everything even after stdout is gone.
          const code = err && err.code;
          if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
            return true;
          }
          throw err;
        }
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
        try {
          return origStderrWrite(chunk, ...rest);
        } catch (err) {
          // Same EPIPE storm as stdout: swallowing it here stops the
          // error log from eating the disk (we saw a single run write
          // 41,933 EPIPE stack traces).
          const code = err && err.code;
          if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
            return true;
          }
          throw err;
        }
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

// Unpack the embedded file-converter scripts (Python + PowerShell
// helpers) into the native-cache directory so the runtime can spawn
// them without exposing them on the user's filesystem. We deliberately
// do NOT write them next to the exe — end users should never see the
// decryption helpers, and exposing them under exeDir/scripts/ would
// defeat that.
// Reuse the dir unpackOnce() already resolved — calling it again would
// re-run the whole native-cache unpack.
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
// (e.g. sag.exe → SAG-backend.exe) doesn't break the lookup.
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
// Expose the unpacked native-cache root so the bundle can locate
// .node binaries, ESM platform packages (@node-llama-cpp/win-x64),
// and any other unpacked file at runtime. Without this, the bundle
// would have to recompute the manifest sig + baseDir itself just to
// reach its own files, which is brittle and racy if a sibling
// process is also unpacking into the same %TEMP%.
process.env.SAG_NATIVE_CACHE_DIR = NATIVE_DIR;

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
  // Inject the build-time-computed embedding priority closure. A
  // function replacer is used so `$`-sequences in the JSON can't be
  // misread as replacement patterns.
  const entryFinal = entry.replace("__EMBEDDING_PRIORITY_JSON__", () => JSON.stringify(embeddingPriority));
  writeFileSync(entryPath, entryFinal);
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
  // The SEA blob must be produced by the SAME Node major we plan to
  // inject it into. Mismatched V8 ABIs cause:
  //   FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
  // at boot, with exit code 134 (SIGABRT). The host's `node` may be
  // a different version than the Windows Node we ship inside the
  // final .exe, so we let the caller pin it via SAG_SEA_NODE_EXE.
  // Default: host's `node`.
  const nodeExe = process.env.SAG_SEA_NODE_EXE || "node";
  log(`sea: generating blob via ${nodeExe} --experimental-sea-config`);
  // execFileSync (not execSync with shell:true): the project path
  // contains CJK characters and cmd.exe cannot parse them, so the
  // shell form failed with "The system cannot find the path specified"
  // even though the very same command worked from PowerShell.
  execFileSync(resolve(nodeExe), ["--experimental-sea-config", resolve(DIST, "sea-config.json")], {
    cwd: resolve(DIST),
    stdio: "inherit",
  });
  const blob = join(DIST, "sag.blob");
  log(
    "✓ blob: dist/sag.blob",
    `(${(statSync(blob).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

(async () => {
  mkdirSync(DIST, { recursive: true });

  // Ensure TypeScript is compiled before esbuild reads dist/ sources.
  // Without this, if tsc hasn't run (e.g. after npm run clean), esbuild
  // bundles stale .js files and changes to .ts sources have no effect.
  execSync("npm run build:api", { cwd: ROOT, stdio: "inherit" });

  // Clean stale build artefacts so retries start fresh.
  for (const f of ["sag.bundle.cjs", "sag.native-map.json", "sag.entry.cjs", "sea-config.json", "sag.blob"]) {
    try { rmSync(join(DIST, f), { force: true }); } catch {}
  }

  await stepBundle();
  await stepWorkerBundle();
  await stepNativeMap();
  // Post-step fix: better-sqlite3 v12.11.1 has no prebuild for
  // node-v137 in the npm registry. We hand-downloaded it and dropped
  // the binary into node_modules/better-sqlite3/build/Release. The
  // native-map walker doesn't include .node binaries in the manifest
  // (it only walks package.jsons), so we patch the manifest here to
  // include the three canonical paths that bindings.js probes at
  // runtime. Without this fix the SEA exe fails with "Could not locate
  // the bindings file" on the very first query.
  execSync("node scripts/fix-better-sqlite3-binary.mjs", {
    cwd: ROOT,
    stdio: "inherit",
  });
  await stepEntry();

  // Honour --skip-sea: skip the slow postject blob generation when
  // we're just iterating on TS code. Saves ~30-60s per iteration.
  // The CJS bundle + native-map + entry are still produced; only the
  // final .exe injection step is skipped. The deploy path needs the
  // SEA blob for the actual production exe, so run without --skip-sea
  // before shipping.
  if (process.argv.includes("--skip-sea")) {
    log("skip-sea: skipping blob generation (use plain build:sea-bundle to ship)");
    return;
  }
  await stepConfig();
  await stepBlob();
  log("DONE — run npm run build:windows-exe to finish.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
