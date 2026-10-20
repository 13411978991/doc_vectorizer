// qa_check_settings_raw.mts
process.env.NODE_ENV = 'production';
process.env.DATABASE_FILE = 'E:\\sag\\完整后端版本\\源码\\doc_vectorizer\\data\\sag.db';
process.env.LOG_LEVEL = 'silent';

import { getAiProviderSettings } from "./src/db/repositories.js";

const settings = await getAiProviderSettings();
console.log('Raw settings:', settings ? JSON.stringify({
  llmProvider: settings.llmProvider,
  llmBaseUrl: settings.llmBaseUrl,
  llmModel: settings.llmModel,
  llmApiKeyLen: settings.llmApiKey?.length
}, null, 2) : 'null');