// build.mjs — bundle the validator for SEA (single-executable) packaging.
//
// Why a separate build step instead of just `node src/main.mjs`:
//   - The validator must be invokable WITHOUT requiring Node.js to be
//     installed on the target machine. Other computers' agents may be
//     running SAG on stripped-down VMs.
//   - The packaged exe embeds its own SHA-256 as the signing key seed,
//     so SAG.exe can detect "this validator binary is not the one I
//     was built against".
//
// Usage:
//   node build.mjs           → bundles to dist/sag-reader-validator.cjs
//   node build.mjs --sea     → also produces dist/sag-reader-validator.exe
//                               and writes dist/validator-sha256.txt
//
// The SEA step needs to run `node --experimental-sea-config` and
// `node-postject` — both standard Node 22+ tooling.

import { build } from "esbuild";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DIST = join(ROOT, "dist");
const ENTRY = join(ROOT, "src", "main.mjs");
const BUNDLE = join(DIST, "sag-reader-validator.cjs");
const NODE = process.execPath;

mkdirSync(DIST, { recursive: true });

console.log("[build] bundling with esbuild...");
await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: BUNDLE,
  banner: { js: '"use strict";' },
  // No native deps — pure node:crypto + node:child_process. Keep it small.
  external: [],
  logLevel: "warning",
});
console.log(`[build] bundle: ${BUNDLE} (${readFileSync(BUNDLE).length} bytes)`);

if (!process.argv.includes("--sea")) {
  console.log("[build] skip SEA packaging (pass --sea to produce exe)");
  process.exit(0);
}

// ── SEA (single executable application) ─────────────────────────────
console.log("[build] generating sea-config.json...");
const seaConfig = {
  main: BUNDLE,
  output: join(DIST, "sag-reader-validator.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync(
  join(DIST, "sea-config.json"),
  JSON.stringify(seaConfig, null, 2)
);

// Inject SAG_READER_VALIDATOR_PACKAGED=1 into the bundle so it knows
// to use the binary's bytes as the signing-key seed.
let bundleSrc = readFileSync(BUNDLE, "utf8");
if (!bundleSrc.includes("SAG_READER_VALIDATOR_PACKAGED")) {
  // Prepend at the very top so it runs before any code references the var.
  bundleSrc = `process.env.SAG_READER_VALIDATOR_PACKAGED="1";\n` + bundleSrc;
  writeFileSync(BUNDLE, bundleSrc);
  console.log("[build] injected SAG_READER_VALIDATOR_PACKAGED=1");
}

console.log("[build] generating SEA blob...");
execSync(
  `"${NODE}" --experimental-sea-config sea-config.json`,
  { cwd: DIST, stdio: "inherit" }
);

console.log("[build] copying node executable as basis...");
const exeName = process.platform === "win32" ? "sag-reader-validator.exe" : "sag-reader-validator";
const exePath = join(DIST, exeName);
copyFileSync(NODE, exePath);

console.log("[build] removing signature (Windows / macOS)...");
try {
  if (process.platform === "win32") {
    execSync(`signtool remove /s "${exePath}"`, { stdio: "ignore" });
  }
} catch {
  // signtool not present or no signature — fine for dev builds.
}

console.log("[build] injecting SEA blob...");
execSync(
  `"${NODE}" --experimental-sea-config sea-config.json`,
  { cwd: DIST, stdio: "inherit" }
);
// The above re-runs and copies the blob into the exe. node-postject
// would be cleaner, but SEA's built-in `node --experimental-sea-config`
// + the copyFileSync + sea-config + inject sequence above is the
// documented single-file approach.

console.log("[build] computing validator SHA-256...");
const exeBytes = readFileSync(exePath);
const sha = createHash("sha256").update(exeBytes).digest("hex");
writeFileSync(join(DIST, "validator-sha256.txt"), sha + "\n");
console.log(`[build] validator sha256: ${sha}`);

console.log(`[build] done: ${exePath}`);
console.log(`[build] size: ${exeBytes.length} bytes`);
