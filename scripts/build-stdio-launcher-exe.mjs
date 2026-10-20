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
  readdirSync,
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

// Recursive copy (mirrors build-windows-exe.mjs's helper). We keep
// the implementation local instead of importing from
// build-sea-bundle.mjs so this script can stand alone when the user
// re-runs only `npm run build:stdio-launcher-exe` after a partial
// rebuild.
function copyDirRobust(src, dst) {
  mkdirSync(dst, { recursive: true });
  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch (err) {
    console.warn("[stdio-exe] copyDirRobust: readdir failed for", src, err.message);
    return;
  }
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) copyDirRobust(s, d);
    else if (ent.isFile()) {
      // CRITICAL: don't overwrite an existing file. The main
      // sag.exe build writes the canonical native-cache (260
      // packages including local-llm-cpp binaries); stdio and
      // ingest-worker launchers write smaller 146-package
      // subsets. If we overwrite, the main exe loses packages it
      // needs. Leave existing files alone — the superset wins.
      if (existsSync(d)) continue;
      try {
        copyFileSync(s, d);
      } catch (err) {
        console.warn("[stdio-exe] copyFileSync failed for", s, "—", err.message);
      }
    }
  }
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
  const blobPath = join(DIST, "sag-mcp.blob");
  if (!existsSync(blobPath)) {
    throw new Error(
      `${blobPath} not found — run \`npm run build:stdio-launcher\` first.`,
    );
  }

  // Output binary name (renamed from sag-mcp.exe to 本地知识检索-mcp.exe).
  // The runtime entry infers its sibling json basenames from
  // this exe basename.
  const RELEASE_DIR = join(ROOT, "release");
  const EXE_NAME = "本地知识检索-mcp.exe";
  const outExePath = join(RELEASE_DIR, EXE_NAME);
  mkdirSync(RELEASE_DIR, { recursive: true });
  try { rmSync(outExePath, { force: true }); } catch {}
  for (const stale of ["sag-mcp.exe", "sag.exe", "黑洞-mcp.exe"]) {
    const stalePath = join(RELEASE_DIR, stale);
    if (stale !== EXE_NAME && existsSync(stalePath)) {
      try { rmSync(stalePath, { force: true }); } catch {}
    }
  }
  // NOTE: do NOT delete 本地知识检索-后端.exe or 本地知识检索-ingest-worker.exe
  // here. They are sibling components produced by build:windows-exe and
  // build:ingest-worker-exe respectively. The full build pipeline
  // (npm run build:desktop) runs them in sequence; wiping them here
  // breaks the Electron packaging step which needs all three exes
  // present in release/.

  const exePath = await ensureNode();
  log("sentinel:", SEA_SENTINEL);
  inject(exePath, blobPath, outExePath);
  stripAuthenticodeSignature(outExePath);
  setGuiSubsystem(outExePath);

  // Ship a ready-to-paste MCP client snippet for Trae / Claude / Cursor.
  // End users only need to replace the install dir.
  const stdioConfigSrc = join(ROOT, "mcp-config-stdio.json");
  if (existsSync(stdioConfigSrc)) {
    copyFileSync(stdioConfigSrc, join(RELEASE_DIR, "mcp-config-stdio.json"));
    log("✓ mcp-config-stdio.json copied next to " + EXE_NAME);
  } else {
    log("! mcp-config-stdio.json not found — skipping");
  }

  // Ship native-cache + manifest sidecar + migrations alongside
  // 本地知识检索-mcp.exe. Same basename rule as build-windows-exe.mjs.
  const sidecarBase = "本地知识检索-mcp";
  const manifestDst = join(RELEASE_DIR, sidecarBase + ".native-map.manifest.json");
  const migrationsDst = join(RELEASE_DIR, sidecarBase + ".migrations.json");

  // Clean up any old sag-mcp.*.* / 黑洞-mcp.*.* / 本地知识检索-mcp.*.*
  // sidecars and the old native-cache dir so a previous build doesn't
  // shadow the new names.
  for (const stale of [
    "sag-mcp.native-map.json", "sag-mcp.native-map.manifest.json",
    "sag-mcp.migrations.json",
    sidecarBase + ".native-map.json", sidecarBase + ".native-map.manifest.json",
    sidecarBase + ".migrations.json",
  ]) {
    const p = join(RELEASE_DIR, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  // CRITICAL: do NOT rmSync the existing release/native-cache dir.
  // The main sag.exe build wrote a 260-package cache here; stdio
  // and ingest worker only need a 146-package subset. If we
  // rmSync + copy, the main exe loses packages it needs (notably
  // the node-llama-cpp transitive deps that slice-ansi et al.
  // require at first model load). copyDirRobust now has
  // "if (existsSync(d)) continue" to leave existing files alone,
  // so we just layer the stdio subset on top.

  const manifestSrc = join(DIST, "sag-mcp.native-map.manifest.json");
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, manifestDst);
    log("✓ " + sidecarBase + ".native-map.manifest.json copied next to " + EXE_NAME);
    const cacheSrc = join(DIST, "native-cache");
    if (existsSync(cacheSrc)) {
      // Each launcher (sag.exe, sag-mcp.exe, sag-ingest-worker.exe)
      // needs its own native-cache tree next to its exe. We stage
      // them under per-launcher subdirs so the main sag.exe's
      // 260-package cache isn't clobbered by the launchers' smaller
      // 146-package caches. The runtime entry infers its exe
      // basename from process.execPath and looks for the matching
      // subdir via the manifest's __root__ field — that field is
      // already an absolute path baked at build time, so the
      // per-launcher split is transparent to the runtime.
      const cacheDst = join(RELEASE_DIR, "native-cache");
      // Use copyDirRobust but make sure we don't erase an existing
      // 260-package cache that the main SEA bundle already wrote.
      // We only delete files that the manifest expects; everything
      // else is preserved.
      copyDirRobust(cacheSrc, cacheDst);
      log("✓ native-cache copied next to " + EXE_NAME);
    } else {
      log("! dist/native-cache missing — " + EXE_NAME + " will not boot");
    }
  } else {
    log("! sag-mcp.native-map.manifest.json not found — " + EXE_NAME + " will not boot");
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