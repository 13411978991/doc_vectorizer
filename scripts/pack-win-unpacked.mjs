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
// Per-machine runtime artifacts. The keys here are matched by name
// anywhere they appear in the tree, so a real `data` subdirectory
// inside a node module (test fixtures, schema files) gets dropped
// just because it happens to share the name with the SAG runtime's
// data/ dir. We avoid that here by keeping this list to *runtime*
// artefacts and only adding HEX12 (per-machine fingerprint dirs)
// and `native-cache-test` (build-script only). The `data`/`logs`/
// `.tmp` per-project runtime dirs are excluded by an explicit
// top-level check further below — see `if (entry === "data" ...)`.
// The `data` exclude used to live here and it silently stripped
// every `tests/data/`, `data/` fixture, and `cldr-data/` payload
// from the distribution, which the SEA runtime then crashed on
// with ENOENT.
const EXCLUDE_DIRS = new Set([
  "native-cache-test",
]);

if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// robocopy mirrors a tree while honoring per-directory exclude rules.
// /MIR not used; we copy explicit top-level entries to keep it safe.
const topLevel = readdirSync(SRC);
const robocopy = (srcDir, dstDir, excludes) => {
  // robocopy exit codes: 0=no change, 1=files copied, 2=extra, 3=1+2, 5/6/7=failures
  // treat 0-7 as success (excluding real failure codes >=8).
  const ex = excludes || [];
  const r = spawnSync("robocopy.exe", [
    srcDir,
    dstDir,
    "*",
    "/E",        // mirror subdirs (including empty)
    "/XD", ...ex,
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
// Per-project runtime dirs that must NEVER ship. These are checked
// against the TOP-LEVEL name only — the bug from the previous
// version was that the same name was also being applied inside
// node_modules, silently stripping every `tests/data/`, `data/`
// fixture, etc. that the runtime then crashed on.
const RUNTIME_TOP_LEVEL_DIRS = new Set(["data", "logs", ".tmp"]);

for (const entry of topLevel) {
  if (RUNTIME_TOP_LEVEL_DIRS.has(entry)) {
    console.log(`skip (runtime): ${entry}/`);
    continue;
  }
  const srcPath = join(SRC, entry);
  const dstPath = join(STAGE, entry);
  const st = statSync(srcPath);
  if (st.isDirectory()) {
    const excludes = [];
    for (const d of EXCLUDE_DIRS) excludes.push(d);
    console.log(`robocopy: ${entry}/`);
    robocopy(srcPath, dstPath, excludes);
  } else {
    console.log(`copy: ${entry}`);
    cpSync(srcPath, dstPath, { recursive: false });
  }
}

// Re-robocopy resources/native-cache excluding every 12-hex subdir.
// The per-machine dirs are unpacked at first boot and are specific to
// the machine that built the zip — they must never ship. This pass
// re-copies native-cache with those excluded, overwriting whatever the
// top-level loop just staged.
const NATIVE_CACHE = join(SRC, "resources", "native-cache");
if (existsSync(NATIVE_CACHE)) {
  const sub = readdirSync(NATIVE_CACHE).filter((n) => HEX12.test(n));
  const dstNC = join(STAGE, "resources", "native-cache");
  // Drop anything already staged so the exclusion is authoritative
  // rather than additive.
  rmSync(dstNC, { recursive: true, force: true });
  console.log(
    sub.length
      ? `robocopy: resources/native-cache/ (excluding ${sub.length} per-machine subdirs)`
      : "robocopy: resources/native-cache/"
  );
  robocopy(NATIVE_CACHE, dstNC, sub);
}

// ── Build-temp sweep ──────────────────────────────────────────────
// pe-set-icon works by copying the exe aside, rewriting the copy, and
// renaming it into place. Both build scripts used to forget the
// intermediate copy on the success path, which shipped a stray
// 188 MB "SAG 桌面版.exe.icon-tmp.exe" inside the distribution. Strip
// any such leftovers from the staging tree so a build-script bug can
// never reach users again.
{
  let stripped = 0;
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (/\.(icon-tmp|icon-new|rcedit-tmp)\.exe$/.test(ent.name)) {
        rmSync(p, { force: true });
        console.log(`  stripped build temp: ${relative(STAGE, p)}`);
        stripped++;
      }
    }
  };
  walk(STAGE);
  if (stripped === 0) console.log("build-temp sweep: clean");
}
// Verify EVERY file the manifest references is actually staged.
//
// This must be exhaustive, not "spot check the bundle". The SEA
// backend's unpacker (build-sea-bundle.mjs entry template,
// sag.entry.cjs:98) calls copyFileSync with NO try/catch — a single
// missing file aborts the process with a raw ENOENT stack before the
// HTTP server ever binds, which is exactly the "backend never became
// ready" failure we chased for hours on 2026-10-21.
//
// The four missing @protobufjs/inquire/tests/data/*.js files were
// dropped by the old `/XD data` exclude, which robocopy matches by
// directory NAME anywhere in the tree. That bug is fixed above; this
// gate exists so it can never ship again.
import { readFileSync } from "node:fs";
{
  const RES = join(STAGE, "resources");
  const manifests = readdirSync(RES).filter((n) => n.endsWith(".native-map.manifest.json"));
  let fatal = 0;
  for (const mf of manifests) {
    const m = JSON.parse(readFileSync(join(RES, mf), "utf8"));
    const missing = [];
    for (const [pkg, files] of Object.entries(m.packages || {})) {
      for (const rel of Object.keys(files)) {
        if (!existsSync(join(RES, "native-cache", pkg, rel))) {
          missing.push(`${pkg}/${rel}`);
        }
      }
    }
    if (m.__bundle__ && !existsSync(join(RES, "native-cache", m.__bundle__))) {
      missing.push(m.__bundle__);
    }
    const pkgCount = Object.keys(m.packages || {}).length;
    const fileCount = Object.values(m.packages || {})
      .reduce((n, f) => n + Object.keys(f).length, 0);
    if (missing.length) {
      fatal += missing.length;
      console.error(`✗ ${mf}: ${missing.length} of ${fileCount} referenced files missing:`);
      for (const f of missing.slice(0, 20)) console.error(`    - ${f}`);
      if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`);
    } else {
      console.log(`✓ ${mf}: ${fileCount} files across ${pkgCount} packages staged`);
    }
  }
  if (fatal > 0) {
    console.error(`\npack aborted: ${fatal} manifest-referenced file(s) missing from staging.`);
    console.error("The SEA runtime aborts on the first missing file, so this is not shippable.");
    console.error("Rebuild the native-cache staging (build:sea-bundle / build:stdio-launcher) before packing.");
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
