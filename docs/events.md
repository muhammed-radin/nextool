---
title: Events
category: Architecture
order: 5
---

# Events

Everything the runtime does is observable. All activity flows through the event manager
(`src/lib/nexool/eventbus.ts`), which:

1. Builds a `NexToolEvent` (`evt_<base36 time>_<rand>`),
2. Appends it to an in-memory ring buffer (last 500, newest last),
3. Notifies in-process subscribers (SSE builder),
4. Persists it to the `TaskEvent` table (fire-and-forget; failure only logs).

```ts
interface NexToolEvent {
  id: string;
  taskId?: string;
  type: string;          // dotted taxonomy, e.g. tool.completed
  source: EventSource;   // runtime | planner | observer | core | tool | environment | user | system
  message: string;       // human-readable one-liner
  data?: Record<string, unknown>;
  priority: number;      // 1 emergency … 9 scheduled tick
  createdAt: string;     // ISO timestamp
}
```

## Priority semantics

Priorities encode urgency, and they have a runtime effect: **any injected event with
priority ≤ 5 wakes a waiting Live task**. The scale:

| Range | Meaning | Examples |
| --- | --- | --- |
| 1–2 | Emergency / immediate wake | `task.stop_requested`, `env.server.crash`, `user.feedback` |
| 3–4 | Important progress / recovery | `task.completed`, `subgoal.created` (recovery), `tool.timeout`, `core.decision` |
| 5–6 | Normal operational flow | `task.started`, `tool.started`, `observer.observed` |
| 7–8 | Informational / degraded diagnostics | `task.waiting`, `observer.verify_fallback` |
| 9 | Scheduled ticks | `observer.scheduled_tick` |

## Complete catalog of emitted event types

Every `emitEvent` call in the runtime, grouped by source. Payload shapes come from the
actual call sites.

### Runtime (`source: 'runtime'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `task.created` | 6 | Task accepted and queued. | `{ taskId, mode, reasoningLevel }` |
| `task.started` | 5 | Loop entered; mode + level announced. | — |
| `task.waiting` | 7 | Live task parked; scheduled tick interval announced. | — |
| `task.completed` | 3 | Terminal success; message includes statusDetail + summary. | FinalResult |
| `task.failed` | 3 / 2 | Terminal failure; priority 2 when the task wrapper crashes (`RUNTIME_CRASH`). | FinalResult / — |
| `task.cancelled` | 3 | Task stopped by user (finalize path). | FinalResult |
| `task.stop_requested` | 1 | Stop endpoint called. | — |
| `goal.completed` | 3 | Goal verified achieved. | `{ reason, engine }` |
| `observer.scheduled_tick` | 9 | Live scheduled timer fired. | `{ at }` |

### Planner (`source: 'planner'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `planner.plan` | 5 | Plan stored on the task. | `{ goal, steps: PlanStep[] }` |
| `planner.plan_built` | 6 | Plan produced (LLM or deterministic fallback; message includes engine + ms). | `{ goal, steps }` |
| `planner.parallel_batch` | 5 | v1.0.3: ≥ 2 independent same-group steps announced for concurrent execution (`"N independent tool call(s) detected — executing concurrently (cap M)"`). | `{ batchId, parallelGroup, tools, maxParallelToolCalls }` |
| `planner.partial_failure` | 4 | v1.0.3: some but not all calls of a parallel batch failed — independent survivors continued. | `{ batchId }` |
| `planner.retry` | 4 | Tool failed; one retry with error-as-observation. | `{ tool, error }` |
| `subgoal.created` | 5 / 3 | Dynamic subgoal (5), recovery or feedback-revised subgoal (3). | `{ subgoal: Subgoal }` |

### Core (`source: 'core'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `core.decision` | 4 | Every CoreModule decision; message `core → <status> [tool] (conf x.xx, engine)`. | full CoreModuleOutput + `objective` |
| `core.clarification` | 3 | Decision asked for missing parameters. | `{ missing: string[], reason }` |

### Observer (`source: 'observer'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `observer.observed` | 6 | Interpretation of each execution. | — |
| `observer.state_changed` | 4 / 3 | Goal verified; server recovered after restart. | — |
| `observer.verify_fallback` | 8 | LLM verification down; heuristic used. | — |
| `observer.event_wake` | 5 | Live task woke on an event. | `{ eventId, type }` |
| `observer.feedback_applied` | 3 | User feedback processed. | — |

### Tool (`source: 'tool'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `tool.started` | 6 | Execution begins. Inside a parallel batch the message carries a `(parallel batch)` suffix. | `{ executionId, tool, params }` + `batchId`/`parallelGroup` when batched (v1.0.3) |
| `tool.completed` | 6 | Execution finished OK. | full ToolExecution |
| `tool.failed` | 5 | Execution failed (unknown tool, invalid params, handler error). | full ToolExecution |
| `tool.timeout` | 4 | Execution exceeded timeout. | full ToolExecution |
| `tool.cancelled` | 5 | Aborted (task stop). | full ToolExecution |
| `notification.sent` | 2 / 4 / 6 | `notification.send` — priority maps to level: critical 2, warning 4, info 6. | `{ id, title, body, level }` |

### Environment (`source: 'environment'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `env.server.crash` | 2 | Virtual server crashed (fleet card / env event injection). | `{ serverId, health: 'unhealthy' }` |
| `env.server.degrade` | 4 | Server degraded. | `{ serverId, health: 'degraded' }` |
| `env.server.recovered` | 3 | Restart completed; healthy again. | `{ serverId, health: 'healthy' }` |

### Injected events (via API — `user` / `environment` sources)

| Type | Pri | Injected by | Effect |
| --- | --- | --- | --- |
| `user.feedback` | 2 | `POST /api/tasks/{id}/feedback` | Live Mode: stores memory (`feedback_<taskId>`), LLM-revises the active subgoal, emits `subgoal.created` + `observer.feedback_applied`. |
| `environment.server.crash` / `.degrade` / `.recover` | 2 / 4 / 4 | `POST /api/env/event` broadcast to all active live tasks | Live Mode: immediate `runRepairPasses` recovery on the affected server. |
| `user.message` | default 5 | Task Preview "Send event" preset | Generic wake → one observe cycle. |
| `environment.custom` | default 5 | Task Preview preset | Generic wake → one observe cycle. |
| `scheduled.force` | default 5 | Task Preview preset | Wakes the live wait immediately (acts like an early tick). |
| `task.stop` | 1 | Synthetic wake built by `stopTask` | Live wait loop breaks; task finalizes `stopped`. |
| *(any custom type)* | 1–9 | `POST /api/tasks/{id}/event` | Persisted + broadcast; wakes live tasks when priority ≤ 5. |

## Frontend representation

- **Events view** — filterable table: source select, type search, minimum-priority slider
  (default shows all, i.e. priority ≥ 1), per-source count chips, expandable rows with the
  JSON payload (`JsonBlock`).
- **Source dots** — `SOURCE_COLORS` maps each of the 8 sources to a stable dot color
  (slate/cyan family); type chips use a reduced label (`tool.completed → COMPLETED`).
- **Task Preview timeline** — events of the selected task, merged from REST backfill and
  the live SSE stream, newest last, with payload inspection.
- **runtime:// terminal** — source-colored lines in the terminal component.
- **Notification bell** — driven by `NotificationRecord`s (not raw events), but the
  `notification.sent` event mirrors each send into the stream.

## Querying events

- REST: `GET /api/tasks/{id}/events?since=&limit=` (ascending, limit default 200 / max
  500) and the SSE stream for live push.
- Storage: every event is a `TaskEvent` row (indexed by `[taskId, createdAt]` and
  `type`), so history survives restarts. The in-memory ring only powers SSE replay.
