// Shared Jev generation core. Runs on Cloudflare Workers and in Node (both have
// fetch + Web streams). Emits events consumed by the SSE layer.

import { VOCAB, EOT } from './vocab.js';
import { EXPANSION_VOCAB } from './vocab-large.js';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
const PRICE_PER_M = 0.042; // USD per 1M input tokens; output is free
const EOT_MIN_PROBABILITY = 0.1;
const BUCKET_SIZE = 255;
const BUCKET_COUNT = 4;
const FINALISTS_PER_BUCKET = 48;
const BORROWED_WORD_LIMIT = 24;

const TERMINATORS = new Set(['.', '!', '?']);
const ATTACH = new Set([',', ';', ':', '-', "'"]);

// Jev has a strong position bias (it favours options near the top of the list),
// so criteria are shuffled every call to average it out.
function shuffle(items, rng = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CORE_VOCAB = VOCAB.filter((word) => word !== EOT);
const BASE_VOCAB = [...new Set([...CORE_VOCAB, ...EXPANSION_VOCAB])];
if (BASE_VOCAB.length !== BUCKET_SIZE * BUCKET_COUNT - 1) {
  throw new Error(`expected 1,019 vocabulary words, got ${BASE_VOCAB.length}`);
}

function criteriaFor(words) {
  const criteria = Object.create(null);
  for (const word of words) {
    criteria[word] =
      word === EOT
        ? 'end the reply now; the assistant is done talking'
        : `the next word or punctuation mark is "${word}"`;
  }
  return criteria;
}

function borrowedWords(messages) {
  const base = new Set(BASE_VOCAB);
  const borrowed = [];
  const seen = new Set();
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue;
    for (const match of String(message.text).toLowerCase().matchAll(/[a-z]+(?:['-][a-z]+)*/g)) {
      const word = match[0];
      if (word.length > 24 || base.has(word) || seen.has(word)) continue;
      seen.add(word);
      borrowed.push(word);
      if (borrowed.length === BORROWED_WORD_LIMIT) return borrowed;
    }
  }
  return borrowed;
}

function vocabularyFor(messages) {
  const borrowed = borrowedWords(messages);
  return [
    ...BASE_VOCAB.slice(0, BASE_VOCAB.length - borrowed.length),
    ...borrowed,
    EOT,
  ];
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function detok(tokens) {
  let cur = '';
  for (const t of tokens) {
    if (ATTACH.has(t) || TERMINATORS.has(t)) cur += t;
    else cur += (cur && !"-'".includes(cur.slice(-1)) ? ' ' : '') + t;
  }
  return cur.trim();
}

function transcript(messages, partial) {
  const lines = messages.map(
    (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`,
  );
  if (partial) lines.push(`Assistant: ${partial}`);
  else lines.push('Assistant:');
  return lines.join('\n');
}

// Sample a token from Jev's returned distribution, with temperature and a
// recency penalty so it does not loop on one word like a raw Markov chain.
function sample(probs, recent, temperature, penalty) {
  const t = Math.max(temperature, 1e-3);
  const keys = Object.keys(probs);
  if (keys.length === 0) return EOT;
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

async function callJev(apiKey, model, state, questions, signal) {
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
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`http ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`http ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.random() * 200));
    }
  }
  throw lastErr;
}

function topK(probs, k) {
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([w, p]) => [w, Number(p.toFixed(4))]);
}

async function tournament(apiKey, model, state, vocabulary, signal, shuffleCriteria) {
  const buckets = chunks(vocabulary, BUCKET_SIZE);
  const questions = Object.create(null);
  for (let i = 0; i < buckets.length; i++) {
    questions[`bucket_${i}`] = {
      type: 'choice',
      instructions:
        "Pick the best available single next word or punctuation mark for the Assistant's reply. This is a preliminary tournament group.",
      criteria: criteriaFor(shuffleCriteria ? shuffle(buckets[i]) : buckets[i]),
    };
  }

  const first = await callJev(apiKey, model, state, questions, signal);
  const finalists = new Set([EOT]);
  for (let i = 0; i < buckets.length; i++) {
    const answer = first.answers[`bucket_${i}`];
    for (const [word] of topK(answer?.probabilities ?? {}, FINALISTS_PER_BUCKET)) {
      finalists.add(word);
    }
  }

  const finalList = [...finalists];
  const final = await callJev(
    apiKey,
    model,
    state,
    {
      next: {
        type: 'choice',
        instructions:
          "Choose the single best next word or punctuation mark for the Assistant's reply. Choose <eot> when the reply is finished.",
        criteria: criteriaFor(shuffleCriteria ? shuffle(finalList) : finalList),
      },
    },
    signal,
  );

  return {
    answer: final.answers.next,
    inputTokens: (first.usage?.input_tokens ?? 0) + (final.usage?.input_tokens ?? 0),
  };
}

/**
 * Async generator. Yields:
 *   { type: 'word', word, p, confidence, alts }   // alts = top candidate words
 *   { type: 'end', text, endProbability, inputTokens, costUsd }
 */
export async function* generateReply({
  apiKey,
  model = 'jev-latest',
  messages,
  maxWords = 24,
  temperature = 1.0,
  shuffleCriteria = false,
  signal,
}) {
  const tokens = [];
  const recent = [];
  let inputTokens = 0;
  const vocabulary = vocabularyFor(messages);

  for (let step = 0; step < maxWords; step++) {
    const state =
      'You are Jev, having a casual chat. Continue the conversation by writing ' +
      'your reply one word at a time.\n\n' +
      transcript(messages, detok(tokens));

    const result = await tournament(
      apiKey,
      model,
      state,
      vocabulary,
      signal,
      shuffleCriteria,
    );
    inputTokens += result.inputTokens;
    const ans = result.answer;
    const probs = ans.probabilities ?? {};
    let word = sample(
      probs,
      new Set(recent.slice(-6)),
      temperature,
      0.06,
    );
    if (
      word === EOT &&
      (tokens.length < 2 || (probs[EOT] ?? 0) < EOT_MIN_PROBABILITY)
    ) {
      const continuing = { ...probs };
      delete continuing[EOT];
      word = sample(
        continuing,
        new Set(recent.slice(-6)),
        temperature,
        0.06,
      );
    }
    if (word === EOT) {
      break;
    }
    tokens.push(word);
    recent.push(word);
    yield {
      type: 'word',
      word,
      p: probs[word] ?? null,
      confidence: ans.confidence ?? null,
      alts: topK(probs, 8),
    };
  }

  const text = detok(tokens);
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
  inputTokens += over.usage.input_tokens;

  yield {
    type: 'end',
    text,
    endProbability: over.answers.over.noul,
    inputTokens,
    costUsd: (inputTokens * PRICE_PER_M) / 1e6,
  };
}

export { BASE_VOCAB as VOCAB };
