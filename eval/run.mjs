#!/usr/bin/env node
// Generate responses from the current jevchat generator, in the JSONL format
// that eval/grade.mjs consumes. This is the missing "runner" half of the harness.
//
//   node eval/run.mjs --prompts eval/prompts.jsonl --output eval/eval-results.jsonl
//
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRATEGIES } from './strategies/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const options = parseArgs(process.argv.slice(2));
const strategy = STRATEGIES[options.impl];
if (!strategy) throw new Error(`unknown --impl ${options.impl}`);
const generateReplyImpl = strategy.generate;

const apiKey = await loadKey();
const prompts = await readJsonl(resolve(options.prompts));
const list = prompts.slice(0, options.limit ?? prompts.length);
const results = new Array(list.length);
let next = 0;
let done = 0;
let totalTokens = 0;
let totalCost = 0;

async function worker() {
  while (true) {
    const i = next++;
    if (i >= list.length) return;
    const item = list[i];
    let end = null;
    try {
      for await (const ev of generateReplyImpl({
        apiKey,
        messages: [{ role: 'user', text: item.prompt }],
        temperature: options.temperature,
        shuffleCriteria: options.shuffleCriteria,
      })) {
        if (ev.type === 'end') end = ev;
      }
    } catch (error) {
      console.error(`[${item.id}] ERROR ${error.message}`);
    }
    const record = {
      id: item.id,
      category: item.category ?? null,
      variant: options.variant,
      run: options.run,
      prompt: item.prompt,
      response: end?.text ?? '',
      reference: item.reference ?? null,
      meta: {
        input_tokens: end?.inputTokens ?? 0,
        cost_usd: end?.costUsd ?? 0,
        end_probability: end?.endProbability ?? null,
      },
    };
    results[i] = record;
    totalTokens += record.meta.input_tokens;
    totalCost += record.meta.cost_usd;
    done++;
    console.error(
      `[${done}/${list.length}] ${item.id}: ${JSON.stringify(record.response)}` +
        `  ($${record.meta.cost_usd.toFixed(5)})`,
    );
  }
}

await Promise.all(
  Array.from({ length: Math.min(options.concurrency, list.length) }, () => worker()),
);

const records = results.filter(Boolean);
await writeFile(
  resolve(options.output),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
console.error(
  `Done: ${records.length} response(s), ${totalTokens.toLocaleString()} input tokens, $${totalCost.toFixed(4)}.`,
);

async function loadKey() {
  if (process.env.JEV_API_KEY) return process.env.JEV_API_KEY;
  for (const rel of ['../.env', '../../.env', '../.dev.vars', './.dev.vars']) {
    try {
      const txt = await readFile(resolve(here, rel), 'utf8');
      const m = txt.match(/JEV_API_KEY\s*=\s*(.+)/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    } catch {
      /* keep looking */
    }
  }
  throw new Error('JEV_API_KEY not found (set it in the env, ../.env, or .dev.vars)');
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function parseArgs(args) {
  const config = {
    prompts: 'eval/prompts.jsonl',
    output: 'eval/eval-results.jsonl',
    impl: 'tournament-1020',
    variant: null,
    run: 1,
    limit: null,
    temperature: 1,
    concurrency: 15,
    shuffleCriteria: false,
  };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--no-shuffle') {
      config.shuffleCriteria = false;
      continue;
    }
    if (name === '--shuffle') {
      config.shuffleCriteria = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new Error(`missing value for ${name}`);
    if (name === '--prompts') config.prompts = value;
    else if (name === '--output') config.output = value;
    else if (name === '--impl') config.impl = value;
    else if (name === '--variant') config.variant = value;
    else if (name === '--run') config.run = Number(value);
    else if (name === '--limit') config.limit = Number(value);
    else if (name === '--temperature') config.temperature = Number(value);
    else if (name === '--concurrency') config.concurrency = Number(value);
    else throw new Error(`unknown option: ${name}`);
  }
  if (!STRATEGIES[config.impl]) {
    throw new Error(`--impl must be one of: ${Object.keys(STRATEGIES).join(', ')}`);
  }
  if (!config.variant) config.variant = STRATEGIES[config.impl].variant;
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return config;
}
