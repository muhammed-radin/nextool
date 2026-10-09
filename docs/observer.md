---
title: Observer
category: Architecture
order: 4
---

# Observer

`src/lib/nexool/main/observer.ts` gives the runtime eyes: it converts raw tool executions
into concise operational observations and decides whether the goal has actually been
achieved based on observed state.

## Part 1 — interpret(toolName, execution, state?)

A pure, synchronous function. It maps the structured `ToolExecution` onto a single
sentence. Timeout/cancel/fail statuses short-circuit:

- `timeout` → `` `<tool> timed out after <ms>ms — no result observed.` ``
- `cancelled` → `` `<tool> execution was cancelled.` ``
- `failed` → `` `<tool> failed: <error message>.` ``

For successful executions it performs **domain-aware summarization** by recognizing
result shapes:

| Result shape | Observation |
| --- | --- |
| `{ serverId, health, cpu, memory }` | `Server api-01 health: healthy (cpu 34%, mem 51%).` |
| `{ environment: 'virtual-env', servers[] }` | `Environment overview: api-01=healthy, web-01=degraded, …` |
| `{ status: 'restart_initiated', healthyAfterMs }` | `… restart initiated; expected healthy in ~2500ms.` |
| `{ echo }` | `Echo result: …` |
| `{ waitedMs }` | `Waited 1200ms.` |
| `{ expression, result }` | `Math result: (2+3)*4 = 20.` |
| `{ imagePath }` | `Image generated and saved at /generated/<uuid>.png.` |
| `{ id, level, title }` | `Notification [warning] sent: …` |
| `{ found, value | matches }` | `Memory recalled: …` / `Memory recall found nothing…` |
| `{ key, value }` | `Memory stored under key "…".` |
| `{ hostname, platform, … }` | Host info summary (system.info). |
| `{ iso, formatted }` | `Current time: …` |
| `{ count, uuids }` | `Generated N UUID(s).` |
| `{ chars, words }` | Text statistics summary. |
| `{ status, body }` | `HTTP GET returned status 200.` |
| anything else | `` `<tool> completed: <JSON up to 220 chars>.` `` |

These sentences are stored as `state.lastObservation`, appended to
`state.observations` (ring of 30), emitted as `observer.observed` (priority 6), and fed
back into the next CoreModule decision as context.

## Part 2 — checkGoalComplete(goal, observation, reasoningLevel, taskId?)

Returns `{ complete: boolean, reason: string, engine: 'llm-core' | 'heuristic-fallback' }`.

**Heuristic path (reasoningLevel ≤ 2)** — no LLM call. The observation is matched against
success markers (`healthy`, `completed successfully`, `generated and saved`, `sent:`,
`recalled`, `stored under key`, `math result`, `current time`, `generated`,
`http get returned status 2`) and negative markers (`failed`, `timed out`, `unhealthy`,
`nothing`). Complete only if a positive marker is present and no negative one. Engine is
`heuristic-fallback`.

**LLM path (levels 3–6)** — chat completion with the configurable
`planner.verifyTimeoutMs` deadline (v1.1.0 — default 6 000 ms; the former hard-coded
`VERIFY_TIMEOUT_MS` is removed; `null` = no application-level timeout) asking for strict
JSON `{"complete": true|false, "reason": "…"}` based on the goal and the latest
observation. Parsed `reason` is capped at 300 chars;
engine `llm-core`. The task's AbortSignal is honored — a force-stop unblocks the
verification call immediately.

**Degradation** — if the LLM call fails or returns garbage, an
`observer.verify_fallback` event (priority 8) is emitted and the check conservatively
returns `complete: false` with reason `Verification unavailable — assuming goal not yet
complete.` (engine `heuristic-fallback`). An unverified goal simply keeps the loop
iterating until limits are hit; it never fabricates success.

## Where the verdict lands

- `loop.runGoalMode` calls `verifyGoal` after every recorded execution (and after parallel
  groups). When complete, it emits `observer.state_changed` (priority 4, "State indicates
  goal achieved: …") and `goal.completed` (priority 3, with `reason` and `engine` in
  `data`), then finalizes the task as `completed` using the last observation as summary.
- Live Mode repair passes use `observer.state_changed` (priority 3) when a server is
  verified healthy again after restart.
- **v1.0.11 — `assessRecovery`**: the Observer is also the AUTHORITY for pre-plan failure
  recovery. After a recovery attempt executes, `assessRecovery` decides whether the
  failed condition is RESOLVED, whether the main goal can safely continue anyway, or
  whether the failure is unrecoverable (recoverability `false` → immediate abort,
  `RECOVERY_UNRECOVERABLE`). Its verdict drives the state-aware resume (failed step
  marked completed vs re-queued at its original position) — see
  [Planner → Pre-plan failure recovery](planner.md#pre-plan-failure-recovery-v1011).

## Events emitted by this module

| Event | Source | Priority | Purpose |
| --- | --- | --- | --- |
| `observer.observed` | observer | 6 | One per recorded execution (emitted by the loop). |
| `observer.state_changed` | observer | 4 / 3 | Goal verified complete; server recovered. |
| `observer.verify_fallback` | observer | 8 | LLM verification unavailable — heuristic used. |
| `goal.completed` | runtime | 3 | Terminal goal-achieved marker (emitted by the loop). |
| `observer.scheduled_tick` | runtime | 9 | Live Mode timer fired (emitted by the loop). |
| `observer.event_wake` | observer | 5 | Live task woken by an event (emitted by the loop). |
| `observer.feedback_applied` | observer | 3 | User feedback processed in Live Mode (emitted by the loop). |

Observer-flavored events are visible in the Events view under the `observer` and
`runtime` source filters.
