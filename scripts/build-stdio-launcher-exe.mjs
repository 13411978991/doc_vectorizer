#!/usr/bin/env node
// build-stdio-launcher-exe.mjs — Splice dist/sag-mcp.blob into a Windows
// node.exe to produce sag-mcp.exe (a stdio-only MCP server launcher).
//
// Companion to build-windows-exe.mjs. Both .exe are produced by the same
// recipe; the only difference is which SEA blob is injected.
//
// End-user experience:
//   1. unzip sag-package.zip into e.g. D:\\sag\\
//   2. paste the snippet from mcp-config-stdio.json into Trae → MCP config
//      (replace "D:\\\\sag\\\\" with the install dir)
//   3. Trae spawns sag-mcp.exe automatically on first use
//
// Both sag.exe and sag-mcp.exe read DATABASE_FILE from the same
// ./data/sag.db, so the web UI and the MCP tools see the same data.
//
// Pre-req: dist/sag-mcp.blob (run `npm run build:stdio-launcher` first).

import {
  existsSync,
  mkdirSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { createWriteStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
const CACHE = process.env.SAG_WIN_NODE_CACHE || "/tmp/sag-win-node";
const NODE_VERSION = process.env.SAG_NODE_VERSION || "24.14.0";

const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const MIRRORS = [
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
];

function log(...args) {
  console.log("[stdio-exe]", ...args);
}

function followRedirects(target, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
    const req = https.get(
      target,
      { headers: { "user-agent": "sag-build/1.0" } },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          res.resume();
          return followRedirects(res.headers.location, redirectsLeft - 1)
            .then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${target}`));
        }
        resolve(res);
      },
    );
    req.on("error", reject);
    req.setTimeout(600_000);
  });
}

async function downloadToFile(url, outPath) {
  const res = await followRedirects(url);
  await new Promise((resolve, reject) => {
    const file = createWriteStream(outPath);
    res.pipe(file);
    file.on("finish", () => file.close(resolve));
    file.on("error", reject);
  });
}

async function ensureNode() {
  const zipPath = join(CACHE, `node-v${NODE_VERSION}-win-x64.zip`);
  const extractDir = join(CACHE, `node-v${NODE_VERSION}-win-x64`);
  const exePath = join(extractDir, "node.exe");

  mkdirSync(CACHE, { recursive: true });

  if (existsSync(exePath)) {
    log(`✓ cached node.exe: ${exePath}`);
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
    throw new Error(
      `could not download Windows Node binary. Last error: ${lastErr && lastErr.message}`,
    );
  }

  log("unzipping");
  const unzipCmds = [
    `unzip -q -o "${zipPath}" -d "${CACHE}"`,
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${CACHE}' -Force"`,
    `tar -xf "${zipPath}" -C "${CACHE}"`,
  ];
  let unzipOk = false;
  for (const cmd of unzipCmds) {
    const r = spawnSync(cmd, { stdio: "inherit", shell: true });
    if (r.status === 0) { unzipOk = true; break; }
  }
  if (!unzipOk) throw new Error("could not unzip — please install unzip / PowerShell / tar");
  if (!existsSync(exePath)) throw new Error(`expected ${exePath} after extraction`);
  return exePath;
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
  log("injecting stdio blob into Windows node.exe");
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
  const blobPath = join(DIST, "sag-mcp.blob");
  if (!existsSync(blobPath)) {
    throw new Error(
      `${blobPath} not found — run \`npm run build:stdio-launcher\` first.`,
    );
  }

  // Output binary name (renamed from sag-mcp.exe to a Chinese display
  // name). The runtime entry infers its sibling json basenames from
  // this exe basename.
  const EXE_NAME = "黑洞-mcp.exe";
  const outExePath = join(ROOT, EXE_NAME);
  try { rmSync(outExePath, { force: true }); } catch {}
  for (const stale of ["sag-mcp.exe", "sag.exe"]) {
    const stalePath = join(ROOT, stale);
    if (stale !== EXE_NAME && existsSync(stalePath)) {
      try { rmSync(stalePath, { force: true }); } catch {}
    }
  }

  const exePath = await ensureNode();
  log("sentinel:", SEA_SENTINEL);
  inject(exePath, blobPath, outExePath);

  // Ship a ready-to-paste MCP client snippet for Trae / Claude / Cursor.
  // End users only need to replace the install dir.
  const stdioConfigSrc = join(ROOT, "mcp-config-stdio.json");
  if (existsSync(stdioConfigSrc)) {
    copyFileSync(stdioConfigSrc, join(ROOT, "mcp-config-stdio.json"));
    log("✓ mcp-config-stdio.json copied next to " + EXE_NAME);
  } else {
    log("! mcp-config-stdio.json not found — skipping");
  }

  // Ship native-map and migrations alongside 黑洞-mcp.exe. Sidecar
  // basenames must match the exe's basename so the entry's runtime
  // lookup succeeds.
  const sidecarBase = "黑洞-mcp";
  const nativeMapDst = join(ROOT, sidecarBase + ".native-map.json");
  const migrationsDst = join(ROOT, sidecarBase + ".migrations.json");

  // Clean up any old sag-mcp.*.* sidecars so they don't shadow the new
  // names on disk.
  for (const stale of ["sag-mcp.native-map.json", "sag-mcp.migrations.json", sidecarBase + ".native-map.json", sidecarBase + ".migrations.json"]) {
    const p = join(ROOT, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }

  const nativeMapSrc = join(DIST, "sag-mcp.native-map.json");
  if (existsSync(nativeMapSrc)) {
    copyFileSync(nativeMapSrc, nativeMapDst);
    log("✓ " + sidecarBase + ".native-map.json copied next to " + EXE_NAME);
  } else {
    log("! sag-mcp.native-map.json not found — " + EXE_NAME + " will not boot");
  }

  const migrationsSrc = join(DIST, "sag-mcp.migrations.json");
  if (existsSync(migrationsSrc)) {
    copyFileSync(migrationsSrc, migrationsDst);
    log("✓ " + sidecarBase + ".migrations.json copied next to " + EXE_NAME);
  } else {
    log("! sag-mcp.migrations.json not found — " + EXE_NAME + " will not boot");
  }

  const size = statSync(outExePath).size;
  log("✓ " + EXE_NAME + " ready:", outExePath, `(${(size / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});