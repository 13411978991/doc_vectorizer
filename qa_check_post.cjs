// qa_check_post.cjs — POST /api/test-connection/llm
const http = require('http');

const data = JSON.stringify({
  llmBaseUrl: "https://llm-api.sunwoda.com/",
  llmModel: "hy-mt2-7b",
  llmApiKey: "sk-jd8hrgMCMl57VtyNcIL5ZCD8gBTwyGtmF0mnfKJmlBiYnL3W"
});

const options = {
  hostname: '127.0.0.1',
  port: 4173,
  path: '/api/test-connection/llm',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    console.log('Headers:', JSON.stringify(res.headers));
    console.log('Body:', body);
  });
});

req.on('error', err => console.error('ERROR', err.message));
req.write(data);
req.end();