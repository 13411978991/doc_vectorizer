// Direct test of the LLM client fallback path.
// Calls extractEventsFromChunk when llmProvider=api but no remote key
// is configured → should fall back to regex without throwing, and the
// returned event should be stamped extractionSource='regex-fallback'.
import { config } from "../src/config/env.js";
import { aiSettingsService } from "../src/services/ai-settings-service.js";
import { llmClient } from "../src/ai/llm-client.js";

const settings = await aiSettingsService.getRuntimeSettings();
console.log("Current runtime settings:");
console.log("  llmProvider =", settings.llmProvider);
console.log("  hasRemoteLlm =", settings.hasRemoteLlm);
console.log("  llmBaseUrl =", settings.llmBaseUrl);
console.log("  llmModel =", settings.llmModel);
console.log("  hasLlmApiKey =", settings.hasLlmApiKey);
console.log("");

const sampleText = "审计发现：张三在2025年10月于北京签署了关于Q4销售报表的合规审查文件。本期内控审计发现1项风险。";
console.log("Calling extractEventsFromChunk...");
const t0 = Date.now();
const events = await llmClient.extractEventsFromChunk({
  title: "测试文档",
  heading: "审计发现",
  content: sampleText,
  references: ["1"]
});
console.log("Got", events.length, "events in", Date.now() - t0, "ms");
console.log("First event extractionSource =", events[0]?.extractionSource);
console.log("First event title =", events[0]?.title);
console.log("First event entities:", events[0]?.entities?.map(e => `${e.type}:${e.name}`).join(", "));
process.exit(0);