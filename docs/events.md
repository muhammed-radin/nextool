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
| 1–2 | Emergency / immediate wake | `task.stop_requested`, `env.server.crash`, `user.feedback`, `task.paused` (v1.0.6), `tool.approval.required/.denied/.timeout` (v1.0.6) |
| 3–4 | Important progress / recovery | `task.completed`, `subgoal.created` (recovery), `tool.timeout`, `core.decision`, `task.resumed` (v1.0.6), `tool.user_prompt.*` (v1.0.6) |
| 5–6 | Normal operational flow | `task.started`, `tool.started`, `observer.observed`, `live.event.queued/.processing/.dropped` (v1.0.6) |
| 7–8 | Informational / degraded diagnostics | `task.waiting`, `observer.verify_fallback`, `live.event.processed` (v1.0.6) |
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
| `task.paused` | 2 | v1.0.6: task suspended by the user — state preserved, no new autonomous actions; queued events retained. | — |
| `task.resumed` | 3 | v1.0.6: paused task continues from its preserved state (never a restart). | — |
| `task.completed` | 3 | Terminal success; message includes statusDetail + summary. | FinalResult |
| `task.failed` | 3 / 2 | Terminal failure; priority 2 when the task wrapper crashes (`RUNTIME_CRASH`). | FinalResult / — |
| `task.cancelled` | 3 | Task stopped by user (finalize path). | FinalResult |
| `task.stop_requested` | 1 | Stop endpoint called. | — |
| `goal.completed` | 3 | Goal verified achieved. | `{ reason, engine }` |
| `observer.scheduled_tick` | 9 | Live scheduled timer fired. | `{ at }` |
| `live.event.queued` | 6 | v1.0.6 multi-event mode: an event landed in the task's queue. | `{ seq, eventId, type, queueLength }` |
| `live.event.processing` | 6 | v1.0.6: the queue head is being processed (one-by-one, priority → arrival order). | `{ seq, type }` |
| `live.event.processed` | 7 | v1.0.6: a queued event finished its observe cycle. | `{ seq, type }` |
| `live.event.dropped` | 6 | v1.0.6: an event was dropped (queue full — lowest priority dropped first, or the incoming event lost to a higher-priority queue). Recorded, never silent. | `{ dropped?, droppedSeq?, incoming, priority? }` |

### Planner (`source: 'planner'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `planner.plan` | 5 | Plan stored on the task. v1.0.10: data carries `plannerType`; under the one-by-one strategy it is emitted once per planned step (1-step plan) so the Task Preview checklist refreshes. | `{ goal, steps: PlanStep[], plannerType? }` |
| `planner.plan_built` | 6 | Plan produced (LLM or deterministic fallback; message includes engine + ms). v1.0.10: data also carries `plannerType`. | `{ goal, steps, plannerType? }` |
| `planner.mode_selected` | **v1.0.10** | The task's planner strategy was resolved at creation (precedence task override → global default → `pre-plan`); the decision is persisted with the task config. | `{ plannerType, taskOverride: boolean, globalDefault, prePlanMaxSteps }` |
| `planner.one_by_one_step_planned` | **v1.0.10** | One-by-one strategy planned exactly ONE next step from the latest state. `source` is `llm` or `deterministic-fallback`; `discarded` counts extra steps the single-step sanitizer dropped (a `{"steps":[…]}` response keeps only the first valid step). | `{ plannerType, stepId, stepTitle, source: 'llm' \| 'deterministic-fallback', discarded }` |
| `planner.one_by_one_step_completed` | **v1.0.10** | The planned one-by-one step finished executing (tool + duration for the trace). | `{ plannerType, stepId, stepTitle, tool, durationMs }` |
| `planner.one_by_one_replanned` | **v1.0.10** | A one-by-one step FAILED — no blind retry: the failure was recorded/observed, the goal verified, and ONE replacement step planned with the failure context. After two consecutive failures of the same step, a third identical proposal is replaced by the failure-aware deterministic fallback. | `{ plannerType, stepId, stepTitle \| failedTool, reason, error }` |
| `planner.one_by_one_goal_reached` | **v1.0.10** | The goal verifier (which runs BEFORE every new planning call) confirmed completion — no further step is generated. In Live Mode the task CONTINUES across ticks (not torn down); `live` marks that context. | `{ plannerType, goal, live? }` |
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
| `tool.approval.required` | 2 | v1.0.6: a tool with `autoExecute: false` awaits a user decision; the task parks in `awaiting_approval`. | `{ approvalId, tool, params, purpose?, reason?, subgoal?, requestedAt }` |
| `tool.approval.allowed` | 3 | v1.0.6: user approved; execution proceeds. | `{ approvalId, tool }` |
| `tool.approval.denied` | 2 | v1.0.6: user denied; the tool is skipped, the task continues per plan. | `{ approvalId, tool }` |
| `tool.approval.timeout` | 2 | v1.0.6: no decision within 5 minutes — the task stops. | `{ approvalId, tool }` |
| `tool.execution.blocked` | 2 | v1.0.6: the tool was NOT executed (cause `user_denied` or `approval_timeout`). | `{ approvalId, tool, cause }` |
| `tool.user_alert` | 4 | v1.0.6: a tool called `await alert(message)` (runtime event, resolves immediately). | `{ executionId, toolName?, message }` |
| `tool.user_prompt.requested` | 3 | v1.0.6: a tool called `await prompt(...)` — pauses that tool only until answered/cancelled/120 s. | `{ promptId, executionId, toolName?, message, hasDefault }` |
| `tool.user_prompt.responded` | 4 | v1.0.6: the prompt was answered or cancelled. | `{ promptId, executionId, value?, cancelled }` |
| `tool.confirm.requested` | 2 | **v1.0.8**: a tool called `await confirm(...)` — shows the confirmation UI and pauses that tool until answered/cancelled/120 s (expiry → `false`). | `{ confirmId, executionId, toolName?, message, hasDefault }` |
| `tool.confirm.responded` | 3 | **v1.0.8**: the confirmation was answered — the tool ALWAYS receives a boolean. Task stop/cancellation resolves every pending confirmation as `false` (never `true`). | `{ confirmId, executionId, toolName?, accepted, cancelled, message }` |
| `notification.sent` | 2 / 4 / 6 | `notification.send` — priority maps to level: critical 2, warning 4, info 6. | `{ id, title, body, level }` |

### Environment (`source: 'environment'`)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `env.server.crash` | 2 | Virtual server crashed (fleet card / env event injection). | `{ serverId, health: 'unhealthy' }` |
| `env.server.degrade` | 4 | Server degraded. | `{ serverId, health: 'degraded' }` |
| `env.server.recovered` | 3 | Restart completed; healthy again. | `{ serverId, health: 'healthy' }` |

### System maintenance (`source: 'system'` — v1.0.7)

| Type | Pri | Purpose | data |
| --- | --- | --- | --- |
| `system.reset.started` | 2 | Application data reset began (persisted; intentionally cleared again by the reset itself). | — |
| `system.reset.completed` | 2 | Reset finished — the minimal audit record that REMAINS after the event history is cleared. | `{ cleared: { store: count… }, filesRemoved, failures }` |
| `system.reset.failed` | 2 | Reset transaction failed — nothing was silently half-deleted; the failure is reported. | — |
| `system.maintenance.cleanup` | 4 | Dependency-aware cleanup removed confirmed orphaned models/datasets. | `{ removedModels, removedDatasets, failed }` |

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
  the live SSE stream, newest last, with payload inspection. The v1.0.10 SSE refresh
  regex includes the new planner events (`planner.mode_selected`,
  `planner.one_by_one_step_planned/.step_completed/.replanned/.goal_reached`), so the
  Task Preview plan/checklist refreshes the moment a one-by-one step transitions (its
  per-step `planner.plan` events feed the same checklist).
- **runtime:// terminal** — source-colored lines in the terminal component.
- **Notification bell** — driven by `NotificationRecord`s (not raw events), but the
  `notification.sent` event mirrors each send into the stream.

## Querying events

- REST: `GET /api/tasks/{id}/events?since=&limit=` (ascending, limit default 200 / max
  500) and the SSE stream for live push.
- Storage: every event is a `TaskEvent` row (indexed by `[taskId, createdAt]` and
  `type`), so history survives restarts. The in-memory ring only powers SSE replay.
