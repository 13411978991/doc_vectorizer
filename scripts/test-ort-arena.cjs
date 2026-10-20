// test-ort-arena.cjs — Isolate the BGE OOM from the SEA / worker stack.
// Run: node scripts/test-ort-arena.cjs [on|off]
//   on  = default onnxruntime session (BFC arena ON)  — expect crash
//   off = enableCpuMemArena:false                     — expect survive
"use strict";
const os = require("node:os");

const mode = process.argv[2] || "off";
const modelPath =
  "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/models/bge-large-zh-v1.5/onnx/model_int8.onnx";

function memMB() {
  const mu = process.memoryUsage();
  return `rss=${(mu.rss / 1048576).toFixed(0)}MB heap=${(mu.heapUsed / 1048576).toFixed(0)}MB free=${(os.freemem() / 1048576).toFixed(0)}MB`;
}

(async () => {
  console.log(`mode=${mode} node=${process.version}`);
  console.log("before require:", memMB());
  const ort = require("onnxruntime-node");
  console.log("ort resolved from:", require.resolve("onnxruntime-node"));
  console.log("after require:", memMB());

  const opts =
    mode === "off"
      ? {
          executionProviders: ["cpu"],
          enableCpuMemArena: false,
          enableMemoryPattern: false,
          intraOpNumThreads: 1,
          interOpNumThreads: 1
        }
      : { executionProviders: ["cpu"] };

  console.log("creating session with opts:", JSON.stringify(opts));
  const session = await ort.InferenceSession.create(modelPath, opts);
  console.log("session created:", memMB());
  console.log("inputs:", session.inputNames, "outputs:", session.outputNames);

  // Reproduce the crash shape: batch=32, seq=512 (the embedding loop's
  // batchSize is 32; worker truncates to 510 tokens).
  for (const [batch, seq] of [
    [1, 512],
    [8, 512],
    [32, 512]
  ]) {
    const ids = new BigInt64Array(batch * seq).fill(100n);
    const mask = new BigInt64Array(batch * seq).fill(1n);
    const tt = new BigInt64Array(batch * seq).fill(0n);
    const feeds = {
      input_ids: new ort.Tensor("int64", ids, [batch, seq]),
      attention_mask: new ort.Tensor("int64", mask, [batch, seq]),
      token_type_ids: new ort.Tensor("int64", tt, [batch, seq])
    };
    console.log(`forward batch=${batch} seq=${seq} ...`, memMB());
    const t0 = Date.now();
    const out = await session.run(feeds);
    const first = out[session.outputNames[0]];
    console.log(
      `  ok in ${Date.now() - t0}ms, out[${session.outputNames[0]}] dims=${first.dims.join("x")}`,
      memMB()
    );
  }
  console.log("ALL OK — arena flag works, model fits.");
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e && e.message ? e.message : e);
  process.exit(2);
});
