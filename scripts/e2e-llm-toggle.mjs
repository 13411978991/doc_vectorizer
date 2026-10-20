// scripts/e2e-llm-toggle.mjs — End-to-end test: flip llmProvider, verify backend persists, reset.
// 1. GET current settings (record llmProvider)
// 2. PUT with llmProvider="local" — verify persisted
// 3. GET again — verify it stays local
// 4. PUT with llmProvider="api" — verify persisted back
import { readFileSync } from "node:fs";

async function getSettings() {
  const r = await fetch("http://127.0.0.1:4173/api/settings/ai");
  const j = await r.json();
  return j.settings;
}

async function putSettings(llmProvider) {
  const r = await fetch("http://127.0.0.1:4173/api/settings/ai", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeddingProvider: "api",
      embeddingBaseUrl: "",
      embeddingModel: "",
      embeddingDimensions: 1024,
      embeddingApiKey: "",
      clearEmbeddingApiKey: false,
      embeddingLocalModelPath: "",
      clearEmbeddingLocalModelPath: false,
      llmProvider,
      llmBaseUrl: "",
      llmModel: "",
      llmApiKey: "",
      clearLlmApiKey: false,
      defaultSearchMode: "fast",
      defaultSearchTopK: 10,
      defaultChunkingMode: "heading_strict",
      chunkTokenLimit: 1024,
      chunkOverlapTokens: 100
    })
  });
  return r.json();
}

(async () => {
  console.log("\n=== STEP 1: initial state ===");
  const s1 = await getSettings();
  console.log(`initial llmProvider = "${s1.llmProvider}"`);

  console.log("\n=== STEP 2: PUT llmProvider='local' ===");
  const r2 = await putSettings("local");
  console.log(`after PUT, server returned llmProvider = "${r2.settings.llmProvider}"`);

  console.log("\n=== STEP 3: GET — should still be 'local' ===");
  const s3 = await getSettings();
  console.log(`getter sees llmProvider = "${s3.llmProvider}"`);

  console.log("\n=== STEP 4: PUT llmProvider='api' (reset) ===");
  const r4 = await putSettings("api");
  console.log(`after reset, server returned llmProvider = "${r4.settings.llmProvider}"`);

  console.log("\n=== STEP 5: GET — should be 'api' again ===");
  const s5 = await getSettings();
  console.log(`getter sees llmProvider = "${s5.llmProvider}"`);

  console.log("\n=== VERDICT ===");
  if (s1.llmProvider === "api" && s3.llmProvider === "local" && s5.llmProvider === "api") {
    console.log("✅ Backend round-trip works: api → local → api all persisted correctly");
  } else {
    console.log("❌ Backend round-trip failed");
    console.log(`expected api/local/api, got ${s1.llmProvider}/${s3.llmProvider}/${s5.llmProvider}`);
    process.exit(1);
  }
})();