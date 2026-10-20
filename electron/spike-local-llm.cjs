// electron/spike-local-llm.cjs
//
// Phase-6 Electron-side feasibility spike: can the SEA / Electron
// runtime load node-llama-cpp's napi binary?
//
// Why this matters: the dev runtime is Node 24 (with its own napi
// v8 ABI), but Electron 33 ships Node 20 internally. node-llama-cpp
// prebuilt napi binaries are compiled against whichever Node ABI
// `node-gyp` resolved at install time — almost certainly the Node 24
// napi v8 — and Electron's ABI may be different.
//
// If the load fails the GGUF provider falls back to either:
//   (a) shipping an Electron-rebuilt binary in post-build
//   (b) declaring "路线B 不支持 Electron 33" and switching to 路线A
//
// Run with:  `npx electron electron/spike-local-llm.cjs <path-to-gguf>`
const { app } = require("electron");
const path = require("node:path");

// `--no-sandbox` is required when running as the root user inside
// some CI containers; harmless on a developer laptop. We pass it
// implicitly via process.argv below so the operator can see it in
// the failing-call stack.
app.commandLine.appendSwitch("no-sandbox");

const GGUF = process.argv[2];
if (!GGUF) {
  console.error("[electron-spike] usage: electron spike-local-llm.cjs <gguf-path>");
  app.exit(2);
  return;
}

(async () => {
  console.log("[electron-spike] electron =", process.versions.electron);
  console.log("[electron-spike] node     =", process.versions.node);
  console.log("[electron-spike] chrome   =", process.versions.chrome);
  console.log("[electron-spike] napi     =", process.versions.napi);
  console.log("[electron-spike] v8       =", process.versions.v8);

  // Defer the import until after we have the versions, so a binding
  // crash lands at a useful stack frame rather than the top-level
  // module evaluation.
  let llama;
  try {
    llama = await import("node-llama-cpp");
  } catch (err) {
    console.error("[electron-spike] FAIL: could not import node-llama-cpp:", err && err.stack ? err.stack : err);
    app.exit(1);
    return;
  }

  let model;
  try {
    const inst = await llama.getLlama();
    console.log("[electron-spike] getLlama() OK; gpu =", !!inst.gpu);
    model = await inst.loadModel({ modelPath: GGUF });
    console.log("[electron-spike] loadModel OK");
  } catch (err) {
    console.error("[electron-spike] FAIL: loadModel threw:", err && err.stack ? err.stack : err);
    app.exit(1);
    return;
  }

  try {
    const ctx = await model.createContext({ contextSize: 2048 });
    console.log("[electron-spike] createContext OK");
    const session = new llama.LlamaChatSession({ contextSequence: ctx.getSequence() });
    const reply = await session.prompt("Reply with the word OK and nothing else.");
    console.log("[electron-spike] inference OK; reply =", JSON.stringify(reply));
    await session.dispose();
    await ctx.dispose();
  } catch (err) {
    console.error("[electron-spike] FAIL: inference threw:", err && err.stack ? err.stack : err);
    app.exit(1);
    return;
  }

  try {
    await model.dispose();
  } catch {
    /* swallow */
  }
  console.log("[electron-spike] PASS");
  app.exit(0);
})();
