// Run the backend with proper env vars
const { spawn } = require('child_process');
const path = require('path');

const exe = path.join('E:\\sag\\完整后端版本\\源码\\doc_vectorizer\\release-desktop\\win-unpacked\\resources', '本地知识检索-后端.exe');

const child = spawn(exe, [], {
  cwd: path.dirname(exe),
  env: {
    ...process.env,
    SAG_SKIP_NER_CHECK: '1',
    SAG_OPEN_BROWSER: 'false',
    HTTP_PORT: '4173'
  },
  windowsHide: false,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.on('data', (d) => process.stdout.write('[OUT] ' + d.toString()));
child.stderr.on('data', (d) => process.stderr.write('[ERR] ' + d.toString()));
child.on('exit', (code, signal) => {
  console.log('Exited code=' + code + ' signal=' + signal);
});

// Keep alive for 60 seconds
setTimeout(() => {
  console.log('Test timeout reached, killing process');
  child.kill();
}, 60000);
