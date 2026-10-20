// qa_check_extract_remote4.mts — Use absolute DB path
process.env.NODE_ENV = 'production';
process.env.DATABASE_FILE = 'E:\\sag\\完整后端版本\\源码\\doc_vectorizer\\data\\sag.db';
process.env.LOG_LEVEL = 'silent';

import { aiSettingsService } from "./src/services/ai-settings-service.js";
import { llmClient } from "./src/ai/llm-client.js";

const settings = await aiSettingsService.getRuntimeSettings();
console.log('LLM provider:', settings.llmProvider);
console.log('baseUrl:', JSON.stringify(settings.llmBaseUrl));
console.log('model:', JSON.stringify(settings.llmModel));
console.log('hasRemoteLlm:', settings.hasRemoteLlm);

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
  console.log('entities count:', e.entities?.length);
}