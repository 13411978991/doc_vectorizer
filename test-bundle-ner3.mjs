// Load transformers.min.js directly (not through package main)
import { createRequire } from 'module';
import path from 'path';

const fpDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache';
import { readdirSync, statSync, existsSync } from 'fs';
const dirs = readdirSync(fpDir).filter(d => {
  try { return statSync(path.join(fpDir, d)).isDirectory() && /^[a-f0-9]{12}$/.test(d); } catch (e) { return false; }
});
const fp = dirs[0];
const minJs = path.join(fpDir, fp, 'node_modules', '@xenova', 'transformers', 'dist', 'transformers.min.js');
console.log('Loading:', minJs);
console.log('Exists:', existsSync(minJs));

const require_ = createRequire(import.meta.url);
// Load transformers.min.js directly
const transformers = require_(minJs);
console.log('env:', !!transformers.env);
console.log('pipeline:', typeof transformers.pipeline);
