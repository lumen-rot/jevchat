// Zero-dependency local dev server. Serves ./public and streams /api/chat,
// using the same generation core as the Worker.
//
//   node dev-server.mjs
//
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReply } from './src/generate.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

let cachedKey;
function clampTemp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(2, n));
}
async function apiKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  if (cachedKey) return cachedKey;
  for (const rel of ['./.env', '../.env', './.dev.vars']) {
    try {
      const txt = await readFile(resolve(here, rel), 'utf8');
      const m = txt.match(/JEV_API_KEY\s*=\s*(.+)/);
      if (m) {
        cachedKey = m[1].trim().replace(/^["']|["']$/g, '');
        return cachedKey;
      }
    } catch {
      /* keep looking */
    }
  }
  throw new Error('JEV_API_KEY not found (set it in the env, ../.env, or .dev.vars)');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    const messages = payload.messages;
    if (!Array.isArray(messages)) {
      res.writeHead(400).end('messages[] required');
      return;
    }
    const temperature = clampTemp(payload.temperature);

    let key;
    try {
      key = await apiKey();
    } catch (e) {
      res.writeHead(500).end(e.message);
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    try {
      for await (const ev of generateReply({
        apiKey: key,
        temperature,
        messages: messages.slice(-20).map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          text: String(m.text ?? '').slice(0, 2000),
        })),
      })) {
        send(ev);
      }
      send({ type: 'done' });
    } catch (e) {
      send({ type: 'error', message: String(e?.message ?? e) });
    }
    res.end();
    return;
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  console.log(`jev chat  →  http://localhost:${port}`);
});
