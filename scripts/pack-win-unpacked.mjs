// pack-win-unpacked.mjs — Stage a clean distribution copy of win-unpacked
// (excluding per-machine caches, user data, logs, tmp) then zip it via
// PowerShell's Compress-Archive. Compress-Archive handles Unicode file
// names and 2+ GB outputs without external tooling.
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = resolve("release-desktop/win-unpacked");
const STAGE = resolve("release-desktop/SAG-桌面版-dist");
const OUT = resolve("release-desktop/SAG-桌面版-portable.zip");

const HEX12 = /^[0-9a-f]{12}$/;
const EXCLUDE_DIRS = new Set([
  "5daa3504d5d6",  // current per-machine fingerprint
  "native-cache-test",
  "data",
  "logs",
  ".tmp",
]);

if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// robocopy mirrors a tree while honoring per-directory exclude rules.
// /MIR not used; we copy explicit top-level entries to keep it safe.
const topLevel = readdirSync(SRC);
const robocopy = (srcDir, dstDir, excludes) => {
  // robocopy exit codes: 0=no change, 1=files copied, 2=extra, 3=1+2, 5/6/7=failures
  // treat 0-7 as success (excluding real failure codes >=8).
  const r = spawnSync("robocopy.exe", [
    srcDir,
    dstDir,
    "*",
    "/E",        // mirror subdirs (including empty)
    "/XD", ...excludes,
    "/NFL",      // no file list output
    "/NDL",      // no dir list output
    "/NJH",      // no job header
    "/NJS",      // no job summary
    "/NP",       // no progress
    "/R:0",      // no retries
    "/W:0",      // no wait
  ], { stdio: "inherit" });
  if (r.status > 7) throw new Error(`robocopy ${srcDir} -> ${dstDir} exit ${r.status}`);
};
for (const entry of topLevel) {
  const srcPath = join(SRC, entry);
  const dstPath = join(STAGE, entry);
  const st = statSync(srcPath);
  if (st.isDirectory()) {
    const excludes = [entry];
    for (const d of EXCLUDE_DIRS) excludes.push(d);
    // per-machine fingerprint dir under native-cache/
    if (entry === "native-cache" || entry === "resources" || entry === "models") {
      // We'll handle native-cache specially below
    }
    console.log(`robocopy: ${entry}/`);
    robocopy(srcPath, dstPath, excludes);
  } else {
    console.log(`copy: ${entry}`);
    cpSync(srcPath, dstPath, { recursive: false });
  }
}

// Re-robocopy resources/native-cache excluding every 12-hex subdir.
const NATIVE_CACHE = join(SRC, "resources", "native-cache");
if (existsSync(NATIVE_CACHE)) {
  const sub = readdirSync(NATIVE_CACHE).filter((n) => {
    if (HEX12.test(n)) return true;  // exclude per-machine
    return false;
  });
  if (sub.length) {
    console.log(`robocopy: resources/native-cache/ (excluding ${sub.length} per-machine subdirs)`);
    robocopy(NATIVE_CACHE, join(STAGE, "resources", "native-cache"), sub);
  }
}

// ── Manifest completeness gate ────────────────────────────────────
// Every file referenced by a native-map manifest must exist in the
// staged native-cache, plus the manifest's __bundle__ target. A zip
// built without __bundle__/sag-mcp.bundle.cjs shipped to users and
// crashed every mcp launch with an opaque copyfile ENOENT; a chalk
// v5→v4 shim once left 4 phantom entries that spammed warnings on
// first boot. Fail the pack instead of shipping a broken zip.
//
// ALLOWLIST — paths that are legitimately absent from the staging
// tree because they are test fixtures / dev-only assets that the
// runtime never loads. These come from the build machine's full
// node_modules walk but the staged native-cache copy omits them
// (packaging filters them out). Verified against the running app:
// nothing in the code path reads them.
//   @protobufjs/inquire/tests/** — protobufjs' own test fixtures,
//     shipped inside the npm tarball but never require()d by the
//     protobuf runtime (only by @protobufjs/inquire's test suite).
const ALLOW_MISSING = [/^@protobufjs[\\/]inquire[\\/]tests[\\/]/];
import { readFileSync } from "node:fs";
{
  const RES = join(STAGE, "resources");
  const manifests = readdirSync(RES).filter((n) => n.endsWith(".native-map.manifest.json"));
  let missingTotal = 0;
  for (const mf of manifests) {
    const m = JSON.parse(readFileSync(join(RES, mf), "utf8"));
    const missing = [];
    for (const [pkg, files] of Object.entries(m.packages || {})) {
      for (const rel of Object.keys(files)) {
        const full = `${pkg}/${rel}`;
        if (ALLOW_MISSING.some((re) => re.test(full))) continue;
        if (!existsSync(join(RES, "native-cache", pkg, rel))) {
          missing.push(full);
        }
      }
    }
    if (m.__bundle__ && !existsSync(join(RES, "native-cache", m.__bundle__))) {
      missing.push(m.__bundle__);
    }
    if (missing.length) {
      missingTotal += missing.length;
      console.error(`✗ ${mf}: ${missing.length} referenced file(s) missing in staged native-cache:`);
      for (const f of missing.slice(0, 20)) console.error(`    - ${f}`);
      if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`);
    } else {
      console.log(`✓ ${mf}: all referenced files present`);
    }
  }
  if (missingTotal > 0) {
    console.error(`\npack aborted: ${missingTotal} manifest-referenced file(s) missing from the staging tree.`);
    console.error("Rebuild the native-cache staging (build:sea-bundle / build:stdio-launcher) or copy the missing files in before packing.");
    process.exit(1);
  }
}

console.log("\n--- staging summary ---");
function size(p) {
  try { return readdirSync(p, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? size(join(p, e.name)) : statSync(join(p, e.name)).size), 0); } catch { return 0; }
}
const total = size(STAGE);
console.log(`stage size: ${(total / 1073741824).toFixed(2)} GB (${(total / 1048576).toFixed(0)} MB)`);
console.log(`output:     ${OUT}`);

console.log("\n--- compressing via PowerShell Compress-Archive ---");
// Compress-Archive does NOT accept per-item excludes for files inside
// the source dir, only `-Path` as a top-level file/directory. We
// point it at the staged dir directly (which already has the excludes
// applied) and let it recurse.
const ps = spawnSync("powershell.exe", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path "${STAGE}\\*" -DestinationPath "${OUT}" -CompressionLevel Optimal -Force`,
], { stdio: "inherit" });
if (ps.status !== 0) {
  console.error("Compress-Archive failed:", ps.status);
  process.exit(ps.status || 1);
}
console.log(`\n✓ portable zip ready: ${OUT}`);
console.log(`  size: ${(statSync(OUT).size / 1073741824).toFixed(2)} GB`);
