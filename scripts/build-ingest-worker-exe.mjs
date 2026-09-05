#!/usr/bin/env node
// build-ingest-worker-exe.mjs — Splice dist/sag-ingest-worker.blob into
// the cached Windows node.exe to produce 黑洞-ingest-worker.exe.
//
// Companion to build-stdio-launcher-exe.mjs. Same recipe, different blob
// and a different output filename. The cached node.exe is reused (no
// extra download) since the SEA blob is what differentiates the two.
//
// The 黑洞.exe parent spawns this on startup, and the two .exe sit in
// the same install dir sharing ./data/sag.db. End users see one
// 黑洞.exe entry in Task Manager; the worker .exe is a hidden helper.

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
const CACHE = process.env.SAG_WIN_NODE_CACHE || "/tmp/sag-win-node";
const NODE_VERSION = process.env.SAG_NODE_VERSION || "24.14.0";
const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function log(...args) {
  console.log("[ingest-worker-exe]", ...args);
}

function ensurePostject() {
  const bin = join(ROOT, "node_modules/.bin/postject");
  if (existsSync(bin)) return bin;
  log("  installing postject on demand");
  const r = spawnSync(
    "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", "postject"],
    { cwd: ROOT, stdio: "inherit", shell: true },
  );
  if (r.status !== 0) throw new Error("postject install failed");
  return bin;
}

function inject(exePath, blobPath, outExePath) {
  log("injecting ingest-worker blob into Windows node.exe");
  copyFileSync(exePath, outExePath);
  const postject = ensurePostject();
  const r = spawnSync(
    postject,
    [
      outExePath,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse", SEA_SENTINEL,
    ],
    { stdio: "inherit", shell: true },
  );
  if (r.status !== 0) throw new Error("postject failed");
}

(async () => {
  const blobPath = join(DIST, "sag-ingest-worker.blob");
  if (!existsSync(blobPath)) {
    throw new Error(
      `${blobPath} not found — run \`npm run build:ingest-worker-launcher\` first.`,
    );
  }

  const nodeExePath = join(CACHE, `node-v${NODE_VERSION}-win-x64`, "node.exe");
  if (!existsSync(nodeExePath)) {
    throw new Error(
      `cached Windows node.exe not found at ${nodeExePath}. ` +
      `Run \`npm run build:stdio-launcher-exe\` first to populate the cache, ` +
      `or \`npm run build:windows-exe\` which does the same download.`,
    );
  }

  const EXE_NAME = "黑洞-ingest-worker.exe";
  const outExePath = join(ROOT, EXE_NAME);
  try { rmSync(outExePath, { force: true }); } catch {}

  // Copy the sidecar files to the .exe's sibling, renaming them so
  // they match the .exe's basename. The SEA entry's basename lookup
  // uses process.execPath (which Windows sets to the .exe name), so
  // 黑洞-ingest-worker.exe looks for:
  //   黑洞-ingest-worker.native-map.json
  //   黑洞-ingest-worker.migrations.json
  const sidecarBase = "黑洞-ingest-worker";
  const nativeMapDst = join(ROOT, sidecarBase + ".native-map.json");
  const migrationsDst = join(ROOT, sidecarBase + ".migrations.json");
  for (const stale of ["sag-ingest-worker.native-map.json", "sag-ingest-worker.migrations.json", nativeMapDst, migrationsDst]) {
    const p = join(ROOT, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  const nativeMapSrc = join(DIST, "sag-ingest-worker.native-map.json");
  if (existsSync(nativeMapSrc)) {
    copyFileSync(nativeMapSrc, nativeMapDst);
    console.log("[ingest-worker-exe] ✓ " + sidecarBase + ".native-map.json copied next to " + EXE_NAME);
  } else {
    throw new Error("sag-ingest-worker.native-map.json missing in dist/");
  }
  const migrationsSrc = join(DIST, "sag-ingest-worker.migrations.json");
  if (existsSync(migrationsSrc)) {
    copyFileSync(migrationsSrc, migrationsDst);
    console.log("[ingest-worker-exe] ✓ " + sidecarBase + ".migrations.json copied next to " + EXE_NAME);
  } else {
    throw new Error("sag-ingest-worker.migrations.json missing in dist/");
  }

  inject(nodeExePath, blobPath, outExePath);

  console.log(`[ingest-worker-exe] ✓ ${EXE_NAME} ready: ${outExePath}`);
})().catch((err) => {
  console.error("[ingest-worker-exe]", err);
  process.exit(1);
});