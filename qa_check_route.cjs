// qa_check_route.cjs — find files referencing test-connection
const fs = require('fs');
const path = require('path');

function walk(dir, results) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, results);
      } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('test-connection') || content.includes('testLlmConnection')) {
            results.push(full);
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
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