#!/usr/bin/env node
// scripts/build-desktop-manual.mjs — Hand-roll an Electron desktop app
// without electron-builder. We compose:
//   * node_modules/electron/dist/electron.exe  →  release-desktop/SAG.exe (renamed)
//   * electron/main.cjs + electron/preload.cjs + package.json  →  resources/app/
//   * app/ inside is NOT asar-packed so the Electron Node loader
//     can resolve `electron/main.cjs` directly via fs.
//   * release/* (SAG backend exes + sidecars + web/dist) →  resources/
//
// This is simpler than electron-builder and avoids asar integrity
// surprises: when Electron starts, it reads
// `<resourcesPath>/app/package.json` → `main: "electron/main.cjs"`,
// loads it via fs (not asar), spawns `resources/SAG.exe`. We know
// the layout works because it's identical to dev mode + electron.exe.

import { copyFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, cpSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ELECTRON_EXE = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const SAG_EXE_SRC = join(ROOT, "release", "SAG-backend.exe");
const SAG_EXE_DST_NAME = "SAG-backend.exe"; // stays in resources/ as-is so SEA matches what SEA expects

const OUT_DIR = join(ROOT, "release-desktop");
const WIN_UNPACKED = join(OUT_DIR, "win-unpacked");
const APP_DIR = join(WIN_UNPACKED, "resources", "app");
const RESOURCES_DIR = join(WIN_UNPACKED, "resources");

function copyDir(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    if (statSync(src).isDirectory()) {
      copyDir(src, dst);
    } else {
      copyFileSync(src, dst);
    }
  }
}

function copyFiltered(srcDir, dstDir, filter) {
  mkdirSync(dstDir, { recursive: true });
  for (const f of readdirSync(srcDir)) {
    const src = join(srcDir, f);
    const dst = join(dstDir, f);
    if (statSync(src).isDirectory()) {
      copyFiltered(src, dst, filter);
    } else if (filter(f)) {
      copyFileSync(src, dst);
    }
  }
}

console.log("[local-bge] preserving downloaded models across rebuilds");

// Before nuking OUT_DIR, stash the local-bge model directory (if any)
// under a sibling path. The bundled BGE models weigh hundreds of MB
// and re-downloading them every build is painful. We move them back
// into <OUT_DIR>/win-unpacked/resources/models/ after the wipe so
// `release-desktop` is shippable with the model already in place.
//
// We keep the stash under release-desktop-stash/ so it doesn't collide
// with the build output and survives clean rebuilds.
const MODELS_STASH_DIR = join(ROOT, "release-desktop-stash", "models");
const OUT_MODELS_DIR = join(RESOURCES_DIR, "models");
let preservedModels = false;
if (existsSync(OUT_MODELS_DIR)) {
  try {
    mkdirSync(MODELS_STASH_DIR, { recursive: true });
    for (const entry of readdirSync(OUT_MODELS_DIR)) {
      const from = join(OUT_MODELS_DIR, entry);
      const to = join(MODELS_STASH_DIR, entry);
      try {
        rmSync(to, { recursive: true, force: true });
        renameSync(from, to);
      } catch {
        cpSync(from, to, { recursive: true, force: true });
        rmSync(from, { recursive: true, force: true });
      }
      preservedModels = true;
    }
    console.log("[manual-build]   stashed local-bge models to", MODELS_STASH_DIR);
  } catch (err) {
    console.warn("[manual-build]   failed to stash models:", err.message);
  }
}

console.log("[manual-build] OUT_DIR =", OUT_DIR);
try { rmSync(OUT_DIR, { recursive: true, force: true }); } catch {}
mkdirSync(WIN_UNPACKED, { recursive: true });
mkdirSync(APP_DIR, { recursive: true });
mkdirSync(RESOURCES_DIR, { recursive: true });

// Restore stashed models so a `release-desktop/` build that bakes the
// model into resources/ can be shipped as-is without a separate copy
// step. We copy (not move) so the stash remains available for the
// next rebuild. We restore even when preservedModels is false — the
// stash from a previous build is just as valid a source.
//
// We use the in-script copyDir (recursive readdir + copyFileSync)
// instead of fs.cpSync because the latter has been observed to throw
// silently on Windows when the source contains symlinks or junction
// points (the .cache dirs that huggingface_hub leaves behind).
function copyDirRobust(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    // Skip the .cache dir and any other hidden cruft from the
    // huggingface_hub download — it's hundreds of MB of metadata
    // we don't need to ship.
    if (entry.name === ".cache") continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRobust(src, dst);
    } else if (entry.isSymbolicLink()) {
      continue; // skip symlinks — they confuse Electron's bundler
    } else {
      copyFileSync(src, dst);
    }
  }
}
// Sync project models/ INTO the stash before restoring. The stash
// was previously write-once: whatever landed there first (including
// a truncated 39 MB stub of the 326 MB BGE int8 model from an
// interrupted download on 2026-09-24) got restored into every later
// build forever, and the complete model in the project tree never
// made it into the desktop bundle — onnxruntime then crashed the
// backend with 0xC06D007F the moment a session was created on the
// truncated file. Rule: the project's models/ directory is the
// source of truth; any file that is missing or differs in size gets
// refreshed into the stash first.
const PROJECT_MODELS_DIR = join(ROOT, "models");
if (existsSync(PROJECT_MODELS_DIR)) {
  mkdirSync(MODELS_STASH_DIR, { recursive: true });
  const syncIntoStash = (srcDir, dstDir) => {
    mkdirSync(dstDir, { recursive: true });
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.name === ".cache") continue;
      const src = join(srcDir, entry.name);
      const dst = join(dstDir, entry.name);
      if (entry.isDirectory()) {
        syncIntoStash(src, dst);
      } else if (entry.isFile()) {
        try {
          const s = statSync(src);
          let dSize = -1;
          try { dSize = statSync(dst).size; } catch {}
          if (dSize !== s.size) {
            copyFileSync(src, dst);
            console.log("[manual-build]   stash refreshed from project:", join(srcDir, entry.name).slice(PROJECT_MODELS_DIR.length + 1));
          }
        } catch (err) {
          console.warn("[manual-build]   stash sync failed for", src, "-", err.message);
        }
      }
    }
  };
  try {
    syncIntoStash(PROJECT_MODELS_DIR, MODELS_STASH_DIR);
  } catch (err) {
    console.warn("[manual-build]   project->stash sync failed:", err.message);
  }
}
if (existsSync(MODELS_STASH_DIR)) {
  mkdirSync(OUT_MODELS_DIR, { recursive: true });
  for (const entry of readdirSync(MODELS_STASH_DIR)) {
    const from = join(MODELS_STASH_DIR, entry);
    const to = join(OUT_MODELS_DIR, entry);
    try {
      // Always restore (overwrite). The previous existsSync-skip
      // meant a truncated file staged once would persist in every
      // subsequent build even after the stash was repaired.
      copyDirRobust(from, to);
      console.log("[manual-build]   restored model:", entry);
    } catch (err) {
      console.warn("[manual-build]   failed to restore", entry, "-", err.message);
    }
  }
}

// 1. Top-level Electron binaries (DLLs, pak files, locales).
//    Copy from node_modules/electron/dist/* to win-unpacked/ root.
console.log("[manual-build] copying Electron runtime");
const ELECTRON_DIST = join(ROOT, "node_modules", "electron", "dist");
for (const f of readdirSync(ELECTRON_DIST)) {
  const src = join(ELECTRON_DIST, f);
  const dst = join(WIN_UNPACKED, f);
  if (statSync(src).isDirectory()) {
    copyDir(src, dst);
  } else if (f === "electron.exe") {
    // Skip the source electron.exe; we rename below.
    continue;
  } else {
    copyFileSync(src, dst);
  }
}

// 2. Rename electron.exe → "SAG 桌面版.exe" at the root so double-
//    clicking the top-level binary launches the desktop app.
//
//    We deliberately avoid names that look like Electron's stock
//    binary names ("electron.exe", "Electron", "SAG.exe", etc.)
//    because Electron 33 has a fallback path that loads
//    `default_app.asar` when the binary name doesn't match a known
//    "this is a packaged app" pattern — and our `app/` directory
//    gets bypassed, so main.cjs never runs. Naming the exe after
//    the product (with a non-ASCII suffix) sidesteps that path.
const SAG_EXE_FINAL = join(WIN_UNPACKED, "SAG 桌面版.exe");
console.log("[manual-build] desktop exe =", SAG_EXE_FINAL);
copyFileSync(ELECTRON_EXE, SAG_EXE_FINAL);

// 2b. Rewrite the desktop exe's icon via rcedit so Explorer /
//     taskbar / shortcut all show the SAG brand mark. We do this
//     BEFORE renaming the binary so the resource section is still
//     in the standard Electron shape — same pattern as build-windows-
//     exe.mjs which rcedits the SEA backend after build.
const SHELL_ICO = join(__dirname, "icon.ico");
if (existsSync(SHELL_ICO)) {
  const rcedit = process.env.RCEDIT_BIN || "rcedit";
  const rceditResult = spawnSync(
    rcedit,
    [SAG_EXE_FINAL, "--set-icon", SHELL_ICO],
    { stdio: "inherit", shell: true }
  );
  if (rceditResult.status === 0) {
    console.log("[manual-build]   ✓ icon rewritten to scripts/icon.ico");
  } else {
    console.warn("[manual-build]   rcedit failed; keeping default icon");
  }
} else {
  console.warn("[manual-build]   scripts/icon.ico missing; using default icon");
}

// 3. resources/app/ holds the Electron app code (NOT asar-packed).
//    Electron's loader reads <resourcesPath>/app/package.json#main
//    via fs, then loads main.cjs via fs. No asar wrapper = no surprises.
console.log("[manual-build] copying app/");
copyFileSync(join(ROOT, "package.json"), join(APP_DIR, "package.json"));
copyDir(join(ROOT, "electron"), join(APP_DIR, "electron"));

// CRITICAL: Electron prefers <resourcesPath>/app.asar over
// <resourcesPath>/app/. If a stale app.asar lingers (e.g. from a
// previous electron-builder run), Electron will load that instead
// and our main.cjs will never execute. Always blow away any
// pre-existing app.asar / app.asar.unpacked.
const staleAsar = join(RESOURCES_DIR, "app.asar");
const staleAsarUnpacked = join(RESOURCES_DIR, "app.asar.unpacked");
for (const stale of [staleAsar, staleAsarUnpacked]) {
  if (existsSync(stale)) {
    rmSync(stale, { recursive: true, force: true });
    console.log("[manual-build]   removed stale:", stale);
  }
}

// 4. resources/SAG-backend.exe + sidecars + web/dist from release/.
//    The Electron shell's main.cjs looks for
//    `process.resourcesPath/SAG-backend.exe`, so this layout
//    matches what the runtime expects.
console.log("[manual-build] copying SAG backend + sidecars");
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
  // The native-cache dir holds every raw binary (better-sqlite3
  // .node, onnxruntime .dll, node-llama-cpp prebuilt binaries).
  // It's a directory not a file, so the filter check below routes
  // it through the copyDir branch.
  "native-cache",
]);
for (const f of readdirSync(join(ROOT, "release"))) {
  if (SAG_FILTERS.has(f) || f === "web") {
    const src = join(ROOT, "release", f);
    const dst = join(RESOURCES_DIR, f);
    if (statSync(src).isFile()) {
      copyFileSync(src, dst);
    } else if (statSync(src).isDirectory()) {
      // web/dist/ — the SAG backend reads <resourcesPath>/web/dist
      // at runtime to serve the SPA bundle.
      copyDir(src, dst);
    }
  }
}

// 5. Make sure migration files are in resources/ for runtime.
//    SAG backend's runtime looks for migrations next to the exe.
const MIGRATIONS_SRC = join(ROOT, "release", "migrations");
if (existsSync(MIGRATIONS_SRC)) {
  copyDir(MIGRATIONS_SRC, join(RESOURCES_DIR, "migrations"));
}

// 6. Stage the external reader scripts. The runtime
//    (`src/watcher/external-reader.ts`) looks in
//    `<exe-dir>/sag-readers/` (i.e. `resources/sag-readers/` here) for
//    `sag-read-<ext>.<ext>` scripts. Operators can edit them in place
//    to handle their environment (SafeNetLOCK, 奇安信, WPS-only, etc.)
//    without rebuilding the exe. Spec lives at sag-readers/SPEC.md.
//
//    The build also preserves any operator-added readers that already
//    sit in `resources/sag-readers/` from a previous install (e.g.
//    `sag-read-pdf-corp.ps1`); we only OVERWRITE files that exist in
//    the source sag-readers/ dir. Anything custom is kept untouched.
const READERS_SRC = join(ROOT, "sag-readers");
const READERS_DST = join(RESOURCES_DIR, "sag-readers");
const READERS_STASH = join(ROOT, "release-desktop-stash", "sag-readers-custom");
if (existsSync(READERS_SRC)) {
  if (existsSync(READERS_DST)) {
    // Back up operator-added files (anything not in the source set)
    // before we wipe / rewrite. Operators will be very unhappy if
    // their custom readers disappear on every rebuild.
    const sourceNames = new Set(readdirSync(READERS_SRC));
    mkdirSync(READERS_STASH, { recursive: true });
    for (const f of readdirSync(READERS_DST)) {
      if (!sourceNames.has(f)) {
        try {
          copyFileSync(
            join(READERS_DST, f),
            join(READERS_STASH, f)
          );
        } catch (err) {
          console.warn("[manual-build]   failed to stash custom reader", f, "-", err.message);
        }
      }
    }
  }
  copyDir(READERS_SRC, READERS_DST);
  // Restore custom readers on top.
  if (existsSync(READERS_STASH)) {
    for (const f of readdirSync(READERS_STASH)) {
      try {
        copyFileSync(
          join(READERS_STASH, f),
          join(READERS_DST, f)
        );
      } catch (err) {
        console.warn("[manual-build]   failed to restore custom reader", f, "-", err.message);
      }
    }
  }
  const readerCount = readdirSync(READERS_DST).length;
  console.log(`[manual-build]   staged ${readerCount} reader file(s) -> resources/sag-readers/`);
} else {
  console.warn("[manual-build]   sag-readers/ source not found — runtime will fall back to in-process parsers");
}

console.log("[manual-build] ✓ SAG desktop ready at:", WIN_UNPACKED);
console.log("[manual-build]   Entry: SAG.exe (double-click to launch)");
console.log("[manual-build]   Logs: release-desktop/win-unpacked/logs/ (created on first run)");