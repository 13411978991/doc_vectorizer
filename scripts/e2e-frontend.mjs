// Simulate what the WebUI does: fetch SettingsInput → mutate ui key via local state → save handler → PUT.
// Step 1: read SettingsInput shape that the bundle generates
// Step 2: just verify the API now accepts llmProvider (already confirmed)
// Step 3: PUT with full SettingsInput including llmProvider
import { readFileSync } from "node:fs";

async function getSettings() {
  const r = await fetch("http://127.0.0.1:4173/api/settings/ai");
  return (await r.json()).settings;
}

async function putSettings(payload) {
  const r = await fetch("http://127.0.0.1:4173/api/settings/ai", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json();
}

// Read the bundle and verify updateAiSettings source includes llmProvider
const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");
// Save the bundle inspection to file rather than console (battle of pieces is huge)
const { writeFileSync } = await import("node:fs");
let idx = 0;
let count = 0;
const inspectionLines = ["=== Bundle inspection ==="];
while ((idx = bundle.indexOf("llmProvider", idx)) !== -1) {
  count++;
  const start = Math.max(0, idx - 50);
  const end = Math.min(bundle.length, idx + 80);
  inspectionLines.push(`Match #${count} at ${idx}: ${bundle.substring(start, end).replace(/\s+/g, ' ')}`);
  idx += 1;
}
inspectionLines.push(`\nTotal matches: ${count}`);
writeFileSync("build-tmp/bundle-inspection.log", inspectionLines.join("\n"));
console.log(`Bundle inspection written to build-tmp/bundle-inspection.log`);
console.log(`llmProvider found ${count} times in bundle`);

(async () => {
  // Run a full save handler round-trip
  const log = [];
  log.push("\n=== Full WebUI save simulation ===");
  const s1 = await getSettings();
  log.push(`current llmProvider = ${s1.llmProvider}`);

  // Mimic save handler: include llmProvider as the user toggled it
  const payload = {
    embeddingProvider: s1.embeddingProvider,
    embeddingBaseUrl: s1.embeddingBaseUrl,
    embeddingModel: s1.embeddingModel,
    embeddingDimensions: s1.embeddingDimensions,
    embeddingApiKey: "",
    clearEmbeddingApiKey: false,
    embeddingLocalModelPath: "",
    clearEmbeddingLocalModelPath: false,
    llmProvider: "local",  // user toggled to local
    llmBaseUrl: s1.llmBaseUrl,
    llmModel: s1.llmModel,
    llmApiKey: "",
    clearLlmApiKey: false,
    defaultSearchMode: s1.defaultSearchMode,
    defaultSearchTopK: s1.defaultSearchTopK,
    defaultChunkingMode: s1.defaultChunkingMode,
    chunkTokenLimit: s1.chunkTokenLimit,
    chunkOverlapTokens: s1.chunkOverlapTokens
  };
  const r2 = await putSettings(payload);
  log.push(`after PUT(llmProvider=local): ${r2.settings.llmProvider}`);

  const s3 = await getSettings();
  log.push(`after GET: ${s3.llmProvider}`);

  if (s3.llmProvider === "local") {
    log.push("✅ End-to-end toggle works (full payload with llmProvider field)");
  } else {
    log.push(`❌ Expected 'local', got '${s3.llmProvider}'`);
  }

  // Reset
  await putSettings({ ...payload, llmProvider: "api" });
  log.push("reset to api");

  // Write the log to a file so it doesn't get drowned in bundle output
  const { writeFileSync } = await import("node:fs");
  writeFileSync("build-tmp/e2e-verdict.log", log.join("\n"));
})();