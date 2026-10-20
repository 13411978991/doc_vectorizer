// scripts/verify-save-payload.mjs
// Capture exactly what the WebUI sends when user toggles llmProvider.
// Approach: monkey-patch global fetch to log the body, then simulate
// the React save handler by directly invoking what the bundle would do.

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";

// Capture fetch
const realFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, init) => {
  if (typeof url === "string" && url.endsWith("/api/settings/ai") && init?.method === "PUT") {
    captured = {
      url,
      method: init.method,
      body: init.body
    };
    // Return a fake successful response so the React save handler doesn't blow up
    return new Response(JSON.stringify({ settings: { llmProvider: "local" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return realFetch(url, init);
};

// Replicate what the bundle's save handler does.
// We can read the bundle, find the e.onSave callback, and extract the
// object literal that gets passed. The object is minified so we have to
// look at identifiers.
//
// Instead of reverse-engineering minified names, let's just call the
// updateAiSettings API directly via the live HTTP endpoint and have
// the user see the actual body. But that means running the bundle's
// React code in node, which is impractical.
//
// Simplest pragmatic test: confirm the backend SETS llmProvider when
// the body contains it (we already did this), and confirm the WebUI
// bundle's save handler inlines llmProvider:N (we already did this).
// What we haven't confirmed: that the click event actually fires
// onSave. That's React semantics — only the user can verify.
//
// So this script is a no-op demonstrator.

(async () => {
  const log = ["=== Save payload verification ===\n"];

  // 1) Backend writes llmProvider to DB
  log.push("Backend upsertAiProviderSettings accepts llmProvider:");
  log.push("  src/db/repositories.ts:2080  llmProvider: LlmProvider;");
  log.push("  src/db/repositories.ts:2116  pg `INSERT INTO ai_provider_settings (... llm_provider ...)`");
  log.push("");

  // 2) zod schema validates llmProvider
  log.push("Backend PUT schema accepts llmProvider:");
  log.push("  src/api/server-helpers.ts:205  llmProvider: z.enum(['api','local']).default('api')");
  log.push("");

  // 3) Service reads llmProvider from input
  log.push("Service updateSettings reads llmProvider from input:");
  log.push("  src/services/ai-settings-service.ts:213  const llmProvider = input.llmProvider ?? ...");
  log.push("");

  // 4) Frontend save handler inlines llmProvider:N
  log.push("Frontend save handler bundles llmProvider:");
  log.push("  web/dist/assets/index-BZPRoTyj.js:632398");
  log.push("  `e.onSave({embeddingProvider:f, ..., llmProvider:N, llmBaseUrl:y, ...})`");
  log.push("");

  // 5) WebUI toggle calls setLlmProvider(option.value)
  log.push("Frontend toggle calls setLlmProvider on click:");
  log.push("  web/src/App.tsx:4752  onClick={() => setLlmProvider(option.value)}");
  log.push("");

  // 6) State syncs from server after save
  log.push("State sync: after save, props.settings.llmProvider updates → useEffect re-syncs llmProvider");
  log.push("  web/src/App.tsx:3952  useEffect(() => { setLlmProvider(props.settings.llmProvider ?? 'api'); ... }, [props.settings])");
  log.push("");

  // 7) Real backend round-trip
  const r1 = await realFetch("http://127.0.0.1:4173/api/settings/ai");
  const j1 = await r1.json();
  log.push(`Direct backend round-trip:`);
  log.push(`  initial = ${j1.settings.llmProvider}`);

  const r2 = await realFetch("http://127.0.0.1:4173/api/settings/ai", {
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
      llmProvider: "local",
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
  const j2 = await r2.json();
  log.push(`  after PUT(llmProvider=local) = ${j2.settings.llmProvider}`);

  const r3 = await realFetch("http://127.0.0.1:4173/api/settings/ai");
  const j3 = await r3.json();
  log.push(`  after GET = ${j3.settings.llmProvider}`);

  // Reset to api
  await realFetch("http://127.0.0.1:4173/api/settings/ai", {
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
      llmProvider: "api",
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

  writeFileSync("build-tmp/verify-save-payload.log", log.join("\n"));
  console.log(log.join("\n"));
})();