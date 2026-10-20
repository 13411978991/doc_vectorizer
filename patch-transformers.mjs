// Patch transformers.min.js to use runtime path
import fs from 'node:fs';
import path from 'node:path';

const fpDir = 'D:\\SAG\\doc_vectorizer\\dist-package\\本地知识检索-0.1.0\\resources\\native-cache';
const dirs = fs.readdirSync(fpDir).filter(d => {
  try { return fs.statSync(path.join(fpDir, d)).isDirectory() && /^[a-f0-9]{12}$/.test(d); } catch (e) { return false; }
});

let patched = 0;
for (const fp of dirs) {
  const minJs = path.join(fpDir, fp, 'node_modules', '@xenova', 'transformers', 'dist', 'transformers.min.js');
  if (!fs.existsSync(minJs)) continue;

  let content = fs.readFileSync(minJs, 'utf8');
  const before = content.length;

  // Replace the hardcoded Linux CI path with a runtime evaluation
  // that uses the actual transformers.min.js location at runtime.
  // This way __dirname is computed from the real file location.
  content = content.replace(
    'url.fileURLToPath("file:///home/runner/work/transformers.js/transformers.js/src/env.js")',
    'path.dirname(require("path").resolve(__filename, "..", "src", "env.js"))'
  );

  if (content.length !== before) {
    fs.writeFileSync(minJs, content);
    console.log('Patched:', minJs);
    patched++;
  }
}
console.log(`Patched ${patched} files`);
