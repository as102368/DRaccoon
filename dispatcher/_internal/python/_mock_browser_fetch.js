// Mock of the new /v1/browser-fetch endpoint to verify the JSON contract.
const http = require('http');

const TOKEN = 'test-token';
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/browser-fetch') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      if (payload.token !== TOKEN) {
        res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'invalid token' })); return;
      }
      // Simulate a successful gated Douyin API response returned by the page fetch.
      const fakeApi = JSON.stringify({ status_code: 0, aweme_detail: { aweme_id: '123', desc: 'ok' } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 200, text: fakeApi }));
    });
  } else {
    res.writeHead(404); res.end('{}');
  }
});
server.listen(39517, '127.0.0.1', () => {
  console.log('MOCK_PORT=' + server.address().port);
});
