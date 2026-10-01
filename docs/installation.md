---
title: Installation
category: Getting Started
order: 2
---

# Installation

Step-by-step setup for NexTool Q1 v1.0.4, including the parts that most often trip up a
fresh environment (Node version, Prisma client, ports, first boot).

## 1. System requirements

- **Node.js** ≥ 20.9 (development used v24.x). Required by Next.js 16.
- **Bun** ≥ 1.1 (development used 1.3.x). Optional but recommended — the `start` script
  and several docs examples assume Bun. npm/pnpm work equally well for install.
- **Disk**: a few hundred MB for `node_modules` plus generated images under
  `public/generated/`.
- **No external database**: Prisma uses a local SQLite file pointed to by `DATABASE_URL`.
- **No external model server**: LLM calls go through `z-ai-web-dev-sdk` (server-side only).

## 2. Get the code and dependencies

```bash
cd nextool-q1
bun install           # or npm install
```

Key dependencies (see `package.json` for the full list):

| Package | Role |
| --- | --- |
| `next` ^16 / `react` ^19 | App Router server + SPA console. |
| `@prisma/client` + `prisma` ^6 | SQLite ORM for tasks, events, tools, memory, history. |
| `z-ai-web-dev-sdk` ^0.0.18 | LLM (chat completions) and image generation — backend only. |
| `zustand` ^5 | Console + runtime-connection state stores. |
| `tailwindcss` ^4, shadcn/ui (Radix) | Blue-gradient glassmorphism design system. |
| `react-markdown` ^10 | Built-in documentation reader. |
| `@dsnp/parquetjs` **1.8.9** (pinned) | Real Parquet dataset import/export (v1.0.3). Pure JS; do not substitute 1.9.x — newer tarballs ship without build artifacts. |

## 3. Environment file

Create `.env` in the project root:

```bash
DATABASE_URL="file:./db/custom.db"
```

That is the only variable the application reads (`prisma/schema.prisma` uses
`env("DATABASE_URL")`). Values are intentionally not documented here — never commit `.env`.

## 4. Generate the Prisma client and push the schema

```bash
bun run db:generate   # prisma generate  → node_modules/@prisma/client
bun run db:push       # prisma db push   → creates all tables
```

After `db:push` the SQLite file contains twelve models: `Task`, `TaskEvent`, `ToolRecord`,
`MemoryEntry`, `HistoryEntry`, `Setting`, `ModelRecord`, `DatasetRecord`,
`NotificationRecord`, `GeneratedImage`, `TrainingJobRecord`, `BenchmarkRunRecord`. See
[Project Structure](project-structure.md) for
what each table stores.

## 5. Start the development server

```bash
bun run dev
```

- Serves on **http://localhost:3000** (the script pins `-p 3000`).
- Output is tee'd to `dev.log` — check it if a page fails to compile.
- The first request seeds the 15 built-in tools and initializes the virtual server fleet
  (api-01, web-01, db-01) in memory.

## 6. Verify

```bash
curl -s http://localhost:3000/api/system | head -c 300
# {"ok":true,"data":{"appVersion":"1.0.4",...}}

curl -s "http://localhost:3000/api/stream?since=0" --max-time 3
# event: hello
# data: {"ok":true,...}
```

Then open the console: the header pill should say **Connected** and the Dashboard should
report runtime `online`.

## 7. Production build (optional now, covered in Deployment)

```bash
bun run build         # next build (standalone output) + copies static/public
bun run start         # NODE_ENV=production bun .next/standalone/server.js
```

Details, proxy notes and env handling live in [Deployment](deployment.md).

## Troubleshooting install

| Symptom | Cause | Fix |
| --- | --- | --- |
| `prisma generate` fails or client is stale after schema edits | client not regenerated | Run `bun run db:generate` again, restart dev server. |
| `Error: Environment variable not found: DATABASE_URL` | `.env` missing or not in root | Create `.env` next to `package.json`; rerun. |
| P3006 / "does not exist in database" | schema not pushed | Run `bun run db:push`. |
| Port 3000 already in use | another dev server running | Stop it, or temporarily edit the `dev` script port. |
| Image generation returns `SERVICE_UNAVAILABLE` | SDK credentials/network unavailable in your environment | Everything else keeps working; the tool reports failure honestly. |
| Types look broken in the IDE | TS server cache | Restart TS server; `next.config.ts` sets `ignoreBuildErrors: true`, so builds do not gate on types. |

## Next steps

- [Configuration](configuration.md) — tune limits, intervals and defaults.
- [Getting Started](getting-started.md) — run your first Goal and Live tasks.
- [Troubleshooting](troubleshooting.md) — symptom → cause → fix tables for runtime issues.
