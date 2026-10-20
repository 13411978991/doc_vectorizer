"use strict";
// Reproduce the in-process embedding path: import @xenova/transformers
// from the SEA sig dir, then load the BGE model and embed "hello".
const path = require("path");
const SIG = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/native-cache/7e4e9c26a019";
const MODEL = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/models/bge-large-zh-v1.5";

(async () => {
  const { pathToFileURL } = require("url");
  const tj = path.join(SIG, "node_modules", "@xenova", "transformers", "src", "transformers.js");
  const fs = require("fs");
  const entry = fs.existsSync(tj) ? tj : path.join(SIG, "node_modules", "@xenova", "transformers");
  console.log("importing @xenova/transformers from:", entry);
  const mod = await import(pathToFileURL(entry).href);
  const { pipeline, env } = mod;
  console.log("import OK");
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  const t0 = Date.now();
  const extractor = await pipeline("feature-extraction", MODEL, { local_files_only: true });
  console.log("pipeline loaded in", Date.now() - t0, "ms");
  const out = await extractor("hello", { pooling: "mean", normalize: true });
  console.log("embed OK, dim:", out.data.length, "first5:", Array.from(out.data.slice(0, 5)));
})().catch((e) => {
  console.log("FAILED:", e.message);
  console.log(e.stack?.split("\n").slice(0, 6).join("\n"));
});
