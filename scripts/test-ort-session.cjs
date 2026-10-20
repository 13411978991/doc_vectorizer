"use strict";
// Isolate: create an onnxruntime InferenceSession on the BGE int8 model
// directly (no transformers.js), verbose logging, to see what crashes.
const path = require("path");
const SIG = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/native-cache/7e4e9c26a019";
const MODEL = "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/models/bge-large-zh-v1.5/onnx/model_int8.onnx";
const ort = require(path.join(SIG, "node_modules", "onnxruntime-node"));
console.log("ort loaded");
(async () => {
  console.log("creating session on:", MODEL);
  const session = await ort.InferenceSession.create(MODEL, {
    logSeverityLevel: 0,
    logVerbosityLevel: 0,
    executionProviders: ["cpu"],
  });
  console.log("session OK");
  console.log("inputs:", session.inputNames);
  console.log("outputs:", session.outputNames);
})().catch((e) => console.log("FAILED:", e.message));
