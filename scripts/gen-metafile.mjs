#!/usr/bin/env node
// gen-metafile.mjs — Re-run esbuild with metafile:true to surface
// every transitive npm package the bundle pulls in. The actual
// `build-sea-bundle.mjs` stepBundle call sets metafile:true too, but
// esbuild 0.28 sometimes only writes the metafile to stdout or to
// <outfile>.meta.json; we use this standalone script to make the
// path explicit.
import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const DIST = join(ROOT, "dist");
const ENTRY = join(DIST, "src", "index.js");
const BUNDLE = join(DIST, "sag.bundle.cjs");
const META = join(DIST, "sag.bundle.cjs.meta.json");

const NATIVE_DEPS = [
  "better-sqlite3", "sqlite-vec", "onnxruntime-node", "sharp", "bindings",
  "node-llama-cpp", "@node-llama-cpp",
];
const EXTERNAL_ESM_DEPS = [
  "@xenova/transformers",
  "onnxruntime-web",
  "@huggingface/jinja",
  "node-llama-cpp",
  "@node-llama-cpp/*",
];

await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: [
    ...NATIVE_DEPS,
    ...EXTERNAL_ESM_DEPS,
    "pg-native",
    "sharp",
    "@embedded-postgres/*",
  ],
  outfile: BUNDLE,
  metafile: true,
  logLevel: "info",
  banner: {
    js: [
      "// SAG esbuild bundle — bootstrapped by sag.entry.cjs at runtime.",
      'var import_meta_url = require("url").pathToFileURL(__filename).href;',
    ].join("\n"),
  },
  define: {
    "import.meta.url": "import_meta_url",
  },
});

const generated = BUNDLE + ".meta.json";
if (existsSync(generated) && generated !== META) {
  writeFileSync(META, readFileSync(generated, "utf8"));
  console.log("wrote", META);
} else if (existsSync(META)) {
  console.log("wrote", META);
} else {
  throw new Error("esbuild did not emit a metafile at " + generated);
}
