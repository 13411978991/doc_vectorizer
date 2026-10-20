// qa_grep_testid.cjs — search bundle for llm-test-connection testid
const fs = require('fs');
const path = require('path');
const file = path.resolve('web/dist/assets/index-DHlgyxcg.js');
const content = fs.readFileSync(file, 'utf8');
const needle = 'llm-test-connection';
const idx = content.indexOf(needle);
if (idx < 0) {
  console.error('NOT FOUND:', needle);
  process.exit(2);
}
console.log('Found at offset', idx);
// Print 200 chars of context
console.log('Context:');
console.log(content.slice(Math.max(0, idx - 100), idx + 200));