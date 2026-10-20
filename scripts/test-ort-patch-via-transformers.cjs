// test-ort-patch-via-transformers.cjs — Reproduce the EXACT worker path
// standalone: @xenova/transformers pipeline + our InferenceSession.create
// monkey-patch. If this crashes with BFCArena OOM, the patch doesn't reach
// transformers. If it survives, the SEA worker's resolution differs.
"use strict";
const path = require("node:path");
const os = require("node:os");

function memMB(tag) {
  const mu = process.memoryUsage();
  console.log(
    `${tag}: rss=${(mu.rss / 1048576).toFixed(0)}MB free=${(os.freemem() / 1048576).toFixed(0)}MB`
  );
}

(async () => {
  const transformers = require("@xenova/transformers");
  console.log("transformers resolved from:", require.resolve("@xenova/transformers"));

  // --- same patch as embedding-worker.ts ---
  const candidatePaths = [];
  try {
    const txMain = require.resolve("@xenova/transformers");
    candidatePaths.push(
      require.resolve("onnxruntime-node", { paths: [path.dirname(txMain)] })
    );
  } catch (e) {
    console.log("resolve via tx failed:", e.message);
  }
  try {
    candidatePaths.push(require.resolve("onnxruntime-node"));
  } catch {}
  console.log("candidatePaths:", candidatePaths);

  const seen = new Set();
  for (const ortPath of candidatePaths) {
    if (seen.has(ortPath)) continue;
    seen.add(ortPath);
    const ortNs = require(ortPath);
    const Create = ortNs?.InferenceSession?.create;
    if (!Create) {
      console.log("no create at", ortPath);
      continue;
    }
    if (Create.__sagPatched) continue;
    const orig = Create;
    const patched = async function sagPatchedCreate(buffer, opts) {
      console.log(">>> sagPatchedCreate INVOKED, opts in =", JSON.stringify(opts));
      return orig(buffer, {
        ...(opts ?? {}),
        enableCpuMemArena: false,
        enableMemoryPattern: false,
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionProviders: opts?.executionProviders ?? ["cpu"]
      });
    };
    patched.__sagPatched = true;
    try {
      ortNs.InferenceSession.create = patched;
      console.log("patched OK at", ortPath);
    } catch (e) {
      console.log("PATCH ASSIGN FAILED at", ortPath, ":", e.message);
    }
    // verify it stuck
    console.log("create is patched?", ortNs.InferenceSession.create.__sagPatched === true);
  }
  // --- end patch ---

  memMB("before pipeline");
  const env = transformers.env;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;

  const modelDir =
    "E:/sag/完整后端版本/源码/doc_vectorizer/release-desktop/win-unpacked/resources/models";
  env.localModelPath = modelDir.replace(/\\/g, "/");
  const pipe = await transformers.pipeline("feature-extraction", "bge-large-zh-v1.5", {
    quantized: false,
    model_file_name: "model_int8",
    local_files_only: true
  });
  memMB("pipeline loaded");

  // Same as worker: batch of 32 truncated texts
  const texts = Array.from({ length: 32 }, (_, i) => "审计底稿第" + i + "号:内部控制测试内容。".repeat(10));
  memMB("before forward");
  const t0 = Date.now();
  const out = await pipe(texts, { pooling: "cls", normalize: true });
  console.log(`forward OK in ${Date.now() - t0}ms, dims=${out.dims.join("x")}`);
  memMB("after forward");
  console.log("ALL OK — patch reaches transformers.");
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e && e.message ? e.message : e);
  process.exit(2);
});
