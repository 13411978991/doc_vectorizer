"use strict";
// Replicate getLocalBgePipeline() exactly: static-style require of
// @xenova/transformers (as the CJS bundle does), env.localModelPath =
// parent dir, pipeline("feature-extraction", basename).
const path = require("path");
const SIG = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/native-cache/7e4e9c26a019";
const MODEL_PARENT = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/models";

// Resolve @xenova/transformers from the sig dir like the bundle would
const Module = require("module");
const sigRequire = Module.createRequire(path.join(SIG, "__bundle__", "sag.bundle.cjs"));

(async () => {
  console.log("requiring @xenova/transformers (CJS-style, as bundle does)...");
  const t0 = Date.now();
  const _transformers = sigRequire("@xenova/transformers");
  console.log("require OK in", Date.now() - t0, "ms");

  const env = _transformers.env;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_PARENT.replace(/\\/g, "/");
  const basename = "bge-large-zh-v1.5";
  const fsPromises = require("fs/promises");
  const onnxDir = path.join(MODEL_PARENT, basename, "onnx");
  const files = await fsPromises.readdir(onnxDir);
  console.log("onnx files:", files.join(", "));
  const onnxFiles = files.filter((f) => f.endsWith(".onnx"));
  const score = (fn) => {
    const stem = fn.replace(/\.onnx$/, "").toLowerCase();
    if (/(int8|uint8|q4|q8|quantized|quantised|quant)/.test(stem)) return 1000 - stem.length;
    if (/(fp16|fp32|float)/.test(stem)) return 100 - stem.length;
    return 1;
  };
  const onnxFileName = onnxFiles.sort((a, b) => score(b) - score(a))[0].replace(/\.onnx$/, "");
  console.log("picked:", onnxFileName);

  const t1 = Date.now();
  const extractor = await _transformers.pipeline("feature-extraction", basename, {
    quantized: false,
    model_file_name: onnxFileName,
    local_files_only: true,
  });
  console.log("pipeline loaded in", Date.now() - t1, "ms");
  const out = await extractor("你好世界", { pooling: "mean", normalize: true });
  console.log("embed OK, dim:", out.data.length);
})().catch((e) => {
  console.log("FAILED:", e.message);
  console.log(e.stack?.split("\n").slice(0, 8).join("\n"));
});
