#!/usr/bin/env node
// scripts/ensure-node.mjs — Pre-download the Windows Node binary that
// `build-windows-exe.mjs` will inject the SEA blob into, AND export
// its path so downstream build steps (`build-sea-bundle.mjs`,
// `build-stdio-launcher.mjs`) can use the same Node major to
// generate the blob. Without this step, the host's `node`
// (Node 24 in the dev box) makes a V8-ABI-mismatched blob, and the
// resulting .exe dies at boot with:
//   FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
//   exit code 134 (SIGABRT)
//
// We deliberately share logic with `build-windows-exe.mjs#ensureNode`
// via `scripts/_node-cache.mjs`.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
// Match build-windows-exe.mjs default so the cache we pre-populate
// here is the same one it reads on its own ensureNode() call.
const CACHE = process.env.SAG_WIN_NODE_CACHE || join(ROOT, ".node-cache");

// Pulled from build-windows-exe.mjs. Keep in sync if you bump the
// build's default Node major.
const NODE_VERSION = process.env.SAG_NODE_VERSION || "24.14.0";
const MIRRORS = [
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
];

function downloadToFile(target, dst) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dst);
    import("node:https").then((https) => {
      const req = https.get(target, { headers: { "user-agent": "sag-build/1.0" } }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          return resolve(downloadToFile(res.headers.location, dst));
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error("HTTP " + res.statusCode));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      });
      req.on("error", reject);
      req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    });
  });
}

// Need createWriteStream for the download helper.
import { createWriteStream } from "node:fs";

function log(...args) { console.log("[ensure-node]", ...args); }

async function downloadNode() {
  const zipPath = join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
  const extractDir = join(CACHE, `node-v${NODE_VERSION}-win-x64`);
  const exePath = join(extractDir, "node.exe");

  mkdirSync(CACHE, { recursive: true });
  if (existsSync(exePath)) {
    log(`✓ cached: ${exePath} (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB)`);
    return exePath;
  }

  log("downloading Windows Node", NODE_VERSION);
  let lastErr;
  for (const url of MIRRORS) {
    try {
      log("  trying", url);
      await downloadToFile(url, zipPath);
      break;
    } catch (err) {
      lastErr = err;
      log(`  ! mirror failed: ${err.message}`);
    }
  }
  if (!existsSync(zipPath)) {
    throw new Error(`could not download Windows Node binary. Last error: ${lastErr && lastErr.message}`);
  }

  log("unzipping");
  // Windows PowerShell Expand-Archive is built-in and doesn't need
  // any extra dependency. It handles long paths and Chinese
  // characters better than 7zip in our experience.
  const r = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `Expand-Archive -Path "${zipPath}" -DestinationPath "${CACHE}" -Force`,
  ], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`Expand-Archive failed (exit ${r.status})`);
  if (!existsSync(exePath)) throw new Error(`node.exe missing after unzip: ${exePath}`);
  log(`✓ downloaded: ${exePath} (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB)`);
  return exePath;
}

const exePath = await downloadNode();
// Export for child processes spawned by build-sea-bundle.mjs and
// build-stdio-launcher.mjs. `process.env` only affects the current
// process's children when they go through spawnSync with
// `env: process.env`, which the existing scripts already do.
process.env.SAG_SEA_NODE_EXE = exePath;
log(`SAG_SEA_NODE_EXE=${exePath}`);
// Also persist it to a temp file so a caller can `source` it from
// bash, but for our npm-script pipeline the env var is enough.