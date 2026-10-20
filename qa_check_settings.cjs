// qa_check_settings.cjs — GET /api/settings/ai
const http = require('http');

const req = http.request({
  hostname: '127.0.0.1',
  port: 4173,
  path: '/api/settings/ai',
  method: 'GET'
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('HTTP', res.statusCode);
    console.log('Body:', body);
  });
});
req.on('error', err => console.error('ERROR', err.message));
req.end();