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
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
const RELEASE_DIR = join(ROOT, "release");
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

function stripAuthenticodeSignature(outExePath) {
  const py = process.env.PYTHON || "python";
  if (process.platform !== "win32" && !existsSync(outExePath)) {
    return;
  }
  const r = spawnSync(
    py,
    [join(ROOT, "scripts", "strip-signature.py"), outExePath, "--keep-marker"],
    { stdio: "inherit", shell: true }
  );
  if (r.status !== 0) {
    log(`  WARN: signature strip failed (exit ${r.status}); exe is signed-but-invalid`);
  }
}

function setGuiSubsystem(outExePath) {
  const py = process.env.PYTHON || "python";
  if (process.platform !== "win32" && !existsSync(outExePath)) {
    return;
  }
  const r = spawnSync(
    py,
    [join(ROOT, "scripts", "pe-set-subsystem.py"), outExePath, "2"],
    { stdio: "inherit", shell: true }
  );
  if (r.status !== 0) {
    log(`  WARN: subsystem flip failed (exit ${r.status}); exe is still CONSOLE subsystem`);
  }
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

  const EXE_NAME = "本地知识检索-ingest-worker.exe";
  const outExePath = join(RELEASE_DIR, EXE_NAME);
  mkdirSync(RELEASE_DIR, { recursive: true });
  try { rmSync(outExePath, { force: true }); } catch {}

  // Copy the sidecar files to the .exe's sibling, renaming them so
  // they match the .exe's basename. The SEA entry's basename lookup
  // uses process.execPath (which Windows sets to the .exe name), so
  // 本地知识检索-ingest-worker.exe looks for:
  //   本地知识检索-ingest-worker.native-map.manifest.json (new)
  //   本地知识检索-ingest-worker.migrations.json
  // Plus the raw binary tree at `native-cache/` next to the exe.
  const sidecarBase = "本地知识检索-ingest-worker";
  const manifestDst = join(RELEASE_DIR, sidecarBase + ".native-map.manifest.json");
  const migrationsDst = join(RELEASE_DIR, sidecarBase + ".migrations.json");
  for (const stale of [
    "sag-ingest-worker.native-map.json",
    "sag-ingest-worker.native-map.manifest.json",
    "sag-ingest-worker.migrations.json",
    "黑洞-ingest-worker.native-map.json",
    "黑洞-ingest-worker.native-map.manifest.json",
    "黑洞-ingest-worker.migrations.json",
    manifestDst, migrationsDst,
  ]) {
    const p = join(RELEASE_DIR, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  // CRITICAL: do NOT rmSync the existing release/native-cache dir.
  // The main sag.exe build wrote a 260-package cache here; ingest
  // worker only needs a 146-package subset. copyDirRobust has
  // "if (existsSync(d)) continue" to leave existing files alone,
  // so we just layer the ingest subset on top.
  // Recursive copy helper — same shape as build-windows-exe.mjs.
  // CRITICAL: don't overwrite existing files. The main sag.exe
  // build writes the canonical 260-package native-cache; ingest
  // worker writes a 146-package subset. Leaving existing files in
  // place keeps the main exe intact.
  function copyDirRobust(src, dst) {
    mkdirSync(dst, { recursive: true });
    let entries;
    try { entries = readdirSync(src, { withFileTypes: true }); }
    catch (err) {
      console.warn("[ingest-worker-exe] copyDirRobust: readdir failed for", src, err.message);
      return;
    }
    for (const ent of entries) {
      const s = join(src, ent.name);
      const d = join(dst, ent.name);
      if (ent.isDirectory()) copyDirRobust(s, d);
      else if (ent.isFile()) {
        if (existsSync(d)) continue;
        try { copyFileSync(s, d); }
        catch (err) {
          console.warn("[ingest-worker-exe] copyFileSync failed for", s, "—", err.message);
        }
      }
    }
  }
  const manifestSrc = join(DIST, "sag-ingest-worker.native-map.manifest.json");
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, manifestDst);
    console.log("[ingest-worker-exe] ✓ " + sidecarBase + ".native-map.manifest.json copied next to " + EXE_NAME);
    const cacheSrc = join(DIST, "native-cache");
    if (existsSync(cacheSrc)) {
      copyDirRobust(cacheSrc, join(RELEASE_DIR, "native-cache"));
      console.log("[ingest-worker-exe] ✓ native-cache copied next to " + EXE_NAME);
    } else {
      throw new Error("dist/native-cache missing");
    }
  } else {
    throw new Error("sag-ingest-worker.native-map.manifest.json missing in dist/");
  }
  const migrationsSrc = join(DIST, "sag-ingest-worker.migrations.json");
  if (existsSync(migrationsSrc)) {
    copyFileSync(migrationsSrc, migrationsDst);
    console.log("[ingest-worker-exe] ✓ " + sidecarBase + ".migrations.json copied next to " + EXE_NAME);
  } else {
    throw new Error("sag-ingest-worker.migrations.json missing in dist/");
  }

  inject(nodeExePath, blobPath, outExePath);
  stripAuthenticodeSignature(outExePath);
  setGuiSubsystem(outExePath);

  console.log(`[ingest-worker-exe] ✓ ${EXE_NAME} ready: ${outExePath}`);
})().catch((err) => {
  console.error("[ingest-worker-exe]", err);
  process.exit(1);
});