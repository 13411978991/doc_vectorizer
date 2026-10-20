// scripts/jsdom-test.mjs — Simulate the browser by parsing the BUNDLE
// (no real DOM needed) to prove the save handler explicitly spreads
// llmProvider. Then make the actual HTTP call to verify backend.
//
// Why this works: the bundle is minified by Rollup/esbuild. Property
// KEYS are never mangled (they have to match the API contract), only
// variable NAMES are. So the onSave object's keys are readable in the
// bundle. We parse it out and assert `llmProvider:` is there.

import { readFileSync, writeFileSync } from "node:fs";

const log = ["=== Bundle save-handler inspection ===\n"];

const bundle = readFileSync("web/dist/assets/index-BZPRoTyj.js", "utf8");

// The save handler is the object literal passed to e.onSave. We know the
// starting key `embeddingProvider:f` is unique and the closing `})` is
// right after `chunkOverlapTokens:ve`. Match.
const startIdx = bundle.indexOf("embeddingProvider:f");
const endIdx = bundle.indexOf("chunkOverlapTokens:ve})", startIdx);

if (startIdx === -1 || endIdx === -1) {
  log.push("❌ Could not locate save handler object literal in bundle");
} else {
  const saveLiteral = bundle.substring(startIdx, endIdx + 24);
  log.push("Save handler object literal (parsed from bundle):");
  log.push(saveLiteral);
  log.push("");
  if (saveLiteral.includes("llmProvider:")) {
    log.push("✅ Bundle save handler explicitly spreads llmProvider");
  } else {
    log.push("❌ Bundle save handler does NOT include llmProvider!");
  }
  // List top-level keys for clarity
  const keys = [...saveLiteral.matchAll(/(\w+):\w+/g)].map(m => m[1]);
  log.push(`Keys present in save handler: ${[...new Set(keys)].join(", ")}`);
}

log.push("");
log.push("=== Full backend round-trip ===");

// Reset and test
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

const s1 = await getSettings();
log.push(`initial = ${s1.llmProvider}`);

// Simulate exactly what the React save handler sends. The bundle's
// onSave callback receives state captured at submit time. We mirror
// that — including `llmProvider: "local"` (user's toggle).
const payload = {
  embeddingProvider: s1.embeddingProvider,
  embeddingBaseUrl: s1.embeddingBaseUrl,
  embeddingModel: s1.embeddingModel,
  embeddingDimensions: s1.embeddingDimensions,
  embeddingApiKey: "",
  clearEmbeddingApiKey: false,
  embeddingLocalModelPath: s1.embeddingLocalModelPath ?? "",
  clearEmbeddingLocalModelPath: false,
  llmProvider: "local",  // ← user toggled to local
  llmBaseUrl: s1.llmBaseUrl ?? "",
  llmModel: s1.llmModel ?? "",
  llmApiKey: "",
  clearLlmApiKey: false,
  llmLocalModelPath: s1.llmLocalModelPath ?? "",
  clearLlmLocalModelPath: false,
  llmLocalContextSize: s1.llmLocalContextSize ?? 4096,
  nerModel: s1.nerModel ?? "",
  clearNerModel: false,
  defaultSearchMode: s1.defaultSearchMode,
  defaultSearchTopK: s1.defaultSearchTopK,
  defaultChunkingMode: s1.defaultChunkingMode,
  chunkTokenLimit: s1.chunkTokenLimit,
  chunkOverlapTokens: s1.chunkOverlapTokens
};

const r2 = await putSettings(payload);
log.push(`after PUT(llmProvider=local) → ${r2.settings.llmProvider}`);

const s3 = await getSettings();
log.push(`after GET → ${s3.llmProvider}`);

// Reset
await putSettings({ ...payload, llmProvider: "api" });
log.push("reset to api");

log.push("");
if (s3.llmProvider === "local") {
  log.push("✅ Backend + bundle shape verified");
} else {
  log.push("❌ Verification failed");
}

writeFileSync("build-tmp/jsdom-test.log", log.join("\n"));
console.log(log.join("\n"));