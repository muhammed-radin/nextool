---
title: Configuration
category: Getting Started
order: 3
---

# Configuration

NexTool has three configuration surfaces:

1. **Central configuration limits** — **v1.0.8**: `config/configuration-limits.json` is the
   ONE authoritative file defining the type, default, min, max, unit and nullability of
   every configurable limit in the application. A self-hosted administrator customizes
   limits by editing this single JSON file — never TypeScript source (see
   [Central configuration limits (v1.0.8)](#central-configuration-limits-v108)).
2. **Global settings** — one JSON row in the `Setting` table (key `nextool`), editable in
   the **Settings** view or via `GET/PUT /api/settings`, with a 10-second in-memory cache
   (`settings.ts`). Defaults AND clamps derive from the central limits.
3. **Per-task config** — a `TaskConfig` supplied at creation, clamped against the global
   settings and the central limits (`nexool.ts` createTask, `loop.ts` mergeConfig).

## Global settings (NexToolSetting)

Defaults live in `src/lib/nexool/settings.ts` (`DEFAULT_SETTINGS`). Ranges below are the
clamp ranges enforced by `updateSettings`.

| Field | Type | Default | Min | Max | Meaning |
| --- | --- | --- | --- | --- | --- |
| `defaultMode` | `'goal' \| 'live'` | `goal` | — | — | Mode used when a task does not specify one. Invalid values fall back to `goal`. |
| `defaultPlannerType` | `'pre-plan' \| 'one-by-one'` | `pre-plan` | — | — | **v1.0.10**: default planner strategy for tasks that do not override it. Resolved AND persisted into the task's config at creation (later Settings changes never switch an existing task). Invalid values fall back to `pre-plan`. |
| `prePlanMaxSteps` | number | `10` | 1 | 122 | **v1.0.10**: maximum steps the pre-plan planner may generate (replaces the old hard-coded 8). Governed by the central limit `task.prePlanMaxSteps`; used by the pre-plan strategy only. |
| `recoveryMaxAttempts` | number | `4` | 2 | 4 | **v1.0.11**: maximum recovery attempts per failed pre-plan step (one attempt = observe → recovery subgoal → recovery pre-plan → execute → verify). Governed by the central limit `task.recoveryMaxAttempts` (range 2–4). Shown in Settings → **Planning**. |
| `defaultReasoningLevel` | `1..6` | `4` | 1 | 6 | Default L1–L6 reasoning level. |
| `maxSubtoolCalls` | number | `20` | 1 | 200 | Cap on tool calls per parallel group slice / subtool auto-execution. |
| `safetyLimit` | number | `100` | 1 | 500 | Hard cap on total tool calls per task. |
| `maxIterations` | number | `30` | 1 | 200 | Max main-loop iterations (Goal Mode). |
| `taskTimeoutMs` | number (ms) | `120000` | 5000 | 3600000 | Wall-clock budget for a task (per live cycle in Live Mode). |
| `toolTimeoutMs` | number (ms) | `10000` | 1000 | 3600000 | **v1.0.7**: default tool-execution timeout — 10 seconds, configurable up to **1 hour**. A tool's own `timeoutMs` overrides it per tool; the runtime caps everything at 3600000 ms. See [Tool execution timeout](#tool-execution-timeout-v107). |
| `liveIntervalMs` | number (ms) | `60000` | 1000 | 3600000 | Scheduled tick interval for Live Mode. |
| `parallelToolCalls` | boolean | `true` | — | — | v1.0.3: runtime default for concurrent execution of independent tool calls (task config overrides). |
| `maxParallelToolCalls` | number | `4` | 1 | 8 | v1.0.3: hard cap on concurrently executing tool calls (waves handle the rest). |
| `autoExecuteTools` | boolean | `false` | — | — | v1.0.6: global auto-execution override — **v1.0.11: the top of the hierarchy ("Global — Highest priority")**. `true` → every tool in every task executes without approval (no lower layer can override it). `false` (default) → the per-tool `autoExecute` config wins over the per-task console preference (see the hierarchy below). |
| `allowMultipleEvents` | boolean | `false` | — | — | v1.0.6: multi-event live processing ("Read & Act All Events"). `true` → events arriving while busy/paused/waiting are queued (max 50) and processed one-by-one (priority → arrival). `false` (default) = v1.0.5 single-event behavior. |
| `useMemory` | boolean | `true` | — | — | Whether the context bundle loads persistent memory entries. |
| `logLevel` | `'info' \| 'debug' \| 'error'` | `info` | — | — | Coarse log level; invalid values revert to `info`. |
| `realTimeTransport` | `'sse'` | `sse` | — | — | Locked to `sse`. A WebSocket adapter is **not installed** in this environment; the Settings UI shows it as locked with a note. |

Non-numeric invalid inputs are replaced by the range minimum (`clampNum`); values are
rounded to integers. Settings are served fresh via `GET /api/settings`
(`getSettings(true)` bypasses the cache) and cached for 10 s elsewhere.

### Reading and writing

```bash
curl http://localhost:3000/api/settings

curl -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"maxIterations":50,"liveIntervalMs":20000}'
```

### Parallel tool calls (v1.0.3)

Two fields control whether truly independent tool calls execute concurrently:

| Field | Where | Default | Notes |
| --- | --- | --- | --- |
| `parallelToolCalls` | runtime settings + per-task config | `true` | When `false`, the parallel branch is skipped entirely — execution is strictly sequential. |
| `maxParallelToolCalls` | runtime settings + per-task config | `4` | Integer 1–8 (clamped). Hard cap on concurrency — no unlimited parallelism. |

Where to configure:

- **Per task** — `config.parallelToolCalls` / `config.maxParallelToolCalls` in
  `POST /api/tasks` (zod-validated: `maxParallelToolCalls` int 1–8). Task-level values
  override the runtime defaults; unset fields fall back to the settings.
- **Task Console UI** — "Parallel tool calls" toggle + "Max parallel calls" number
  field in the *Execution limits* group (per task).
- **Settings UI** — "Parallel tool calls by default" + "Max parallel calls" under the
  runtime defaults (persisted via `PUT /api/settings`, which accepts both fields).

Example task config:

```json
{"mode":"goal","enabledTools":["server.health","server.restart"],"parallelToolCalls":true,"maxParallelToolCalls":4}
```

The tool-selection rule is defense in depth (v1.0.4): the Task Console blocks the submit
with *"Select at least one tool before running the task."* when nothing is selected and
always sends `config.enabledTools: [...selectedTools]`; `taskConfigSchema.enabledTools`
is `.min(1)`; and `POST /api/tasks` re-checks the merged config (`TOOLS_REQUIRED`).

Semantics live in [Planner](planner.md) (group batching) and
[Tool Runtime](../tools/tool-runtime.md) (`executeParallelBatch`: waves, caps, failure
isolation).

### Tool auto-execution approval (v1.0.6, hierarchy redefined in v1.0.11)

One centralized resolver decides whether a task-driven tool execution runs immediately
or waits for an Allow/Deny decision — **v1.0.11 replaces the old boolean-merging
precedence with an explicit hierarchy** (`resolveAutoExecution` in
`src/lib/nexool/approval.ts`; see
[Tool Runtime](../tools/tool-runtime.md#the-approval-gate-v106)):

```
1. GLOBAL auto-execution (Settings autoExecuteTools)  — highest priority
     ↓ global === true → ON (source: 'global') — nothing below can override it
2. TOOL auto-execution (ToolDefinition.autoExecute, tri-state in the IDE)
     ↓ tool === true → ON (source: 'tool') — wins over the task console
3. TASK CONSOLE preference (config.autoExecuteTools)   — lowest priority
     ↓ task === true → ON (source: 'task')
4. otherwise → OFF (source: 'default') → APPROVAL REQUIRED
```

- `undefined` means **inherit / never forces** — a layer without a value never decides;
  a lower layer can NEVER override a higher-priority enable. Test matrix: global ON +
  tool OFF + task OFF → ON (global); global ON + tool ON + task OFF → ON (global);
  global OFF + tool ON + task OFF → ON (tool); global OFF + tool OFF + task ON → ON
  (task); all OFF → OFF (default). The back-compat `resolveAutoExecute` delegates to it.
- **The effective source is observable**: when a lower layer decides, the runtime emits
  `tool.auto_execution` with `{ tool, enabled, source }`; the Tool IDE shows an
  "Effective auto-execution:" display (e.g. `GLOBAL ENABLED — this setting cannot
  override the global switch`). The approval flow itself
  (`tool.approval.required/allowed/denied/timeout` → `tool.execution.blocked`) is
  unchanged.

Where to configure:

- **Global (highest priority)** — Settings switch **"Auto-Execute Tools"**, labeled
  **"Global — Highest priority"** since v1.0.11 (or `PUT /api/settings` with
  `autoExecuteTools`).
- **Per tool** — the `autoExecute` field on the ToolDefinition, now a **tri-state**
  **Auto-execution** select in the Tool IDE (Enabled / Disabled / **Inherit** — stored
  as `boolean | undefined`, where `undefined` = inherit), via `POST /api/tools/js` or
  `PUT /api/tools/{name}`. Persists with the tool and round-trips export/import.
- **Per task (lowest priority)** — `config.autoExecuteTools` in `POST /api/tasks`; the
  Task Console renders the per-task **Auto-Execute Tools** switch labeled **"Task —
  lowest priority"** and shows "Controlled by global auto-execution setting — this task
  preference cannot override it." whenever the global switch is ON.

While an approval is pending the task status is `awaiting_approval`; the decision UIs
are the pending-approval cards in Task Preview / Live Monitor (`GET/POST /api/approvals`).
A 5-minute timeout **stops the task** — nothing ever silently executes.

### Multi-event live processing (v1.0.6)

The global setting `allowMultipleEvents` (Settings: **"Allow Multiple Events at Same
Time"**; user-facing label elsewhere: **"Read & Act All Events"**) and the per-task
`config.allowMultipleEvents` toggle enable the live event queue: events arriving while
a live task is busy/paused/waiting are queued (max 50, 16 KiB payload cap, lowest
priority dropped first when full) and processed one-by-one ordered by priority then
arrival. Default `false` preserves the v1.0.5 single-event behavior. See
[Live Mode](../modes/live-mode.md#multi-event-mode--read--act-all-events-v106).

### Planner configuration (v1.0.10)

Every task runs exactly ONE planner strategy: `pre-plan` (the classic multi-step
forward plan) or the new `one-by-one` (plans exactly one next step per call from the
latest state — semantics in [Planner](planner.md#planner-modes-v1010)).

- **Global** — Settings → new **Planning** section: "Default planner" select
  (`defaultPlannerType`, default `pre-plan`) and "Pre-plan max steps"
  (`prePlanMaxSteps`, default 10, 1–122). Both persist via `PUT /api/settings`, which
  validates them from the central limits (zod enum for the planner type, integer limit
  for the max steps).
- **Per task** — `config.plannerType` + `config.prePlanMaxSteps` in `POST /api/tasks`
  (Task Console: planner select + max-steps input, the latter shown for the pre-plan
  strategy only; one-by-one shows an honest "no pre-generated step list" note instead).
  Resolution precedence: **task → global default → `'pre-plan'`**.
- **Creation-time persistence** — the resolved `plannerType` and `prePlanMaxSteps` are
  written into the task's stored config JSON at creation. Later Settings changes affect
  new tasks only — an existing task never switches strategy mid-flight.
- **Server-side validation** — an invalid `plannerType` or an out-of-range
  `prePlanMaxSteps` is rejected by `POST /api/tasks` (400 `INVALID_REQUEST`, e.g.
  `"expected number to be <=122"`); see [API](api.md#post-apitasks). Old tasks/configs
  without the fields keep working unchanged (backward compatible).

### Recovery configuration (v1.0.11)

A failed pre-plan step is RECOVERED (not blind-retried once and hard-stopped) — the
attempt budget is configurable, never hard-coded:

- **Central limit** — `task.recoveryMaxAttempts`: integer, **default 4, min 2, max 4**.
  One attempt = observe failure → recovery subgoal → recovery pre-plan → execute →
  verify (see [Planner](planner.md#pre-plan-failure-recovery-v1011)).
- **Global** — Settings → **Planning** section: "Recovery attempts per failed step"
  (`recoveryMaxAttempts`, min/max derived from the central limit like every other
  numeric field), persisted via `PUT /api/settings`.
- **Per task** — `config.recoveryMaxAttempts` in `POST /api/tasks`. Out-of-range values
  are **rejected with 400 `INVALID_REQUEST`** (zod, same contract as
  `prePlanMaxSteps`) — never silently clamped at the route boundary.
- Applies to **pre-plan goal tasks only**; one-by-one tasks already replan and
  Live-Mode repair passes are unchanged.

## Per-task config (TaskConfig)

Sent as `config` in `POST /api/tasks` (or `body.config`). `mode` is used **exactly as
provided** — it defaults to `settings.defaultMode` but is never auto-switched to `live`.

| Field | Type | Default source | Clamp / notes |
| --- | --- | --- | --- |
| `name` | string? | — | Optional display name. |
| `mode` | `'goal' \| 'live'` | `settings.defaultMode` | Other values are deleted at creation; Live Mode is explicit opt-in. |
| `reasoningLevel` | `1..6` | `settings.defaultReasoningLevel` | 1–6. |
| `enabledTools` | string[] | — | **v1.0.4: required, non-empty at creation** — `POST /api/tasks` rejects a missing or empty list (400 `TOOLS_REQUIRED`; the zod schema also rejects `[]` with `INVALID_REQUEST`). Otherwise an allow-list of enabled tool names. |
| `useMemory` | boolean | `settings.useMemory` | Enables memory in the context bundle. |
| `learnFrom` | `{feedback?, results?}` | both `true` | `feedback: true` stores user feedback into memory (key `feedback_<taskId>`). |
| `autoExecuteSubtools` | boolean | `true` | Enables parallel group execution. |
| `maxSubtoolCalls` | number | `settings.maxSubtoolCalls` | 1–200, additionally capped by `safetyLimit`. |
| `safetyLimit` | number | `settings.safetyLimit` | 1–500. |
| `maxIterations` | number | `settings.maxIterations` | 1–200. |
| `taskTimeoutMs` | number | `settings.taskTimeoutMs` | 5000–3600000. |
| `toolTimeoutMs` | number | `settings.toolTimeoutMs` | v1.0.7: 1000–3600000 (task-level default; a tool's own `timeoutMs` still overrides it). |
| `liveIntervalMs` | number | `settings.liveIntervalMs` | 1000–3600000. |
| `parallelToolCalls` | boolean | `settings.parallelToolCalls` | v1.0.3: `false` forces strictly sequential execution. |
| `maxParallelToolCalls` | number | `settings.maxParallelToolCalls` | v1.0.3: clamped 1–8 at merge time. |
| `autoExecuteTools` | boolean | `false` | v1.0.6: per-task auto-execution preference — **v1.0.11: the LOWEST layer of the hierarchy**; a `true` here enables auto-execution only when neither the global switch nor the tool config did. |
| `allowMultipleEvents` | boolean | `settings.allowMultipleEvents` (default `false`) | v1.0.6: enables the multi-event live queue for this task ("Read & Act All Events"). |
| `plannerType` | `'pre-plan' \| 'one-by-one'` | `settings.defaultPlannerType` (then `'pre-plan'`) | **v1.0.10**: planner strategy override for this task. Resolved AND persisted in the stored config JSON at creation — later Settings changes never switch an existing task. |
| `prePlanMaxSteps` | number | `settings.prePlanMaxSteps` (default 10) | **v1.0.10**: max steps for the pre-plan planner (1–122, central limit `task.prePlanMaxSteps`); governs the pre-plan strategy only. Persisted with the task config at creation. |
| `recoveryMaxAttempts` | number | `settings.recoveryMaxAttempts` (default 4) | **v1.0.11**: recovery attempt budget per failed pre-plan step (2–4, central limit `task.recoveryMaxAttempts`; out-of-range values rejected with 400). Pre-plan tasks only. |
| `continuationOfTaskId` | `task_*` | — | **v1.1.0**: Continue Task — the new task starts with a bounded prior-context block built from the source task (per `contextOptions`); emits `task.context_seeded`; the source is never mutated. Persisted with the task config. |
| `forkedFromTaskId` | `task_*` | — | **v1.1.0**: fork-from-recent — the same seeding mechanism, chosen in the Task Console; old tool calls are never replayed automatically. |
| `contextOptions` | `{result?, plan?, executions?, memory?, skills?}` | result/executions/skills on, plan/memory off | **v1.1.0**: which context classes the prior-task block includes (booleans default on unless explicitly `false` for result/executions/skills; plan and memory are opt-in). |
| `skills` | string[] (≤ 12) | — | **v1.1.0**: manual skill selection — validated against the registry at run time; disabled/invalid names are excluded with an explanation in `skills.selected`. More than 12 names → 400. |
| `skillsMode` | `'auto' \| 'manual' \| 'auto+manual'` | `auto` | **v1.1.0**: skill selection mode. |
| `executeAllPlannedSteps` | boolean | `false` | **v1.1.0**: pre-plan only — after goal verification the remaining planned steps still execute (`planner.execute_all_continue`); stop/approvals/safety limits stay enforced. |
| `sessionId` | string? | — | Free-form session correlation. |
| `context` | object? | — | Arbitrary initial context. |

If `maxSubtoolCalls > safetyLimit`, creation clamps it down to `safetyLimit`.
`maxParallelToolCalls` is clamped to 1–8 when the config is merged at loop start
(`loop.ts` `mergeConfig`) — beyond the cap, calls run in later waves, never wider.

## Where limits bite (runtime behavior)

- **Goal Mode** loop: stops with `limit_reached` when `iterationCount ≥ maxIterations` or
  `toolCallCount ≥ safetyLimit`; stops with `TIMEOUT` when the task exceeds
  `taskTimeoutMs`.
- **Live Mode**: each wake/scheduled cycle is bounded by `taskTimeoutMs` (per-cycle
  deadline); the scheduled tick fires every `liveIntervalMs`.
- **Tool executions**: default `toolTimeoutMs` = 10 s; a tool's own `timeoutMs`
  overrides it; the executor hard-caps every value at **1 hour** (3600000 ms).
  Failures get exactly one retry in Goal Mode. See the section below.

## Central configuration limits (v1.0.8)

**File:** `config/configuration-limits.json` — the single source of truth.

**Loader:** `src/lib/nexool/config-limits.ts`:

```text
configuration-limits.json
        ↓
Limit Loader (fs read + mtime cache, ≤2 s revalidation)
        ↓
Limit Validator (schema, types, nullable, min ≤ default ≤ max)
        ↓
Typed Resolved Limits  ──→  Settings · Backend (schemas) · Runtime
        ↓                                     ↓             ↓
   Settings UI (GET /api/config/limits)   zod bounds   network/VFS/execution/childProcess
```

### Purpose

- Every configurable property carries metadata: `type` (integer | number | boolean |
  string | enum), `nullable`, `default`, `min`, `max`, `unit`, `description`, and optional
  `step` / `enum` / `category`.
- **Self-hosting:** change a limit by editing the JSON and restarting NexTool — no source
  modification, no rebuild. The shipped file ships `execution.timeoutMs.max = 3600000`
  (1 hour); an administrator may raise it there and every layer follows.
- **Startup validation (§7.7/§7.8):** `min <= default <= max` is validated for every
  numeric property. Invalid JSON, an invalid type, `default > max`, `default < min` or a
  broken nullable configuration FAIL CLEARLY (`ConfigurationLimitsError` naming the
  property) — the application never silently falls back to hard-coded values.
- **Reload (§12):** the loader caches by mtime (re-checked at most every 2 s) and a
  restart always re-reads the file. No rebuild is required.
- **Security boundary (§7.10):** the limits file controls the application's configured
  limits only. Raising a timeout or a VFS size never grants host filesystem, host process
  or sandbox-escape privileges — those boundaries are not configurable.

### Shipped values (defaults, and the maximum allowed by the SHIPPED configuration)

### Network (network.*)

| Property | Default | Shipped max | Unit | Meaning |
| --- | --- | --- | --- | --- |
| `timeoutMs` | 60000 | 3600000 | ms | Per-request timeout for fetch/XHR/http(s)/URL imports/npm (60 seconds). The per-execution request timeout follows the tool execution timeout. |
| `maxResponseBytes` | 5242880 (5 MiB) | 734003200 | bytes | Maximum response body (fetch, XHR, http(s), URL-imported modules, npm tarballs). |
| `maxRedirects` | 56 | 56 | count | Maximum redirect hops; every hop re-validated. |
| `maxRequestsPerExecution` | 56 | 56 | count | Requests per tool execution — counts fetch, XHR, http(s), URL imports and npm registry/tarball downloads. |
| `allowUrlImports` | true | — | boolean | Enable dynamic `import()` of http(s) URLs (v1.0.8). Set `false` to disable without code changes. |
| `selfOriginAccess` | true | — | boolean | Allow tool functions to call the NexTool application itself (v1.0.91): relative fetch URLs such as `/api/tools/test` resolve against the application origin; requests to that exact origin skip ONLY the local-host block — every other policy limit still applies and all other local/private hosts stay blocked. |

### Virtual FS (vfs.*)

| Property | Default | Shipped max | Unit | Meaning |
| --- | --- | --- | --- | --- |
| `maxFileBytes` | 2097152 (2 MiB) | 734003200 | bytes | Maximum size of ONE file (also caps single reads/writes). Lowering it never corrupts or deletes existing files — new violating operations fail clearly. |
| `maxTotalBytes` | 734003200 (700 MiB) | 734003200 | bytes | Maximum total workspace size per tool. |
| `maxEntries` | 4000 | 50000 | count | Maximum stored entries (files + directories) per workspace. |
| `maxDepth` | 56 | 128 | levels | Maximum directory nesting depth. |
| `maxPathLength` | 512 | 4096 | chars | Maximum normalized virtual path length. |

### Filesystem freedom gate (fs.* — v1.0.11, freedom-node only)

| Property | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | Authorizes the **freedom-node** environment's unrestricted host capabilities (real filesystem, real network, real processes, `process.env`). **Configuration-file ONLY**: the Settings UI deliberately exposes no control for this switch. Fail closed — when `false` (or the file is unreadable) every freedom-node execution is rejected with `FREEDOM_DISABLED` and nothing runs. |
| `restricted` | false | `false` (default) = freedom-node uses the REAL host filesystem and is never redirected into the restricted tool VFS; `true` would re-enable restrictions for freedom-node. |

**`fs.*` vs `vfs.*` are separate on purpose**: `vfs.*` governs the restricted Virtual
File System used by `js-function`/`nodejs` tools (unchanged); `fs.*` governs ONLY the
unrestricted freedom-node mode. The gate is read server-side on every freedom-node
execution (`getFreedomFsConfig()` in `config-limits.ts`); no API route and no Settings
field can flip it — editing this file on the host is the only way. See
[Tool Development](tool-development.md#the-freedom-node-environment--intentionally-unrestricted-v1011)
and [Security](security.md#freedom-node-threat-model-v1011).

### Execution (execution.*)

| Property | Default | Shipped max | Unit | Meaning |
| --- | --- | --- | --- | --- |
| `timeoutMs` | 10000 | 3600000 | ms | Tool execution timeout — the hard runtime ceiling (shipped 1 h). |
| `syncTimeoutMs` | 4000 | 1800000 | ms | Synchronous (non-awaiting) execution cap inside the sandbox (30 min max). |
| `heapSentinelBytes` | 268435456 (256 MiB) | 763363328 (728 MiB) | bytes | Heap-GROWTH sentinel for nodejs tools. This is a monitor, not an OS memory limit: it aborts the tool result when observed growth exceeds the value. |
| `maxSourceChars` | 64000 | 200000 | chars | Maximum tool function source length (js-function and nodejs). |
| `maxResultBytes` | 65536 (64 KiB) | 1048576 | bytes | Maximum serialized JSON result size. |
| `maxLogs` | 100 | 1000 | lines | Maximum captured console log lines per execution. |
| `maxLogLineChars` | 2000 | 8000 | chars | Maximum characters of one log line. |

### Child process (childProcess.*)

| Property | Default | Shipped max | Unit | Meaning |
| --- | --- | --- | --- | --- |
| `timeoutMs` | 8000 | 3600000 | ms | Default per-command ceiling; the effective tool execution timeout RAISES it (never shorter). |
| `maxOutputBytes` | 65536 | 1048576 | bytes | Maximum combined stdout+stderr of one virtual command. |
| `maxProcessesPerExecution` | 64 | 512 | count | Virtual command invocations per execution (raised from 4 in v1.0.8 for realistic multi-command workflows). |
| `maxPipeStages` | 3 | 16 | count | Maximum pipe stages per command line. |
| `maxArgs` | 32 | 512 | count | Maximum arguments per stage. |
| `npmMaxPackages` | 25 | 200 | count | Packages (incl. transitive deps) per virtual npm install. |

### Task (task.*)

`maxIterations` 30 (1–200) · `maxSubtoolCalls` 20 (1–200) · `safetyLimit` 100 (1–500) ·
`taskTimeoutMs` 120000 (5000–3600000 ms) · `toolTimeoutMs` 10000 (1000–3600000 ms) ·
`liveIntervalMs` 60000 (1000–3600000 ms) · `maxParallelToolCalls` 4 (1–8) ·
`eventQueueCap` 50 (1–500) · **v1.0.10** `task.prePlanMaxSteps` — integer, default 10,
min 1, max **122** (the single source of truth for the pre-plan planner's step cap;
replaces the old hard-coded 8) · **v1.0.11** `task.recoveryMaxAttempts` — integer,
default **4**, allowed range **2–4** (the recovery attempt budget per failed pre-plan
step; out-of-range API values are rejected, not clamped).

These bound both the Settings defaults and per-task configuration values —
`updateSettings` clamps with them, the zod schemas validate with them and
`loop.ts` merges task config with them.

### v1.1.0 sections — coreModule · planner · terminal · vfsTerminal · skills · events · continuity

v1.1.0 centralizes the remaining application caps (previously hard-coded or missing):

| Property | Default | Range | Nullable (`null` =) |
| --- | --- | --- | --- |
| `coreModule.llmTimeoutMs` | 300 000 ms (5 min) | 1 000–3 600 000 | **unlimited** — no application-level CoreModule deadline (replaces the removed 25 s `CORE_TIMEOUT_MS`) |
| `coreModule.liveOutputBufferBytes` | 65 536 | 4 096–1 048 576 | — (Live Output replay-window cap) |
| `planner.llmTimeoutMs` | 60 000 ms | 1 000–3 600 000 | unlimited (replaces the removed 25 s `PLANNER_TIMEOUT_MS`) |
| `planner.verifyTimeoutMs` | 6 000 ms | 500–3 600 000 | unlimited (replaces the removed 6 s `VERIFY_TIMEOUT_MS`; expiry falls back to the deterministic heuristic) |
| `planner.recoveryMaxPlanSteps` | 4 | 1–16 | — (recovery pre-plan step cap) |
| `terminal.maxSessions` | 4 | 1–16 | — |
| `terminal.execTimeoutMs` | 300 000 ms | 1 000–3 600 000 | commands run until they exit or are interrupted |
| `terminal.maxOutputBytes` | 1 048 576 | 65 536–33 554 432 | — |
| `terminal.historyLimit` | 100 | 10–1 000 | — |
| `vfsTerminal.allowedCommands` | the 13 implemented commands | array of strings | **every IMPLEMENTED VFS-shell command is permitted** (enforced SERVER-SIDE; an array = exactly those commands — it is a cap for the shell UX, never a path out of the VFS) |
| `skills.maxLoadedPerTask` | 4 | 0–12 (0 disables loading) | — |
| `skills.maxInstructionChars` | 6 000 | 500–100 000 | — |
| `skills.maxResourceBytes` | 262 144 | 1 024–10 485 760 | — |
| `skills.maxZipBytes` | 8 388 608 | 10 240–52 428 800 | — |
| `events.recentRingSize` | 500 | 50–5 000 | — |
| `events.maxDataBytes` | 16 384 | 1 024–1 048 576 | — |
| `continuity.maxContextChars` | 12 000 | 2 000–200 000 | — (prior-task context block cap) |
| `continuity.maxExecutionRows` | 12 | 0–100 | — |
| `continuity.maxObservations` | 8 | 0–50 | — |

Loader notes: `config-limits.ts` gained the `'array'` property type (with `items`),
nullable numeric validation and a string-array resolver — **a `null` default requires
`nullable: true`**, otherwise startup validation fails with a
`ConfigurationLimitsError` naming the property. Nullable numerics and the nullable
array are the ONLY values the ⚠ Complete Unrestricted preset sets to `null`
(genuinely unlimited); non-nullable values go to their shipped maximums.

### Which timeout governs which operation (§14 — intentionally separate)

| Timeout | Property | Governs |
| --- | --- | --- |
| Tool execution | `execution.timeoutMs` (default; tools may set their own `timeoutMs`) | The whole tool execution. |
| Task | `task.taskTimeoutMs` | The whole task. |
| Network request | `network.timeoutMs` | ONE network request (fetch/XHR/http(s)/URL import/npm). |
| Child command | `childProcess.timeoutMs` | ONE virtual command; raised by the effective tool execution timeout. |
| CoreModule decision | `coreModule.llmTimeoutMs` (**v1.1.0**; nullable = unlimited) | ONE CoreModule LLM decision call (plus one stricter re-ask); reported in the `coreTimeoutMs` diagnostics. |
| Planner call | `planner.llmTimeoutMs` (**v1.1.0**; nullable = unlimited) | ONE Planner LLM call (pre-plan, one-by-one step, subgoal proposal) — separate from the CoreModule deadline on purpose. |
| Goal verification | `planner.verifyTimeoutMs` (**v1.1.0**; nullable = unlimited) | The verification LLM call (`checkGoalComplete`, `assessRecovery`); expiry falls back to the deterministic heuristic. |
| Terminal command | `terminal.execTimeoutMs` (**v1.1.0**; nullable = unlimited) | ONE real-FS terminal command (SIGTERM → SIGKILL on expiry). |
| Approval | fixed 300000 ms (v1.0.6 §9) | User approval of a tool call — intentionally NOT configurable here. |
| Prompt / confirm | fixed 120000 ms | Interactive prompt()/confirm() windows; confirm resolves **false** on expiry. |

### Frontend / backend / runtime agreement (§8)

- **Settings UI:** `GET /api/config/limits` exposes the resolved metadata; numeric inputs
  derive min/max/default/unit from it — never duplicated in React components. Since
  v1.0.14 the **Limitations** page additionally SAVEs the file (`PUT /api/config/limits`)
  and applies presets.
- **Backend:** `settings.ts` clamps and `schemas.ts` zod bounds resolve the same limits.
- **Runtime:** network, VFS, execution and child-process enforcement resolve the same
  limits live (getter per operation, no cached stale snapshot) — a Limitations-page save
  therefore takes effect at runtime within ≤ 2 s without a restart.
- The Task Console's execution-limits fields read the same metadata
  (`task.*` properties).

### CLI

```bash
bun run cli config limits     # print the resolved limits
bun run cli config validate   # validate configuration-limits.json
```

### The Limitations page (v1.0.14)

Since v1.0.14 the limits file is no longer host-edit-only: the console ships a
**Limitations** page (console → **More → Limitations**) — a complete control surface for
`config/configuration-limits.json` (spec §17/§18):

- **Full metadata rendering** — the page loads the complete configuration-limits JSON
  (`GET /api/config/limits`) and renders EVERY property with its
  `type / min / max / default / unit / enum / nullable` metadata — structured editors
  per section (network · vfs · fs · execution · childProcess · task · **and the v1.1.0
  sections coreModule · planner · terminal · vfsTerminal · skills · events ·
  continuity**), never a hand-built subset. **v1.1.0 editor additions**: array
  properties (`vfsTerminal.allowedCommands`) get a dedicated array editor, and
  nullable numerics get an "unlimited (null)" checkbox that sends a real `null`.
- **Raw JSON editor mode** — a toggle switches the page to the raw JSON text of the
  whole limits file (with the same validate-before-save pipeline).
- **Save (§17.2/§18.1)** — writes via **`PUT /api/config/limits`**: the payload is
  validated server-side (structure, required fields, types, min/max relationships)
  BEFORE anything is written; only a fully valid object replaces the file (atomic
  temp-file + rename), the loader cache is invalidated and the change hot-reloads into
  the REAL runtime within ≤ 2 s — VFS caps, execution ceilings, network policy and task
  limits all follow without a restart. Invalid payloads fail with 400
  `CONFIGURATION_LIMITS_INVALID` listing every issue; the current file is untouched.
- **Export / Import JSON** — the page downloads the current limits JSON and imports a
  previously exported file; import runs through the SAME server-side validation —
  nothing is overwritten until validation succeeds.
- **Standard / Default preset** — a shipped byte-exact snapshot of the shipped
  configuration (`GET /api/config/limits?preset=standard`, generated programmatically
  from the real file). Applying it restores every default.
- **⚠ Complete Unrestricted preset** — `?preset=unrestricted`: every numeric property at
  its maximum, capability booleans open, `fs.restricted: false`, and — since v1.1.0 —
  nullable numerics (`coreModule.llmTimeoutMs`, `planner.llmTimeoutMs`,
  `planner.verifyTimeoutMs`, `terminal.execTimeoutMs`) and the nullable array
  (`vfsTerminal.allowedCommands`) set to `null` = genuinely unlimited. The UI renders a
  persistent warning banner AND a confirmation dialog before applying. Even this preset
  cannot weaken the security boundaries (§7.10): it changes CONFIGURED LIMITS only —
  never host filesystem, host process or sandbox-escape privileges (the sandbox
  architecture is not configurable).

Error reporting: `UNKNOWN_PRESET` (unknown `?preset=` value),
`CONFIGURATION_LIMITS_INVALID` (validation), `LIMITS_WRITE_FAILED` (host file not
writable). See [API](api.md#get-apiconfiglimits-v108).

## Tool execution timeout (v1.0.7)

The tool execution timeout is fully configurable with a stable default and a hard
runtime ceiling:

- **Default: 10 seconds** (`10000` ms) — unchanged behavior for unconfigured tools.
- **Maximum: 1 hour** (`3600000` ms) — **no configuration may exceed one hour.**
- Values above the maximum are **rejected** by API validation (zod schemas return 400)
  and **clamped** by the runtime (defense in depth for hand-edited rows).

Precedence (highest wins, the runtime maximum always applies):

```
Global/default timeout   Settings.toolTimeoutMs (default 10000 ms)
        ↓ overridden by
Tool-specific timeout    ToolDefinition.timeoutMs (Tool IDE "Execution timeout (ms)")
        ↓ bounded by
Runtime-enforced maximum 3600000 ms — never bypassable
```

Where to configure:

- **Settings view** → *Execution limits* → "Tool timeout (ms)" numeric input plus a
  preset select (10 s / 30 s / 1 min / 5 min / 30 min / 1 hour). The caption shows
  "Default: 10 seconds (10000) · Maximum: 1 hour (3600000)".
- **Tool IDE** → *Execution Environment* → "Execution timeout (ms)" — empty means the
  global default; valid range 1000–3600000.
- **CLI** → `nextool tool test <name> --timeout <ms>`.
- **API** → `PUT /api/settings` (`toolTimeoutMs`), `POST /api/tools/js` +
  `PUT /api/tools/{name}` (`timeoutMs`), `POST /api/tasks` (`config.toolTimeoutMs`).

### Timeout propagation

The **effective** timeout (tool-specific → task/global default, capped at 1 h) flows
through the whole execution chain, so child operations never inherit a shorter
hard-coded limit:

```
Task → Main → CoreModule → Tool Runtime (executor watchdog)
                              ├─ Network layer      policyFetch / XHR / virtual http(s)
                              │                      (NetworkAccounting.requestTimeoutMs —
                              │                       v1.0.9: resolved from the Network
                              │                       Policy chain, NOT the tool timeout)
                              ├─ Sandbox deadline   js-runner / node-runner watchdogs
                              │                      (v1.0.9: capped by execution.timeoutMs.MAX,
                              │                       never by the 10000 ms default)
                              └─ child_process       virtual commands (ceiling = effective
                                                      timeout; default 8 s when unset)
```

## Network Policy request timeout (v1.0.9)

The timeout applied to **each individual network request** made inside a tool —
fetch, XMLHttpRequest, virtual http/https, URL imports and npm registry access — is
directly configurable from the Settings page as a SEPARATE limit from the tool
execution timeout (neither setting silently overwrites the other):

- **Settings default**: `networkRequestTimeoutMs` = **60000 ms (60 s)** (shipped
  central default), configurable in **Settings → Network policy → "Network request
  timeout (ms)"** (numeric input + preset select up to 1 hour).
- **Bounds**: resolved from the central `network.timeoutMs` metadata — shipped
  min 1000 ms, max 3600000 ms — and validated by the frontend schema, the backend
  API (`PUT /api/settings`) and the runtime clamp from the SAME metadata.
- **Persistence**: stored with the existing Settings system (survives page
  refresh, application restart, new tasks and new executions).
- **Runtime propagation**: Settings → Settings API → resolved configuration →
  Network Policy → `policyFetch` (fetch / XHR / virtual http(s) / URL imports /
  npm). A request longer than 10 s succeeds once the setting is raised — e.g.
  `llm.chat` with tool timeout 300000 ms and network timeout 120000 ms.

Precedence (first present wins; every value clamped into the central bounds;
the owning tool's effective execution timeout remains the outer ceiling so a
request never outlives its tool):

```
1. Request-specific override   fetch(url, { timeoutMs })
2. Tool-specific Network Policy ToolDefinition.networkTimeoutMs (Tool IDE)
3. Task-level Network Policy   POST /api/tasks → config.networkTimeoutMs
4. Global Network Policy       Settings.networkRequestTimeoutMs
5. Shipped default             network.timeoutMs.default (60000 ms)
```

Error reporting: a request killed by the Network Policy fails with the stable
code **`NETWORK_TIMEOUT`** and the message
`Network request exceeded the configured timeout of <effective>ms.` — it is
never reported as a tool execution timeout (`TOOL_TIMEOUT` / `TIMEOUT`), and the
message always carries the actually configured value.

v1.0.9 also fixed the v1.0.8 conflation where the sandbox network layer
inherited the TOOL EXECUTION timeout as the per-request timeout, and the
js/node runner watchdogs clamped the effective tool timeout to the
`execution.timeoutMs` DEFAULT (10000 ms) instead of its MAX (1 h) — the root
cause of long-running tools (e.g. `llm.chat`) failing after exactly 10 seconds
with `Function exceeded 10000ms and was aborted.` despite a 300000 ms tool timeout.

A network request inside a tool is therefore **not** forcibly terminated after 10 s
when the effective tool timeout is longer — `10000` ms exists in exactly one place:
the documented policy default in `sandbox-net.ts`.

### Timeout errors

When a timeout occurs the error reports the **actual configured timeout** — never a
hard-coded `10000ms`:

```
TOOL_FAILURE [tool_execution]:
Tool "server.health" timed out after 300000ms.
```

The structured `ToolTimeoutError` carries `tool`, `operation`,
`effectiveTimeoutMs`, `elapsedMs` and `reason`; `tool.timeout` events include the
effective timeout in their payload.

### Separate timeouts (do not confuse them)

| Timeout | Default | Configurable? | Scope |
| --- | --- | --- | --- |
| Tool execution timeout | 10 s | yes — up to 1 h (this section) | one tool call |
| Network/request timeout | follows the effective tool timeout (policy default 10 s) | indirectly — via the tool timeout | one HTTP request inside a tool |
| Approval timeout | **5 minutes** (v1.0.6, unchanged) | no | waiting for a user approval decision |
| Prompt timeout | 120 s (v1.0.6, unchanged) | no | `prompt()` interactivity |
| Task timeout | `taskTimeoutMs` 120 s | yes (5 s–1 h) | the whole task / live cycle |

## Application data reset (v1.0.7)

**Settings → Danger zone → "Reset Application Data"** performs a controlled,
backend-executed reset of RUNTIME data. It requires a confirmation dialog **and**
typing the exact phrase `RESET`; the destructive button stays disabled until the
phrase matches. It is also available as `POST /api/settings/reset` with body
`{ "confirm": "RESET" }` (anything else → 400 `CONFIRMATION_REQUIRED`) and via the
CLI `nextool maintenance reset --confirm RESET`.

**What the reset clears** (runtime data only):

cached/generated data (incl. generated images) · persistent memory · statistics ·
stored events · task histories (tasks, execution history, live-state history) ·
runtime state (incl. tool Virtual FS workspaces) · session/runtime caches.

**What the reset NEVER deletes** (protected resources — enforced by an explicit
allowlist in `maintenance.ts`; the endpoint cannot touch anything else):

- Tools — definitions, handler config, function source
- Models — registrations, manifests, artifacts
- Datasets — records, examples, files
- Training jobs + benchmark runs (training artifacts and model/dataset provenance)
- Settings (including the timeout configuration)

The reset is a controlled transaction, **not** `DELETE FROM` on the whole database
and not a storage-directory wipe. Events `system.reset.started` / `system.reset.completed`
/ `system.reset.failed` are emitted; the old event history is intentionally cleared
by the reset, leaving only the minimal `system.reset.completed` audit record.
Failures are reported per the §3.7 contract — the reset never claims success when a
store could not be cleared. After a successful reset the UI refreshes to the new
empty runtime state.

## Model/dataset maintenance cleanup (v1.0.7)

**Settings → Maintenance** exposes two real operations (also available via
`GET|POST /api/maintenance/cleanup`, `GET /api/maintenance/validate` and the CLI
`nextool maintenance validate | cleanup [--apply]`):

- **Validate dependencies** — checks the active model (built-in `llm-core`), model
  manifest/artifact integrity, required datasets and every model/dataset reference
  (training jobs, benchmark runs). Missing resources are **reported as clear errors**;
  nothing is ever silently recreated.
- **Model/dataset cleanup** — dependency-aware, **idempotent** cleanup. A resource is
  a cleanup candidate **only** when dependency analysis proves it has no inbound
  references (training jobs, benchmark runs) and it is not the active model
  (`status: "active"`). Models/datasets are never removed merely for being old,
  duplicate-named or lower-versioned. The report lists protected / candidates /
  removed / failed resources plus broken-reference warnings — always traceable.
  A dry run ("Analyze") never deletes; the second cleanup run removes nothing new.

Dependency rules (v1.0.7):

```
Model   → protected when referenced by a training job, referenced by a benchmark
          run, or status "active" (current model); otherwise orphan candidate
Dataset → protected when referenced by a training job or a benchmark run;
          otherwise orphan candidate (DatasetRecord imports are versioned — same
          name does NOT mean duplicate)
```

For confirmed orphans the database record is removed and, because orphans have no
inbound references by definition, no broken references remain. User downloads in
`exports/` are never touched.

## Environment variables

Only `DATABASE_URL` is read (Prisma SQLite connection). There are no other application
env vars; the image-generation and LLM credentials are resolved by `z-ai-web-dev-sdk`
from its own sandbox configuration, not from project files.

## Related pages

- [Runtime](../architecture/runtime.md) — lifecycle, limits and cancellation semantics.
- [Scheduler](../architecture/scheduler.md) — how `liveIntervalMs` and event wakes interact.
- [API](../api/api.md) — `/api/settings` endpoint details.
