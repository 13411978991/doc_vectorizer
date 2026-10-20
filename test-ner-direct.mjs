// Direct test that mimics exactly what the bundle does
import * as transformers from '@xenova/transformers';

transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = "D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models";

// Override wasm paths
if (transformers.env.wasm) {
  transformers.env.wasm.wasmPaths = "D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models/bert-base-chinese-ner/dist";
}

const p = await transformers.pipeline('token-classification', 'bert-base-chinese-ner', {
  quantized: true,
  model_file_name: 'model',
  local_files_only: true
});

const text = '张三在北京大学会见李四。';
const result = await p(text, {
  max_length: 512,
  truncation: true,
  ignore_labels: []
});

console.log('Result count:', result.length);
console.log('First 5 tokens:');
for (const t of result.slice(0, 5)) {
  console.log(`  index=${t.index} entity=${t.entity} word="${t.word}" score=${t.score.toFixed(4)}`);
}
console.log('Last 3 tokens:');
for (const t of result.slice(-3)) {
  console.log(`  index=${t.index} entity=${t.entity} word="${t.word}" score=${t.score.toFixed(4)}`);
}
