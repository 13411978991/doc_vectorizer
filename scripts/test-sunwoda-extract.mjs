process.env.NODE_ENV = "production";
const { aiSettingsService } = await import("../src/services/ai-settings-service.js");
const { llmClient } = await import("../src/ai/llm-client.js");
const settings = await aiSettingsService.getRuntimeSettings();
console.log("Runtime settings:");
console.log("  llmProvider:", settings.llmProvider);
console.log("  llmBaseUrl:", settings.llmBaseUrl);
console.log("  llmModel:", settings.llmModel);
console.log("  hasRemoteLlm:", settings.hasRemoteLlm);
console.log("  hasLlmApiKey:", !!settings.llmApiKey);
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
for (const e of events) {
  console.log("  extractionSource:", e.extractionSource);
  console.log("  title:", e.title);
  console.log("  category:", e.category);
  console.log("  entities:", e.entities?.slice(0, 3).map(en => `${en.type}:${en.name}`).join(", "));
}
process.exit(0);