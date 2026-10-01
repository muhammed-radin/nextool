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
- **Icon packages** (v1.0.2) live under `public/icons/<packageId>/` — created on first
  upload and referenced by the active branding manifest in the `Setting` table. Copy
  that directory along with the database when migrating hosts, or discard via
  `DELETE /api/icons` + re-upload. Since v1.0.3 the ZIP may also use common
  favicon-generator filenames — `favicon-16x16.png`/`favicon-32x32.png`,
  `android-chrome-192x192.png`/`android-chrome-512x512.png` and
  `apple-touch-icon-<anything>.png` are aliased to the canonical `icon-<size>.png` /
  `apple-touch-icon.png` names after real PNG dimension validation;
  `site.webmanifest`/`manifest.json`/`browserconfig.xml` entries are skipped (returned
  in the upload response's `ignored` list, not rejected) and duplicate canonical names
  keep the first. Everything else is unchanged: `favicon.ico` required, ≤ 2 MiB per
  file, staged → preview → activate.
- **Exports directory** (v1.0.2): `nextool model export -o ./exports/…` writes model
  packages wherever you point it (`exports/` is the convention used in the docs); these
  are plain zips — safe to archive or move between environments.
- **Time sync** matters for SSE replay (`since` comparisons) and event ordering.

## CLI availability

The CLI ships with the app (v1.0.2) and runs wherever the repo + Bun do:

```bash
bun run cli -- runtime status        # via the package script
bun scripts/nextool.ts train …       # directly
```

`package.json` declares `"bin": { "nextool": "./scripts/nextool.ts" }`, so a
`bun link` / global install exposes a plain `nextool` command. Commands that talk to
SQLite directly (train, benchmark, model, dataset, tool) work without the web server;
`nextool runtime status/start` targets the HTTP API (`NEXOOL_RUNTIME_URL` overrides the
default `http://127.0.0.1:3000`). Full reference: [CLI](cli.md).

## Model / dataset deployment notes

- The active engine is llm-core v1.0.0 via `z-ai-web-dev-sdk`; the heuristic fallback
  is code. No engine artifact needs to be deployed.
- **Trained model artifacts are real since v1.0.2**: checkpoints registered by training
  live in the `ModelRecord` table (weights embedded in the manifest JSON), and export
  produces portable zips (`GET /api/models/export`, `nextool model export`). To move a
  model between environments: export, then import in the target env
  (`POST /api/models/import` or `nextool model import`) — the import runs the real TFJS
  compatibility check before registering. Note the TensorFlow.js dependency
  (`@tensorflow/tfjs` 4.22.0, CPU backend) is a normal npm dependency — no native
  binaries, no extra services.
- `.nextool` manifests registered via `POST /api/models/load` remain metadata-only
  (no weights) and are not runnable; the import path marks them with a warning.
- Datasets live in the `DatasetRecord` table. To move them between environments, export
  (`GET /api/datasets/{id}/export?format=json` or `?format=parquet`, `nextool dataset
  export`) and re-import in the target env — the export format is exactly the import
  format, and the Parquet round-trip is binary-exact through the same
  `@dsnp/parquetjs` adapter on both ends.

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
| `GET /api/system` | `{ ok: true, data.runtimeStatus: "online" }`, `appVersion "1.0.3"`. |
| `GET /api/stream` (curl, 3 s) | `event: hello` frame immediately, then `:keepalive` within 15 s. |
| `POST /api/tasks` smoke | Queued task reaches `completed` (goal) or `waiting` (live). |
| `nextool runtime status` | `[ok] runtime online — app v1.0.3 · engine llm-core v1.0.0`. |
| `nextool model list` | Lists registered packages without error (empty list is valid). |

## Rollback

The build is self-contained per commit: rebuild the previous commit and restart.
SQLite migrations are `db push`-based — schema changes are additive in this project's
history so far; take a file backup before `db:push` on upgrades.

## See also

- [CLI](cli.md) — command reference for the bundled `nextool` CLI.
- [Testing](testing.md) — verification workflows before shipping.
- [Troubleshooting](troubleshooting.md) — runtime issues in production.
