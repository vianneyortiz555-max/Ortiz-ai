const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env.local'));
loadEnvFile(path.join(__dirname, '.env'));

const { handler: chatHandler } = require('./netlify/functions/chat.js');
const { handler: stripeWebhookHandler } = require('./netlify/functions/stripe-webhook.js');

const PORT = Number(process.env.PORT || 8888);
const root = __dirname;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handleFunction(req, res, handler) {
  let body = '';
  for await (const chunk of req) body += chunk;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers[k] = v;
  }

  try {
    const result = await handler({
      httpMethod: req.method,
      headers,
      body: body || null
    });

    send(
      res,
      result.statusCode || 200,
      result.body || '',
      result.headers || { 'Content-Type': 'application/json' }
    );
  } catch (err) {
    console.error(err);
    send(res, 500, JSON.stringify({ error: err.message || 'Local server error' }), {
      'Content-Type': 'application/json'
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/.netlify/functions/chat') {
    return handleFunction(req, res, chatHandler);
  }

  if (url.pathname === '/.netlify/functions/stripe-webhook') {
    return handleFunction(req, res, stripeWebhookHandler);
  }

  let requested = decodeURIComponent(url.pathname);
  if (requested === '/') requested = '/index.html';

  const filePath = path.normalize(path.join(root, requested));
  if (!filePath.startsWith(root)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ortiz AI local server: http://localhost:${PORT}`);
  console.log(`Health endpoint: http://localhost:${PORT}/.netlify/functions/chat`);
  console.log(`Stripe webhook: http://localhost:${PORT}/.netlify/functions/stripe-webhook`);
});
