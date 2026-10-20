// scripts/fix-better-sqlite3-binary.mjs
// better-sqlite3 has no prebuild for Node v24.14.0 (node-v137). The prebuild
// registry only ships up to node-v115/v127. We hand-fetched the
// better-sqlite3-v12.11.1-node-v137-win32-x64.tar.gz prebuild from
// registry.npmmirror.com and dropped it into node_modules/better-sqlite3/
// at:
//   (a) build/Release/better_sqlite3.node
//   (b) compiled/24.14.0/win32/x64/better_sqlite3.node
//   (c) lib/binding/node-v137-win32-x64/better_sqlite3.node
//
// The build pipeline's manifest walker doesn't see these (because gyp
// download wasn't run). Without these entries, the SEA runtime extracts
// only the JS files and crashes with "Could not locate the bindings file".
// This script patches the manifest + ensures the binary is in the source
// native-cache after stepNativeMap.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const RELEASE = join(ROOT, "release");
const SOURCE_BIN = join(ROOT, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

const BS_REL_ENTRIES = [
  "build/Release/better_sqlite3.node",
  "compiled/24.14.0/win32/x64/better_sqlite3.node",
  "lib/binding/node-v137-win32-x64/better_sqlite3.node",
];

if (!existsSync(SOURCE_BIN)) {
  console.error("[fix-bsqlite] WARNING: better_sqlite3.node not found at", SOURCE_BIN);
  console.error("  Build will still proceed but runtime will fail with 'Could not locate the bindings file'.");
  process.exit(0);
}

function ensureInSourceCache(sourceCacheRoot) {
  for (const rel of BS_REL_ENTRIES) {
    const target = join(sourceCacheRoot, "better-sqlite3", rel);
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(SOURCE_BIN, target);
    } catch (err) {
      console.error("[fix-bsqlite] failed to copy", target, err.message);
    }
  }
}

function patchManifest(manifestPath, sourceCacheRoot) {
  if (!existsSync(manifestPath)) {
    console.log("[fix-bsqlite] manifest missing:", manifestPath);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bs = manifest.packages && manifest.packages["better-sqlite3"];
  if (!bs) {
    console.log("[fix-bsqlite] better-sqlite3 not in manifest:", manifestPath);
    return;
  }
  let added = 0;
  for (const rel of BS_REL_ENTRIES) {
    if (!bs[rel]) {
      bs[rel] = rel;
      added++;
    }
  }
  if (added > 0) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[fix-bsqlite] ${added} entries added to`, manifestPath);
  }
  ensureInSourceCache(sourceCacheRoot);
}

console.log("[fix-bsqlite] patching manifests...");
patchManifest(join(DIST, "sag.native-map.manifest.json"), join(DIST, "native-cache"));
patchManifest(join(DIST, "sag-mcp.native-map.manifest.json"), join(DIST, "native-cache"));
patchManifest(join(DIST, "sag-ingest-worker.native-map.manifest.json"), join(DIST, "native-cache"));
patchManifest(join(RELEASE, "本地知识检索-后端.native-map.manifest.json"), join(RELEASE, "native-cache"));
patchManifest(join(RELEASE, "本地知识检索-mcp.native-map.manifest.json"), join(RELEASE, "native-cache"));
patchManifest(join(RELEASE, "本地知识检索-ingest-worker.native-map.manifest.json"), join(RELEASE, "native-cache"));
console.log("[fix-bsqlite] done.");