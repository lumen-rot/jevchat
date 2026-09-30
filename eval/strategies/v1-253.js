// Strategy: v1 — one `choice` call per word over the fixed 253-word vocabulary.
import { VOCAB, EOT } from '../../src/vocab.js';
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

function criteria(shuffleCriteria) {
  const order = shuffleCriteria ? shuffle(VOCAB) : VOCAB;
  const c = {};
  for (const w of order) {
    c[w] = w === EOT ? 'end of my reply, I am done talking' : `"${w}"`;
  }
  return c;
}

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

  for (let step = 0; step < maxWords; step++) {
    const out = await callJev(
      apiKey,
      model,
      chatState(messages, detok(tokens)),
      {
        next: {
          type: 'choice',
          instructions:
            "Choose the single next word of the Assistant's reply. Choose <eot> when the reply is finished.",
          criteria: criteria(shuffleCriteria),
        },
      },
      signal,
    );
    inputTokens += out.usage.input_tokens;
    const ans = out.answers.next;
    const probs = ans.probabilities ?? {};
    const word = sample(probs, new Set(recent.slice(-6)), temperature, 0.06);
    if (word === EOT) {
      if (tokens.length < 2) continue;
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
  const end = await endOfChat(apiKey, model, messages, text, signal);
  inputTokens += end.inputTokens;
  yield endEvent(text, inputTokens, end.endProbability);
}
