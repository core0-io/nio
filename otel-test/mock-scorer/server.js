const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      // 90% → [0, 0.5), 10% → [0.5, 1]
      const high = Math.random() < 0.1;
      const score = high
        ? 0.5 + Math.random() * 0.5
        : Math.random() * 0.5;

      const rounded = Math.round(score * 100) / 100;
      const reason = high
        ? 'Random high-risk score (mock)'
        : 'Random low-risk score (mock)';

      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}

      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        mode: parsed.mode,
        tool: parsed.tool_name,
        score: rounded,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ score: rounded, reason }));
    });
  } else {
    // Health check
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }
});

server.listen(8080, () => console.log('Mock scorer listening on :8080'));
