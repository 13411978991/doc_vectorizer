#!/usr/bin/env node
// refresh-win-unpacked.mjs — Re-stage SAG backend + sidecars into an
// existing win-unpacked/ tree WITHOUT copying the Electron dist (which
// can be EBUSY if the user has the GUI running). Mirrors the steps
// after "copying Electron runtime" in build-desktop-manual.mjs.
import {
  existsSync,
  mkdirSync,
  statSync,
  copyFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const RELEASE_DIR = join(ROOT, "release");
const WIN_UNPACKED = join(ROOT, "release-desktop", "win-unpacked");
const RESOURCES_DIR = join(WIN_UNPACKED, "resources");
const APP_DIR = join(RESOURCES_DIR, "app");

function copyDir(s, d) {
  mkdirSync(d, { recursive: true });
  for (const ent of readdirSync(s, { withFileTypes: true })) {
    const ss = join(s, ent.name);
    const dd = join(d, ent.name);
    if (ent.isDirectory()) copyDir(ss, dd);
    else if (ent.isFile()) {
      try { copyFileSync(ss, dd); } catch (err) {
        console.warn("[refresh]   copyFileSync failed for", ss, "—", err.message);
      }
    }
  }
}

console.log("[refresh] WIN_UNPACKED =", WIN_UNPACKED);
console.log("[refresh] RELEASE_DIR =", RELEASE_DIR);

if (!existsSync(WIN_UNPACKED)) {
  throw new Error("win-unpacked/ does not exist. Run scripts/build-desktop-manual.mjs first (or npm run build:desktop).");
}

// Clear stale SAG backend sidecars from previous (pre-SAG-rename)
// builds so the new SAG* names don't collide with old `本地知识检索-*`
// or `黑洞-*` leftovers. We do NOT touch the Electron binaries (dll/.
// pak files) — those might be locked by a running GUI process.
const SAG_STALE = [
  // old 本地知识检索-* basenames
  "本地知识检索-后端.exe", "本地知识检索-后端.exe.stripped-sig.marker",
  "本地知识检索-后端.native-map.manifest.json", "本地知识检索-后端.native-map.json",
  "本地知识检索-后端.migrations.json", "本地知识检索-后端.scripts.json",
  "本地知识检索-mcp.exe", "本地知识检索-mcp.exe.stripped-sig.marker",
  "本地知识检索-mcp.native-map.manifest.json", "本地知识检索-mcp.native-map.json",
  "本地知识检索-mcp.migrations.json",
  "本地知识检索-ingest-worker.exe", "本地知识检索-ingest-worker.exe.stripped-sig.marker",
  "本地知识检索-ingest-worker.native-map.manifest.json", "本地知识检索-ingest-worker.native-map.json",
  "本地知识检索-ingest-worker.migrations.json",
  // old 黑洞-* basenames (from an earlier codename)
  "黑洞.exe", "黑洞.exe.stripped-sig.marker",
  "黑洞.native-map.manifest.json", "黑洞.native-map.json",
  "黑洞.migrations.json", "黑洞.scripts.json",
  "黑洞-mcp.exe", "黑洞-mcp.exe.stripped-sig.marker",
  "黑洞-mcp.native-map.manifest.json", "黑洞-mcp.native-map.json",
  "黑洞-mcp.migrations.json",
  "黑洞-ingest-worker.exe", "黑洞-ingest-worker.exe.stripped-sig.marker",
  "黑洞-ingest-worker.native-map.manifest.json", "黑洞-ingest-worker.native-map.json",
  "黑洞-ingest-worker.migrations.json",
  // old sag-* basenames (from an even earlier codename)
  "sag.exe", "sag-mcp.exe", "sag-ingest-worker.exe",
  // ensure no leftover top-level native-cache when migrating basenames
  "native-cache",
];
for (const f of SAG_STALE) {
  const p = join(RESOURCES_DIR, f);
  if (existsSync(p)) {
    try { rmSync(p, { recursive: true, force: true }); } catch (err) {
      console.warn("[refresh]   could not remove", f, "-", err.message);
    }
  }
}

// Refresh app/ — read package.json + electron/ from the project root.
// We delete app/ first so a stale main.cjs or preload.cjs doesn't
// survive the refresh.
if (existsSync(APP_DIR)) {
  try { rmSync(APP_DIR, { recursive: true, force: true }); } catch {}
}
mkdirSync(APP_DIR, { recursive: true });
copyFileSync(join(ROOT, "package.json"), join(APP_DIR, "package.json"));
if (existsSync(join(ROOT, "electron"))) {
  copyDir(join(ROOT, "electron"), join(APP_DIR, "electron"));
}
console.log("[refresh] ✓ app/ refreshed");

// Copy SAG backend + sidecars.
const SAG_FILTERS = new Set([
  "SAG-backend.exe",
  "SAG-backend.exe.stripped-sig.marker",
  "SAG-backend.native-map.manifest.json",
  "SAG-backend.migrations.json",
  "SAG-backend.scripts.json",
  "SAG-mcp.exe",
  "SAG-mcp.exe.stripped-sig.marker",
  "SAG-mcp.native-map.manifest.json",
  "SAG-mcp.migrations.json",
  "SAG-ingest-worker.exe",
  "SAG-ingest-worker.exe.stripped-sig.marker",
  "SAG-ingest-worker.native-map.manifest.json",
  "SAG-ingest-worker.migrations.json",
  ".env.example",
  "mcp-config.json",
  "native-cache",
]);
for (const f of readdirSync(RELEASE_DIR)) {
  if (SAG_FILTERS.has(f)) {
    const src = join(RELEASE_DIR, f);
    const dst = join(RESOURCES_DIR, f);
    if (statSync(src).isFile()) {
      try { copyFileSync(src, dst); }
      catch (err) { console.warn("[refresh]   copyFileSync failed for", src, "—", err.message); }
    } else if (statSync(src).isDirectory()) {
      copyDir(src, dst);
    }
  }
}

const webSrc = join(RELEASE_DIR, "web");
if (existsSync(webSrc)) {
  copyDir(webSrc, join(RESOURCES_DIR, "web"));
  console.log("[refresh] ✓ web/ refreshed");
}
const MIGRATIONS_SRC = join(RELEASE_DIR, "migrations");
if (existsSync(MIGRATIONS_SRC)) {
  copyDir(MIGRATIONS_SRC, join(RESOURCES_DIR, "migrations"));
  console.log("[refresh] ✓ migrations/ refreshed");
}

console.log("[refresh] ✓ SAG desktop ready at:", WIN_UNPACKED);
