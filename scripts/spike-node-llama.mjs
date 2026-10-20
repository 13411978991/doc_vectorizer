// scripts/spike-node-llama.mjs
// Phase-1 feasibility spike: does node-llama-cpp load on this
// Node 22 + Windows box? Does it find its prebuilt llama binary?
// We don't actually run inference here — just verify the
// `getLlama()` factory works so we know we can wire up the real
// client in Phase 4.
//
// Exit code 0 = OK, non-zero = the whole "路线B" is a dead end
// and we need to switch to 路线A (外挂 Ollama).
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GGUF = process.argv[2];

console.log("[spike] node =", process.version);
console.log("[spike] platform =", process.platform, process.arch);

try {
  const llama = await getLlama();
  console.log("[spike] getLlama() OK");
  console.log("[spike] gpu =", !!llama.gpu, "cpu =", llama.cpu);

  if (!GGUF) {
    console.log("[spike] no GGUF path given — skipping model load");
    console.log("[spike] PASS (factory-only smoke)");
    process.exit(0);
  }

  console.log("[spike] loading model:", GGUF);
  const model = await llama.loadModel({ modelPath: GGUF });
  console.log("[spike] loadModel OK");

  const context = await model.createContext();
  console.log("[spike] createContext OK");

  const session = new LlamaChatSession({ contextSequence: context.getSequence() });
  console.log("[spike] chat session created");

  const reply = await session.prompt("Say hi in one short sentence.");
  console.log("[spike] model reply:", JSON.stringify(reply));

  await session.dispose();
  await context.dispose();
  await model.dispose();
  console.log("[spike] PASS");
  process.exit(0);
} catch (err) {
  console.error("[spike] FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
}
