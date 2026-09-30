// Strategy: buckets (ported from kyle-pena-nlp/jevchat).
//
// Split the alphabet into questions of <=254 symbols, each with an OTHER escape
// meaning "the next word is not in this bucket". Criteria are shuffled every step
// to cancel Jev's position bias. STOP is asked once as its own noul question, not
// offered inside every bucket. Buckets are folded into one distribution in a single
// request (no second round), which is cheaper than the tournament strategy.
import { VOCAB as ALPHABET_1019 } from '../../src/generate.js';
import { EOT } from '../../src/vocab.js';
import {
  chatState,
  detok,
  sample,
  shuffle,
  topK,
  callJev,
  endEvent,
  endOfChat,
} from './_shared.js';

const MAX_BUCKET = 254; // one slot reserved for OTHER
const OTHER = 'OTHER';
const OTHER_DESC =
  'None of the options listed here. The next word is something else entirely, not present among these options.';
const OTHER_INSTRUCTION =
  ' Only a fraction of the possible words are listed in this question. If the word that should come next is not among them, choose OTHER.';

function buildBuckets(alphabet, bucketSize) {
  const buckets = [];
  for (let i = 0; i < alphabet.length; i += bucketSize) {
    buckets.push(alphabet.slice(i, i + bucketSize));
  }
  return buckets;
}

export async function* generateReply({
  apiKey,
  model = 'jev-latest',
  messages,
  maxWords = 24,
  temperature = 1.0,
  signal,
  bucketSize = MAX_BUCKET,
  stopBias = 0.5,
  minSteps = 3,
}) {
  const buckets = buildBuckets(ALPHABET_1019, bucketSize);
  const tokens = [];
  const recent = [];
  let inputTokens = 0;

  for (let step = 0; step < maxWords; step++) {
    const questions = {
      stop: {
        type: 'noul',
        instructions: 'Is the reply already finished?',
        criteria: {
          true: 'The reply is complete and nothing more should be written.',
          false: 'The reply is not finished: at least one more word follows.',
        },
      },
    };
    for (let i = 0; i < buckets.length; i++) {
      const criteria = {};
      for (const word of shuffle(buckets[i])) criteria[word] = word;
      criteria[OTHER] = OTHER_DESC;
      questions[`b${i}`] = {
        type: 'choice',
        instructions:
          "Choose the single best next word or punctuation mark for the Assistant's reply." +
          OTHER_INSTRUCTION,
        criteria,
      };
    }

    const out = await callJev(
      apiKey,
      model,
      chatState(messages, detok(tokens)),
      questions,
      signal,
    );
    inputTokens += out.usage.input_tokens;
    const answers = out.answers;

    // Fold buckets into one distribution: drop OTHER, concatenate, rescale.
    let pStop = Math.min(1, Math.max(0, Number(answers.stop?.noul ?? 0)));
    if (tokens.length < minSteps) pStop = 0;
    else pStop *= stopBias;

    const merged = {};
    for (let i = 0; i < buckets.length; i++) {
      const raw = answers[`b${i}`]?.probabilities ?? {};
      for (const word of buckets[i]) {
        const v = Number(raw[word] ?? 0);
        if (v > 0) merged[word] = (merged[word] ?? 0) + v;
      }
    }
    const total = Object.values(merged).reduce((a, b) => a + b, 0);
    const scale = total > 0 ? (1 - pStop) / total : 0;
    const dist = {};
    for (const [w, v] of Object.entries(merged)) dist[w] = v * scale;
    dist[EOT] = pStop;

    const word = sample(dist, new Set(recent.slice(-6)), temperature, 0.06);
    if (word === EOT || word == null) break;
    tokens.push(word);
    recent.push(word);
    yield {
      type: 'word',
      word,
      p: dist[word] ?? null,
      confidence: Math.max(...Object.values(dist), 0),
      alts: topK(dist, 8),
    };
  }

  const text = detok(tokens);
  const end = await endOfChat(apiKey, model, messages, text, signal);
  inputTokens += end.inputTokens;
  yield endEvent(text, inputTokens, end.endProbability);
}
