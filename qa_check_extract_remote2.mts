// qa_check_extract_remote2.mts
process.env.NODE_ENV = 'production';
process.env.LOG_LEVEL = 'silent';

import * as AiSettingsService from "./src/services/ai-settings-service.js";
const { aiSettingsService } = AiSettingsService;

const settings = await aiSettingsService.getRuntimeSettings();
console.log('LLM provider:', settings.llmProvider);
console.log('baseUrl:', JSON.stringify(settings.llmBaseUrl));
console.log('model:', JSON.stringify(settings.llmModel));
console.log('hasRemoteLlm:', settings.hasRemoteLlm);
console.log('hasApiKey:', settings.llmApiKey?.length > 0);