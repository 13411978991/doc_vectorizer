// qa_check_fallback_api.cjs — find files returning fallbackEventCount
const fs = require('fs');
const path = require('path');

function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
      try {
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes('fallbackEventCount') || content.includes('extraction_source')) {
          results.push(full);
        }
      } catch { /* ignore */ }
    }
  }
}

const roots = ['src', 'dist'];
for (const r of roots) {
  const results = [];
  walk(r, results);
  console.log('=== ' + r + ' ===');
  for (const f of results) {
    console.log('  ' + f);
  }
}