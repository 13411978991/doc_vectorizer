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
const CACHE = process.env.SAG_WIN_NODE_CACHE || "/tmp/sag-win-node";
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
  // script ships scripts/黑洞.ico; missing icon is a no-op.
  const icoPath = join(__dirname, "黑洞.ico");
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

  // Output binary name (renamed from sag.exe to a Chinese display name).
  // The runtime entry infers its sibling json basenames from this exe
  // basename, so the .native-map.json / .migrations.json that ship next
  // to it must match.
  const EXE_NAME = "黑洞.exe";
  const outExePath = join(ROOT, EXE_NAME);
  try { rmSync(outExePath, { force: true }); } catch {}
  // Remove the old-name binary if it lingers from a previous build so
  // the dist directory doesn't accumulate stale files.
  for (const stale of ["sag.exe", "sag-mcp.exe", "黑洞-mcp.exe"]) {
    const stalePath = join(ROOT, stale);
    if (stale !== EXE_NAME && existsSync(stalePath)) {
      try { rmSync(stalePath, { force: true }); } catch {}
    }
  }

  writeBuildInfo();

  const exePath = await ensureNode();
  log("sentinel:", SEA_SENTINEL);
  inject(exePath, blobPath, outExePath);

  // Ship .env.example next to 黑洞.exe so end users can discover
  // configuration without opening the docs. No secrets inside.
  const envExampleSrc = join(ROOT, ".env.example");
  if (existsSync(envExampleSrc)) {
    copyFileSync(envExampleSrc, join(ROOT, ".env.example"));
    log("✓ .env.example copied next to " + EXE_NAME);
  } else {
    log("! .env.example not found — skipping");
  }

  // Ship a ready-to-paste MCP client snippet so users don't have to
  // hand-write JSON. They only need to replace the project UUID.
  const mcpConfigSrc = join(ROOT, "mcp-config.json");
  if (existsSync(mcpConfigSrc)) {
    copyFileSync(mcpConfigSrc, join(ROOT, "mcp-config.json"));
    log("✓ mcp-config.json copied next to " + EXE_NAME);
  } else {
    log("! mcp-config.json not found — skipping");
  }

  // Ship native-map and migrations alongside 黑洞.exe. Names must
  // match process.execPath's basename (黑洞) so the entry's basename
  // lookup finds them.
  const sidecarBase = "黑洞";
  const nativeMapDst = join(ROOT, sidecarBase + ".native-map.json");
  const migrationsDst = join(ROOT, sidecarBase + ".migrations.json");

  // Clean up any old sag.*.* sidecars so a previous build doesn't
  // shadow the new names.
  for (const stale of ["sag.native-map.json", "sag.migrations.json", sidecarBase + ".native-map.json", sidecarBase + ".migrations.json"]) {
    const p = join(ROOT, stale);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  }

  const nativeMapSrc = join(DIST, "sag.native-map.json");
  if (existsSync(nativeMapSrc)) {
    copyFileSync(nativeMapSrc, nativeMapDst);
    log("✓ " + sidecarBase + ".native-map.json copied next to " + EXE_NAME);
  } else {
    log("! sag.native-map.json not found — " + EXE_NAME + " will not boot");
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
  const scriptsDst = join(ROOT, sidecarBase + ".scripts.json");
  if (existsSync(scriptsSrc)) {
    copyFileSync(scriptsSrc, scriptsDst);
    log("✓ " + sidecarBase + ".scripts.json copied next to " + EXE_NAME);
  } else {
    log("! sag.scripts.json not found — encrypted-office extraction will fail at runtime");
  }

  // Copy the web UI (web/dist) next to the .exe so the static file
  // server can serve it. The watermark is injected into index.html
  // during copy so it cannot be removed by editing the source files.
  // The destination is <sibling-of-exe>/web/dist/, which is where
  // the running server's webDistDir lookup finds it.
  const webDistSrc = join(ROOT, "web", "dist");
  const webDistDst = join(ROOT, "web", "dist");
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
              const watermarkStyle = "<style id=\"sag-watermark\" data-injected-by=\"server\">body::after{content:\"\";position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='280' height='140'%3E%3Ctext x='0' y='70' fill='rgba(0,0,0,0.05)' font-size='16' font-family='sans-serif' transform='rotate(-30,140,70)'%3Esunwoda audit%3C/text%3E%3C/svg%3E\");background-repeat:repeat;}</style>";
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
