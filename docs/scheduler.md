---
title: Scheduler
category: Architecture
order: 6
---

# Scheduler

NexTool has no cron infrastructure and no background worker pool. All scheduling is
per-task and lives inside the Live Mode wait loop in `src/lib/nexool/main/loop.ts`
(`runLiveMode` + `waitWithEvents`). Goal Mode has no scheduler at all — it runs a tight
loop until termination.

## The wait/wake primitive

```ts
function waitWithEvents(intervalMs: number, handle: TaskRunHandle): Promise<WakePayload>
```

A single promise that resolves on whichever happens first:

1. **Timer expiry** — `setTimeout(intervalMs)` resolves
   `{ reason: 'timeout' }`. The timer is `unref()`'d so it never keeps the Node process
   alive by itself.
2. **Event wake** — `handle.wake(payload)` resolves
   `{ reason: 'event', event: NexToolEvent }`. The slot is cleared after use.

While waiting, the task row status is `waiting` (set once before the loop, after the
initial observation cycle). Stopping the task sets `stopFlag`, which both loops check
immediately after every wake.

## Wake sources and their priorities

A waiting live task is woken by `nexool.injectEvent` only when
`event.priority <= 5`. Who injects what:

| Wake source | Event type | Priority | Trigger |
| --- | --- | --- | --- |
| Environment broadcast | `environment.server.crash` | 2 | `POST /api/env/event` `{ type: 'server.crash' }` — sent to every active live task. |
| Environment broadcast | `environment.server.degrade` / `.recover` | 4 | Same endpoint, other types. |
| User feedback | `user.feedback` | 2 | `POST /api/tasks/{id}/feedback`. |
| User stop | `task.stop` | 1 | `stopTask()` synthetic wake. |
| Manual injection | any type | default 5 | `POST /api/tasks/{id}/event` (priority ≤ 5 required to wake). |
| Console presets | `user.message`, `environment.custom`, `scheduled.force` | default 5 | Task Preview "Send event" dialog. |
| Scheduled timer | — | — | `liveIntervalMs` elapsed → `{ reason: 'timeout' }`. |

Events with priority > 5 are still persisted and streamed to the frontend — they just
don't interrupt the wait.

## What each wake does

After every wake the loop re-checks `stopFlag`, then computes a cycle deadline
(`Date.now() + taskTimeoutMs`) and dispatches:

- **Scheduled tick** (`reason: 'timeout'`): emits `observer.scheduled_tick`
  (priority 9, data `{ at }`), then runs one `liveObserveCycle` with the objective
  `Scheduled observation: keep making progress on: <goal>` plus the serialized fleet
  state. Environment-driven recovery runs afterwards if the goal mentions monitoring
  keywords (`monitor|recover|production|prod|api|server|health|web|db`) and any server is
  unhealthy/degraded.
- **`task.stop`** event: breaks the loop → task finalizes `stopped`.
- **`user.feedback`**: emits `observer.feedback_applied`, upserts a memory entry keyed
  `feedback_<taskId>` (tags `['feedback','live']`) when `learnFrom.feedback` is on, asks
  the LLM (10 s timeout) to revise the active subgoal — falling back to `correctAction`
  or a generic title — then emits `subgoal.created` (priority 3).
- **`environment.*`**: resolves the affected serverId from the event payload (or the
  first non-healthy server) and runs `runRepairPasses`.
- **Anything else**: one `liveObserveCycle` bounded by the cycle deadline — it is skipped
  entirely if the deadline already passed.

## Repair passes

`runRepairPasses(ctx, serverId)` is the automation sequence for recovery:

1. Create a `Recover server <id>` subgoal (`subgoal.created`, priority 3).
2. `server.health` — if healthy, subgoal completes, done (≤ 1 tool call).
3. `server.restart` — the environment flips the server to `restarting`; the fleet makes it
   healthy again after `RESTART_DELAY_MS` = 2500 ms and emits `env.server.recovered`.
4. The pass itself settles for `RESTART_SETTLE_MS` = 2700 ms, then re-checks
   `server.health`; success marks the subgoal completed and emits
   `observer.state_changed` (priority 3); failure marks the subgoal failed.
5. The pass is bounded to ~4 tool calls total.

## Interval tuning

`liveIntervalMs` comes from the task config (default from settings: 60 000 ms, clamp
1 000–3 600 000). Because wakes interrupt the timer, the effective observation rate is
`max(interval, event rate)` — a crash injected one second after a tick still wakes the
task instantly (verified in the v1.0.0 E2E run: crash → recovery subgoal → healthy again
in ~3 s).

## Limitations (honest)

- Scheduling is in-process: restarting the server loses pending timers; waiting tasks
  stay `waiting` in the DB but will not tick again after a restart.
- There is no persisted job queue and no multi-node coordination — one process, one
  scheduler per waiting task.

## See also

- [Live Mode](../modes/live-mode.md) — full lifecycle with diagrams.
- [Runtime](runtime.md) — timeouts and cancellation.
- [Events](events.md) — wake priority semantics.
