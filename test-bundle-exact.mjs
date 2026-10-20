// Test with EXACT same options the bundle uses
import { createRequire } from 'module';
const bundleDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache\\dcc7dfb03298';
const require_ = createRequire(bundleDir + '\\__bundle__\\sag.bundle.cjs');

const transformersPkg = require_('@xenova/transformers');
const transformers = transformersPkg.default || transformersPkg;

transformers.env.allowRemoteModels = false;
transformers.env.allowLocalModels = true;
transformers.env.localModelPath = 'D:/SAG/doc_vectorizer/dist-package/本地知识检索-0.1.0/resources/models';

const onnxEnv = transformers.env.backends?.onnx;
if (onnxEnv?.wasm) {
  onnxEnv.wasm.wasmPaths = '/';
  onnxEnv.wasm.proxy = false;
}

const p = await transformers.pipeline('token-classification', 'bert-base-chinese-ner', {
  quantized: true,
  model_file_name: 'model',
  local_files_only: true
});

// Wrap like the bundle does
const wrapper = async (text, options) => {
  const merged = {
    aggregation_strategy: 'none',
    max_length: options?.max_length ?? 512,
    truncation: options?.truncation ?? true,
    ignore_labels: options?.ignore_labels ?? ['O']
  };
  return await p(text, merged);
};

const text = '张三在北京大学会见李四。';
const result = await wrapper(text, {
  max_length: 512,
  truncation: true,
  ignore_labels: []
});

console.log('Result count:', result.length);
for (const t of result.slice(0, 5)) {
  console.log('  index=' + t.index + ' entity=' + t.entity + ' word=' + JSON.stringify(t.word) + ' score=' + t.score.toFixed(4));
}
