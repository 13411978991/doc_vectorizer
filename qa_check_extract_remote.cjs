// qa_check_extract_remote.cjs — Test llmClient.extractEventsFromChunk via the actual compiled module
const path = require('path');
process.env.NODE_ENV = 'production';

(async () => {
  try {
    // The dist folder contains the compiled JS. Need to use the JS path.
    // Looking at task description: import('../src/services/ai-settings-service.js')
    // — likely refers to compiled output.
    const aiSvc = await import('../dist/src/services/ai-settings-service.js').catch(() => null);
    if (!aiSvc) {
      // Try without the dist path
      const aiSvcAlt = await import('../src/services/ai-settings-service.ts').catch(() => null);
      console.error('aiSvcAlt:', aiSvcAlt ? 'loaded' : 'failed');
      return;
    }
    const { aiSettingsService } = aiSvc;
    const settings = await aiSvc.aiSettingsService.getRuntimeSettings();
    console.log('LLM provider:', settings.llmProvider, 'baseUrl:', settings.llmBaseUrl, 'model:', settings.llmModel, 'hasRemoteLlm:', settings.hasRemoteLlm);

    const llmMod = await import('../dist/src/ai/llm-client.js');
    const { llmClient } = llmMod;

    const sample = {
      title: "审计报告",
      heading: "审计发现",
      content: "审计发现:张三于2025年10月在北京签署了一份关于Q4销售报表的合规审查文件。",
      references: ["ref-1"]
    };
    const events = await llmClient.extractEventsFromChunk(sample);
    console.log('events:', JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message, err.stack);
  }
})();