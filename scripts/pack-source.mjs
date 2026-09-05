#!/usr/bin/env node
// Pack the source tree (excluding heavy / generated / private dirs) into a
// zip the user can hand back to me later. Skips:
//   - node_modules       (deps; rebuilt via npm ci)
//   - dist               (build artifacts)
//   - test-model         (huge bge-large embedding model, symlink loop)
//   - .trae              (IDE config)
//   - .tmp               (scratch)
//   - release-staging    (build staging)
//   - .git               (large history; user has it elsewhere)
import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(process.argv[2] ?? "E:\\sag\\export");
const OUT = process.argv[3] ?? `E:\\sag\\dist\\sag-source-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.zip`;
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "test-model",
  ".trae",
  ".tmp",
  "release-staging",
  ".git",
  "sag-source",
  "verify-extract"
]);
const SKIP_FILES = new Set([".DS_Store"]);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) yield* walk(full);
      else if (e.isFile() && !SKIP_FILES.has(e.name)) yield full;
    } catch (err) {
      console.warn(`skip ${full}: ${err.message}`);
    }
  }
}

console.log(`packing ${ROOT} -> ${OUT}`);
let count = 0;
// Use system tar for speed + handles symlinks gracefully.
// Also exclude a few known transient files so a leftover EXCEL-locked
// test artifact (test-smoke.xlsx etc.) doesn't abort the whole tar.
const args = [
  "-cf", OUT,
  "--exclude=node_modules",
  "--exclude=dist",
  "--exclude=test-model",
  "--exclude=.trae",
  "--exclude=.tmp",
  "--exclude=release-staging",
  "--exclude=.git",
  "--exclude=test-smoke.xlsx",
  "--exclude=test-large.xlsx",
  "--exclude=~*",
  "--exclude=*.log",
  "-C", ROOT, "."
];
const t = spawn("tar", args, { stdio: "inherit" });
t.on("close", (code) => {
  if (code === 0) console.log(`done (tar exit ${code})`);
  else console.log(`tar exit ${code}`);
});