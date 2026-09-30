// Cloudflare Worker: serves static assets from ./public and streams /api/chat.
import { generateReply } from './generate.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/chat') {
      if (request.method !== 'POST') {
        return json({ error: 'method not allowed' }, 405);
      }
      return handleChat(request, env);
    }

    // Static assets (index.html, styles.css, app.js)
    return env.ASSETS.fetch(request);
  },
};

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!body || !Array.isArray(body.messages)) {
    return json({ error: 'messages[] required' }, 400);
  }
  if (!env.JEV_API_KEY) {
    return json({ error: 'server missing JEV_API_KEY' }, 500);
  }

  const messages = body.messages.slice(-20).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    text: String(m.text ?? '').slice(0, 2000),
  }));
  const temperature = clampTemp(body.temperature);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        for await (const ev of generateReply({
          apiKey: env.JEV_API_KEY,
          messages,
          temperature,
        })) {
          send(ev);
        }
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', message: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clampTemp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(2, n));
}
