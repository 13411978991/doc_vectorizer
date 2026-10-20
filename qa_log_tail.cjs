// qa_log_tail.cjs — read last 200 lines of sag-stdout-v16.log
const fs = require('fs');
const path = require('path');
const file = 'E:\\sag\\export\\sag-source-compilable\\build-tmp\\sag-stdout-v16.log';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split(/\r?\n/);
const tail = lines.slice(-200);
console.log('Total lines:', lines.length);
console.log('--- Last 200 lines ---');
for (const l of tail) console.log(l);