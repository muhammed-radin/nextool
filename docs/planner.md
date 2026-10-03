---
title: Planner
category: Architecture
order: 3
---

# Planner

`src/lib/nexool/main/planner.ts` turns a raw request into an ordered, minimal plan before
the loop starts, and revises objectives mid-flight (dynamic subgoals live in `loop.ts`,
feedback-driven revision is described in [Live Mode](../modes/live-mode.md)).

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
- Maximum **8 steps** (`MAX_STEPS`).
- Output STRICT JSON only: `{"goal": "<refined goal>", "steps": [...]}`.

**Sanitizing** (`sanitizeSteps`): at most 8 raw steps; titles are trimmed to 200 chars and
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

| Event | Source | Priority | When |
| --- | --- | --- | --- |
| `planner.plan_built` | planner | 6 | After a successful LLM plan — message includes step count, `llm`, and elapsed ms; `data` carries `{ goal, steps }`. |
| `planner.plan_built` | planner | 6 | Same type for the fallback path — message says `deterministic fallback`. |
| `planner.plan` | planner | 5 | Emitted by `loop.runTask` once the plan is stored — message `Plan created: N step(s) for goal "…"`. |
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
