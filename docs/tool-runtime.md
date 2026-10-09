---
title: Tool Runtime
category: Tools
order: 3
---

# Tool Runtime

`src/lib/nexool/tools/executor.ts` is the execution engine every tool call passes
through. Its contract: **`executeTool` never throws** — it always resolves with a
structured `ToolExecution`, whether the call succeeded, failed, timed out, or was
cancelled.

```ts
interface ToolExecution {
  executionId: string;   // exec_<hrtime base36><2 rand bytes>
  tool: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';
  params?: Record<string, unknown>;   // post-coercion params
  result?: unknown;
  error?: { code: string; message: string } | null;
  startedAt: string;                  // ISO
  completedAt?: string;
  durationMs?: number;
  batchId?: string;                   // v1.0.3: set when this call ran in a parallel batch
  parallelGroup?: number;             // v1.0.3: planner group the call belonged to
}
```

## Execution pipeline

```mermaid
flowchart LR
    A[task-driven call] --> AG{approval gate v1.0.6}
    AG -- auto/allowed --> A2[executeTool]
    AG -- denied --> F8[skipped · DENIED_BY_USER]
    AG -- timeout --> F9[TASK STOPS]
    A2 --> B{tool in registry?}
    B -- no --> F1[failed UNKNOWN_TOOL]
    B -- yes --> C{aborted before start?}
    C -- yes --> F2[cancelled CANCELLED]
    C -- no --> D[coerceParams]
    D --> E[validateParams]
    E -- errors --> F3[failed INVALID_PARAMS]
    E -- ok --> G{handler resolvable?}
    G -- no --> F4[failed NO_HANDLER]
    G -- yes --> H[race: handler vs timeout vs abort]
    H -- ok --> I[completed + result]
    H -- timeout --> F5[timeout TIMEOUT]
    H -- abort --> F6[cancelled CANCELLED]
    H -- throw --> F7[failed TOOL_FAILURE / handler code]
```

0. **Approval gate (v1.0.6)** — BEFORE the executor runs, every task-driven call
   resolves `resolveAutoExecute` (global setting → task config → tool flag; see
   [below](#the-approval-gate-v106)). `auto`/`allowed` proceed; `denied` skips the tool;
   `timeout` stops the task. Nothing silently executes.
1. **Timeout budget** — `opts.timeoutMs ?? 30_000`, hard-clamped to **250 ms –
   300 000 ms** regardless of config.
2. **Param coercion** (`coerceParams`) — per declared type: numbers from numeric
   strings, `"true"/"false"` → boolean, JSON strings parsed for object/array, CSV
   strings split into arrays. Unknown keys are dropped here.
3. **Validation** (`validateParams`) — after coercion: unknown params are errors,
   required params must exist, types must match (finite numbers, plain objects,
   arrays), `min`/`max` bounds and `enumValues` membership enforced. Errors join into
   one `INVALID_PARAMS` message.
4. **Race** — the handler runs against both the timeout timer (unref'd) and the
   task's `AbortSignal`, so a task stop cancels in-flight work deterministically.
5. **Handler errors** — handlers throw `ToolFailure(message, code)`; the executor maps
   them onto `failed` with the handler's code (`TOOL_FAILURE` default,
   `INVALID_PARAMS`, `SERVICE_UNAVAILABLE`, `INVALID_CONFIG`, …). A timeout message
   detection flips the status to `timeout` with code `TIMEOUT`.
6. **Sandbox invocation hardening (v1.0.5)** — `js-function` and `nodejs` tools are
   invoked *inside* the `node:vm` context under the 4 s sync timeout, so a body
   without `await` (a runaway `for(;;)` loop) is bounded by the vm timeout instead of
   hanging the host event loop until the async watchdog cap (default 10 s — v1.0.7: the effective tool timeout, configurable to 1 h).

## The approval gate (v1.0.6, hierarchy redefined in v1.0.11)

`src/lib/nexool/approval.ts` implements the ONE auto-execution resolver, shared by
the runtime loop and the tests. **v1.0.11 replaces the old boolean-merging precedence
with an explicit hierarchy** — `resolveAutoExecution(global, tool, task)` returns
`{ enabled, source }` with source `global | tool | task | default`:

```
1. GLOBAL auto-execution (settings.autoExecuteTools, default false) — highest priority
     ↓ global === true → ON (source 'global') — nothing below can override it
2. TOOL auto-execution (definition.autoExecute — tri-state in the IDE since v1.0.11:
     Enabled / Disabled / Inherit, stored boolean|undefined)
     ↓ tool === true → ON (source 'tool') — wins over the task console
3. TASK CONSOLE preference (config.autoExecuteTools)               — lowest priority
     ↓ task === true → ON (source 'task')
4. otherwise → OFF (source 'default') → APPROVAL REQUIRED → WAIT
```

`undefined` means inherit / never forces; a lower layer can NEVER override a
higher-priority enable. Test matrix: G=T,O=F,Tk=F → ON (global); G=T,O=T,Tk=F → ON
(global); G=F,O=T,Tk=F → ON (tool); G=F,O=F,Tk=T → ON (task); G=F,O=F,Tk=F → OFF
(default). The back-compat `resolveAutoExecute` delegates to `resolveAutoExecution`.

**Observable effective source (v1.0.11):** when a lower layer decides, the runtime
emits `tool.auto_execution` with `{ tool, enabled: true, source }` (the global-forced
case is the documented default and stays silent). The approval flow below is
unchanged.

When approval is required (`requestApprovalIfNeeded` in the runtime loop):

1. `tool.approval.required` (priority 2) is emitted with `{ approvalId, tool, params,
   purpose, reason, subgoal, requestedAt }` — the task is persisted as
   **`awaiting_approval`**.
2. The user Allow/Denies via the pending-approval card in Task Preview or Live Monitor
   (`GET/POST /api/approvals`). Allow → `tool.approval.allowed`, execution proceeds.
   Deny → `tool.approval.denied` + `tool.execution.blocked` (cause `user_denied`); the
   tool is **skipped** (execution `cancelled`, code `DENIED_BY_USER`) and the task
   continues per plan — dependent steps get an explicit observation so the planner never
   assumes success. Optional denial feedback becomes an `observer.feedback_applied`
   event (≤ 2000 chars).
3. **Timeout (5 minutes)** — `tool.approval.timeout` + `tool.execution.blocked` (cause
   `approval_timeout`) fire and the **TASK STOPS** (blockedStop with the reason). A
   timeout never silently executes the tool (§9.11).
4. **Parallel batches (§9.13)** — every blocked tool waits for ITS OWN decision;
   approving one never auto-approves its batch siblings.
5. Stop/pause interactions: stopping the task flushes pending approvals (resolved
   `cancelled`); pausing while awaiting approval keeps the approval unresolved —
   `paused` is displayed and the 5-minute timeout remains well-defined.

The decision record also lands in the task state (`pendingApproval`) so the console can
render tool / purpose / params / subgoal without extra requests.

## Parallel independent calls (v1.0.3)

Two layers of parallelism:

- **Plan groups → `executeParallelBatch`** — when `parallelToolCalls` is on (default)
  and `autoExecuteSubtools` allows execution, the goal loop collects ≥ 2 consecutive
  pending *action* steps sharing a `parallelGroup`, gets one CoreModule decision per
  step, and — only if **every** decision is a `tool_call` — executes the batch through
  `executeParallelBatch(batchId, calls, { maxParallel, ... })`. Otherwise the group is
  reset to pending and handled sequentially.
- **Executor helper** — `executeToolsParallel(calls, opts)` still exists and runs any
  list of calls through `Promise.all` (each call fully independent: own id, own timeout,
  own events/history).

### `executeParallelBatch` semantics

- **Hard concurrency cap** — `maxParallel` is clamped to **1–8** (default 4). There is
  no unlimited concurrency, ever.
- **Waves** — the goal loop slices the group to the cap before dispatch
  (`group.slice(0, min(group.length, maxParallelToolCalls))`), so a larger same-group
  backlog runs across later loop iterations instead of one oversized dispatch.
  `executeParallelBatch` itself also clamps the cap and would run any calls beyond it in
  subsequent waves after the current wave completes — overflow is deferred, never
  widened.
- **Failure isolation** — `executeTool` never throws, and each call is independent:
  one sibling failing (or timing out) never cancels the others. If some but not all
  calls of a batch fail, the loop marks the steps individually and emits
  `planner.partial_failure`; the survivors count.
- **Per-call safety unchanged** — `toolTimeoutMs` still applies to every call in the
  batch, and the task's abort signal still cancels in-flight calls.
- **Safety limits unchanged** — `safetyLimit`/`maxSubtoolCalls` accounting is not
  relaxed by batching; every call still counts.
- **Provenance** — every batched call gets `batchId` + `parallelGroup` on the execution,
  a `tool.started` message with a `(parallel batch)` suffix, and the fields persisted on
  its `HistoryEntry` row (new v1.0.3 columns) — which is what
  `GET /api/tasks/{id}/executions` returns and what Task Preview groups into a labeled
  "parallel batch · N concurrent" card.

Dependent operations are simply steps **without** a shared group — the loop executes
them sequentially in plan order, so step N+1 can use step N's observation as context.
There is no automatic dataflow between executions; dependencies are expressed through
plan order and the context bundle.

## The nodejs execution environment (v1.0.5 → expanded v1.0.6)

`environment: 'nodejs'` tools run in `src/lib/nexool/tools/node-runner.ts` — a
restricted Node.js JavaScript environment with the same `execute(params, context)`
contract and the same structured-result shape as the `js-function` runner
(`js-runner.ts`), so the executor, `POST /api/tools/test` and the CLI share one path
per environment:

- **Common controlled APIs (v1.0.6)** — `fetch` / `XMLHttpRequest` (one policy layer),
  async `alert`/`prompt`, deadline-bounded timers; see
  [Tool Development](tool-development.md#common-runtime-apis-in-both-environments-v106).
- **Static allowlist** — `require()`/`await import()` resolve `buffer`, `crypto`,
  `events`, `path`, `querystring`, `string_decoder`, `url`, `util`, `assert`, `zlib`
  from statically imported host modules.
- **Context-provided virtual modules (v1.0.6)** — `fs` (the Virtual FS), `os`
  (virtualized values), `timers`/`timers/promises`, `http`/`https` (controlled network
  client) and `child_process` (restricted virtual commands). Each is built per
  execution around the tool's own sandbox context — no host module object crosses the
  boundary.
- **One import resolver** — allowlist → virtual modules → VFS files (`.js/.mjs/.json`,
  CommonJS + conservative ESM transform). URL imports are disabled by default
  (`NETWORK_POLICY.urlImportsEnabled = false`). Anything else fails with
  `Module "x" is not available in the NexTool Node.js environment (…)` — deliberately
  blocked modules (`cluster`, `vm`, `worker_threads`, `net`, `dgram`, `dns`, `process`,
  `perf_hooks`, `inspector`, `module`, `async_hooks`) append their reason.
- **Dynamic `import()` without host flags** — `import("x")` call sites are rewritten
  at compile time to the resolver shim (`__nexoolDynamicImport`), because the stock
  `vm` dynamic-import callback would need `--experimental-vm-modules`.
- **Execution limits** — resolved live from the central limits (`execution.*`): source ≤ 64 000 chars default (200 000 max, configurable); sync cap 4 s default enforced at the function
  invocation (bounds no-`await` runaway loops without freezing the host event loop);
  async watchdog: the effective execution timeout (default 10 s, v1.0.7 configurable up to 1 h — `TIMEOUT`, deferred while `prompt()` waits); heap-growth
  sentinel 256 MiB (`MEMORY` — an honest in-process guard: it aborts the tool result
  but cannot revoke memory already allocated in the host realm); result ≤ 64 KiB
  serialized, depth ≤ 12.
- The authoring-side contract (module tables, VFS guide, virtual child_process command
  table, error wording) is documented in
  [Tool Development](tool-development.md#the-nodejs-environment--restricted-virtualized-nodejs).

## Runtime capability source: GET /api/tools/environments (v1.0.5 → v1.0.6 → v1.0.11)

The handler-kind registry (`HANDLER_KIND_INFO` in `tools/registry.ts`) and the
Node.js configuration (`NODE_MODULE_ALLOWLIST`, `NODE_BLOCKED_MODULES`,
`NODE_SANDBOX_GLOBALS`, `NODE_EXECUTION_LIMITS` in `tools/node-runner.ts`) are served
verbatim by `GET /api/tools/environments` — environments, handler kinds with their
`configFields`, sandbox limits and the module allowlist/globals. v1.0.6 adds four more
blocks served from the real runtime constants: `network` (the `NETWORK_POLICY`),
`vfs` (`VFS_LIMITS` + workspace directories), `childProcess`
(`CHILD_PROCESS_LIMITS` + `VIRTUAL_COMMANDS`) and `capabilities` — the
capability × environment matrix (spec §8) generated from the real runtime config.
**v1.0.11 adds the `freedom-node` environment (authorable, `execution:
'freedom-node'`), a `freedomNode` column on every capability row and a `freedomNode`
block `{ enabled (LIVE gate state), fsConfig, note, preservedLimits }` — the IDE
reference reflects the ACTUAL unrestricted-environment runtime including the honest
gate state.**
The Tool IDE selector, handler-kind UI, capability matrix, IntelliSense declarations
and References panel read THIS endpoint; there is no hardcoded frontend copy of the
runtime capabilities.

The `http_get` handler kind's structured config — `url` (required) and `timeout`
(ms, 1000–15000, default 8000) — is declared in the same registry
(`configFields`) and enforced by the handler at execution time.

## Failure, cancel and retry semantics

| Outcome | Execution status | Error code | Event | Retry? |
| --- | --- | --- | --- | --- |
| Approval denied (v1.0.6) | cancelled | `DENIED_BY_USER` | `tool.approval.denied` (2) + `tool.execution.blocked` (2) | No — the task continues per plan; the planner may re-request approval. |
| Approval timeout (v1.0.6) | — (not executed) | — | `tool.approval.timeout` (2) + `tool.execution.blocked` (2) | **The task stops.** Never silently executed. |
| Unknown tool | failed | `UNKNOWN_TOOL` | `tool.failed` (5) | No |
| Invalid params | failed | `INVALID_PARAMS` | `tool.failed` (5) | No |
| No handler bound | failed | `NO_HANDLER` | `tool.failed` (5) | No |
| Handler threw | failed | handler code | `tool.failed` (5) | **Once** in Goal Mode (fresh decision with the error as observation; `planner.retry` event) — **v1.0.11: superseded in the pre-plan failure branch, where the bounded recovery state machine takes over** (see [Planner](planner.md#pre-plan-failure-recovery-v1011)). Second failure ends the task (`TOOL_FAILURE`). |
| Timeout | timeout | `TIMEOUT` | `tool.timeout` (4) — the payload carries the **effective timeout** (v1.0.7) | Same single retry rule. |

The timeout error reports the ACTUAL configured value — `Tool "server.health" timed
out after 300000ms.` — never a hard-coded 10000ms (v1.0.7). The effective timeout is
resolved as: tool-specific `timeoutMs` → global `toolTimeoutMs` (default 10000) →
hard cap 3600000 ms, and it propagates into the network layer, sandbox watchdogs and
virtual child_process ceilings. See
[Configuration → Tool execution timeout](../getting-started/configuration.md#tool-execution-timeout-v107).
| Task stop / abort | cancelled | `CANCELLED` | `tool.cancelled` (5) | No — stop wins. |

In Live Mode there is no retry machinery: failed cycles are logged and the next tick or
event wake tries again.

## Task-owned child processes (v1.1.0)

A REAL host process spawned on behalf of a task is registered in the per-task process
registry (`src/lib/nexool/main/task-processes.ts`) at spawn time:

- **`fs.cmd`** registers every bash child (`fs.cmd:<pid>`) it spawns, together with a
  release function that removes the entry when the command finishes.
- **Force-stop integration** — `stopTask` calls `terminateTaskProcesses(taskId)`:
  every registered entry receives SIGTERM, stragglers are escalated to SIGKILL after
  1.5 s (detached children are killed as whole process groups), and the stop path
  emits "Force-stop terminated N task-owned child process(es)." — so no background
  child keeps working after the task stopped merely because the HTTP request
  returned.
- **Scope** — only task-owned processes are tracked and killed. The standalone FS
  Inspector terminal is NOT task-owned: it is controlled through its own session
  actions and is never terminated by a task stop. Unrelated host processes are never
  touched.
- `countTaskProcesses(taskId)` exposes the current ownership count for diagnostics.

## After every execution (finalize)

- **Stats** — `completed | failed | timeout` increment the tool's counters and
  cumulative ms on `ToolRecord` (durable, per-tool, surfaced in `/api/tools`).
- **Event** — `tool.completed` / `tool.failed` / `tool.timeout` / `tool.cancelled` with
  the full execution as payload; the execution id lets you correlate
  `tool.started` ↔ terminal event.
- **History** — a `HistoryEntry` row (task, action, params JSON, result JSON, status,
  and — v1.0.3 — `batchId`/`parallelGroup` for batched calls).
  This is the durable record the console's History view and the task's
  `/executions` endpoint read; it survives restarts and is written even when other
  bookkeeping fails (write failures are logged, never thrown).

## Execution ids

- Live executions: `exec_<high-resolution time base36><2 hex bytes>` — unique per call,
  present in both the `tool.started` and terminal event payloads.
- History-derived records (the `/api/tasks/{id}/executions` endpoint reconstructs
  executions from history rows): ids look like `hist_<HistoryEntry.id>`; error fields
  for those are reconstructed (`{ code: 'FAILED' | 'TIMEOUT', message: 'See task
  events for details.' }`) since history rows don't store structured errors.

## Notes and edges

- `params` recorded on the execution are the **coerced** values — what the handler
  actually received.
- A `tool_call` decision whose tool got disabled mid-task is caught earlier by the
  CoreModule gate (→ `cannot_execute`), but the executor would still answer
  `UNKNOWN_TOOL`/`NO_HANDLER` as defense in depth.
- Cancellation before start is possible: if the abort signal fires between decision and
  execution, the execution resolves `cancelled` without invoking the handler.

## See also

- [Tools](tools.md) — definitions, registration, handler kinds.
- [Tool Development](tool-development.md) — the Tool IDE and both function-tool sandboxes.
- [Runtime](../architecture/runtime.md) — task-level limits and cancellation.
- [Events](../architecture/events.md) — tool event catalog.
