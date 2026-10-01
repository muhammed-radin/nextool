---
title: Project Structure
category: Getting Started
order: 4
---

# Project Structure

Every directory and file that matters in the repository, what it contains, why it exists
and what depends on it.

```
nextool-q1/
├── docs/                      ← this documentation system (markdown + front-matter)
├── prisma/schema.prisma       ← 12-model SQLite schema
├── db/custom.db               ← SQLite database file (DATABASE_URL target)
├── scripts/nextool.ts         ← CLI entry (commander; shares the service layer)
├── tests/                     ← sandbox-infrastructure checks (shell scripts, NOT app tests)
├── exports/                   ← model packages written by `nextool model export -o ./exports/…`
├── public/
│   ├── generated/             ← images produced by image.generate (PNG)
│   ├── icons/<packageId>/     ← staged/active icon packages (created on first upload)
│   └── logo.svg               ← favicon / brand mark (fallback)
├── src/
│   ├── app/                   ← Next.js App Router (1 page + API routes)
│   ├── components/console/    ← the SPA console (shell + 16 views)
│   ├── components/ui/         ← shadcn/ui primitives (Radix)
│   ├── hooks/                 ← useNexoolStream + helpers
│   └── lib/
│       ├── db.ts              ← Prisma client singleton
│       ├── utils.ts           ← cn() helper
│       └── nexool/            ← THE RUNTIME (server-only modules)
├── package.json / next.config.ts / tsconfig.json
└── worklog.md                 ← build history of this project
```

## Root files

| Path | Purpose |
| --- | --- |
| `package.json` | `nextool-q1` v1.0.3. Scripts: `dev`, `build`, `start`, `lint`, `db:push`, `db:generate`, `db:migrate`, `db:reset`, `cli` (`bun run scripts/nextool.ts`). `bin`: `nextool` → `./scripts/nextool.ts`. Notable deps: `@tensorflow/tfjs` 4.22.0 (v1.0.2), `@dsnp/parquetjs` **1.8.9 pinned** (v1.0.3 Parquet adapter), `@monaco-editor/react` + `monaco-editor` (Tool IDE), `@uiw/react-json-view`, `commander` (CLI), `fflate` (zip packaging). |
| `next.config.ts` | `output: "standalone"` (production server bundle), `reactStrictMode: false`, `typescript.ignoreBuildErrors: true`, `serverExternalPackages: ["@dsnp/parquetjs"]` (v1.0.3 — the Parquet adapter is required from node_modules at runtime, not bundled). |
| `tsconfig.json` | Standard Next.js TS config with `@/*` path alias → `src/*`. |
| `.env` | Only `DATABASE_URL`. Never committed, values never documented. |
| `Caddyfile` | Sandbox infrastructure (local reverse proxy) — not part of the application. |
| `worklog.md` | Task-by-task build log; v1.0.0 build, v1.0.1 foundation, v1.0.2 additions, v1.0.3 updates. |
| `scripts/nextool.ts` | The CLI (`nextool train / benchmark / model / dataset / tool / runtime / version`). Directly imports the same service modules the API routes use. |
| `tests/*.sh` | Sandbox-infrastructure verification scripts (e.g. a fake-bun harness for `db:push`); they test the hosting environment, not the application. No `*.test.ts` files exist. |

## prisma/schema.prisma

Binding data model (SQLite). Everything in the runtime persists here:

| Model | Stores | Written by |
| --- | --- | --- |
| `Task` | request, goal, mode, status, config JSON, state JSON, plan JSON, finalResult, error | `nexool.ts` / `loop.ts` |
| `TaskEvent` | every emitted event (type, source, message, data, priority 1–9) | `eventbus.emitEvent` |
| `ToolRecord` | tool definitions (JSON), environment incl. `js-function`, `functionSource` + `toolVersion` (v1.0.2), enabled flag, call/success/failure/timeout stats | `tools/registry.ts` |
| `TrainingJobRecord` | v1.0.2 training jobs: dataset lineage, status, config, per-epoch metrics + logs, finalMetrics, modelRecordId | `training/engine.ts` |
| `BenchmarkRunRecord` | v1.0.2 benchmark runs: modelKey, dataset lineage, metrics, per-case results, durationMs | `training/benchmark.ts` |
| `MemoryEntry` | persistent memory: unique key, JSON value, tags, source | `memory.store` tool, feedback loop, `/api/memory` |
| `HistoryEntry` | one row per tool execution (params/result JSON, status; v1.0.3 `batchId` + `parallelGroup` for parallel-batch provenance) | `tools/executor.ts` |
| `Setting` | global settings JSON under key `nextool`; branding manifest under `branding.icons` | `settings.ts`, `branding.ts` |
| `ModelRecord` | registered model packages (manifests, trained checkpoints, imports) | `training/engine.ts`, `/api/models/load`, `/api/models/import` |
| `DatasetRecord` | imported datasets: split sizes, examples JSON, categories | `/api/datasets/import` |
| `NotificationRecord` | notifications created by `notification.send` | `tools/notify.ts` |
| `GeneratedImage` | image artifacts (path, prompt, size, taskId) | `tools/image.ts` |

## src/lib/nexool — the runtime

| File | Contents | Depends on |
| --- | --- | --- |
| `types.ts` | All domain types: ToolDefinition, CoreModuleOutput, MainState, TaskConfig, NexToolEvent, GlobalLiveState, ContextComposition, SystemStats, ApiEnvelope… | (binding contract) |
| `api-contract.ts` | REST contract comment + DTOs (`TaskDetail`, `ToolEntry`, `MemoryEntryDTO`…) | `types.ts` |
| `version.ts` | `APP_VERSION` 1.0.3, `RELEASE_NAME`, `CORE_MODULE_NAME` llm-core, `CORE_MODULE_VERSION` 1.0.0, SSE constants | everything reads this |
| `eventbus.ts` | Global event manager: `emitEvent`, `subscribe`, `recentEvents`, `queryEvents`, SSE controller registry, runtime metrics (`coreCalls`, latency series) | db, types |
| `settings.ts` | `DEFAULT_SETTINGS`, cached `getSettings`, clamping `updateSettings` | db |
| `schemas.ts` | zod schemas for every mutating endpoint (tasks, tools incl. `registerJsToolSchema`/`updateToolSchema`/`testToolSchema`, training, benchmark, memory, datasets, settings) | zod |
| `branding.ts` | v1.0.2 icon packages: zip validation (PNG IHDR parsing, safe names, size caps), staging/activation under `public/icons/<packageId>/` | fflate, db |
| `tool-runtime-declarations.ts` | v1.0.2 Monaco `extraLib` + References-pane source for the js-function sandbox (one declaration module for both) | types |
| `environment.ts` | Virtual server fleet state machine: drift/crash/degrade/recover/restart, `getGlobalLiveState` | eventbus |
| `api-helpers.ts` | `ok()` / `fail()` ApiEnvelope responses, `readJson` | types |
| `docs.ts` | Docs loader: front-matter parse, SAFE_SLUG anti-traversal, `listDocs`/`readDoc` | filesystem `docs/` |
| `connection.ts` | Frontend Zustand store: 5-state connection machine, backoff policy (max 8 attempts, 1 s→10 s + jitter) | zustand, version |
| `client.ts` | Typed frontend API client: `apiFetch` envelope enforcement, `ApiClientError`, one helper per endpoint | types, api-contract |
| `main/nexool.ts` | Runtime singleton (globalThis-backed): `createTask`, `stopTask`, `injectEvent`, task queries, active counts | loop, eventbus, settings, environment |
| `main/loop.ts` | `runTask` entry; Goal Mode and Live Mode state machines; context bundle; parallel groups; repair passes; finalize | planner, observer, coremodule, executor, registry |
| `main/planner.ts` | `buildPlan` — LLM decomposition (max 8 steps, parallelGroup), deterministic 2-step fallback | z-ai-web-dev-sdk |
| `main/observer.ts` | `interpret` (domain-aware observation strings) + `checkGoalComplete` (LLM verify, heuristic at L1–2) | z-ai-web-dev-sdk |
| `core/coremodule.ts` | `decide` — tool matching + parameter generation; validates output; allowed-tools filter; records latency metrics | z-ai-web-dev-sdk, heuristic, executor |
| `core/heuristic.ts` | Deterministic fallback matcher: token overlap scoring (threshold 0.18), typo normalization, naive param extraction | types |
| `tools/registry.ts` | `BUILTIN_TOOLS` (15 definitions), DB seeding, handler resolution, dynamic + js-function registration (`registerJsTool`, `updateTool`, `deleteTool`), stats | db, tools/* |
| `tools/js-runner.ts` | v1.0.2 `node:vm` sandbox for `js-function` tools: compile/validate, 4 s sync + 10 s async caps, serializable-result enforcement (64 KiB / depth 12), capped log capture | node:vm |
| `tools/executor.ts` | Tool runtime: param coercion/validation, timeout + abort race, stats, history, events; `executeToolsParallel`; v1.0.3 `executeParallelBatch` (capped waves, batch provenance) | registry, handler |
| `tools/handler.ts` | `ToolHandler` type, `HandlerContext`, `ToolFailure` error class | types |
| `tools/builtin.ts` | Real handlers: system.info, math.evaluate (safe parser), text.analyze, time.now, uuid.generate, echo.echo, delay.wait | node:os, node:crypto |
| `tools/virtual.ts` | server.list / server.health / server.restart / service.restart against the virtual fleet | environment |
| `tools/memory.ts` | memory.store (upsert) / memory.recall (exact + fuzzy top-5) | db |
| `tools/notify.ts` | notification.send — persists NotificationRecord, emits `notification.sent` | db, eventbus |
| `tools/image.ts` | image.generate — z-ai SDK, prompt enrichment, writes PNG to `public/generated` | z-ai-web-dev-sdk, db |
| `training/engine.ts` | v1.0.2 REAL TF.js trainer: hashed bag-of-words vectorization, dense classifier, per-epoch persistence, checkpoint registration | @tensorflow/tfjs, db |
| `training/benchmark.ts` | v1.0.2 REAL benchmark engine: runs llm-core / heuristic-fallback / a trained classifier per example, computes metrics, persists per-case results | @tensorflow/tfjs, core, db |
| `training/model-package.ts` | v1.0.2 packaging: export tfjs zip / `.nextool` package, import + TFJS load-validation, 25 MiB cap, traversal-safe unzip | fflate, @tensorflow/tfjs, db |
| `datasets/parquet.ts` | v1.0.3 Parquet dataset adapter: `encodeParquetDataset` / `decodeParquetDataset` (one flat row per example, per-row validation with row index), `parquetAdapterInfo()` honest capability probe (cached once per process) | @dsnp/parquetjs 1.8.9 |
| `stream/sse.ts` | `buildEventStream` — hello frame, replay from in-memory recent events, live push, 15 s keepalive | eventbus |

## src/app — routes

- `page.tsx` + `layout.tsx` + `globals.css` — the only user-visible route (`/`) and the
  blue-gradient glassmorphism theme.
- `api/**/route.ts` — endpoints grouped as `system`, `state`, `env/event`, `stream`,
  `tasks` (+ `[id]/{stop,event,events,feedback,context,executions}`), `tools`
  (+ `register`, `js`, `test`, `[name]` (GET/PUT/DELETE), `[name]/toggle`), `memory`,
  `history`, `notifications` (+ `read-all`), `images`, `models` (+ `load`, `export`,
  `import`), `datasets` (+ `import`, `[id]`, `[id]/export`), `training` (+ `[id]`),
  `benchmark` (+ `[id]`), `icons`, `settings`, `docs` (+ `[slug]`), plus the scaffold
  `api/route.ts` hello-world.
  Every route is `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  See [API](../api/api.md).

## src/components/console — the SPA

| File | Contents |
| --- | --- |
| `console-app.tsx` | Shell: header (brand, RuntimeConnectionStatus, bell), glass sidebar, mobile bottom nav + More sheet, status bar, view switching with AnimatePresence. |
| `console-store.ts` | Zustand: `activeView` (16 views incl. `tool-editor`, `training`, `benchmark`), `selectedTaskId`, `openTaskPreview`, `openToolEditor` / `closeToolEditor`. |
| `providers.tsx` | `SystemStatsProvider` (5 s poll), `GlobalStreamProvider` (one SSE, 15 min replay), `NotificationsProvider` (10 s poll). |
| `runtime-connection-status.tsx` | Accessible connection pill + details popover (5 states, retry countdown, reconnect button). |
| `ui-bits.tsx` | StatusChip, SourceDot, TypeChip, EventRow, JsonBlock, MetricCard, EmptyState, ErrorCard, formatters — plus `deriveTaskRuntime` / `terminalStatusLine` / `deriveChecklist` (v1.0.2 status + checklist derivation, one source of truth). |
| `json-tree.tsx` + `json-theme.ts` | v1.0.2 ONE consistent JSON tree viewer (@uiw/react-json-view, NexTool-themed, expand depth 2, copy, wrapped long strings). |
| `task-checklist.tsx` | v1.0.2 Live Mode checklist/timeline (Aceternity-style): `[✓] [-] [ ] [!] [~]` states from the real plan/events, percent only when meaningful. |
| `terminal.tsx` | Runtime terminal surface — v1.0.2: dynamic status line from `deriveTaskRuntime` (no hardcoded prompt), real event lines, blinking cursor only while a tool runs. |
| `server-card.tsx` | Fleet card with CPU/memory bars and Crash/Degraded/Recover injections. |
| `views/*.tsx` | dashboard, task-console, task-preview, live-monitor, tools, tool-editor, memory, live-state, events, history, models, datasets, training, benchmark, docs, settings. |

## docs/ — this documentation system

Markdown files with `title`/`category`/`order` front-matter, read by `docs.ts` and served
through `/api/docs` and `/api/docs/[slug]`, rendered by the built-in **Documentation**
view. Slugs are filenames; only `[a-z0-9-]` slugs pass the safety check.
