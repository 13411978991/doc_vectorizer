#!/usr/bin/env node
// build-windows-exe.mjs — Splice dist/sag.blob into a Windows node.exe to
// produce sag.exe.
//
// Runs on any host (Linux, macOS, Windows, CI). Steps:
//   1. Pull and cache the official Node v22.23.1 Windows binary.
//   2. Copy it as sag.exe.
//   3. Use postject to inject the SEA blob at NODE_SEA_BLOB with the
//      fixed NODE_SEA_FUSE sentinel that v22 ships in the binary.
//
// Pre-req: dist/sag.blob + dist/sag.entry.cjs (run
// `npm run build:sea-bundle` first).

import {
  existsSync,
  mkdirSync,
  statSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  createWriteStream,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import https from "node:https";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
// All build artifacts (.exe, sibling .json, web/dist) go into
// `release/` rather than the source root, so the user's repo stays
// free of binary blobs. The runtime entry locates sidecars by
// `path.dirname(process.execPath)`, so as long as everything ships
// in the same `release/` dir, it boots identically.
const RELEASE_DIR = join(ROOT, "release");
// Local cache so repeated builds don't re-download the Windows
// Node zip. Default lives under the project root for portability;
// ensure-node.mjs pre-populates this same directory when run as
// part of `npm run build:windows-all`.
const CACHE = process.env.SAG_WIN_NODE_CACHE || join(ROOT, ".node-cache");
// Node 24.x LTS. Despite earlier text about 22.x compatibility,
// the SEA + V8 cache on 22.x dies with:
//   FATAL ERROR: v8::ToLocalChecked Empty MaybeLocal
// during `node::LoadEnvironment`, exit code 134. 24.x boots fine.
// Better-sqlite3 / sharp / sqlite-vec have to be rebuilt against
// ABI 137 (`npx @electron/rebuild --version 33.4.11` does this
// because Electron 33 ships the same V8/NODE_MODULE_VERSION as
// Node 24 LTS) — npm run build:desktop wires that in.
const NODE_VERSION = process.env.SAG_NODE_VERSION || "24.14.0";

// The SEA sentinel Node v22 bakes into its Windows binary at build time.
// It's a fixed project fuse (NOT a hash of the blob). If you switch to a
// different Node major, grep the new binary for "NODE_SEA_FUSE_" and
// update this string. See https://nodejs.org/api/single-executable-applications.html
const SEA_SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const MIRRORS = [
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://registry.npmmirror.com/-/binary/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
];

function log(...args) {
  console.log("[win-exe]", ...args);
}

// Recursively copy a directory tree from src to dst. Used to stage the
// unpacked native binaries (better_sqlite3.node, llama.dll, ...) next
// to SAG.exe. We deliberately don't use cp -r / robocopy because we
// want explicit file-level permission handling and to avoid chasing
// junction points.

// Recursively copy a directory tree from `src` to `dst`. Used to
// stage the unpacked native binaries (`better_sqlite3.node`,
// `llama.dll`, ...) next to SAG.exe. We deliberately don't use
// `cp -r` / `robocopy` because we want explicit file-level
// permission handling and to avoid chasing junction points.
function copyDirRobust(src, dst) {
  mkdirSync(dst, { recursive: true });
  let entries;
  try {
    entries = readdirSync(src, { withFileTypes: true });
  } catch (err) {
    console.warn("[win-exe] copyDirRobust: readdir failed for", src, err.message);
    return;
  }
  for (const ent of entries) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) {
      copyDirRobust(s, d);
    } else if (ent.isFile()) {
      try {
        copyFileSync(s, d);
      } catch (err) {
        // AV scanners on Windows occasionally hold a transient
        // lock on .dll/.node files we just wrote. Retry once
        // after a brief pause; if it still fails the parent
        // copy step will surface the missing file at boot.
        console.warn("[win-exe] copyFileSync failed for", s, "—", err.message);
        try {
          copyFileSync(s, d);
        } catch (err2) {
          console.warn("[win-exe] copyFileSync retry failed for", s, "—", err2.message);
        }
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
    log(`✓ cached node.exe: ${exePath} (${(statSync(exePath).size / 1024 / 1024).toFixed(1)} MB)`);
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
  if (!unzipOk) {
    throw new Error("could not unzip — please install unzip / PowerShell / tar");
  }
  if (!existsSync(exePath)) {
    throw new Error(`expected ${exePath} after extraction`);
  }

  // Sanity: confirm the SEA sentinel is embedded. If absent the binary is
  // unusable for SEA injection (some slimmed Node builds strip it).
  const exeBuf = readFileSync(exePath);
  if (!exeBuf.includes(Buffer.from(SEA_SENTINEL))) {
    throw new Error(
      `downloaded node.exe does not embed the SEA sentinel. ` +
        `Try a different mirror or a fresh Node v${NODE_VERSION} binary.`,
    );
  }

  // Stamp the project icon into the *freshly extracted* node.exe before
  // postject splices the SEA blob on top. We deliberately rewrite icon
  // here (and only here): once the SEA blob is appended, postject leaves
  // the resource section intact so a second rcedit pass on the final
  // 87 MB exe would have to re-scan the trailing data unnecessarily. The
  // script ships scripts/build/icosag.ico; missing icon is a no-op.
  const icoPath = join(__dirname, "icosag.ico");
  if (existsSync(icoPath)) {
    const rcedit = process.env.RCEDIT_BIN || "rcedit";
    const rr = spawnSync(rcedit, [exePath, "--set-icon", icoPath], { stdio: "inherit", shell: true });
    if (rr.status === 0) {
      log(`✓ icon: ${icoPath} (replaces Node.exe default icon)`);
    } else {
      log(`! rcedit failed (status ${rr.status}); continuing with default icon`);
    }
  }
  return exePath;
}

function ensurePostject() {
  // node_modules/.bin/postject is provided transitively by @yao-pkg/pkg
  // (already a devDep). If it isn't there (e.g. clean CI install), fetch
  // it on demand.
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

function writeBuildInfo() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const info = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    nodeVersion: process.versions.node,
    buildHost: process.platform + " " + process.arch,
    blobSha256: createHash("sha256")
      .update(readFileSync(join(DIST, "sag.blob")))
      .digest("hex"),
  };
  const out = join(DIST, "build-info.json");
  writeFileSync(out, JSON.stringify(info, null, 2));
}

function inject(exePath, blobPath, outExePath) {
  log("injecting blob into Windows node.exe");
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

/**
 * Strip the now-invalid Authenticode signature from the postject-
 * injected .exe. postject's blob injection invalidates the original
 * node.exe hash, leaving a dangling signature that triggers:
    "The signature seems corrupted!" on Windows load — and worse,
    SmartScreen flags the file as tampered.
 *
 * We zero the IMAGE_DIRECTORY_ENTRY_SECURITY (data directory index
 * 4) and recompute the optional-header CheckSum so the PE remains
 * well-formed and Windows loads it cleanly. The .exe is then
 * unsigned; users who need Authenticode can re-sign with their own
 * cert via `signtool sign /fd SHA256 /a SAG.exe`.
 *
 * The .stripped-sig.marker sidecar is left next to the .exe so
 * downstream tooling (release scripts, AV scanners) can detect that
 * the unsigned state is intentional.
 */
function stripAuthenticodeSignature(outExePath) {
  const py = process.env.PYTHON || "python";
  // Skip on non-Windows hosts — Python can run cross-platform but
  // we only need to strip Windows signatures, so guard the call.
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

/**
 * Switch the postject-injected .exe to a GUI subsystem so a
 * double-click does NOT spawn a console window. Logger.ts auto-
 * routes stdout/stderr to <release>/logs/ when the exe is detected
 * as a built SEA binary, so nothing is lost.
 *
 * Subsystem=2 (WINDOWS_GUI) per PE/COFF spec. Subsystem=3 (the
 * stock node.exe default) is what we are replacing.
 */
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
  const blobPath = join(DIST, "sag.blob");
  const entryPath = join(DIST, "sag.entry.cjs");
  if (!existsSync(blobPath)) {
    throw new Error(
      `${blobPath} not found — run \`npm run build:sea-bundle\` first.`,
    );
  }
  if (!existsSync(entryPath)) {
    throw new Error(
      `${entryPath} not found — run \`npm run build:sea-bundle\` first.`,
    );
  }

  // Output binary name. The runtime entry infers its sibling json
  // basenames from this exe basename, so the .native-map.json /
// .migrations.json that ship next to it must match.
  const EXE_NAME = "SAG-backend.exe";
  const outExePath = join(RELEASE_DIR, EXE_NAME);
  mkdirSync(RELEASE_DIR, { recursive: true });
  try { rmSync(outExePath, { force: true }); } catch {}
  // Remove the old-name binaries if they linger from a previous build so
  // the dist directory doesn't accumulate stale files.
  for (const stale of ["sag.exe", "sag-mcp.exe", "SAG.exe", "SAG-mcp.exe", "SAG-ingest-worker.exe", "SAG-mcp.exe", "SAG-ingest-worker.exe"]) {
    const stalePath = join(RELEASE_DIR, stale);
    if (stale !== EXE_NAME && existsSync(stalePath)) {
      try { rmSync(stalePath, { force: true }); } catch {}
    }
  }

  writeBuildInfo();

  const exePath = await ensureNode();
  // Export the Windows Node path so SEA bundle generators (which
  // execSync `node --experimental-sea-config`) can use the same
  // major as the binary we're injecting into. Without this they
  // use the host's `node` (often 24) and the resulting blob V8 ABI
  // mismatches the Node 22 runtime we ship — boot crash.
  process.env.SAG_SEA_NODE_EXE = exePath;
  log("sentinel:", SEA_SENTINEL);
  inject(exePath, blobPath, outExePath);
  // postject's blob injection invalidates node.exe's Authenticode
  // signature. Strip it so Windows doesn't flag the file as
  // tampered; users can re-sign with their own cert if needed.
  stripAuthenticodeSignature(outExePath);
  // Flip PE Subsystem from CONSOLE (3) to GUI (2) so a double-click
  // does not spawn a console window. Logger auto-routes to
  // <release>/logs/ when the binary is a built SEA exe.
  setGuiSubsystem(outExePath);

  // Ship .env.example next to SAG.exe so end users can discover
  // configuration without opening the docs. No secrets inside.
  const envExampleSrc = join(ROOT, ".env.example");
  if (existsSync(envExampleSrc)) {
    copyFileSync(envExampleSrc, join(RELEASE_DIR, ".env.example"));
    log("✓ .env.example copied next to " + EXE_NAME);
  } else {
    log("! .env.example not found — skipping");
  }

  // Ship a ready-to-paste MCP client snippet so users don't have to
  // hand-write JSON. They only need to replace the project UUID.
  const mcpConfigSrc = join(ROOT, "mcp-config.json");
  if (existsSync(mcpConfigSrc)) {
    copyFileSync(mcpConfigSrc, join(RELEASE_DIR, "mcp-config.json"));
    log("✓ mcp-config.json copied next to " + EXE_NAME);
  } else {
    log("! mcp-config.json not found — skipping");
  }

  // Ship the native-cache dir + manifest alongside the backend .exe.
  // Names must match process.execPath's basename (SAG-backend) so the
  // entry's basename lookup finds them. We moved from a single base64
  // JSON map to a directory of raw binaries + a tiny manifest because
  // the base64 JSON blew up V8's 512 MB single-string limit once
  // node-llama-cpp's prebuilt napi binaries were added (the old
  // build wrote a 1.4 GB base64 string and `readFileSync →
  // JSON.parse` in the runtime hit the same ceiling and crashed
  // the exe on startup).
  const sidecarBase = "SAG-backend";
  const manifestDst = join(RELEASE_DIR, sidecarBase + ".native-map.manifest.json");
  const migrationsDst = join(RELEASE_DIR, sidecarBase + ".migrations.json");

  // Clean up any old sag.*.* sidecars and the old native-cache dir
  // so a previous build doesn't shadow the new names.
  for (const stale of [
    "sag.native-map.json", "sag.native-map.manifest.json",
    "sag.migrations.json",
    sidecarBase + ".native-map.json", sidecarBase + ".native-map.manifest.json",
    sidecarBase + ".migrations.json",
  ]) {
    const p = join(RELEASE_DIR, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }
  const oldCacheDir = join(RELEASE_DIR, "native-cache");
  if (existsSync(oldCacheDir)) {
    try { rmSync(oldCacheDir, { recursive: true, force: true }); } catch {}
  }

  const manifestSrc = join(DIST, "sag.native-map.manifest.json");
  if (existsSync(manifestSrc)) {
    copyFileSync(manifestSrc, manifestDst);
    log("✓ " + sidecarBase + ".native-map.manifest.json copied next to " + EXE_NAME);
    // P23 fix: ensure better-sqlite3 .node binary is in source native-cache
    // (build pipeline manifest walker doesn't add .node binaries by default
    // since v12.11.1 has no prebuild for node-v137 in the npm registry).
    const fixBin = spawnSync("node", ["scripts/fix-better-sqlite3-binary.mjs"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (fixBin.status !== 0) {
      log("! fix-better-sqlite3-binary failed — SEA exe may fail to load native module");
    }
    // Recursively copy the native-cache dir. The directory holds
    // every binary the SEA runtime needs to load (better-sqlite3
    // .node, onnxruntime .dll, node-llama-cpp's ggml + llama
    // prebuilt DLLs, etc.). We deliberately use copyFileSync per
    // file rather than cp/copy-tree because the latter has
    // inconsistent behavior on Windows junctions / reparse points.
    const cacheSrc = join(DIST, "native-cache");
    if (existsSync(cacheSrc)) {
      copyDirRobust(cacheSrc, join(RELEASE_DIR, "native-cache"));
      log("✓ native-cache copied next to " + EXE_NAME);
    } else {
      log("! dist/native-cache missing — " + EXE_NAME + " will not boot");
    }
  } else {
    log("! sag.native-map.manifest.json not found — " + EXE_NAME + " will not boot");
  }

  const migrationsSrc = join(DIST, "sag.migrations.json");
  if (existsSync(migrationsSrc)) {
    copyFileSync(migrationsSrc, migrationsDst);
    log("✓ " + sidecarBase + ".migrations.json copied next to " + EXE_NAME);
  } else {
    log("! sag.migrations.json not found — " + EXE_NAME + " will not boot");
  }

  // Ship the file-converter helper scripts (Python + PowerShell)
  // packed as a single base64 JSON sidecar. The runtime unpacks it
  // into the native-cache directory — never next to the exe —
  // so end users do not see the decryption helpers on disk.
  const scriptsSrc = join(DIST, "sag.scripts.json");
  const scriptsDst = join(RELEASE_DIR, sidecarBase + ".scripts.json");
  if (existsSync(scriptsSrc)) {
    copyFileSync(scriptsSrc, scriptsDst);
    log("✓ " + sidecarBase + ".scripts.json copied next to " + EXE_NAME);
  } else {
    log("! sag.scripts.json not found — encrypted-office extraction will fail at runtime");
  }

  // Copy the web UI (web/dist) into the release dir so the static
  // file server can serve it. Runtime resolves webDistDir as
  // <sibling-of-exe>/web/dist/, so the layout must mirror the
  // source tree's web/dist/ location relative to the exe.
  const webDistSrc = join(ROOT, "web", "dist");
  const webDistDst = join(RELEASE_DIR, "web", "dist");
  if (existsSync(webDistSrc)) {
    // Recursive copy: web/dist/ may contain nested directories like
    // assets/. We walk the tree and inject the watermark into any
    // index.html we find along the way.
    const walk = (srcDir, dstDir) => {
      mkdirSync(dstDir, { recursive: true });
      let count = 0;
      for (const f of readdirSync(srcDir)) {
        const src = join(srcDir, f);
        const dst = join(dstDir, f);
        const st = statSync(src);
        if (st.isDirectory()) {
          count += walk(src, dst);
        } else if (st.isFile()) {
          if (f === "index.html") {
            let html = readFileSync(src, "utf8");
            if (!html.includes("sag-watermark")) {
              const watermarkStyle = "<style id=\"sag-watermark\" data-injected-by=\"server\">body::after{content:\"\";position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='140'%3E%3Ctext x='0' y='70' fill='rgba(0,0,0,0.05)' font-size='16' font-family='sans-serif' transform='rotate(-30,140,70)'%3Esag%3C/text%3E%3C/svg%3E\");background-repeat:repeat;}</style>";
              html = html.replace("</head>", watermarkStyle + "</head>");
            }
            writeFileSync(dst, html, "utf8");
          } else {
            copyFileSync(src, dst);
          }
          count += 1;
        }
      }
      return count;
    };
    const copied = walk(webDistSrc, webDistDst);
    log("✓ web/dist copied: " + copied + " file(s)");
  } else {
    log("! web/dist not found — web UI will 404");
  }
  const size = statSync(outExePath).size;
  log("✓ " + EXE_NAME + " ready:", outExePath, `(${(size / 1024 / 1024).toFixed(1)} MB)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
