---
title: Goal Mode
category: Modes
order: 1
---

# Goal Mode

Goal Mode is the default mode: a finite pipeline that decomposes a request, executes
tools, observes results and terminates as soon as the goal is verified — or honestly
reports why it could not finish. The mode is used **exactly as provided**; the runtime
never promotes a goal task to live.

## Lifecycle overview

```mermaid
sequenceDiagram
    participant U as Client (API/Console)
    participant M as Main (nexool.ts)
    participant L as Goal Loop (loop.ts)
    participant P as Planner
    participant C as CoreModule
    participant T as Tool Runtime
    participant O as Observer

    U->>M: POST /api/tasks { request, config }
    M->>M: validate + clamp config, row status=queued
    M-->>U: 201 TaskDetail (async execution starts)
    M->>L: runTask (fire-and-forget)
    L->>P: buildPlan(request, goal, toolDefs)
    P-->>L: refined goal + ≤8 steps (fallback plan on failure)
    L->>L: persist plan, emit planner.plan

    loop until verified / limits / stop
        L->>L: pick objective (subgoal or next plan step / parallel group)
        L->>C: decide(objective, context bundle)
        C-->>L: tool_call | no_tool | clarification | cannot_execute | stop
        alt tool_call
            L->>T: executeTool(tool, params, timeout+abort)
            T-->>L: ToolExecution (never throws)
            L->>O: interpret(execution)
            O-->>L: observation sentence
            L->>O: checkGoalComplete(goal, observation)
            O-->>L: complete? (llm-core or heuristic)
        else failed execution (pre-plan)
            L->>L: FREEZE main plan → recovery subgoal + own pre-plan →
                  execute → verify (≤ task.recoveryMaxAttempts attempts)
        else failed execution (one-by-one)
            L->>C: re-decide with error as observation (replan, no blind retry)
        else plan exhausted
            L->>P: proposeNextSubgoal (LLM, 10s)
        end
    end

    L->>M: finalize(FinalResult, status)
    M-->>U: terminal state via GET /api/tasks/{id} + SSE events
```

## Phase by phase

1. **Understand / create** — request validated (≤ 32 000 chars since v1.0.11, raised
   from 8 000 for large Markdown descriptions), config clamped, task row
   created, `task.created` emitted, execution fire-and-forget.
2. **Plan** — v1.0.10: the task's **planner strategy** decides how steps come into
   existence. `pre-plan` (default) runs the LLM decomposition below (max
   `prePlanMaxSteps`, optional `parallelGroup` per step, refined goal; deterministic
   2-step fallback guarantees the loop can start). `one-by-one` instead plans exactly
   ONE next step per cycle from the latest state — see
   [Planner modes (v1.0.10)](planner.md#planner-modes-v1010). Per-task
   `config.plannerType` overrides the global default and is persisted at creation.
3. **Select tool + generate params** — CoreModule picks ONE tool per objective and
   produces extractive/constructive parameters (see
   [CoreModule](../ai-core/core-module.md)).
4. **Execute** — through the tool runtime with `toolTimeoutMs`, abort signal, stats and
   history. With `parallelToolCalls` on (default), ≥ 2 consecutive pending action steps
   sharing a `parallelGroup` execute **concurrently** via `executeParallelBatch` — one
   decision per step (if any is not a `tool_call`, the group falls back to sequential
   handling), concurrency capped by `maxParallelToolCalls` (1–8, default 4), one sibling
   failing never cancels the others. Sequential execution remains the fallback and the
   `parallelToolCalls: false` path. **v1.0.11:** when a pre-plan step FAILS, the loop
   no longer blind-retries once and hard-stops — the main plan is FROZEN and a bounded
   recovery state machine runs (see
   [Planner](planner.md#pre-plan-failure-recovery-v1011)); one-by-one tasks keep their
   replan-from-current-state failure handling.
5. **Observe** — `interpret` produces an operational sentence; the observation is stored
   (ring of 30), emitted (`observer.observed`) and fed into the next decision.
6. **Update state** — plan steps marked completed/failed/skipped, counters persisted,
   active subgoal completed when its action succeeds.
7. **Replan** — plan exhausted but goal unverified? The loop asks the LLM for the next
   dynamic subgoal (10 s timeout). `{"done":true}` ends the task honestly.
8. **Complete** — `checkGoalComplete` (LLM at levels 3–6, success-marker heuristic at
   levels ≤ 2) gates the terminal `completed` status.

## Worked example (real E2E run)

Request: `Check the health of server api-01` (goal mode, defaults).

| Step | What happened |
| --- | --- |
| Plan | LLM produced steps including "Check the health of server api-01" (action) and a verification step. |
| Decision 1 | `core.decision`: `tool_call server.health` with `{"serverId":"api-01"}` (extractive), confidence ~0.95, engine llm-core. |
| Execution | `server.health` drifted + reported: `{ serverId: 'api-01', health: 'healthy', cpu: 34, memory: 51, … }`. |
| Observation | `Server api-01 health: healthy (cpu 34%, mem 51%).` |
| Verify | Goal check → complete. Events `observer.state_changed` + `goal.completed`. |
| Final | `finalResult.status = 'completed'`, summary = the observation, duration a few seconds. |

Failure paths from the same run: a typo request (`moniter the server api-01 and infrom
me…`) still completed; a request with no matching tool terminated honestly (`no_tool`,
informational) rather than inventing an answer.

## Termination matrix

| Trigger | Task status | finalResult.status | errorState |
| --- | --- | --- | --- |
| Goal verified / plan + subgoals done | completed | completed | — |
| Informational `no_tool` | completed | completed | — |
| CoreModule `stop` | stopped | stopped | — |
| User stop | stopped | stopped | — |
| Non-informational `no_tool` | failed | failed | `NO_TOOL` |
| `clarification_required` | failed | failed | `CLARIFICATION_REQUIRED` |
| `cannot_execute` | failed | failed | `NO_CAPABLE_TOOL` |
| Tool failed twice (legacy pre-v1.0.11 behavior; pre-plan failures now recover first — see the rows below) | failed | failed | `TOOL_FAILURE` |
| Pre-plan step unrecoverable after `recoveryMaxAttempts` attempts (v1.0.11) | failed | failed | `RECOVERY_EXHAUSTED` (stage `recovery`) |
| Observer judged the failure unrecoverable (v1.0.11) | failed | failed | `RECOVERY_UNRECOVERABLE` (immediate abort — no wasted retry budget) |
| Stop / approval timeout during recovery (v1.0.11) | failed / stopped | failed / stopped | `RECOVERY_BLOCKED` |
| `maxIterations` / `safetyLimit` hit | failed | limit_reached | `SAFETY_LIMIT` |
| `taskTimeoutMs` exceeded | failed | limit_reached | `TIMEOUT` |
| Loop crash | failed | failed | `RUNTIME_ERROR` / `RUNTIME_CRASH` |

## Configuration knobs that matter here

`reasoningLevel` (observer switches to heuristic verification at ≤ 2), `enabledTools`
(allow-list enforced post-decision), `maxIterations`, `safetyLimit`, `maxSubtoolCalls`,
`taskTimeoutMs`, `toolTimeoutMs`, `useMemory`, `autoExecuteSubtools`,
`parallelToolCalls` + `maxParallelToolCalls` (v1.0.3 concurrency policy),
**v1.0.10**: `plannerType` + `prePlanMaxSteps` (planner strategy and pre-plan step cap —
see [Planner configuration](configuration.md#planner-configuration-v1010)), and
**v1.0.11**: `recoveryMaxAttempts` (recovery attempt budget per failed pre-plan step,
2–4 — see [Recovery configuration](configuration.md#recovery-configuration-v1011)) — all
documented in [Configuration](../getting-started/configuration.md).

## See also

- [Main](../architecture/main.md) — loop internals.
- [Live Mode](live-mode.md) — the continuous counterpart.
- [Tool Runtime](../tools/tool-runtime.md) — execution, parallelism, retry semantics.
