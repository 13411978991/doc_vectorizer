// qa_check_bundle.cjs — multiple checks against the bundle
const fs = require('fs');
const path = require('path');
const file = path.resolve('web/dist/assets/index-DHlgyxcg.js');
const content = fs.readFileSync(file, 'utf8');

console.log('Bundle size:', content.length, 'bytes');
console.log();
console.log('1. LLM section "远程 API" button:');
const idx = content.indexOf('远程 API');
console.log('  found at offset:', idx);
if (idx >= 0) console.log('  context:', content.slice(idx - 30, idx + 30));
console.log();

console.log('2. data-testid llm-test-connection:');
const idx2 = content.indexOf('llm-test-connection');
console.log('  found at offset:', idx2);
if (idx2 >= 0) console.log('  context:', content.slice(idx2 - 60, idx2 + 100));
console.log();

console.log('3. data-testid doc-fallback-badge:');
const idx3 = content.indexOf('doc-fallback-badge');
console.log('  found at offset:', idx3);
if (idx3 >= 0) console.log('  context:', content.slice(idx3 - 60, idx3 + 200));
console.log();

console.log('4. testConnection (two-row layout — embedding + llm):');
const idx4 = content.indexOf('testConnection');
console.log('  found at offset:', idx4);
if (idx4 >= 0) console.log('  context:', content.slice(idx4, idx4 + 200));

console.log('5. search for "testLlmConnection":');
const idx5 = content.indexOf('testLlmConnection');
console.log('  found at offset:', idx5);

console.log('6. search for "fallback *":');
const idx6 = content.indexOf('fallback *');
console.log('  found at offset:', idx6);