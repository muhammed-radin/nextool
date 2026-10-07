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
├── VFS/                       ← v1.0.14: THE real shared Virtual File System directory (created on first VFS use; legacy data/vfs migrated in automatically)
├── prisma/schema.prisma       ← 12-model SQLite schema
├── db/custom.db               ← SQLite database file (DATABASE_URL target)
├── scripts/nextool.ts         ← CLI entry (commander; shares the service layer)
├── tests/                     ← bun test suites (*.test.ts) + sandbox-infrastructure shell scripts
├── exports/                   ← model packages written by `nextool model export -o ./exports/…`
├── public/
│   ├── generated/             ← images produced by image.generate (PNG)
│   ├── icons/<packageId>/     ← staged/active icon packages (created on first upload)
│   └── logo.svg               ← favicon / brand mark (fallback)
├── src/
│   ├── app/                   ← Next.js App Router (1 page + API routes)
│   ├── components/console/    ← the SPA console (shell + 20 views)
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
| `package.json` | `nextool-q1` v1.0.14. Scripts: `dev`, `build`, `start`, `lint`, `db:push`, `db:generate`, `db:migrate`, `db:reset`, `cli` (`bun run scripts/nextool.ts`). `bin`: `nextool` → `./scripts/nextool.ts`. Notable deps: `@tensorflow/tfjs` 4.22.0 (v1.0.2), `@dsnp/parquetjs` **1.8.9 pinned** (v1.0.3 Parquet adapter), `@monaco-editor/react` + `monaco-editor` (Tool IDE), `@uiw/react-json-view` 2.0.0-alpha.43 (JSON tree — reads `--w-rjv-*` tokens only), `commander` (CLI), `fflate` (zip packaging). |
| `next.config.ts` | `output: "standalone"` (production server bundle), `reactStrictMode: false`, `typescript.ignoreBuildErrors: true`, `serverExternalPackages: ["@dsnp/parquetjs"]` (v1.0.3 — the Parquet adapter is required from node_modules at runtime, not bundled). |
| `tsconfig.json` | Standard Next.js TS config with `@/*` path alias → `src/*`. |
| `.env` | Only `DATABASE_URL`. Never committed, values never documented. |
| `Caddyfile` | Sandbox infrastructure (local reverse proxy) — not part of the application. |
| `worklog.md` | Task-by-task build log; v1.0.0 build, v1.0.1 foundation, v1.0.2 additions, v1.0.3 updates, v1.0.4 refinements, v1.0.5 improvements, v1.0.6 tool-runtime expansion, v1.0.7 timeout/search/reset/cleanup, v1.0.8 central limits + tool runtime expansion, v1.0.9/v1.0.91 fixes, v1.0.10 planner modes + training 1.0.1, v1.0.11 pre-plan recovery + freedom-node + auto-execution hierarchy + training 1.0.2, v1.0.12 MCP connectors + shared global VFS + fs tools + model 1.0.3 + task instructions, v1.0.13 operator console + MCP auth + verification latch + continuations, **v1.0.14 event-driven Live Mode + AskSelf/AskForUser + Limitations page + interactive test runtime + Assistant + real-directory VFS/**. |
| `scripts/nextool.ts` | The CLI (`nextool train / benchmark / model / dataset / tool / runtime / version`). Directly imports the same service modules the API routes use. |
| `scripts/gen-seed-dataset-v103.ts` | **v1.0.12** — the v1.0.3 curriculum generator (bun): loads seed v1.0.2, appends the v1.0.12 teaching batches, validates every example against the REAL registry (uniqueness, tools, param schemas, split coverage) before writing `config/training/seed-dataset-v1.0.3.json`. |
| `model-checkpoints/v1.0.3/` | **v1.0.12** — exported checkpoints for the trained generation: `tfjs/model.zip` (native TF.js) + `nextool/model.nextool` (portable package); both validated through the real import path. Earlier generations keep their own directories. |
| `scripts/gen-seed-dataset-v102.py` | v1.0.11 — the deterministic generator for `config/training/seed-dataset-v1.0.2.json` (324 examples incl. long Markdown documents and hard examples; test/validation membership frozen by request text). |
| `tests/*.sh` | Sandbox-infrastructure verification scripts (e.g. a fake-bun harness for `db:push`); they test the hosting environment, not the application. The `*.test.ts` files (`nextool-v102`/`v103`/`v104`/`v105`/`v106`/`v107`/`v108`/`v109`/`v1091`/`v1010`/`v1011`) ARE app tests — see [Testing](testing.md). |
| `config/configuration-limits.json` | v1.0.8 — THE authoritative central limits file (loader: `src/lib/nexool/config-limits.ts`); v1.0.10 adds `task.prePlanMaxSteps` (integer, default 10, min 1, max 122) to the `task` section; v1.0.11 adds `task.recoveryMaxAttempts` (integer, default 4, range 2–4) and the `fs` section (`{ enabled: true, restricted: false }` — the configuration-only, fail-closed freedom-node gate); **v1.0.14 — savable at runtime from the console Limitations page (`PUT /api/config/limits`, validate-before-write, hot reload ≤ 2 s) with Standard/Unrestricted presets**. |
| `config/training/seed-dataset-v1.0.1.json` | **v1.0.10** (historical generation, kept importable) — the previous shipped training seed ("NexTool Core v1.0.1 Seed", version 1.0.1): 170 examples — 121 train / 23 validation / 26 test, all 15 registered tools covered in train AND test, paraphrases/typos/ambiguous pairs, parameter-generation examples, zero duplicate requests. Import-ready via `POST /api/datasets/import` or the CLI (see [Datasets](datasets.md)). |
| `config/training/seed-dataset-v1.0.3.json` | **v1.0.12** — the CURRENT shipped training seed ("NexTool seed curriculum", version 1.0.3): 447 examples — 320/64/63 splits, 24 categories, all 25 registered tools (incl. the 10 fs.* tools) covered in ALL THREE splits, zero duplicates; carries the full v1.0.2 curriculum plus categorization/coding/GK/technology/NexTool-identity/MCP/shared-VFS/freedom-node teaching batches. Generated by `scripts/gen-seed-dataset-v103.ts` (validated against the real registry). |
| `config/training/seed-dataset-v1.0.2.json` | v1.0.11 — the previous shipped training seed ("NexTool Core v1.0.2 Seed", version 1.0.2): 324 examples — 246 train / 39 validation / 39 test, 17 categories, all 15 registered tools covered in ALL THREE splits, long Markdown-heavy documents + hard examples (typos/synonyms/ambiguity/confusion pairs/irrelevant context/failed previous attempts/state-after-action/conditional requirements) + pattern-aware recovery/verification examples, zero duplicate requests. Generated by `scripts/gen-seed-dataset-v102.py` (test/validation membership frozen by request text). Import-ready via `POST /api/datasets/import` or the CLI (see [Datasets](datasets.md)). |

## prisma/schema.prisma

Binding data model (SQLite). Everything in the runtime persists here:

| Model | Stores | Written by |
| --- | --- | --- |
| `Task` | request, goal, mode, status, config JSON, state JSON, plan JSON, finalResult, error | `nexool.ts` / `loop.ts` |
| `TaskEvent` | every emitted event (type, source, message, data, priority 1–9) | `eventbus.emitEvent` |
| `ToolRecord` | tool definitions (JSON), environment incl. `js-function` and `nodejs` (v1.0.5; metadata + `autoExecute` (v1.0.6) + `timeoutMs` (v1.0.7) travel inside the definition JSON), `functionSource` + `toolVersion` (v1.0.2), enabled flag, call/success/failure/timeout stats (zeroed by the v1.0.7 reset, tools preserved) | `tools/registry.ts` |
| `TrainingJobRecord` | v1.0.2 training jobs: dataset lineage, status, config, per-epoch metrics + logs, finalMetrics, modelRecordId | `training/engine.ts` |
| `BenchmarkRunRecord` | v1.0.2 benchmark runs: modelKey, dataset lineage, metrics, per-case results, durationMs | `training/benchmark.ts` |
| `MemoryEntry` | persistent memory: unique key, JSON value, tags, source | `memory.store` tool, feedback loop, `/api/memory` |
| `HistoryEntry` | one row per tool execution (params/result JSON, status; v1.0.3 `batchId` + `parallelGroup` for parallel-batch provenance) | `tools/executor.ts` |
| `Setting` | global settings JSON under key `nextool`; branding manifest under `branding.icons` | `settings.ts`, `branding.ts` |
| `PatternRecord` | **v1.0.10** — learned execution patterns: unique `signature`, `patternType` (sequence \| outcome \| verification \| failure-recovery \| live \| early-completion), `inputConditions` + `context` JSON, `actionTool`, `resultSummary`, `outcome`, derived `confidence` (0–1), `frequency`/`successCount`/`failureCount`/`contradictionCount`, `source`, `taskMode`, `plannerType`, `sourceRequest` (bounded 300 chars) | `patterns/extractor.ts` (hooked fire-and-forget in `loop.ts` `recordExecution` + finalize); read by `GET /api/patterns` |
| `ModelRecord` | registered model packages (manifests, trained checkpoints, imports) | `training/engine.ts`, `/api/models/load`, `/api/models/import` |
| `DatasetRecord` | imported datasets: split sizes, examples JSON, categories | `/api/datasets/import` |
| `NotificationRecord` | notifications created by `notification.send` | `tools/notify.ts` |
| `GeneratedImage` | image artifacts (path, prompt, size, taskId) | `tools/image.ts` |
| `VirtualFile` | v1.0.6 Virtual File System rows: `toolId` + normalized virtual `path` (unique pair), `kind` file\|dir, `encoding` utf8\|base64, `content`, `size` — **legacy storage (v1.0.6–v1.0.13); since v1.0.14 the VFS lives in the real `VFS/` directory on disk (§24), so this table is no longer written by the runtime** | `tools/vfs.ts` (historical write-through) |

## src/lib/nexool — the runtime

| File | Contents | Depends on |
| --- | --- | --- |
| `types.ts` | All domain types: ToolDefinition, CoreModuleOutput, MainState, TaskConfig, NexToolEvent, GlobalLiveState, ContextComposition, SystemStats, ApiEnvelope… | (binding contract) |
| `api-contract.ts` | REST contract comment + DTOs (`TaskDetail`, `ToolEntry`, `MemoryEntryDTO`…) | `types.ts` |
| `config/configuration-limits.json` | **v1.0.8** — THE authoritative configuration-limits file (version 1 + `$meta` + `network`/`vfs`/`execution`/`childProcess`/`task` sections). Every property carries type/nullable/default/min/max/unit/description. Self-hosted administrators customize limits by editing THIS single file (host edit + restart) or — since v1.0.14 — from the console **Limitations** page (`PUT /api/config/limits`, validated, hot-reloaded ≤ 2 s) | `src/lib/nexool/config-limits.ts` reads it |
| `version.ts` | `APP_VERSION` **1.0.14**, `RELEASE_NAME` ("THE LIVELY AI — event-driven Live Mode … real-directory VFS/"), `CORE_MODULE_NAME` llm-core, `CORE_MODULE_VERSION` 1.0.0 (provider-served, never retrained), **`TRAINED_MODEL_VERSION` 1.0.3 (since v1.0.12; unchanged in v1.0.14 — the app release does NOT change the model version)**, SSE constants | everything reads this |
| `eventbus.ts` | Global event manager: `emitEvent`, `subscribe`, `recentEvents`, `queryEvents`, SSE controller registry, runtime metrics (`coreCalls`, latency series); **v1.0.14 — `emitEventLifecycle` emits the canonical `event.*` lifecycle family (`EventLifecycleState`: received/admitted/queued/processing/completed/rejected/ignored/failed/cancelled)** | db, types |
| `settings.ts` | `DEFAULT_SETTINGS`, cached `getSettings`, clamping `updateSettings` | db |
| `schemas.ts` | zod schemas for every mutating endpoint (tasks, tools incl. `registerJsToolSchema`/`updateToolSchema`/`testToolSchema` — v1.0.5: `environment` js-function\|nodejs + `metadataRecordSchema` (≤ 50 string pairs); v1.0.6: `autoExecute` on the tool schemas + `autoExecuteTools`/`allowMultipleEvents` on task + settings schemas; **v1.0.11: `freedom-node` in the tool/test environment enums, `recoveryMaxAttempts` (int 2–4, rejected out-of-range) on task + settings schemas, `request` caps 8 000 → 32 000 chars on `createTaskSchema` + `datasetExampleSchema`**; training, benchmark, memory, datasets, settings) | zod |
| `editor-source.ts` | v1.0.5 tool-editor source-sync invariants (pure): `coerceEditorChange` (a non-edit onChange can never clear the code) and `readMonacoValue` (a disposed editor is never trusted — the shared source state is the fallback); unit-tested in `tests/nextool-v105.test.ts` | — |
| `docs-link-resolver.ts` | v1.0.5 centralized docs-link classification (pure): `isExternalHref`/`isInPageAnchor`/`isInternalDocLink`, `normalizeDocHref` (basename slug), `resolveDocSlug` (validated against the real docs index), GitHub-style `headingSlug`; powers the docs viewer's in-viewer navigation and not-found state | — |
| `branding.ts` | v1.0.2 icon packages: zip validation (PNG IHDR parsing, safe names, size caps), staging/activation under `public/icons/<packageId>/` | fflate, db |
| `tool-runtime-declarations.ts` | v1.0.2 Monaco `extraLib` + References-pane source for the js-function sandbox (one declaration module for both) | types |
| `tool-portable.ts` | v1.0.4 tool portability (pure, dependency-free): `exportToolJson`/`exportToolsJson` (portable envelope, function source as text), `parseToolImport`, `validateImportedTool`, `validateSchemaJson`, `proposeCopyName`; v1.0.5: `nodejs` environment + `metadata` round trip (string-only pairs, ≤ 50); v1.0.6: `autoExecute` round-trips (tools without the field default to approval-required); v1.0.7: `timeoutMs` round-trips (validated 1000–3600000); **v1.0.91: `parseToolsImport` (single object OR array OR empty), `buildBulkImportPlan` (validate-all-before-register + in-file duplicate + registry conflict detection)**; shared by the Tools view and the unit tests | types, api-contract |
| `tool-search.ts` | v1.0.7 pure tool search/filter shared by the Tools view and the unit tests: `filterTools` — case-insensitive, trimmed, AND-token matching across name/description/purpose/category/environment/handler kind/version/metadata | — |
| `maintenance.ts` | v1.0.7 maintenance operations: `resetApplicationRuntime` (§3 typed-phrase runtime reset — explicit DELETION ALLOWLIST, protects tools/models/datasets/training/settings, emits `system.reset.*`, resets bus statistics), `analyzeResourceDependencies` (§4.2 reference graph over training jobs + benchmark runs + active status), `runResourceCleanup` (§4.7/§5 dry-run + idempotent orphan removal + traceable report), `validateRuntimeDependencies` (§4.11 active model/artifact/reference validation) | db, eventbus, version |
| `tools/timeout.ts` | v1.0.7 ONE source of truth for tool-execution timeouts: `DEFAULT_TOOL_TIMEOUT_MS` 10000, `resolveEffectiveToolTimeout` (tool-specific → task/global → runtime cap), `sanitizeConfiguredToolTimeoutMs`; v1.0.8 — the hard ceiling is LIVE (`maxToolTimeoutMs()` resolves `execution.timeoutMs.max` from the central limits; shipped 3600000) | config-limits |
| `config-limits.ts` | **v1.0.8** — the central limit loader/validator: `getConfigurationLimits` (fs read + mtime cache ≤ 2 s → hot reload without rebuild), `validateLimitsObject` (schema/type/nullable/min≤default≤max — fails CLEARLY with `ConfigurationLimitsError`), `getResolvedLimits` (typed snapshot), `getLimitProperty`, `clampToLimit`, `setConfigurationLimitsPath` (test hook); **v1.0.11 — `getFreedomFsConfig()` + `ResolvedRuntimeLimits.fs` (the fail-closed freedom-node escape gate, read server-side on every freedom-node execution)** | fs |
| `environment.ts` | Virtual server fleet state machine: drift/crash/degrade/recover/restart, `getGlobalLiveState` | eventbus |
| `api-helpers.ts` | `ok()` / `fail()` ApiEnvelope responses, `readJson` | types |
| `docs.ts` | Docs loader: front-matter parse, SAFE_SLUG anti-traversal, `listDocs`/`readDoc` | filesystem `docs/` |
| `connection.ts` | Frontend Zustand store: 5-state connection machine, backoff policy (max 8 attempts, 1 s→10 s + jitter) | zustand, version |
| `client.ts` | Typed frontend API client: `apiFetch` envelope enforcement, `ApiClientError`, one helper per endpoint | types, api-contract |
| `main/nexool.ts` | Runtime singleton (globalThis-backed): `createTask`, `stopTask`, `pauseTask`/`resumeTask` (v1.0.6), `injectEvent`, task queries, active counts (incl. `paused`/`awaiting_approval`); **v1.0.14 — the priority ≤ 5 wake gate is REMOVED (every event wakes immediately), observable rejection without "Read & Act All Events" (queueingDisabled/actionRunning on the handle), event lifecycle records on injection, stop cancels pending events + alerts** | loop, eventbus, settings, environment |
| `main/loop.ts` | `runTask` entry; Goal Mode and Live Mode state machines; context bundle; parallel groups; **approval gate** (v1.0.6 `requestApprovalIfNeeded`/`executeWithApproval`; **v1.0.11 — resolves `resolveAutoExecution` and emits `tool.auto_execution` when a lower layer decides**); **live event queue** (v1.0.6 inbox + `state.eventQueue`, drop policy); **pause hold** (`waitWhilePaused`); repair passes; **v1.0.11 — pre-plan failure branch delegates to `main/recovery.ts` (the old single blind retry + hard stop is superseded)**; **v1.0.14 — event-driven Live Mode: `LiveTrigger` (initial/interval/event), initial cycle on startup, inbox drained before every wait, continuous `drainEventQueue` (failed events never deadlock — §32), stop cancels queued events (§31), full event body into `CONTEXT.trigger`**; finalize | planner, observer, coremodule, executor, registry, approval, recovery |
| `approval.ts` | v1.0.6 Tool Auto-Execution Approval; **v1.0.11 — the hierarchy resolver `resolveAutoExecution(global, tool, task)` → `{ enabled, source: 'global'|'tool'|'task'|'default' }` (global → tool → task precedence; `undefined` = inherit/never forces; a lower layer can NEVER override a higher enable; back-compat `resolveAutoExecute` delegates)**; pending-approval registry + 5-minute timeout (`tool.approval.*` + `tool.execution.blocked` events), `listPendingApprovals`/`resolveApproval` for the console, `cancelPendingApprovalsForTask` | eventbus, types |
| `main/planner.ts` | `buildPlan` — LLM decomposition (max steps = resolved `prePlanMaxSteps`, parallelGroup), deterministic 2-step fallback — the **pre-plan** strategy (semantics unchanged except the configurable cap) | z-ai-web-dev-sdk |
| `main/planner-strategy.ts` | **v1.0.10** — the **one-by-one** planner strategy: `resolvePlannerType` (task → global default → `pre-plan`), `buildOneByOneContext` (request, goal, mode, level, previous steps/subgoals, last 6 observations, latest tool result, counters, enabled tools, `knownFailures`, constraints, situational note), `planOneByOneStep` (ONE LLM call → exactly one step + events), `sanitizeOneStepResponse`/`sanitizeSingleStep` (single-step contract — a `{"steps":[…]}` response keeps the first valid step, `discarded` reports the rest), `buildOneByOneFallbackStep` (failure-aware / latest-observation-aware deterministic fallback) | z-ai-web-dev-sdk, types |
| `patterns/extractor.ts` | **v1.0.10** — deterministic pattern extraction over recorded executions (no LLM): sequence/verification/outcome/failure-recovery/live/early-completion patterns, `deriveConfidence` (`successRate × min(1, total/3) − 0.15 × contradictions`, floor 0), `patternsToDatasetExamples` (reliable single-action patterns → training examples at minConfidence 0.5); persisted as `PatternRecord` rows, read by `GET /api/patterns` | db, types |
| `main/recovery.ts` | **v1.0.11** — the PRE-PLAN FAILURE RECOVERY state machine (`RECOVERY_PLAN_MAX_STEPS = 4`): frozen main plan → recovery subgoal → recovery pre-plan (same `buildPlan` strategy) → sequential execution through the normal decide/execute/approval gates → Observer `assessRecovery` verification; state-aware resume (mark failed step completed with `resolved by recovery attempt N` OR re-queue it at its original position), per-failed-step attempt counting (Map on the task run), exhaustion/unrecoverable/blocked outcomes (`RECOVERY_EXHAUSTED`/`RECOVERY_UNRECOVERABLE`/`RECOVERY_BLOCKED`), the eight `planner.recovery_*`/`main_plan_*` events; one narrow host surface from `loop.ts` — no circular imports | eventbus, planner, observer, types |
| `main/observer.ts` | `interpret` (domain-aware observation strings) + `checkGoalComplete` (LLM verify, heuristic at L1–2); **v1.0.11 — `assessRecovery` verifies a recovery attempt (resolved / can-continue / recoverability verdict — the authority for resuming or aborting)** | z-ai-web-dev-sdk |
| `core/coremodule.ts` | `decide` — tool matching + parameter generation; validates output; allowed-tools filter; records latency metrics | z-ai-web-dev-sdk, heuristic, executor |
| `core/heuristic.ts` | Deterministic fallback matcher: token overlap scoring (threshold 0.18), typo normalization, naive param extraction | types |
| `tools/registry.ts` | `BUILTIN_TOOLS` (15 definitions), DB seeding, handler resolution, dynamic + js-function/nodejs registration (`registerJsTool`, `updateTool`, `deleteTool`), `HANDLER_KIND_INFO` (the real handler-kind registry incl. `http_get` config fields), metadata validation, `autoExecute` persistence (v1.0.6), stats | db, tools/* |
| `tools/js-runner.ts` | v1.0.2 `node:vm` sandbox for `js-function` tools: compile/validate, serializable-result enforcement (depth 12), capped log capture; v1.0.5 — sync cap enforced at function INVOCATION; v1.0.6 — common runtime APIs (policy fetch, XHR, alert/prompt, timers) and the NARROW require() (VFS modules only); v1.0.7 — the async deadline follows the EFFECTIVE execution timeout; v1.0.8 — `confirm()` joins the sandbox, dynamic `import()` works (URL via the policy-gated resolver + VFS), and ALL caps (sync/result/logs/source chars) resolve live from the central limits | node:vm, tools/sandbox-net, tools/sandbox-interactive, tools/import-resolver, config-limits |
| `tools/node-runner.ts` | v1.0.5 restricted Node.js environment for `nodejs` tools, expanded v1.0.6: module allowlist + blocked-module reasons, sandbox globals, dynamic-import transform, heap-growth sentinel, same result/log contracts as js-runner; v1.0.8 — `confirm()`, all execution caps (sync/heap/source/result/logs) resolve live from the central limits (`getLiveExecutionLimits`), the shared import transform moved to import-resolver.ts, child_process receives the execution network accounting (**v1.0.11 — NOT weakened; freedom-node runs on its own dedicated runner**) | node:vm, tools/js-runner, tools/sandbox-net, tools/vfs, tools/virtual-child-process, config-limits |
| `tools/freedom-node-runner.ts` | **v1.0.11** — the INTENTIONALLY UNRESTRICTED `freedom-node` environment (dedicated runtime path): real `require()`/`import()` (host builtins + npm packages), REAL host filesystem (never the VFS), real `fetch` with NO Network Policy caps, real `process`/`Buffer`; PRESERVED task lifecycle — execution deadline watchdog, vm sync cap, JSON result contract with the 5 MiB runtime transport cap, capped logs (`process.env` never auto-dumped); CONFIGURATION-ONLY GATE read on every execution (`fs.enabled`/`fs.restricted` via `getFreedomFsConfig()` — fail closed → `FREEDOM_DISABLED`); test runs route through the same runner + gate | node:vm, node:module, tools/js-runner, tools/import-resolver, tools/sandbox-interactive, config-limits |
| `tools/sandbox-net.ts` | THE controlled networking layer (`policyFetch`) used by fetch, XMLHttpRequest, virtual http/https, URL imports and npm in BOTH environments; `NetworkPolicyError` codes, real XHR class; v1.0.7 — `NetworkAccounting.requestTimeoutMs` carries the EFFECTIVE timeout; v1.0.8 — `getNetworkPolicy()` resolves the policy LIVE from the central limits (`network.timeoutMs` 60 s default, `maxResponseBytes` 5 MiB, `maxRedirects` 56, `maxRequestsPerExecution` 56, `allowUrlImports` true) — no hard-coded limits remain | node:stream, config-limits |
| `tools/sandbox-interactive.ts` | v1.0.6 async `alert()`/`prompt()` runtime functions: `tool.user_prompt.requested/.responded` events, pending-prompt registry (120 s timeout → null, deadline deferral), `listPendingPrompts`/`resolvePendingPrompt` for `/api/prompts`; **v1.0.14 — REWRITTEN to be INTERACTIVE in every mode: `alert()` is an OK dialog with its own pending registry (`listPendingAlerts`/`resolvePendingAlert` → `/api/alerts`, `tool.user_alert.dismissed`), `prompt()` accepts structured specs `{ message, type, placeholder?, defaultValue? }` with 14 input types (file → JSON `{ name, mimeType, size, content? }`), and NO auto-resolve in test mode (the Tool Editor test waits like production) plus `listPendingConfirmations/Choices` DTO extensions (inputType/placeholder)** | eventbus |
| `tools/sandbox-fs.ts` | v1.0.6 builds the sandbox `fs` surface from a `VirtualFsSession`: promise-first + `fs.promises` + `*Sync` + callback readFile/writeFile + the NexTool `fs.exists(path)`/`fs.usage()` extensions | tools/vfs |
| `tools/vfs.ts` | v1.0.6 Virtual File System (per-tool workspace on the `VirtualFile` table until v1.0.12; shared runtime-owned store since); decode-before-validate path safety (`VirtualFSAccessError`), node-shaped errors, limits resolved from the central config; **v1.0.14 (§24) — the root is the REAL host directory `VFS/` inside the project storage root: one-time automatic migration from legacy `data/vfs` on first VFS use (never deletes/overwrites, logged `[vfs] v1.0.14 migration`), lexical validation + per-component lstat walk + symlink refusal + realpath-pinned root unchanged** | fs |
| `tools/virtual-child-process.ts` | v1.0.6 RESTRICTED virtual `child_process`: 22 documented commands executed against the VFS workspace (no host process), shell-metacharacter rejection (exit 126) + unknown-command 127, `CHILD_PROCESS_LIMITS` (8 s / 64 KiB / 4 processes / 3 pipes / 32 args), exec/execSync/execFile/spawn/spawnSync | node:events, tools/vfs |
| `tools/import-resolver.ts` | v1.0.6 THE centralized import resolver for require()/import() in both environments: allowlist → virtual modules → VFS files (.js/.mjs/.json; CommonJS + conservative ESM transform `transformEsmExports`), URL imports policy-gated (disabled by default) | node:vm, tools/sandbox-net, tools/node-runner, tools/vfs |
| `tools/executor.ts` | Tool runtime: param coercion/validation, timeout + abort race, stats, history, events; `executeToolsParallel`; v1.0.3 `executeParallelBatch` (capped waves, batch provenance) | registry, handler |
| `tools/handler.ts` | `ToolHandler` type, `HandlerContext`, `ToolFailure` error class | types |
| `tools/builtin.ts` | Real handlers: system.info, math.evaluate (safe parser), text.analyze, time.now, uuid.generate, echo.echo, delay.wait | node:os, node:crypto |
| `tools/virtual.ts` | server.list / server.health / server.restart / service.restart against the virtual fleet | environment |
| `tools/memory.ts` | memory.store (upsert) / memory.recall (exact + fuzzy top-5) | db |
| `tools/notify.ts` | notification.send — persists NotificationRecord, emits `notification.sent` | db, eventbus |
| `tools/image.ts` | image.generate — z-ai SDK, prompt enrichment, writes PNG to `public/generated` | z-ai-web-dev-sdk, db |
| `training/engine.ts` | v1.0.2 REAL TF.js trainer: hashed bag-of-words vectorization, dense classifier, per-epoch persistence, checkpoint registration; **v1.0.10 — best-validation-accuracy checkpoint selection (weights snapshotted + restored before saving, `checkpointSelection` in the manifest), MANUAL early stopping on `val_loss` (the tf.js `EarlyStopping` callback is broken in this build), unique per-job model/layer names + dispose-on-failure (fixes `Variable with name dense_Dense1/kernel was already registered` poisoning later jobs), optional semver-validated `modelVersion` config (default `TRAINED_MODEL_VERSION` 1.0.1; `modelSemanticVersion` + legacy `tc-<job>` `checkpointId` in the manifest)** | @tensorflow/tfjs, db |
| `training/benchmark.ts` | v1.0.2 REAL benchmark engine: runs llm-core / heuristic-fallback / a trained classifier per example, computes metrics, persists per-case results | @tensorflow/tfjs, core, db |
| `training/model-package.ts` | v1.0.2 packaging: export tfjs zip / `.nextool` package, import + TFJS load-validation, 25 MiB cap, traversal-safe unzip | fflate, @tensorflow/tfjs, db |
| `datasets/parquet.ts` | v1.0.3 Parquet dataset adapter: `encodeParquetDataset` / `decodeParquetDataset` (one flat row per example, per-row validation with row index), `parquetAdapterInfo()` honest capability probe (cached once per process) | @dsnp/parquetjs 1.8.9 |
| `stream/sse.ts` | `buildEventStream` — hello frame, replay from in-memory recent events, live push, 15 s keepalive | eventbus |

## src/app — routes

- `page.tsx` + `layout.tsx` + `globals.css` — the only user-visible route (`/`) and the
  blue-gradient glassmorphism theme.
- `api/**/route.ts` — endpoints grouped as `system`, `state`, `env/event`, `stream`,
  `tasks` (+ `[id]/{stop,event,events,feedback,context,executions,pause,resume}` —
  pause/resume are v1.0.6), `approvals` (v1.0.6 — GET/POST pending tool approvals),
  `prompts` (v1.0.6 — GET/POST pending tool prompts), `tools`
  (+ `register`, `js`, `test` (v1.0.5 — the dedicated test route, restored),
  `environments` (v1.0.5 capability payload, expanded v1.0.6 with network/vfs/
  childProcess/capabilities), `[name]` (GET/PUT/DELETE),
  `[name]/toggle`), `memory`,
  `history`, `notifications` (+ `read-all`), `images`, `models` (+ `load`, `export`,
  `import`), `datasets` (+ `import`, `[id]`, `[id]/export`), `training` (+ `[id]`),
  `benchmark` (+ `[id]`), `icons`, `settings` (+ `reset` — v1.0.7 typed-phrase
  application data reset), `patterns` (**v1.0.10** — `GET /api/patterns` pattern store:
  list + stats, `?type=`, `?minConfidence=`, `?format=examples&minConfidence=0.5`),
  `maintenance` (`cleanup` — v1.0.7 dependency-aware
  model/dataset cleanup; `validate` — v1.0.7 runtime dependency validation),
  `docs` (+ `[slug]`), plus the scaffold `api/route.ts` hello-world.
  Every route is `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  See [API](../api/api.md).

## src/components/console — the SPA

| File | Contents |
| --- | --- |
| `console-app.tsx` | Shell: header (brand, RuntimeConnectionStatus, bell), glass sidebar, mobile bottom nav + More sheet, status bar, view switching with AnimatePresence; v1.0.4 renders the real `BrandLogo` in the brand button + sheet headers, and remounts the Tool IDE route per session (`key=toolEditorKey`) so editor state always re-initializes. |
| `console-store.ts` | Zustand: `activeView` (20 views incl. `tool-editor`, `connectors`, `inspector`, and the v1.0.14 `limitations` + `assistant`), `selectedTaskId`, `openTaskPreview`, `openToolEditor` / `closeToolEditor`. |
| `providers.tsx` | `SystemStatsProvider` (5 s poll), `GlobalStreamProvider` (one SSE, 15 min replay), `NotificationsProvider` (10 s poll). |
| `runtime-connection-status.tsx` | Accessible connection pill + details popover (5 states, retry countdown, reconnect button). |
| `ui-bits.tsx` | StatusChip, SourceDot, TypeChip, EventRow, JsonBlock, MetricCard, EmptyState, ErrorCard, formatters — plus `deriveTaskRuntime` / `terminalStatusLine` / `deriveChecklist` (v1.0.2 status + checklist derivation, one source of truth). |
| `json-tree.tsx` + `json-theme.ts` | v1.0.2 ONE consistent JSON tree viewer (@uiw/react-json-view, expand depth 2, copy, wrapped long strings). v1.0.4: theme rewritten with the library's real `--w-rjv-*` tokens (the old `--json-tree-*` names were ignored → near-black default colors). |
| `brand-logo.tsx` | v1.0.4 product identity: `BrandLogo` + `useBrandLogoUrl` — the real NexTool logo from the active icon package (module-level cache; `apple-touch-icon.png` → `icon-192` → `icon-512` → `icon-32` → `icon-16` preference), plain "N" monogram fallback. |
| `task-checklist.tsx` | v1.0.2 Live Mode checklist/timeline (Aceternity-style): `[✓] [-] [ ] [!] [~]` states from the real plan/events, percent only when meaningful. v1.0.4: the vertical timeline rail was removed — clean checklist/card rows, states and animations unchanged. |
| `terminal.tsx` | Runtime terminal surface — v1.0.2: dynamic status line from `deriveTaskRuntime` (no hardcoded prompt), real event lines, blinking cursor only while a tool runs. |
| `server-card.tsx` | Fleet card with CPU/memory bars and Crash/Degraded/Recover injections. |
| `views/*.tsx` | dashboard, task-console, task-preview, live-monitor, tools, tool-editor, memory, live-state, events, history, models, datasets, training, benchmark, docs, settings. |

## docs/ — this documentation system

Markdown files with `title`/`category`/`order` front-matter, read by `docs.ts` and served
through `/api/docs` and `/api/docs/[slug]`, rendered by the built-in **Documentation**
view. Slugs are filenames; only `[a-z0-9-]` slugs pass the safety check.
