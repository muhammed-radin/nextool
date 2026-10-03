---
title: Planner
category: Architecture
order: 3
---

# Planner

The planner turns a raw request into executable steps. Since **v1.0.10** there are TWO
planner strategies — the existing `pre-plan` planner (`src/lib/nexool/main/planner.ts`)
and the new one-by-one planner (`src/lib/nexool/main/planner-strategy.ts`) — selected
per task at creation (see [Planner modes (v1.0.10)](#planner-modes-v1010) below). The
pre-plan planner turns a request into an ordered, minimal plan before the loop starts,
and revises objectives mid-flight (dynamic subgoals live in `loop.ts`, feedback-driven
revision is described in [Live Mode](../modes/live-mode.md)).

## buildPlan(request, goal, toolDefs, reasoningLevel, taskId?)

**Input**: the raw request, the initial goal (defaults to the request), the enabled tool
definitions (name/description/category only — no handlers leak into the prompt), the task
reasoning level, and the task id for event attribution.

**Model call**: `z-ai-web-dev-sdk` chat completion, `thinking: { type: 'disabled' }`,
hard timeout **25 000 ms** (`PLANNER_TIMEOUT_MS`) via `Promise.race`. The system prompt
instructs:

- Decompose into minimal ordered steps, each one concrete operational action.
- Step shape: `{"title", "detail", "kind": "action"|"observation"|"verification",
  "parallelGroup": number}`.
- Truly independent steps share a `parallelGroup` number; dependent steps must not.
- Maximum steps (`MAX_STEPS`) — **v1.0.10: configurable** via `prePlanMaxSteps`
  (per task → global setting → central default 10, range 1–122; the previous hard-coded
  value was 8). See [Planner configuration (v1.0.10)](configuration.md#planner-configuration-v1010).
- Output STRICT JSON only: `{"goal": "<refined goal>", "steps": [...]}`.

**Sanitizing** (`sanitizeSteps`): at most `maxSteps` raw steps (v1.0.10 — resolved
`prePlanMaxSteps`, previously the hard-coded 8); titles are trimmed to 200 chars and
empty ones drop the step; `detail` is capped at 400 chars; `kind` must be one of
`action | observation | verification` (anything else becomes `action`); `parallelGroup`
is kept only if it is a positive finite number; ids are reassigned `step_1…step_n`; every
step starts `pending`.

**Fallback plan** (used when the SDK throws, times out, or returns unparseable/empty
JSON — the LLM path is never trusted blindly):

```json
[
  { "id": "step_1", "title": "Fulfill request via best available tool",
    "detail": "<original request>", "status": "pending", "kind": "action" },
  { "id": "step_2", "title": "Verify outcome and observe result",
    "status": "pending", "kind": "verification" }
]
```

The refined goal falls back to the input goal when the model omits one (capped 300
chars).

## Events emitted

v1.0.10: the two `plan_built` rows and `planner.plan` apply to the **pre-plan** strategy
(and `planner.plan` also fires once per planned step under one-by-one, so the Task
Preview refreshes — see [Planner modes](#planner-modes-v1010)); `plan_built`/`plan`
data now also carry `plannerType`. The one-by-one events are listed in
[Events](events.md#planner-source-planner).

| Event | Source | Priority | When |
| --- | --- | --- | --- |
| `planner.plan_built` | planner | 6 | After a successful LLM plan — message includes step count, `llm`, and elapsed ms; `data` carries `{ goal, steps }` (+ `plannerType` since v1.0.10). |
| `planner.plan_built` | planner | 6 | Same type for the fallback path — message says `deterministic fallback`. |
| `planner.plan` | planner | 5 | Emitted by `loop.runTask` once the plan is stored — message `Plan created: N step(s) for goal "…"`. One-by-one: emitted per planned step (1-step plan) so the Task Preview checklist refreshes. |
| `planner.parallel_batch` | planner | 5 | v1.0.3: a parallel batch was formed — message `"N independent tool call(s) detected — executing concurrently (cap M)"`; `data` carries `{ batchId, parallelGroup, tools, maxParallelToolCalls }`. |
| `planner.partial_failure` | planner | 4 | v1.0.3: some but not all calls of a parallel batch failed — the independent survivors were NOT cancelled; `data` carries `{ batchId }`. |
| `subgoal.created` | planner | 5 / 3 | Dynamic subgoals (goal loop), recovery subgoals (repair passes), and feedback-revised subgoals. |

## How the loop consumes the plan

- `firstPendingIndex` finds the first `pending | in_progress` step.
- `parallelGroupSteps` collects the consecutive pending **action** steps sharing that
  step's `parallelGroup`. With `parallelToolCalls` enabled (default) and a group of
  **≥ 2**:
  1. a `batchId` is minted and `planner.parallel_batch` announces the batch (with the
     configured `maxParallelToolCalls` cap),
  2. each step gets its own CoreModule decision,
  3. if **every** decision is a `tool_call`, all calls execute concurrently via
     `executeParallelBatch` (capped waves — see [Tool Runtime](../tools/tool-runtime.md));
     otherwise the group is reset to `pending` and handled sequentially instead.
- `parallelToolCalls: false` skips the parallel branch entirely — strictly sequential
  execution in plan order.
- Dependent steps never share a group, so they can never batch — the next group/step is
  a later iteration (a later wave in effect).
- `markStepByExecution` maps an execution status onto a step: `completed → completed`,
  `cancelled → skipped`, anything else → `failed`. If some but not all batch calls fail,
  `planner.partial_failure` is emitted and the survivors keep going.
- When the plan is exhausted but the goal is not yet verified, the loop requests a dynamic
  subgoal from the LLM (10 s timeout, strict JSON `{"done":true}` or
  `{"title","reason"}`); `done` completes the task honestly.

## Reasoning level

The level (1–6) is passed to the planner prompt as context. The only hard behavioral
switch is in the Observer (levels ≤ 2 use heuristic verification); the planner uses it as
soft guidance for how granular the decomposition should be.

## Failure behavior

Any planner failure is non-fatal: the deterministic fallback plan guarantees the loop can
start, and the fallback event makes the degradation visible in the Events view. Planning
time is also visible — the `planner.plan_built` message embeds elapsed milliseconds.
For one-by-one failure handling (no blind retries, replan with failure context,
endless-repetition guard) see [Failure handling (v1.0.10)](#failure-handling-v1010).
For **pre-plan** failure recovery (v1.0.11 — the failed step no longer costs a single
blind retry followed by a hard stop; the runtime recovers instead) see
[Pre-plan failure recovery (v1.0.11)](#pre-plan-failure-recovery-v1011) below.

## Planner modes (v1.0.10)

Two planner strategies exist and every task resolves to exactly one **at creation
time**:

- **`pre-plan`** (default, unchanged semantics) — plans several steps up front,
  executes them in order, stops early the moment the goal is verified, and discards the
  remaining steps.
- **`one-by-one`** (new in v1.0.10) — plans exactly ONE next step per call, using the
  latest observed state, executes it, observes, verifies the goal, then plans the next
  step. It never generates a hidden future list — there is no pre-computed plan to grow
  stale.

```text
PRE-PLAN (planner.ts — buildPlan)
┌────────────────────────────────────────────────────────────────┐
│ request + goal + tools ──► ONE LLM call                        │
│   └─► plan = [step_1 … step_N]   (N ≤ prePlanMaxSteps, ≤ 122)  │
│ loop:                                                          │
│   pick next pending step ──► execute ──► observe               │
│   └─► goal verified? ──► YES ► COMPLETE EARLY                  │
│         (remaining steps DISCARDED, never executed)            │
│        NO ► next step … (replan subgoals when exhausted)       │
└────────────────────────────────────────────────────────────────┘

ONE-BY-ONE (planner-strategy.ts — planOneByOneStep)
┌────────────────────────────────────────────────────────────────┐
│ loop (guarded by maxIterations / safetyLimit / taskTimeoutMs): │
│                                                                │
│   1. GOAL VERIFIER RUNS FIRST                                  │
│      └─► complete? ► planner.one_by_one_goal_reached ► DONE    │
│            (no further step is generated)                      │
│   2. plan ONE step  ──► planner.one_by_one_step_planned        │
│      (LLM step or deterministic fallback; exactly one)         │
│   3. execute the step ──► tool events                          │
│   4. observe the result (recorded, failures included)          │
│   5. verify goal ──► complete? ► goal_reached ► DONE           │
│   6. otherwise → back to 2 with the NEW state                  │
│                                                                │
│   on failure: NO blind retry — the failure is recorded and     │
│   observed, the goal is verified, then ONE step is REPLANNED   │
│   with the failure context (one_by_one_replanned)              │
└────────────────────────────────────────────────────────────────┘

LIVE MODE + ONE-BY-ONE
┌────────────────────────────────────────────────────────────────┐
│ tick / event wake:                                             │
│   plan ONE action from the CURRENT world state                 │
│   └─► execute ──► observe ──► goal check (evidence recorded)   │
│   the live task CONTINUES across ticks — it is NOT torn down   │
│   when the goal check passes; environment-driven repair passes │
│   are UNCHANGED for both planner types                         │
└────────────────────────────────────────────────────────────────┘
```

### Choosing a mode — override and precedence

Resolution precedence (highest wins):

```text
task config plannerType ('pre-plan' | 'one-by-one')
        ↓ unset →
global Settings.defaultPlannerType (default 'pre-plan')
        ↓ fallback →
'pre-plan'
```

The resolved planner type (and `prePlanMaxSteps`) is **persisted in the task's stored
config JSON at creation** — changing Settings later never switches an existing task's
strategy mid-flight. `planner.mode_selected` records the decision:
`{ plannerType, taskOverride, globalDefault, prePlanMaxSteps }`.

Configure per task in `POST /api/tasks` (`config.plannerType`,
`config.prePlanMaxSteps` — see [Configuration](configuration.md#planner-configuration-v1010))
or in the Task Console planner select; the global default lives in Settings →
**Planning**. Safeguards (`maxIterations`, `safetyLimit`, `taskTimeoutMs`) still bound
one-by-one loops exactly like pre-plan loops — a verification task hit `SAFETY_LIMIT`
at `maxIterations=12` as designed.

### Single-step contract and sanitizer

The one-by-one prompt requires the model to output **exactly one step**
`{"step": {"title", "detail", "kind"}}` (kind `action | observation | verification`).
`sanitizeOneStepResponse` enforces the contract defensively:

- A valid single step is kept (title trimmed to 200 chars, detail capped at 400, kind
  coerced to `action` when invalid, id assigned `step_<n>`, status `pending`).
- If the model ignores the contract and returns `{"steps":[…]}`, the sanitizer retains
  the **first valid step** and **discards the rest** — the count travels in the
  `planner.one_by_one_step_planned` event data as `discarded` (never silently dropped,
  never executed).
- An unparseable/empty response yields the deterministic one-step fallback (below).

One-by-one planning input (`buildOneByOneContext`) includes: the original request, the
goal, task mode, planner type, reasoning level, previous executed steps, previous
subgoals, recent observations (last 6), the latest tool result, executed actions,
iteration/toolCall counters, enabled tools, `knownFailures` (recent failure summaries),
constraints and a situational note — so every planning call sees the CURRENT state,
not a stale pre-computed list.

### Failure handling (v1.0.10)

One-by-one does **NOT blind-retry**. When a step fails:

1. The failure is recorded and observed (error-as-observation).
2. The goal verifier still runs — the failure may already satisfy the goal.
3. Otherwise ONE new step is planned **with the failure context** and
   `planner.one_by_one_replanned` is emitted:
   `{ plannerType, stepId, stepTitle | failedTool, reason, error }`.

**Endless-repetition guard:** after the same step fails twice in a row, a third
identical proposal is replaced by the failure-aware deterministic fallback step — the
loop can never spin on a known-bad action.

### Goal completion has priority

The goal verifier runs **before every new planning call**. When the goal is complete,
no further step is generated — `planner.one_by_one_goal_reached` fires
(`{ plannerType, goal, live? }`) and the loop stops (in Live Mode the task continues
to its wait instead of being torn down; the verification evidence is recorded).

### Fallback — never zero steps

Like pre-plan, one-by-one degrades deterministically
(`buildOneByOneFallbackStep`): a single-step fallback plan is always available.
It is **failure-aware** when `knownFailures` exist (names the failed tool / asks for an
alternative approach) and **latest-observation-aware** otherwise. The emitted
`planner.one_by_one_step_planned` marks `source: 'deterministic-fallback'` (vs
`'llm'`) — degradation is visible, and the planner never emits zero steps.

### Pre-plan failure recovery (v1.0.11)

Since v1.0.11 a failed or timed-out **pre-plan** step does not cost the old single blind
retry followed by a hard stop (`planner.retry` + `TOOL_FAILURE` in that branch are
superseded). The runtime runs a bounded recovery state machine instead
(`src/lib/nexool/main/recovery.ts`, one implementation, one call site in `loop.ts`):

```text
MAIN GOAL → PRE-PLAN → STEP n FAILS (failed / timeout)
     ↓
MAIN PLAN FROZEN — step n+1 never runs first; later steps never overtake it
     ↓
OBSERVE FAILURE → recovery subgoal created (subgoal.created)
     ↓
RECOVERY PRE-PLAN — the SAME buildPlan strategy, bounded
                     RECOVERY_PLAN_MAX_STEPS = 4 steps
     ↓
EXECUTE recovery steps sequentially (normal decide/execute/approval gate)
     ↓
OBSERVER VERIFIES (assessRecovery — the authority)
     ├─ resolved / main goal can safely continue → planner.main_plan_resumed
     ├─ still broken → retry up to task.recoveryMaxAttempts (2–4, default 4)
     └─ exhausted / unrecoverable → task ends honestly
```

- **One attempt** = observe the failure → create/revise the recovery subgoal → pre-plan
  the recovery → execute the recovery plan → verify. UI refreshes, SSE replays and
  ordinary planner events never increment the counter. Attempt counts are kept per
  failed step in a Map on the task run and persist across separate recovery entries.
- **Scope** — recovery applies ONLY to `plannerType: 'pre-plan'` goal tasks. One-by-one
  semantics are unchanged (it already replans from the latest state after every
  failure), and Live-Mode repair passes (`runRepairPasses`) are unchanged.
- **State-aware resume (never a blind index)** — recovery succeeds when the Observer
  establishes that the failed condition is resolved OR the main goal can safely
  continue. If the failed step's objective was satisfied, the step is marked
  `completed` (its detail gains `— resolved by recovery attempt N`); otherwise the step
  is **re-queued at its original position** (status back to `pending`) so its REAL
  re-execution verifies the fix. Completed steps are never repeated.
- **Exhaustion** — when `recoveryMaxAttempts` attempts have failed:
  `planner.recovery_exhausted` + `planner.main_plan_aborted` fire and the task ends
  honestly failed (errorState code `RECOVERY_EXHAUSTED`, stage `recovery`) with a
  statusDetail naming the failed step and the last failure.
- **Unrecoverable** — when the Observer judges the failure unrecoverable
  (recoverability `false`: `cannot_execute`, a clarification requirement, or an
  observer verdict), recovery aborts IMMEDIATELY — `RECOVERY_UNRECOVERABLE`, no wasted
  retry budget.
- **Stop/approval during recovery** — an approval timeout or a user stop during
  recovery stops the task (`RECOVERY_BLOCKED`). Pause/stop/approval gates stay
  interactive exactly as in normal execution.
- **Safeguards** — `taskTimeoutMs`, `safetyLimit`, `maxIterations`, stop/pause and the
  approval gate all remain active during recovery; every recovery execution goes through
  `recordExecution`, so safety-limit accounting includes recovery tool calls.
- **Attempts are configured, not hard-coded** — `task.recoveryMaxAttempts` (central
  limit: default 4, range 2–4), a Settings → Planning field and a per-task
  `config.recoveryMaxAttempts` (zod REJECTS out-of-range values with 400 — same
  contract as `prePlanMaxSteps`). See
  [Configuration](configuration.md#planner-configuration-v1010).

Recovery events (all `source: 'planner'`):
`planner.recovery_started`, `planner.recovery_plan_built`, `planner.recovery_attempt`,
`planner.recovery_succeeded`, `planner.recovery_failed`, `planner.recovery_exhausted`,
`planner.main_plan_resumed`, `planner.main_plan_aborted` — payload shapes in
[Events](events.md#planner-source-planner). The Task Preview renders a dedicated
**Recovery** panel (failed step, live recovery pre-plan, attempt counter, resume note
or honest exhausted message) — never hidden in the generic event list (see
[Frontend](frontend.md#v1011-frontend-changes)).

### File map

| File | Strategy | Contents |
| --- | --- | --- |
| `src/lib/nexool/main/planner.ts` | pre-plan (unchanged semantics) | `buildPlan` — the multi-step LLM decomposition + `sanitizeSteps` + fallback plan; `maxSteps` now resolved from `prePlanMaxSteps`. |
| `src/lib/nexool/main/planner-strategy.ts` | one-by-one (new in v1.0.10) | `resolvePlannerType` (precedence), `buildOneByOneContext` (state bundle), `planOneByOneStep` (single LLM call + events), `sanitizeOneStepResponse` / `sanitizeSingleStep` (single-step contract), `buildOneByOneFallbackStep` (deterministic fallback). |
| `src/lib/nexool/main/recovery.ts` | pre-plan recovery (**v1.0.11**) | the bounded recovery state machine: frozen main plan, recovery subgoal + own pre-plan (`RECOVERY_PLAN_MAX_STEPS = 4`), sequential execution through the normal gates, Observer `assessRecovery` verification, state-aware resume (mark-completed vs re-queue-at-position), per-failed-step attempt counting, exhaustion/unrecoverable/blocked outcomes. |

### Worked event timeline (verified acceptance run)

A one-by-one task "Check the health of server api-01" produced, in order:

```text
planner.mode_selected            { plannerType: 'one-by-one', taskOverride: true,
                                   globalDefault: 'pre-plan', prePlanMaxSteps: 10 }
planner.one_by_one_step_planned  { plannerType: 'one-by-one', stepId: 'step_1',
                                   stepTitle: 'Check the health of server api-01',
                                   source: 'llm', discarded: 0 }
tool.started / tool.completed    server.health  (params { serverId: 'api-01' })
planner.one_by_one_step_completed{ plannerType: 'one-by-one', stepId: 'step_1',
                                   stepTitle: 'Check the health of server api-01',
                                   tool: 'server.health', durationMs: <measured> }
observer.observed                Server api-01 health: healthy …
planner.one_by_one_goal_reached  { plannerType: 'one-by-one', goal: 'Check the health
                                   of server api-01' }
task.completed                   (goal verified after exactly one planned step)
```

`planner.plan` (1-step) fired alongside each `one_by_one_step_planned` so the Task
Preview plan checklist stayed in sync. Pre-plan tasks emit the familiar
`planner.plan_built` → `planner.plan` pair instead.
