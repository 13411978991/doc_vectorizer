// Test using the NATIVE-CACHE transformers (not workspace)
import { createRequire } from 'module';
import path from 'path';

const fpDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache';
// Find the actual fingerprint dir (12 hex chars)
import { readdirSync, statSync } from 'fs';
const dirs = readdirSync(fpDir).filter(d => {
  try {
    return statSync(path.join(fpDir, d)).isDirectory() && /^[a-f0-9]{12}$/.test(d);
  } catch (e) { return false; }
});
const fp = dirs[0];
const transformersPath = path.join(fpDir, fp, 'node_modules', '@xenova', 'transformers');
console.log('Using transformers from:', transformersPath);
console.log('Transformers exists:', statSync(transformersPath).isDirectory());

const require_ = createRequire(transformersPath + '\\package.json');
const transformers = require_('@xenova/transformers');

transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = 'D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models';

const onnxEnv = transformers.env.backends?.onnx;
console.log('hasWasm:', !!onnxEnv?.wasm);
console.log('wasmPaths:', onnxEnv?.wasm?.wasmPaths);
console.log('envKeys:', Object.keys(transformers.env));
console.log('backends.onnx keys:', Object.keys(transformers.env.backends.onnx || {}).slice(0, 10));

if (onnxEnv?.wasm) {
  onnxEnv.wasm.wasmPaths = '/';
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
