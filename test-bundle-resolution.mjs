// Check what require() from the bundle dir resolves to
import { createRequire } from 'module';
const bundleDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache\\61534e5a1d29';
const require_ = createRequire(bundleDir + '\\__bundle__\\sag.bundle.cjs');

const resolved = require_.resolve('@xenova/transformers');
console.log('Resolved:', resolved);

const pkg = require_.resolve('@xenova/transformers/package.json');
const pkgObj = require_(pkg);
console.log('main field:', pkgObj.main);
console.log('type field:', pkgObj.type);

// Load it
const mod = require_('@xenova/transformers');
console.log('mod type:', typeof mod);
console.log('mod.pipeline type:', typeof mod.pipeline);
console.log('mod.env type:', typeof mod.env);
console.log('mod keys count:', Object.keys(mod).length);
console.log('mod first 10 keys:', Object.keys(mod).slice(0, 10));
