// Slim, clean distribution zip. Only files the end user actually needs.
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "E:\\sag\\dist\\builds\\sag-20260813-171645";
const STAGE = "E:\\sag\\dist\\release-staging";
const OUT_DIR = "E:\\sag\\dist";

// Slotted timestamp for the zip name.
const now = new Date();
const stamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, "0"),
  String(now.getDate()).padStart(2, "0"),
  "-",
  String(now.getHours()).padStart(2, "0"),
  String(now.getMinutes()).padStart(2, "0"),
  String(now.getSeconds()).padStart(2, "0")
].join("");
const zipPath = join(OUT_DIR, `sag-${stamp}.zip`);

// Reset staging.
if (existsSync(STAGE)) {
  spawnSync("powershell", ["-NoProfile", "-Command", `Remove-Item -Recurse -Force "${STAGE}"`], { stdio: "inherit" });
}
mkdirSync(STAGE, { recursive: true });

// Each entry here is either a single file or a whole directory copied across.
const keep = [
  "黑洞.exe",
  "黑洞.native-map.json",
  "黑洞.migrations.json",
  "黑洞-mcp.exe",
  "黑洞-mcp.native-map.json",
  "黑洞-mcp.migrations.json",
  "web",
  "migrations",
  "scripts",
  "mcp-config.json"
];

// Recursive copy of a file or directory.
function copyOne(src, dst) {
  if (!existsSync(src)) {
    console.log(`  MISSING: ${src}`);
    return;
  }
  if (statSync(src).isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const ent of readdirSync(src)) {
      copyOne(join(src, ent), join(dst, ent));
    }
  } else {
    const parent = dirname(dst);
    mkdirSync(parent, { recursive: true });
    spawnSync("powershell", ["-NoProfile", "-Command", `Copy-Item -Force "${src}" "${dst}"`], { stdio: "inherit" });
  }
}

console.log("Staging user-facing artifacts:");
for (const name of keep) {
  const sp = join(SRC, name);
  const dp = join(STAGE, name);
  console.log(`  + ${name}`);
  copyOne(sp, dp);
}

console.log("\nSkipped (not for end users):");
const all = readdirSync(SRC);
const skipNames = new Set(keep);
skipNames.add("data"); // runtime data, never ship
for (const ent of all) {
  if (!skipNames.has(ent)) console.log(`  - ${ent}`);
}

console.log("\nFinal staged contents:");
for (const ent of readdirSync(STAGE, { withFileTypes: true })) {
  const full = join(STAGE, ent.name);
  if (ent.isDirectory()) {
    let total = 0;
    const walk = (p) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const fp = join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else total += statSync(fp).size;
      }
    };
    walk(full);
    console.log(`  ${ent.name}/  ${(total / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`  ${ent.name}  ${(statSync(full).size / 1024 / 1024).toFixed(2)} MB`);
  }
}

console.log(`\nZipping → ${zipPath}`);
const r = spawnSync("powershell", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path "${STAGE}\\*" -DestinationPath "${zipPath}" -Force`
], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("zip failed");
  process.exit(1);
}
console.log(`\n✓ ${zipPath} (${(statSync(zipPath).size / 1024 / 1024).toFixed(2)} MB)`);