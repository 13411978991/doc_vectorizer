// qa_check_fallback.cjs — check fallback badge rendering
const fs = require('fs');
const path = require('path');
const appTsx = path.resolve('web/src/App.tsx');
const content = fs.readFileSync(appTsx, 'utf8');
const lines = content.split('\n');
const needle = 'fallback';
const refs = [];
lines.forEach((line, i) => {
  if (line.toLowerCase().includes(needle) || line.includes('extraction_source')) {
    refs.push((i + 1) + ': ' + line.trim());
  }
});
console.log('fallback/extraction_source references in App.tsx:', refs.length);
for (const r of refs.slice(0, 40)) console.log('  ' + r);