// Test the api-branch fallback directly by setting NODE_ENV to production
// so getSettingsOrFallback reads from the DB. Requires llmProvider="api"
// with a configured key in DB.
process.env.NODE_ENV = "production";
import("../src/services/ai-settings-service.js").then(async ({ aiSettingsService }) => {
  const { llmClient } = await import("../src/ai/llm-client.js");
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
  process.exit(0);
});