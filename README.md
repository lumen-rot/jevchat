# jevchat

Turns [Jev](https://docs.typesafe.ai) — a System One model that returns typed decisions,
not text — into a chatbot. At every step it asks Jev one question: *given the user's
message and the reply so far, which word comes next?* Jev returns a probability for each
candidate, the sampler draws one, appends, repeats.

It is not good. That is the point.

## How it works

- **Vocabulary:** ~1,020 words (`src/vocab.js` + `src/vocab-large.js`), plus `<eot>` to stop.
- **Tournament:** Jev's `choice` caps at 255 options, so the vocabulary is split into four
  buckets asked in parallel, the top 48 from each go to a final round, and the winner is
  drawn from the final distribution. Two API calls per word.
- **Sampling:** temperature + a recency penalty so it doesn't loop. Default temp `0.3`.
- **End of chat:** a separate `noul` question after each reply — "is this conversation over?"
  — returned as a probability and shown per turn.

The "but how?" button in the UI walks through the same steps.

## Quickstart

```sh
node dev-server.mjs          # http://localhost:8787 (zero deps; reads ./env or ./.dev.vars)
```

Paste your TypeSafe key into `.env`:

```
JEV_API_KEY="..."
```

## Deploy (Cloudflare Workers)

```sh
npm install
npx wrangler login
npx wrangler secret put JEV_API_KEY
npx wrangler deploy
```

One Worker serves `public/` as static assets and streams `/api/chat` (SSE). The API key
stays server-side.

## Eval

`eval/` runs 100 prompts through a pluggable strategy and grades them with a judge model.
See [`eval/README.md`](eval/README.md). Strategies: `v1-253`, `tournament-1020`, `buckets`.

## API

`POST /api/chat` — body `{ messages: [{role, text}], temperature }`; returns `text/event-stream`.
Events: `word`, `end`, `done`, `error`.
