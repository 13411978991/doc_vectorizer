#!/usr/bin/env node
// sync-bundle-keep-exe.mjs — Update the user's win-unpacked/ install with
// the latest native-cache + manifests + sidecars WITHOUT touching the
// 本地知识检索-后端.exe (which may be locked by a running backend PID). The
// runtime entry inside the SEA exe reads
// <exe-dir>/<basename>.native-map.manifest.json at startup, so swapping
// the manifest + native-cache is enough to load new code on the next
// fresh boot — even with the old .exe.
//
// Used when the user has a long-lived 本地知识检索-后端.exe they want to keep
// running and we just need to refresh the on-disk artifacts for the
// NEXT time they restart.

import {
  existsSync,
  mkdirSync,
  statSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const RELEASE_DIR = join(ROOT, "release");
const WIN_UNPACKED = join(ROOT, "release-desktop", "win-unpacked");
const USER_UNPACKED = "D:\\SAG\\doc_vectorizer\\release-desktop\\win-unpacked";

function safeCopyFile(src, dst) {
  try {
    copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn("[sync]  ✗", src, "→", dst, ":", err.message.split("\n")[0]);
    return false;
  }
}

function copyDir(src, dst, exclude = new Set()) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (exclude.has(ent.name)) continue;
    const ss = join(src, ent.name);
    const dd = join(dst, ent.name);
    if (ent.isDirectory()) copyDir(ss, dd, exclude);
    else if (ent.isFile()) safeCopyFile(ss, dd);
  }
}

const SKIP = new Set(["本地知识检索-后端.exe"]);
const SIDE_FILES = [
  "本地知识检索-后端.exe.stripped-sig.marker",
  "本地知识检索-后端.native-map.manifest.json",
  "本地知识检索-后端.migrations.json",
  "本地知识检索-后端.scripts.json",
  "本地知识检索-mcp.exe",
  "本地知识检索-mcp.exe.stripped-sig.marker",
  "本地知识检索-mcp.native-map.manifest.json",
  "本地知识检索-mcp.migrations.json",
  "本地知识检索-ingest-worker.exe",
  "本地知识检索-ingest-worker.exe.stripped-sig.marker",
  "本地知识检索-ingest-worker.native-map.manifest.json",
  "本地知识检索-ingest-worker.migrations.json",
  ".env.example",
  "mcp-config.json"
];

console.log("[sync] USER_UNPACKED =", USER_UNPACKED);
console.log("[sync] RELEASE_DIR =", RELEASE_DIR);

// Copy sidecar files (NOT 本地知识检索-后端.exe)
for (const f of SIDE_FILES) {
  const src = join(RELEASE_DIR, f);
  const dst = join(USER_UNPACKED, "resources", f);
  if (!existsSync(src)) continue;
  safeCopyFile(src, dst);
}

// Copy native-cache — overwrite top-level packages, but DO NOT touch
// <native-cache>/0a29d2a28cfe/ (likely locked by running PID)
const nativeSrc = join(RELEASE_DIR, "native-cache");
const nativeDst = join(USER_UNPACKED, "resources", "native-cache");
if (existsSync(nativeSrc)) {
  for (const ent of readdirSync(nativeSrc, { withFileTypes: true })) {
    if (ent.name === "0a29d2a28cfe") {
      console.log("[sync]  · skip", ent.name, "(may be locked by running PID)");
      continue;
    }
    const ss = join(nativeSrc, ent.name);
    const dd = join(nativeDst, ent.name);
    if (ent.isDirectory()) copyDir(ss, dd);
    else if (ent.isFile()) safeCopyFile(ss, dd);
  }
  console.log("[sync] ✓ native-cache synced (skipping 0a29d2a28cfe)");
}

// Copy web/dist (always safe to overwrite). `vite build` writes to
// <repo>/web/dist/ (per vite.config.ts root:"web" + outDir:"dist"),
// NOT to release/web/dist/. Reading from the wrong tree was the
// reason previous syncs shipped stale web bundles (fixed 2026-09-13).
const webSrc = join(ROOT, "web", "dist");
const webDst = join(USER_UNPACKED, "resources", "web", "dist");
if (existsSync(webSrc)) {
  // Wipe stale hashed assets so the new index.html can never reference
  // a removed chunk. Old bundles stay harmless but bloat the install;
  // the only thing that matters is the entry HTML + its hashed refs.
  if (existsSync(join(webDst, "assets"))) {
    const keep = new Set();
    const indexHtml = join(webSrc, "index.html");
    if (existsSync(indexHtml)) {
      const html = readFileSync(indexHtml, "utf8");
      for (const m of html.matchAll(/assets\/([A-Za-z0-9_-]+\.[a-z]+)/g)) {
        keep.add(m[1]);
      }
    }
    for (const ent of readdirSync(join(webDst, "assets"))) {
      if (!keep.has(ent)) {
        try {
          unlinkSync(join(webDst, "assets", ent));
        } catch {}
      }
    }
  }
  copyDir(webSrc, webDst);
  console.log("[sync] ✓ web/dist synced from <repo>/web/dist/ (stale chunks pruned)");
}

// Copy app/ (Electron main.cjs + package.json — usually NOT locked).
// The Electron shell reads from resources/app/electron/main.cjs; this
// is what we patched earlier for the port-collision fix.
const appSrc = join(ROOT, "release-desktop", "win-unpacked", "resources", "app");
const appDst = join(USER_UNPACKED, "resources", "app");
if (existsSync(appSrc)) {
  copyDir(appSrc, appDst);
  console.log("[sync] ✓ app/ synced");
} else {
  console.log("[sync] ! no dev resources/app/ — run scripts/refresh-win-unpacked.mjs first");
}

console.log("[sync] ✓ done — close existing window, reopen 本地知识检索.exe to pick up new code");