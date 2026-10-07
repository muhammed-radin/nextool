---
title: Main
category: Architecture
order: 2
---

# Main — the task orchestrator

`src/lib/nexool/main/` is the heart of the runtime. It owns task identity, the loop state
machines, and the boundary between Goal Mode and Live Mode.

## Files and responsibilities

| File | Exports | Role |
| --- | --- | --- |
| `nexool.ts` | `createTask`, `stopTask`, `injectEvent`, `getTaskDetail`, `listTasks`, `countActiveTasks`, `getGlobalState`, `toTaskDetail` | Task manager singleton: creation, cancellation, event injection, queries. |
| `loop.ts` | `runTask`, `TaskRunHandle`, `WakePayload`, `ResolvedTaskConfig` | The per-task state machines: `runGoalMode` and `runLiveMode`, plus context building, parallel groups, repair passes, **v1.0.11 pre-plan failure recovery delegation** and finalization. |
| `planner.ts` | `buildPlan` | Request → ordered plan (see [Planner](planner.md)). |
| `planner-strategy.ts` | `resolvePlannerType`, `planOneByOneStep` | The one-by-one strategy (v1.0.10, see [Planner](planner.md)). |
| `recovery.ts` | `runPrePlanRecovery`, `RECOVERY_PLAN_MAX_STEPS` | **v1.0.11** — the bounded pre-plan failure-recovery state machine (frozen main plan → recovery subgoal + own pre-plan → execute → Observer verify → state-aware resume / honest abort; see [Planner](planner.md#pre-plan-failure-recovery-v1011)). |
| `observer.ts` | `interpret`, `checkGoalComplete`, `assessRecovery` | Execution → observation + goal verdict (see [Observer](observer.md)); **v1.0.11 `assessRecovery` verifies recovery attempts.** |

## The runtime singleton

`nexool.ts` keeps its handle map on `globalThis.__nextoolRuntime`, so hot reloads in dev
don't orphan running tasks' cancellation handles:

```ts
interface TaskRunHandle {
  stopFlag: { stopped: boolean };
  abortController: AbortController;   // aborts in-flight tool executions
  wake: ((payload: WakePayload) => void) | null;  // set while a live task waits
  inbox: NexToolEvent[];              // v1.0.6: events that arrived while busy/paused/waiting
  queueingDisabled?: boolean;         // v1.0.14: set without "Read & Act All Events"
  actionRunning?: boolean;            // v1.0.14: true while a live cycle executes
}
```

`createTask(request, configPartial)`:

1. Trims and validates the request (non-empty, ≤ 32 000 chars — v1.0.11, raised from 8 000 for long Markdown requests).
2. Clamps every config number against global settings (see [Configuration](../getting-started/configuration.md)).
3. Creates the DB row with status `queued`; emits `task.created` (priority 6).
4. Registers the handle and fire-and-forgets `runTask(id, handle)` — the HTTP response
   returns immediately with the queued `TaskDetail`.

`stopTask(taskId)`: sets `stopFlag`, aborts the AbortController (cancelling any in-flight
tool execution), and if the task is a waiting live task, delivers a synthetic priority-1
`task.stop` wake so the wait exits immediately. It also emits `task.stop_requested`.
**v1.0.14 §31:** every pending inbox event is cancelled observably (`event.cancelled`),
the inbox is dropped and pending interactive alerts auto-dismiss — nothing runs after
the stop.

`injectEvent(taskId, type, payload, priority, source)`: emits the event (plus the
`event.received` lifecycle record) and — for a live task that is neither stopped nor
busy-without-queue — admits it (`event.admitted`), pushes it to the handle inbox and
wakes the waiting loop IMMEDIATELY. **Changed in v1.0.14: the old `priority <= 5` gate
is gone — every injected event wakes a live task regardless of priority; priority is
ordering/metadata only.** Without "Read & Act All Events", an event arriving while an
action runs (or another event is pending) is REJECTED with the observable reason
*"Live action already running and Read & Act All Events is disabled."* — no hidden
backlog. Paused tasks retain events (§11.4). This is how user feedback (priority 2),
user messages and environment broadcasts interrupt scheduled waiting.

## The main loop

`runTask` executes the canonical pipeline. A simplified skeleton:

```ts
state = { request, goal, mode, plan: [], subgoals: [], observations: [], ... }
persist(status: 'running'); emit('task.started')
toolDefs = await getEnabledToolDefs(config.enabledTools)
plan = await buildPlan(request, goal, toolDefs, reasoningLevel)   // refines goal too
emit('planner.plan')
term = config.mode === 'live' ? await runLiveMode(ctx) : await runGoalMode(ctx)
await finalize(ctx, term)                                         // writes FinalResult
```

Every iteration of the goal loop:

1. Checks stop flag → `taskTimeoutMs` → `maxIterations` / `safetyLimit`.
2. Picks an objective: the active subgoal, else the first pending plan step (plus its
   consecutive same-`parallelGroup` siblings).
3. If the plan is exhausted and no subgoal is active, asks the LLM for the next dynamic
   subgoal (`proposeNextSubgoal`, 10 s timeout); if none is needed the task completes.
4. Executes — parallel batch (≥ 2 consecutive pending action steps with the same
   `parallelGroup`, gated by `parallelToolCalls`, capped by `maxParallelToolCalls` 1–8,
   dispatched through `executeParallelBatch`; all decisions must yield `tool_call`) or
   sequential `decideAndExecute`.
5. Handles the decision status (`clarification_required` / `cannot_execute` / `stop` /
   `no_tool` / `tool_call`; **v1.0.11 — a failed pre-plan step no longer costs a single
   blind retry plus a hard stop: the loop hands over to the bounded recovery state
   machine in `recovery.ts`**, while one-by-one keeps its replan-on-failure handling).
6. Records the observation, marks plan steps, persists state, and re-verifies the goal
   after each execution.

## Goal Mode vs Live Mode

| Aspect | Goal Mode (default) | Live Mode (explicit) |
| --- | --- | --- |
| Purpose | Finish the request, then terminate. | Keep observing/acting forever until stopped. |
| First action | Enter the plan loop immediately. | **One full observation cycle on STARTUP (v1.0.14 — no first-interval wait)**, then park as `waiting`. |
| Scheduling | None — tight loop. | `waitWithEvents(liveIntervalMs)` — timer (`unref`'d) or event wake, whichever first; **events wake IMMEDIATELY (v1.0.14)** and the queue is drained before every wait. |
| Wakes | N/A | Scheduled tick (priority 9 `observer.scheduled_tick`, message-less interval trigger), **ANY injected event regardless of priority (v1.0.14 — the priority ≤ 5 gate was removed)**. |
| Special handling | One retry per failed tool; dynamic subgoals when the plan runs out. | `user.message` → live conversation cycle; `user.feedback` → memory upsert + LLM-revised subgoal + immediate correction cycle; `environment.*` → recovery repair passes; other events → one observe cycle carrying the full event (`CONTEXT.trigger`), bounded by `taskTimeoutMs`. |
| Termination | `completed` / `failed` (limits, timeout, no tool, tool failure, clarification) / `stopped`. | `stopped` by user (or stop event) — it never "completes" on its own. |
| Status while idle | `running`. | `waiting` (counts as active; drives the Live counters). |

## Finalization

`finalize` computes `durationMs`, assembles the persisted `FinalResult`:

```json
{
  "status": "completed | failed | stopped | cancelled | limit_reached",
  "goal": "…",
  "result": { "summary": "…", "lastObservation": "…", "artifacts": [ … ] },
  "steps": 3,
  "toolCalls": 4,
  "durationMs": 8123
}
```

Artifacts collected during execution: `{ type: 'image', path }` from `image.generate` and
`{ type: 'notification', id, level }` from `notification.send`. The final task row gets
status `completed | failed | stopped`, plus a terminal event (`task.completed`,
`task.failed`, or `task.cancelled`, all priority 3). Fatal loop errors produce
`RUNTIME_ERROR` with `errorState { code, message, stage }`; a crash in the fire-and-forget
wrapper marks the task `failed` with `RUNTIME_CRASH`.

## State (MainState) surfaced to the console

`state` persisted on the Task row and rendered in Task Preview includes: `request`,
`goal`, `mode`, `plan[]` (with step statuses), `currentStepId`, `activeSubgoal`,
`subgoals[]`, `previousActions[]` (last 30), `observations[]` (last 30),
`iterationCount`, `toolCallCount`, `lastObservation`, `terminationStatus`,
`errorState` — and, since **v1.0.11**, the optional `recovery` snapshot
(`TaskRecoveryState`: `status 'recovering'|'resumed'|'exhausted'`, `reason`,
`failedStepId`/`failedStepTitle`, `attempt`/`maxAttempts`, `subgoalId`, the recovery
`steps[]`, `startedAt`/`updatedAt` and the `resumeNote?`) that feeds the Task Preview
Recovery panel.

## See also

- [Goal Mode](../modes/goal-mode.md) and [Live Mode](../modes/live-mode.md) — full
  walkthroughs with diagrams.
- [Runtime](runtime.md) — limits, timeouts, cancellation details.
- [Scheduler](scheduler.md) — the Live Mode wait/wake machinery.
