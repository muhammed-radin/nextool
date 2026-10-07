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

Priorities encode urgency for ORDERING and display — **changed in v1.0.14: priority no
longer has a runtime wake effect.** The old rule ("any injected event with priority ≤ 5
wakes a waiting Live task") was REMOVED in v1.0.14 — every injected event now wakes a
waiting Live task immediately regardless of priority (see
[Live Mode](live-mode.md#immediate-event-reaction-v1014)). Priority remains the
queue order (priority ascending, then arrival sequence) and the severity metadata of
the stream. The scale:

| Range | Meaning | Examples |
| --- | --- | --- |
| 1–2 | Emergency / immediate wake | `task.stop_requested`, `env.server.crash`, `user.feedback`, `task.paused` (v1.0.6), `tool.approval.required/.denied/.timeout` (v1.0.6) |
| 3–4 | Important progress / recovery | `task.completed`, `subgoal.created` (recovery), `tool.timeout`, `core.decision`, `task.resumed` (v1.0.6), `tool.user_prompt.*` (v1.0.6) |
| 5–6 | Normal operational flow | `task.started`, `tool.started`, `observer.observed`, `event.queued/.processing/.rejected` (v1.0.14; the retired v1.0.6 `live.event.*` types used these priorities) |
| 7–8 | Informational / degraded diagnostics | `task.waiting`, `observer.verify_fallback`, `event.completed/.received/.admitted` (v1.0.14 lifecycle records) |
| 9 | Scheduled ticks | `observer.scheduled_tick` |

## The event lifecycle family (v1.0.14)

Every event injected into a live task (`POST /api/tasks/{id}/event`, feedback,
environment broadcasts, console presets) moves through an **observable lifecycle**,
emitted as first-class `event.*` runtime events (`source: 'runtime'`, via
`emitEventLifecycle` in `eventbus.ts`). Admission decisions are never silent —
Events, Task Preview and Live Monitor render them. Each record's data carries
`{ eventId, eventType, lifecycle, reason? , …extra }`.

| Type | Pri | Purpose | data (beyond the common shape) |
| --- | --- | --- | --- |
| `event.received` | 8 | The event arrived at `injectEvent` — the first lifecycle record, emitted for EVERY injected event. | — |
| `event.admitted` | 8 | Accepted for the live loop: pushed to the run handle's inbox and the wait is interrupted immediately (v1.0.14 — regardless of priority). | — |
| `event.rejected` | 6 | NOT accepted — always with an observable `reason`: queue-off while an action runs ("Live action already running and Read & Act All Events is disabled."), task stopped, queue full (incoming lost to a higher-priority queue), or displaced from a full queue by a higher-priority event (carries `droppedSeq`). | `{ reason, incoming?, droppedSeq?, priority? }` |
| `event.ignored` | 8 | Reserved admission outcome (e.g. non-live or inapplicable targets) — part of the canonical state set. | — |
| `event.queued` | 8 | "Read & Act All Events" mode: the event entered the persisted task queue (`state.eventQueue`). | `{ seq, queueLength }` |
| `event.processing` | 8 | The queue head (or the single-event path) is being processed — one observe/understand/act/finish cycle. | `{ seq? }` |
| `event.completed` | 7 | The event's cycle finished (status `processed` in the queue). | `{ seq? }` |
| `event.failed` | 5 | The event's cycle threw — recorded with the error and the NEXT queued event proceeds (no deadlock, §32). | `{ reason, seq? }` |
| `event.cancelled` | 6 | Task stop flushed the event (inbox event or persisted queue entry): "Task stopped by user — … cancelled." | `{ reason, seq? }` |

Lifecycle paths:

```text
injectEvent → event.received
    ├─ queue-off + action running / stopped → event.rejected (reason)
    ├─ Read & Act All Events → event.admitted → event.queued → event.processing
    │                            → event.completed | event.failed
    └─ single-event mode → event.admitted → event.processing → event.completed | event.failed
stop during processing → remaining events: event.cancelled
```

**Retired types:** the v1.0.6 `live.event.queued` / `live.event.processing` /
`live.event.processed` / `live.event.dropped` event types were **REPLACED by this
`event.*` family in v1.0.14** — they are documented below only for history. The queue
data shape (`seq`, 16 KiB payload guard, processed-history trim to 10) is unchanged.

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
| `live.event.queued` | 6 | **RETIRED in v1.0.14** (replaced by `event.queued`): v1.0.6 multi-event mode — an event landed in the task's queue. | `{ seq, eventId, type, queueLength }` |
| `live.event.processing` | 6 | **RETIRED in v1.0.14** (replaced by `event.processing`): v1.0.6 — the queue head is being processed (one-by-one, priority → arrival order). | `{ seq, type }` |
| `live.event.processed` | 7 | **RETIRED in v1.0.14** (replaced by `event.completed`): v1.0.6 — a queued event finished its observe cycle. | `{ seq, type }` |
| `live.event.dropped` | 6 | **RETIRED in v1.0.14** (replaced by `event.rejected`): v1.0.6 — an event was dropped (queue full — lowest priority dropped first, or the incoming event lost to a higher-priority queue). Recorded, never silent. | `{ dropped?, droppedSeq?, incoming, priority? }` |

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
| `planner.retry` | 4 | Tool failed; one retry with error-as-observation. **v1.0.11: superseded in the pre-plan failure branch** — a failed pre-plan step now enters the bounded recovery state machine (see the recovery events below). The event type itself remains in the catalog. | `{ tool, error }` |
| `planner.recovery_started` | 3 | **v1.0.11**: a pre-plan step failed/timed out — the main plan is FROZEN and a recovery subgoal was created. | `{ failedStepId?, failedStepTitle, failedTool?, attempt, maxAttempts, reason }` |
| `planner.recovery_plan_built` | 4 | **v1.0.11**: the recovery subgoal's OWN pre-plan was built (same `buildPlan` strategy, ≤ `RECOVERY_PLAN_MAX_STEPS` = 4 steps). | `{ attempt, maxAttempts, subgoalId, steps: [{ id, title, kind }] }` |
| `planner.recovery_attempt` | 4 | **v1.0.11**: the recovery attempt begins executing its steps sequentially. | `{ attempt, maxAttempts, stepCount }` |
| `planner.recovery_succeeded` | 3 | **v1.0.11**: the Observer verified the failed condition resolved (or the main goal can safely continue) — the main plan resumes state-aware. | `{ failedStepId?, attempt, maxAttempts, reason, resumeNote? }` |
| `planner.recovery_failed` | 4 | **v1.0.11**: the recovery attempt failed (execution status, unresolved assessment or an abort reason). Further attempts follow while the budget lasts. | `{ failedStepId?, failedStepTitle?, attempt, maxAttempts, reason }` |
| `planner.recovery_exhausted` | 2 | **v1.0.11**: all `recoveryMaxAttempts` (2–4) attempts failed — the task ends honestly (`RECOVERY_EXHAUSTED`). | `{ failedStepId?, attempts, maxAttempts, reason }` |
| `planner.main_plan_resumed` | 3 | **v1.0.11**: recovery succeeded; the message carries the resume note (failed step marked completed OR re-queued at its original position). | `{ failedStepId?, attempt, maxAttempts, resumeNote }` |
| `planner.main_plan_aborted` | 2 | **v1.0.11**: the main plan was aborted — recovery exhausted, or the Observer judged the failure unrecoverable (`RECOVERY_UNRECOVERABLE`), or stop/blocked (`RECOVERY_BLOCKED`). | `{ failedStepId?, attempts?, maxAttempts? }` |
| `subgoal.created` | 5 / 3 | Dynamic subgoal (5), recovery or feedback-revised subgoal (3). A **v1.0.11** recovery subgoal carries its own pre-plan (see the recovery events above). | `{ subgoal: Subgoal }` |

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
| `tool.user_alert` | 4 | v1.0.6 emitted; **interactive since v1.0.14** — a tool called `await alert(message)` and the runtime now shows an OK dialog that PAUSES that tool until the operator dismisses it (120 s auto-dismiss). | `{ alertId, executionId, toolName?, message }` |
| `tool.user_alert.dismissed` | 4 | **v1.0.14**: the alert was dismissed (operator OK, task stop, or the 120 s auto-dismiss) — the tool resumes. Served by `GET/POST /api/alerts`. | `{ alertId, executionId?, reason? }` |
| `tool.user_prompt.requested` | 3 | v1.0.6: a tool called `await prompt(...)` — pauses that tool only until answered/cancelled/120 s. | `{ promptId, executionId, toolName?, message, hasDefault }` |
| `tool.user_prompt.responded` | 4 | v1.0.6: the prompt was answered or cancelled. | `{ promptId, executionId, value?, cancelled }` |
| `tool.confirm.requested` | 2 | **v1.0.8**: a tool called `await confirm(...)` — shows the confirmation UI and pauses that tool until answered/cancelled/120 s (expiry → `false`). | `{ confirmId, executionId, toolName?, message, hasDefault }` |
| `tool.confirm.responded` | 3 | **v1.0.8**: the confirmation was answered — the tool ALWAYS receives a boolean. Task stop/cancellation resolves every pending confirmation as `false` (never `true`). | `{ confirmId, executionId, toolName?, accepted, cancelled, message }` |
| `tool.auto_execution` | 6 | **v1.0.11**: a LOWER layer of the auto-execution hierarchy decided (tool config or task console — the global-forced case is the documented default and stays silent). Makes the effective source observable. Approval flows (`tool.approval.required/allowed/denied/timeout` → `tool.execution.blocked`) are unchanged. | `{ tool, enabled: true, source: 'tool' \| 'task' }` |
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
| `user.message` | default 5 | Task Preview "Send event" preset — and the **live conversation channel** (v1.0.14 §8): the message reaches the observe/decide pipeline verbatim; the cycle is immediate. | Immediate observe/act cycle (live conversation turn). |
| `environment.custom` | default 5 | Task Preview preset | Generic wake → one observe cycle. |
| `scheduled.force` | default 5 | Task Preview preset | Wakes the live wait immediately (acts like an early tick). |
| `task.stop` | 1 | Synthetic wake built by `stopTask` | Live wait loop breaks; task finalizes `stopped`. |
| *(any custom type)* | 1–9 | `POST /api/tasks/{id}/event` | Persisted + broadcast; **wakes live tasks IMMEDIATELY regardless of priority (v1.0.14 — the priority ≤ 5 gate was removed)**; the full event body travels into the decision context (`CONTEXT.trigger`). |

## Frontend representation

- **Events view** — filterable table: source select, type search, minimum-priority slider
  (default shows all, i.e. priority ≥ 1), per-source count chips, expandable rows with the
  JSON payload (`JsonBlock`).
- **Source dots** — `SOURCE_COLORS` maps each of the 8 sources to a stable dot color
  (slate/cyan family); type chips use a reduced label (`tool.completed → COMPLETED`).
- **Task Preview timeline** — events of the selected task, merged from REST backfill and
  the live SSE stream, newest last, with payload inspection. The v1.0.10 SSE refresh
  regex includes the one-by-one planner events (`planner.mode_selected`,
  `planner.one_by_one_step_planned/.step_completed/.replanned/.goal_reached`); **v1.0.11
  extends it with all eight recovery events** (`planner.recovery_started`,
  `planner.recovery_plan_built`, `planner.recovery_attempt`, `planner.recovery_succeeded`,
  `planner.recovery_failed`, `planner.recovery_exhausted`, `planner.main_plan_resumed`,
  `planner.main_plan_aborted`) **and `tool.auto_execution`** — the Task Preview Recovery
  panel and plan checklist refresh the moment a recovery transition happens (its
  per-step `planner.plan` events feed the same checklist). **v1.0.14: the `event.*`
  lifecycle family and `tool.user_alert.dismissed` render in the same timeline —
  admission/rejection/completion of every live event is directly visible.**
- **runtime:// terminal** — source-colored lines in the terminal component.
- **Notification bell** — driven by `NotificationRecord`s (not raw events), but the
  `notification.sent` event mirrors each send into the stream.

## Querying events

- REST: `GET /api/tasks/{id}/events?since=&limit=` (ascending, limit default 200 / max
  500) and the SSE stream for live push.
- Storage: every event is a `TaskEvent` row (indexed by `[taskId, createdAt]` and
  `type`), so history survives restarts. The in-memory ring only powers SSE replay.
