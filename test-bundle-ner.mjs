// Test that mimics the bundle's behavior
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);
const transformers = require_('@xenova/transformers');

transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = 'D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models';

const onnxEnv = transformers.env.backends?.onnx;
console.log('hasWasm:', !!onnxEnv?.wasm);
console.log('wasmPaths:', onnxEnv?.wasm?.wasmPaths);

if (onnxEnv?.wasm) {
  const path = require_('path');
  const wasmDir = path.join(
    'D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models',
    'bert-base-chinese-ner',
    'dist'
  );
  onnxEnv.wasm.wasmPaths = wasmDir;
  onnxEnv.wasm.proxy = false;
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
for (const t of result.slice(0, 5)) {
  console.log('  index=' + t.index + ' entity=' + t.entity + ' word=' + JSON.stringify(t.word) + ' score=' + t.score.toFixed(4));
}
