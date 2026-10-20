// Standalone test using the EXACT same factory configuration
import * as transformers from '@xenova/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Replicate factory
const modelPath = "models/bert-base-chinese-ner";
const exeDir = "D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources";
const absoluteModelPath = path.join(exeDir, modelPath);
const basename = path.basename(absoluteModelPath);
const parentDir = path.dirname(absoluteModelPath);
transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = parentDir.replace(/\\/g, '/');

console.log('absoluteModelPath:', absoluteModelPath);
console.log('parentDir:', parentDir);
console.log('env.localModelPath:', transformers.env.localModelPath);
console.log('basename:', basename);

const p = await transformers.pipeline('token-classification', basename, {
  quantized: true,
  model_file_name: 'model',
  local_files_only: true
});

const text = '张三在北京大学会见李四。';
console.log('\nCalling pipeline...');
const result = await p(text, {
  max_length: 512,
  truncation: true,
  ignore_labels: []
});
console.log('Result count:', result.length);
console.log('Result (first 5):', JSON.stringify(result.slice(0, 5), null, 2));
console.log('Last 3:', JSON.stringify(result.slice(-3), null, 2));
