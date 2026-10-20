"use strict";
// Same InferenceSession test but from the PROJECT's node_modules +
// project models dir (the dev layout that previously worked).
const path = require("path");
const ort = require("onnxruntime-node"); // resolves to project node_modules
const MODEL = process.argv[2] || "E:/sag/完整后端版本/源码/doc_vectorizer/models/bge-large-zh-v1.5/onnx/model_int8.onnx";
console.log("ort version pkg:", require("onnxruntime-node/package.json").version);
console.log("creating session on:", MODEL);
(async () => {
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ["cpu"] });
  console.log("session OK, inputs:", session.inputNames, "outputs:", session.outputNames);
  // Run a dummy inference to be thorough
  const { Tensor } = ort;
  const seq = new Tensor("int64", BigInt64Array.from([101n, 2023n, 102n]), [1, 3]);
  const mask = new Tensor("int64", BigInt64Array.from([1n, 1n, 1n]), [1, 3]);
  const feeds = { input_ids: seq, attention_mask: mask };
  if (session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new Tensor("int64", BigInt64Array.from([0n, 0n, 0n]), [1, 3]);
  }
  const res = await session.run(feeds);
  const first = res[session.outputNames[0]];
  console.log("inference OK, output dims:", first.dims.join("x"));
})().catch((e) => console.log("FAILED:", e.message));
