// qa_check_extract_misconfigured.mts — Test with broken key
process.env.NODE_ENV = 'production';
process.env.DATABASE_FILE = 'E:\\sag\\完整后端版本\\源码\\doc_vectorizer\\data\\sag.db';
process.env.LOG_LEVEL = 'silent';

import { initPool } from "./src/db/pool.js";
import { aiSettingsService } from "./src/services/ai-settings-service.js";
import { llmClient } from "./src/ai/llm-client.js";

await initPool();

// Override settings to force misconfigured state for this test
const settingsSvc = aiSettingsService as any;
// Save original settings
const orig = await aiSettingsService.getRuntimeSettings();
console.log('Original provider:', orig.llmProvider);

// We'll call llmClient with explicit misconfig: it uses settings.hasRemoteLlm which is true, but
// we can simulate by using a bogus base URL. Actually, easier: clear hasRemoteLlm by overriding
// the runtime setting via the ai-settings-service. But we don't have a setter.
// So: just inject a runtime LLM that's blocked by simulating a wrong key path. The settings
// endpoint accepts an explicit input via testLlmConnection, but extractEventsFromChunk uses getRuntimeSettings().

// Use the testLlmConnection function with bogus input — verify it returns ok: false
const { testLlmConnection } = await import("./src/ai/llm-client.js");
const result = await testLlmConnection({
  llmBaseUrl: "https://invalid.example.com/",
  llmModel: "fake",
  llmApiKey: "fake-key"
});
console.log('misconfigured probe result:', JSON.stringify(result));

// Now try extractEventsFromChunk with the actual config. Since the URL is wrong (returns HTML),
// we expect extractionSource: "regex-fallback".
const sample = {
  title: "审计报告",
  heading: "审计发现",
  content: "审计发现:张三于2025年10月在北京签署了一份关于Q4销售报表的合规审查文件。",
  references: ["ref-1"]
};
const events = await llmClient.extractEventsFromChunk(sample);
console.log('events[0].extractionSource:', events[0].extractionSource);