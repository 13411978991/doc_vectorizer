// Check what model file is actually being loaded
import { createRequire } from 'module';
const fs = await import('node:fs');

const bundleDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache\\61534e5a1d29';
const require_ = createRequire(bundleDir + '\\__bundle__\\sag.bundle.cjs');

// Check what the bundle's transformers resolves to
const pkg = require_.resolve('@xenova/transformers/package.json');
const pkgObj = require_(pkg);

// Check the actual model directory
const modelDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\models\\bert-base-chinese-ner';
console.log('Model dir exists:', fs.existsSync(modelDir));
const files = fs.readdirSync(modelDir);
console.log('Model dir contents:', files);

// Check the onnx file
const onnxDir = `${modelDir}\\onnx`;
const onnxFiles = fs.readdirSync(onnxDir);
console.log('ONNX dir contents:', onnxFiles);

// Read the first 100 bytes of the model_quantized.onnx
const buf = fs.readFileSync(`${onnxDir}\\model_quantized.onnx`).subarray(0, 100);
console.log('ONNX file first 100 bytes:', Array.from(buf.slice(0, 20)));
