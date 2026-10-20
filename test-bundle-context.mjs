// Test that mimics EXACTLY what the bundle does
import { createRequire } from 'module';
import path from 'path';

// Use the same require path as the bundle
const bundleDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache\\dcc7dfb03298';
const require_ = createRequire(bundleDir + '\\__bundle__\\sag.bundle.cjs');

// Load transformers the same way the bundle does (CJS require)
const transformersPkg = require_('@xenova/transformers');
console.log('Loaded type:', typeof transformersPkg);
console.log('Has default:', !!transformersPkg.default);
console.log('Has pipeline:', typeof transformersPkg.pipeline);
console.log('Has env:', typeof transformersPkg.env);

// If pipeline is on the default, we need to use it from there
const transformers = transformersPkg.default || transformersPkg;
console.log('Effective transformers type:', typeof transformers);
console.log('Has pipeline on effective:', typeof transformers.pipeline);

// Try the call
transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = 'D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models';

const onnxEnv = transformers.env.backends?.onnx;
console.log('hasWasm:', !!onnxEnv?.wasm);

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
