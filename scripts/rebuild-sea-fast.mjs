#!/usr/bin/env node
// rebuild-sea-fast.mjs — Rebuild dist/ SEA artifacts WITHOUT spawning npm
// (npm spawns hang in this sandbox due to piped-stdio EPERM). Steps:
//   1. tsc (build:api) via direct tsc invocation
//   2. copy migrations to dist/src/db/sqlite/migrations/
//   3. regenerate dist/sag.migrations.json (base64 map)
//   4. esbuild bundle dist/src/index.js -> dist/sag.bundle.cjs
//   5. copy bundle to dist/native-cache/__bundle__/
// Caller then runs write-entry.cjs, SEA blob, build-windows-exe.mjs.
import { build } from "esbuild";
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync,
  copyFileSync, existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");

function log(...a) { console.log("[rebuild]", ...a); }

// 1. TypeScript compile (API only — web build not needed for SEA exe)
log("tsc...");
{
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: ROOT, stdio: "inherit" }
  );
  if (r.status !== 0) throw new Error("tsc failed: " + r.status);
}

// 2. Copy migrations into dist
log("copy migrations...");
{
  const src = join(ROOT, "src", "db", "sqlite", "migrations");
  const dst = join(DIST, "src", "db", "sqlite", "migrations");
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith(".sql")) copyFileSync(join(src, f), join(dst, f));
  }
}

// 3. Regenerate sag.migrations.json
log("migrations.json...");
{
  const src = join(DIST, "src", "db", "sqlite", "migrations");
  const map = {};
  for (const f of readdirSync(src)) {
    if (f.endsWith(".sql")) map[f] = readFileSync(join(src, f)).toString("base64");
  }
  writeFileSync(join(DIST, "sag.migrations.json"), JSON.stringify(map));
  log("  " + Object.keys(map).length + " migrations packed");
}

// 4. esbuild bundle (mirrors build-sea-bundle.mjs stepBundle externals)
log("esbuild bundle...");
{
  const NATIVE_DEPS = [
    "better-sqlite3", "sqlite-vec", "onnxruntime-node", "sharp",
    "bindings", "node-llama-cpp", "@node-llama-cpp", "@xenova/transformers",
  ];
  const EXTERNAL_ESM = [
    "@xenova/transformers", "onnxruntime-web", "@huggingface/jinja",
    "node-llama-cpp",
    "@node-llama-cpp/win-x64", "@node-llama-cpp/win-x64-cuda",
    "@node-llama-cpp/win-x64-cuda-ext", "@node-llama-cpp/win-x64-vulkan",
    "@node-llama-cpp/win-arm64", "@node-llama-cpp/mac-x64",
    "@node-llama-cpp/mac-arm64-metal", "@node-llama-cpp/linux-x64",
    "@node-llama-cpp/linux-x64-cuda", "@node-llama-cpp/linux-x64-cuda-ext",
    "@node-llama-cpp/linux-x64-vulkan", "@node-llama-cpp/linux-arm64",
    "@node-llama-cpp/linux-armv7l", "@node-llama-cpp/linux-riscv64",
  ];
  const externalPlugin = {
    name: "sag-external-glob",
    setup(b) {
      b.onResolve({ filter: /@node-llama-cpp\// }, (args) =>
        args.path.startsWith("@node-llama-cpp/") ? { external: true } : null
      );
    },
  };
  await build({
    entryPoints: [join(DIST, "src", "index.js")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: [
      ...NATIVE_DEPS, ...EXTERNAL_ESM,
      "pg-native", "sharp", "@embedded-postgres/*",
    ],
    plugins: [externalPlugin],
    outfile: join(DIST, "sag.bundle.cjs"),
    // Mirror build-sea-bundle.mjs stepBundle: CJS has no import.meta,
    // so define it away and provide the value via banner (__filename
    // of the bundle itself). Without this, db-write-worker-pool's
    // fileURLToPath(import.meta.url) crashes at module load with
    // "The path argument must be of type string. Received undefined".
    banner: {
      js: 'var import_meta_url = require("url").pathToFileURL(__filename).href;',
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  log("  bundle written");
}

// 5. Copy bundle into native-cache/__bundle__ so the SEA runtime finds it
log("stage bundle in native-cache/__bundle__...");
{
  const dst = join(DIST, "native-cache", "__bundle__");
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(DIST, "sag.bundle.cjs"), join(dst, "sag.bundle.cjs"));
}

// 6. Embedding-worker bundle (mirrors build-sea-bundle.mjs
// stepWorkerBundle). The Worker(workerPath) constructor needs a real
// file on disk; embedding-worker-client looks for
// <exeDir>/native-cache/__bundle__/sag.embedding-worker.cjs first.
// Without it, local-BGE falls back to in-process ONNX in the MAIN
// process — and a native ONNX crash there (0xC06D007F on the local
// model test) takes the whole backend down (desktop "闪退").
log("esbuild embedding-worker bundle...");
{
  const { build: buildWorker } = await import("esbuild");
  await buildWorker({
    entryPoints: [join(ROOT, "src", "ai", "embedding-worker.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: [
      "better-sqlite3", "sqlite-vec", "onnxruntime-node", "sharp",
      "bindings", "node-llama-cpp", "@node-llama-cpp", "@xenova/transformers",
      "onnxruntime-web", "@huggingface/jinja",
      "@node-llama-cpp/win-x64", "@node-llama-cpp/win-x64-cuda",
      "@node-llama-cpp/win-x64-cuda-ext", "@node-llama-cpp/win-x64-vulkan",
      "@node-llama-cpp/win-arm64", "@node-llama-cpp/mac-x64",
      "@node-llama-cpp/mac-arm64-metal", "@node-llama-cpp/linux-x64",
      "@node-llama-cpp/linux-x64-cuda", "@node-llama-cpp/linux-x64-cuda-ext",
      "@node-llama-cpp/linux-x64-vulkan", "@node-llama-cpp/linux-arm64",
      "@node-llama-cpp/linux-armv7l", "@node-llama-cpp/linux-riscv64",
      "pg-native", "@embedded-postgres/*",
    ],
    outfile: join(DIST, "sag.embedding-worker.cjs"),
    logLevel: "warning",
    banner: {
      js: 'var import_meta_url = require("url").pathToFileURL(__filename).href;',
    },
    define: {
      "import.meta.url": "import_meta_url",
    },
  });
  // Stage next to sag.bundle.cjs — the SEA runtime's unpackOnce copies
  // the whole __bundle__ dir's manifest-driven files; the client probes
  // exeDir/native-cache/__bundle__/ directly (no manifest entry needed).
  copyFileSync(
    join(DIST, "sag.embedding-worker.cjs"),
    join(DIST, "native-cache", "__bundle__", "sag.embedding-worker.cjs")
  );
  log("  worker bundle staged in native-cache/__bundle__");
}

log("DONE — next: node scripts/write-entry.cjs, then SEA blob, then build-windows-exe.mjs");
