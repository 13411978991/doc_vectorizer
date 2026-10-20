// qa_check_insert.cjs — verify event insert uses extraction_source
const fs = require('fs');
const path = require('path');
const file = path.resolve('src/services/ingestion-service.ts');
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');
let inInsert = false;
let out = '';
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('insert into events')) {
    inInsert = true;
    out += (i + 1) + ': ' + line + '\n';
    continue;
  }
  if (inInsert) {
    out += (i + 1) + ': ' + line + '\n';
    if (line.trim().endsWith(');')) {
      inInsert = false;
      out += '\n';
    }
  }
}
console.log(out);