// qa_check_files.cjs — verify NerSection.tsx absent + no NerSection references
const fs = require('fs');
const path = require('path');

const nerPath = path.resolve('web/src/NerSection.tsx');
console.log('NerSection.tsx exists:', fs.existsSync(nerPath));

const appTsx = path.resolve('web/src/App.tsx');
const content = fs.readFileSync(appTsx, 'utf8');
const lines = content.split('\n');
const refs = [];
lines.forEach((line, i) => {
  if (line.includes('NerSection')) {
    refs.push((i + 1) + ': ' + line.trim());
  }
});
console.log('NerSection references in App.tsx:', refs.length);
for (const r of refs) console.log('  ' + r);