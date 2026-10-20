// Standalone test of NER model
import { pipeline, env } from '@xenova/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exeDir = process.argv[2] || path.join(__dirname, 'dist-package', '本地知识检索-0.1.0', 'resources');
const modelPath = path.join(exeDir, 'models', 'bert-base-chinese-ner');

console.log('Model path:', modelPath);
console.log('Exe dir:', exeDir);

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = path.dirname(modelPath).replace(/\\/g, '/'); // parent dir

console.log('env.localModelPath:', env.localModelPath);

const p = await pipeline('token-classification', 'bert-base-chinese-ner', {
  local_files_only: true,
  model_file_name: 'model'
});

const text = '张三在北京大学会见李四。';
const result = await p(text, { aggregation_strategy: 'none' });
console.log('Result (none agg):', JSON.stringify(result.slice(0, 10), null, 2));

const result2 = await p(text, { aggregation_strategy: 'simple' });
console.log('Result (simple agg):', JSON.stringify(result2.slice(0, 10), null, 2));

const result3 = await p(text);
console.log('Result (default):', JSON.stringify(result3.slice(0, 10), null, 2));
