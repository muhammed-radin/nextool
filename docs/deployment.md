---
title: Deployment
category: Operations
order: 1
---

# Deployment

How to build, start and operate NexTool Q1 outside the dev server.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Prisma SQLite connection string (e.g. `file:./db/custom.db`). The file path resolves relative to the app directory. |

That is the only variable the application reads. No project-level API keys exist; the
`z-ai-web-dev-sdk` resolves its own credentials from its hosting environment — make sure
that environment provides them, otherwise LLM-dependent steps degrade to the
heuristic-fallback engine and `image.generate` reports `SERVICE_UNAVAILABLE` honestly.

## Production build

```bash
bun run build
```

The script does three things (see `package.json`):

1. `next build` — `next.config.ts` sets `output: "standalone"`, producing
   `.next/standalone/server.js` with a minimal node_modules subset.
2. `cp -r .next/static .next/standalone/.next/` — static assets into the standalone
   bundle.
3. `cp -r public .next/standalone/` — `public/` (including `generated/` images) into
   the bundle.

Type-checking does **not** gate the build (`typescript.ignoreBuildErrors: true`);
`bun run lint` is the quality gate you should run yourself.

## Start

```bash
bun run start
# NODE_ENV=production bun .next/standalone/server.js  (logs tee'd to server.log)
```

Then:

```bash
bun run db:push       # ensure schema exists before first boot (or right after)
```

Port comes from the standalone server (defaults to 3000; `PORT` env is honored by the
Next server itself).

## Operational notes

- **Single process.** The runtime is in-process (task handles, live schedulers, event
  ring, virtual fleet in memory). Do not run multiple replicas against one SQLite file
  and do not expect live tasks to survive a restart — they persist as rows but their
  schedulers die with the process (see [Scheduler](../architecture/scheduler.md)).
- **SQLite** is fine for a single-node ops console; for durability, back up
  `db/custom.db` (stop writes or use SQLite's backup API).
- **Generated images** accumulate under `public/generated/`; prune by disk policy (the
  `GeneratedImage` table references paths — deleting files orphans rows honestly).
- **Time sync** matters for SSE replay (`since` comparisons) and event ordering.

## Model / dataset deployment notes

- There is **no model artifact to ship**. The active engine is llm-core v1.0.0 via
  `z-ai-web-dev-sdk`; the heuristic fallback is code.
- `.nextool` manifests registered via `POST /api/models/load` live in the `ModelRecord`
  table and are metadata only — the inference adapter is not installed, so packages
  stay `registered` and nothing needs to be deployed alongside the app.
- Datasets live in the `DatasetRecord` table. To move them between environments, export
  JSON (`GET /api/datasets/{id}/export?format=json`) and re-import in the target env —
  the export format is exactly the import format.

## Realtime behind proxies

The SSE stream needs buffering disabled and idle timeouts longer than the 15 s
keepalive. The server already sends `X-Accel-Buffering: no` (recognized by nginx and
most derivatives) — for explicit configs:

- **nginx**: `proxy_buffering off;` for `/api/stream` (or rely on the header),
  `proxy_read_timeout` ≥ 60 s, HTTP/1.1 `proxy_set_header Connection ''`.
- **Caddy**: reverse_proxy works by default for SSE (no buffering); ensure the site
  address matches the public origin.
- **CDN / aggressive caches**: bypass the cache for `text/event-stream` responses
  (`Cache-Control: no-cache, no-transform` is already sent).

Client behavior through proxies is handled by the frontend reconnect policy
(1 s→10 s backoff, max 8 attempts, jitter — see
[Realtime](../realtime/realtime.md)).

## Health checks

| Check | Expectation |
| --- | --- |
| `GET /api/system` | `{ ok: true, data.runtimeStatus: "online" }`, `appVersion "1.0.1"`. |
| `GET /api/stream` (curl, 3 s) | `event: hello` frame immediately, then `:keepalive` within 15 s. |
| `POST /api/tasks` smoke | Queued task reaches `completed` (goal) or `waiting` (live). |

## Rollback

The build is self-contained per commit: rebuild the previous commit and restart.
SQLite migrations are `db push`-based — schema changes are additive in this project's
history so far; take a file backup before `db:push` on upgrades.

## See also

- [Testing](testing.md) — verification workflows before shipping.
- [Troubleshooting](troubleshooting.md) — runtime issues in production.
