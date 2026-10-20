// qa_check_extract_remote.mts — Use tsx to load .ts directly
process.env.NODE_ENV = 'production';

import { aiSettingsService } from "./src/services/ai-settings-service.js";
import { llmClient } from "./src/ai/llm-client.js";

const settings = await aiSettingsService.getRuntimeSettings();
console.log('LLM provider:', settings.llmProvider, 'baseUrl:', settings.llmBaseUrl, 'model:', settings.llmModel, 'hasRemoteLlm:', settings.hasRemoteLlm);

const sample = {
  title: "审计报告",
  heading: "审计发现",
  content: "审计发现:张三于2025年10月在北京签署了一份关于Q4销售报表的合规审查文件。",
  references: ["ref-1"]
};

const events = await llmClient.extractEventsFromChunk(sample);
console.log('events count:', events.length);
for (const e of events) {
  console.log('extractionSource:', e.extractionSource);
  console.log('title:', e.title?.slice(0, 50));
  console.log('summary:', e.summary?.slice(0, 80));
  console.log('category:', e.category);
  console.log('entities:', e.entities?.length);
}