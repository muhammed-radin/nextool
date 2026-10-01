---
title: Getting Started
category: Getting Started
order: 1
---

# Getting Started

NexTool Q1 is a specialized AI task-processing, planning, observation, automation and
tool-execution runtime with an operations console. It is **not** a chatbot: requests are
decomposed into plans, executed through a dynamic tool registry, observed, and verified
against a goal — either once (Goal Mode) or continuously (Live Mode).

This page walks from a fresh clone to your first completed task and your first live task.

## Prerequisites

| Requirement | Version used in development | Notes |
| --- | --- | --- |
| Node.js | v24.x (v20.9+ works for Next.js 16) | Runtime for dev/build. `node -v` to check. |
| Bun | 1.3.x | Used for the production start script and fast installs. |
| SQLite | file-based, bundled with Prisma | No separate database server needed. |

You do **not** need a separate model server. All LLM decisions (planning, tool matching,
observation) run through the `z-ai-web-dev-sdk` package, which is backend-only.

## Install

```bash
git clone <your-repo-url> nextool-q1
cd nextool-q1
bun install        # or: npm install
```

## Configure environment variables

The runtime reads exactly one environment variable:

```bash
# .env
DATABASE_URL="file:./db/custom.db"
```

`DATABASE_URL` is the Prisma SQLite connection string. No API keys are stored in the
project itself — the `z-ai-web-dev-sdk` resolves its own credentials from the sandbox
environment it runs in. Never commit `.env`.

## Create the database schema

```bash
bun run db:push       # prisma db push — creates tables in the SQLite file
```

Available database scripts (from `package.json`):

| Script | Command | Purpose |
| --- | --- | --- |
| `bun run db:push` | `prisma db push` | Sync schema to SQLite (development workflow). |
| `bun run db:generate` | `prisma generate` | Regenerate the Prisma client. |
| `bun run db:migrate` | `prisma migrate dev` | Create/apply a dev migration. |
| `bun run db:reset` | `prisma migrate reset` | Wipe and recreate the database. |

## Run in development

```bash
bun run dev           # next dev -p 3000, logs tee'd to dev.log
```

Open `http://localhost:3000`. The console is a single-page app — the only server route is
`/`; all 13 screens (Dashboard, Task Console, Live Monitor, Tools, Memory, Live State,
Events, History, Models, Datasets, Documentation, Settings, Task Preview) are client-side
views inside that one page.

On first use the tool registry seeds 15 built-in tools into the `ToolRecord` table
(`server.*` virtual fleet tools, `system.info`, `math.evaluate`, `memory.*`,
`notification.send`, `image.generate`, and utility tools). Seeding happens automatically
on the first registry query.

## Verify the runtime is up

```bash
curl -s http://localhost:3000/api/system | head -c 400
```

A healthy response is an envelope `{ "ok": true, "data": { "appVersion": "1.0.1", ... } }`
with runtime status `online`. The console header shows a connection pill that reads
**Connected** once the SSE stream (`/api/stream`) is live.

## Load the model

There is no model download step. The decision engine is **llm-core v1.0.0**, served
through `z-ai-web-dev-sdk` on the server side; the deterministic **heuristic-fallback**
matcher covers SDK outages automatically. Check the active engine in the console under
**Models**, or via:

```bash
curl -s http://localhost:3000/api/models | head -c 400
```

The `adapters` field honestly reports what is installed in this environment:
`{ "tfjs": false, "nextoolManifest": true, "parquet": false }` — TensorFlow.js and Parquet
adapters are **not installed**; the `.nextool` manifest validator is available.

## Run your first task (Goal Mode)

Via the UI: **Task Console** → enter a request such as
`Check the health of server api-01` → submit. The view switches to **Task Preview** where
you can watch the plan, tool executions, observations and the final result in real time.

Via the API:

```bash
curl -s -X POST http://localhost:3000/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01"}'
```

The task runs UNDERSTAND → PLAN → SELECT TOOL → GENERATE PARAMS → EXECUTE → OBSERVE →
UPDATE STATE → REPLAN → COMPLETE. When it completes, `GET /api/tasks/{id}` returns the
`finalResult` with the last observation (e.g. `Server api-01 health: healthy (cpu …%, mem
…%)`).

## Run your first live task (Live Mode)

Live Mode is an explicit opt-in — the runtime never auto-switches a task into it.

1. In **Task Console**, select mode **live**, keep the amber confirmation switch ON.
2. Use a monitoring-flavored request, e.g. `Monitor the production API servers and inform
   me if anything becomes unhealthy`.
3. Submit. The task runs one observation cycle, then parks in `waiting` and schedules a
   tick every `liveIntervalMs` (default 60000 ms).

To see event-driven automation immediately, open **Live State** (or **Live Monitor**),
press **Crash** on a server. The environment broadcast wakes the live task instantly, a
recovery subgoal is created, and the runtime runs health → restart → verify until the
server is healthy again.

## Where to go next

- [Installation](installation.md) — detailed setup and troubleshooting during install.
- [Configuration](configuration.md) — every settings field with defaults and ranges.
- [Architecture](architecture.md) — how Main, Planner, Observer, CoreModule and the tool
  runtime fit together.
- [API](api.md) — every endpoint with request/response examples.
