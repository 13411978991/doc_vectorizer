"use strict";
// Load onnxruntime-node from the SEA runtime cache with Node 24 to
// reproduce the 0xC06D007F crash in isolation.
const path = require("path");
const SIG = process.argv[2] || "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/native-cache/7e4e9c26a019";
const binding = path.join(SIG, "node_modules", "onnxruntime-node", "bin", "napi-v3", "win32", "x64", "onnxruntime_binding.node");
console.log("loading:", binding);
try {
  process.dlopen({ exports: {} }, binding);
  console.log("dlopen OK");
} catch (e) {
  console.log("dlopen FAILED:", e.message);
}
try {
  const ort = require(path.join(SIG, "node_modules", "onnxruntime-node"));
  console.log("require OK, version:", ort.version ?? "(unknown)");
} catch (e) {
  console.log("require FAILED:", e.message);
}
