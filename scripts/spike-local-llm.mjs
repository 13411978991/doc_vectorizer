// scripts/spike-local-llm.mjs
// Phase-4 runtime smoke: load a GGUF via LocalLlmClient, run a
// JSON-schema-constrained extraction against the SAG prompt
// shape, and verify the result parses cleanly.
//
// This is the same code path the real ingestion pipeline takes
// (just with a hardcoded sample text instead of a real chunk).
import { loadLocalLlmModel, extractEventsViaLocalLlm } from "../dist/src/ai/local-llm-client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GGUF = process.argv[2] ?? path.join(
  ROOT,
  "release-desktop",
  "win-unpacked",
  "resources",
  "models",
  "SmolLM2-135M-Instruct-Q4_K_M.gguf"
);

const settings = {
  llmProvider: "local",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKey: "",
  llmLocalModelPath: GGUF,
  llmLocalContextSize: 2048,
  llmTimeoutMs: 60_000
};

console.log("[smoke] GGUF =", GGUF);
const t0 = Date.now();
const info = await loadLocalLlmModel(GGUF, 2048);
console.log("[smoke] loaded in", Date.now() - t0, "ms:", info);

const systemPrompt = [
  "You are a SAG content extractor.",
  'Output strict JSON: {"type":"response","data":{"items":[{"title":"...","summary":"...","content":"...","category":"...","keywords":["..."],"priority":"UNKNOWN","status":"COMPLETED","references":[],"entities":[{"type":"subject","name":"...","description":"..."}],"is_valid":true,"children":[]}],"meta":{"reason":"...","confidence":0.5}}}'
].join("\n");

const userPrompt = JSON.stringify({
  type: "request",
  data: {
    items: [
      {
        id: 1,
        content: "审计发现：张三在 2025 年 10 月于北京签署了关于 Q4 销售报表的合规审查文件。"
      }
    ],
    meta: { source_type: "test", source_title: "smoke", entity_types: ["person", "organization", "location", "time"] }
  }
});

console.log("[smoke] running extractEventsViaLocalLlm...");
const t1 = Date.now();
const events = await extractEventsViaLocalLlm(settings, { system: systemPrompt, user: userPrompt, operation: "smoke" });
console.log("[smoke] extracted in", Date.now() - t1, "ms; events:", events);
process.exit(0);
