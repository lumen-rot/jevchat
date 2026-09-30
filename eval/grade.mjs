#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_MODEL = 'opencode-go/deepseek-v4.1-flash';
const MAX_CONCURRENCY = 15;
const VALID_FAILURES = new Set([
  'none',
  'off_topic',
  'incorrect',
  'grammar',
  'repetition',
  'truncated',
  'instruction_failure',
  'vocabulary_failure',
  'empty_or_error',
]);

const options = parseArgs(process.argv.slice(2));
const inputPath = resolve(options.input);
const outputPath = resolve(options.output);
const errorPath = `${outputPath}.errors`;
const rubric = await readFile(resolve(options.rubric), 'utf8');
const items = await readJsonl(inputPath);
const completed = await completedKeys(outputPath);
const pending = items.filter((item) => !completed.has(sourceKey(item)));

if (!pending.length) {
  console.error(`Nothing to grade: ${completed.size} result(s) already complete.`);
  process.exit(0);
}

console.error(
  `Grading ${pending.length} response(s) with ${options.model} at concurrency ${options.concurrency}.`,
);

let nextIndex = 0;
let finished = 0;
let failed = 0;
let writeChain = Promise.resolve();

const workers = Array.from(
  { length: Math.min(options.concurrency, pending.length) },
  async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= pending.length) return;
      const item = pending[index];
      const key = sourceKey(item);

      try {
        const judged = await gradeWithRetry(item, rubric, options);
        const record = {
          source_key: key,
          id: item.id,
          category: item.category ?? null,
          variant: item.variant ?? null,
          run: item.run ?? null,
          prompt: item.prompt ?? item.messages ?? null,
          response: item.response,
          reference: item.reference ?? null,
          grade: judged.grade,
          judge: {
            model: options.model,
            session_id: judged.sessionID,
            input_tokens: judged.tokens.input,
            output_tokens: judged.tokens.output,
            cache_read_tokens: judged.tokens.cacheRead,
            cost_usd: judged.cost,
          },
        };
        await appendLine(outputPath, record);
        finished++;
        console.error(`[${finished + failed}/${pending.length}] ${key}: ${record.grade.score}`);
      } catch (error) {
        failed++;
        await appendLine(errorPath, {
          source_key: key,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(`[${finished + failed}/${pending.length}] ${key}: ERROR`);
      }
    }
  },
);

await Promise.all(workers);
await writeChain;

console.error(`Done: ${finished} graded, ${failed} failed.`);
if (failed) process.exitCode = 1;

async function gradeWithRetry(item, rubricText, config) {
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const result = await runOpenCode(
        config.model,
        buildPrompt(item, rubricText),
        config.timeoutMs,
      );
      return { ...result, grade: validateGrade(parseJson(result.text)) };
    } catch (error) {
      lastError = error;
      if (attempt < config.retries) {
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, 500 * 2 ** attempt),
        );
      }
    }
  }
  throw lastError;
}

function runOpenCode(model, prompt, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'opencode',
      ['run', '--model', model, '--format', 'json', prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`judge timed out after ${timeoutMs}ms`));
      if (code !== 0) {
        return reject(new Error(`opencode exited ${code}: ${stderr.trim().slice(0, 400)}`));
      }

      const events = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const text = events
        .filter((event) => event.type === 'text')
        .map((event) => event.part?.text ?? '')
        .join('');
      const finish = [...events].reverse().find((event) => event.type === 'step_finish');
      resolvePromise({
        text,
        sessionID: finish?.sessionID ?? events[0]?.sessionID ?? null,
        tokens: {
          input: finish?.part?.tokens?.input ?? null,
          output: finish?.part?.tokens?.output ?? null,
          cacheRead: finish?.part?.tokens?.cache?.read ?? null,
        },
        cost: finish?.part?.cost ?? null,
      });
    });
  });
}

function buildPrompt(item, rubricText) {
  const payload = {
    id: item.id,
    category: item.category ?? null,
    prompt: item.prompt ?? item.messages ?? null,
    response: item.response,
    reference: item.reference ?? null,
  };
  return `${rubricText}\n\nEvaluate this record:\n${JSON.stringify(payload, null, 2)}`;
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('judge returned no JSON object');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateGrade(value) {
  const limits = {
    task_fulfillment: 40,
    correctness: 30,
    coherence: 20,
    concision: 10,
  };
  const grade = {};
  for (const [name, max] of Object.entries(limits)) {
    const score = Number(value[name]);
    if (!Number.isFinite(score) || score < 0 || score > max) {
      throw new Error(`invalid ${name}: ${value[name]}`);
    }
    grade[name] = Math.round(score);
  }
  grade.score = Object.values(grade).reduce((sum, score) => sum + score, 0);
  if (!VALID_FAILURES.has(value.failure)) {
    throw new Error(`invalid failure tag: ${value.failure}`);
  }
  grade.failure = value.failure;
  grade.reason = String(value.reason ?? '').trim().slice(0, 300);
  if (!grade.reason) throw new Error('missing grade reason');
  return grade;
}

function sourceKey(item) {
  if (!item.id) throw new Error('every input record needs an id');
  if (typeof item.response !== 'string') {
    throw new Error(`${item.id} needs a string response`);
  }
  return [item.id, item.variant ?? 'default', item.run ?? 1].join('::');
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error.message}`);
      }
    });
}

async function completedKeys(path) {
  try {
    const records = await readJsonl(path);
    return new Set(records.map((record) => record.source_key).filter(Boolean));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Set();
    throw error;
  }
}

function appendLine(path, value) {
  const line = `${JSON.stringify(value)}\n`;
  writeChain = writeChain.then(() => appendFile(path, line));
  return writeChain;
}

function parseArgs(args) {
  const config = {
    input: 'eval-results.jsonl',
    output: 'grades.jsonl',
    rubric: 'eval/grader.md',
    model: DEFAULT_MODEL,
    concurrency: 15,
    retries: 2,
    timeoutMs: 120_000,
  };

  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const value = args[++i];
    if (!value) throw new Error(`missing value for ${name}`);
    if (name === '--input') config.input = value;
    else if (name === '--output') config.output = value;
    else if (name === '--rubric') config.rubric = value;
    else if (name === '--model') config.model = value;
    else if (name === '--concurrency') config.concurrency = Number(value);
    else if (name === '--retries') config.retries = Number(value);
    else if (name === '--timeout-ms') config.timeoutMs = Number(value);
    else throw new Error(`unknown option: ${name}`);
  }

  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  config.concurrency = Math.min(config.concurrency, MAX_CONCURRENCY);
  return config;
}
