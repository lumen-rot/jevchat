# Jev evaluation

Two halves: **generate** responses from a strategy, then **grade** them with a judge model.

## Generate

Runs a strategy over `eval/prompts.jsonl` (100 prompts) and writes the JSONL the grader
consumes. Strategies live in `eval/strategies/` (`v1-253`, `tournament-1020`, `buckets`).

```sh
node eval/run.mjs --impl tournament-1020 --temperature 0.3 \
  --output eval/eval-results.jsonl --concurrency 15
# flags: --impl --temperature --variant --run --limit --prompts --output --concurrency --shuffle
```

## Grade

Input is JSONL with one response per line:

```json
{"id":"arithmetic_001","category":"arithmetic","variant":"tournament-1020","run":1,"prompt":"what is two plus three?","response":"five.","reference":"five"}
```

Grade with DeepSeek 4.1 Flash through the configured OpenCode Go account:

```sh
node eval/grade.mjs \
  --input eval/eval-results.jsonl \
  --output eval/eval-grades.jsonl \
  --concurrency 15
```

The runner never exceeds 15 concurrent jobs. Completed `source_key` values are
skipped on later runs, so the same command safely resumes an interrupted batch.
Failures are written to `<output>.errors` and retried on the next run.

Test the setup with the included sample:

```sh
node eval/grade.mjs \
  --input eval/sample-results.jsonl \
  --output eval/sample-grades.jsonl \
  --concurrency 2
```
