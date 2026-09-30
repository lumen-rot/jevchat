// Shared helpers for jevchat generation strategies.
export const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const PRICE_PER_M = 0.042; // USD per 1M input tokens; output free

const TERMINATORS = new Set(['.', '!', '?']);
const ATTACH = new Set([',', ';', ':', '-', "'"]);

export function detok(tokens) {
  let cur = '';
  for (const t of tokens) {
    if (ATTACH.has(t) || TERMINATORS.has(t)) cur += t;
    else cur += (cur && !"-'".includes(cur.slice(-1)) ? ' ' : '') + t;
  }
  return cur.trim();
}

export function transcript(messages, partial) {
  const lines = messages.map(
    (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`,
  );
  if (partial) lines.push(`Assistant: ${partial}`);
  else lines.push('Assistant:');
  return lines.join('\n');
}

export function chatState(messages, partial) {
  return (
    'You are Jev, having a casual chat. Continue the conversation by writing ' +
    'your reply one word at a time.\n\n' +
    transcript(messages, partial)
  );
}

// Temperature + recency-penalty sampling from a probability map.
export function sample(probs, recent, temperature = 1.0, penalty = 0.06) {
  const t = Math.max(temperature, 1e-3);
  const keys = Object.keys(probs);
  if (keys.length === 0) return null;
  let max = -Infinity;
  const logi = {};
  for (const k of keys) {
    let q = probs[k];
    if (recent.has(k)) q *= penalty;
    const v = Math.log(Math.max(q, 1e-12)) / t;
    logi[k] = v;
    if (v > max) max = v;
  }
  let total = 0;
  const exps = {};
  for (const k of keys) {
    const e = Math.exp(logi[k] - max);
    exps[k] = e;
    total += e;
  }
  let r = Math.random() * total;
  let acc = 0;
  for (const k of keys) {
    acc += exps[k];
    if (acc >= r) return k;
  }
  return keys[keys.length - 1];
}

export function shuffle(array, rng = Math.random) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function topK(probs, k) {
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w, p]) => [w, Number(p.toFixed(4))]);
}

export async function callJev(apiKey, model, state, questions, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, state, questions }),
        signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
    }
  }
  throw lastErr;
}

// Emit the standard {word}/{end} events for a finished reply.
export function endEvent(text, inputTokens, endProbability) {
  return {
    type: 'end',
    text,
    endProbability,
    inputTokens,
    costUsd: (inputTokens * PRICE_PER_M) / 1e6,
  };
}

export async function endOfChat(apiKey, model, messages, text, signal) {
  const over = await callJev(
    apiKey,
    model,
    transcript([...messages, { role: 'assistant', text }]),
    {
      over: {
        type: 'noul',
        instructions:
          'The conversation has reached a natural conclusion and should end now.',
        criteria: { true: 'a goodbye or clear end', false: 'still more to say' },
      },
    },
    signal,
  );
  return { endProbability: over.answers.over.noul, inputTokens: over.usage.input_tokens };
}
