---
title: Context
category: Data
order: 3
---

# Context

"Context" in NexTool is the composed view of everything a decision takes into account:
**Previous Context + Delta + Observation + Memory + History**. It exists in two forms:

1. The **runtime bundle** built each iteration (`buildContextBundle` in `loop.ts`) and
   fed to CoreModule.
2. The **inspectable composition** served by `GET /api/tasks/{id}/context` and rendered
   as five panels in Task Preview.

## ContextComposition (the API shape)

```jsonc
{
  "previousContext": {
    "goal": "…", "mode": "goal",
    "iteration": 2, "toolCalls": 2,
    "previousObservation": "…",       // second-to-last observation or null
    "previousAction": { "action": "server.health", "status": "completed", "at": "…" }
  },
  "delta": {
    "newObservation": "Server api-01 health: healthy (cpu 34%, mem 51%).",
    "lastAction": { "action": "server.health", "status": "completed", "at": "…" },
    "iterationDelta": 1,
    "activeSubgoal": "Recover server api-01"   // or null
  },
  "observation": { "message": "…", "at": "…" },   // lastObservation, or null before the first one
  "memory": [ { "key": "…", "value": {…}, "tags": "…", "updatedAt": "…" } ],  // ≤ 5 newest
  "history": [ { "action": "…", "status": "…", "result": {…}, "timestamp": "…" } ],  // ≤ 5 latest for this task
  "assembledAt": "2024-…"
}
```

### How each part is derived

| Part | Source | Semantics |
| --- | --- | --- |
| `previousContext` | Task `MainState` | The state as of *before* the latest step: iteration/toolCalls minus one, the second-to-last observation and action. Derived from real state history (the observations/actions rings), not fabricated. |
| `delta` | Task `MainState` | What the latest step changed: the newest observation, the last action, `iterationDelta: 1`, and the currently active subgoal. |
| `observation` | `state.lastObservation` | The Observer's latest sentence, with its timestamp; `null` for a task that hasn't executed anything yet. |
| `memory` | `MemoryEntry` (5 newest, ordered by `updatedAt`) | Only when `config.useMemory !== false`. Values are JSON-parsed for readability; tags stay as the raw string. |
| `history` | `HistoryEntry` for this task (5 latest) | The most recent tool executions with parsed results. |

### Composition rules in the runtime bundle

The bundle CoreModule actually sees is slightly leaner (`buildContextBundle`):

- `memory`: ≤ 5 entries as `{ key, value, updatedAt }` — only when `useMemory`.
- `history`: ≤ 5 entries as `{ action, status, result }` — this task's rows only.
- `stateSummary`: a compact JSON string with mode, iteration, tool call count, active
  subgoal title, plan step statuses (`step_1:completed,step_2:pending`, …) and fleet
  health (`api-01=healthy,…`).
- `lastObservation`: the newest observation sentence.

The same bundle is reused (and optionally overridden) for the single retry after a
failed execution — the override injects the failure message as the "last observation" so
the model conditions on its own error.

## Why context composition matters

- **Continuity** — decisions never start from a blank slate: the previous observation,
  prior actions and plan progress are always attached.
- **Grounding** — `expectedParams` decisions stay extractive because the objective plus
  context carries the verbatim values.
- **Recovery** — the retry path and Live Mode repair passes work because the delta
  (what just failed / what just crashed) is explicit.

## Inspecting context

- **Console**: Task Preview → context panels — *previous context*, *delta*, *new
  observation*, *memory refs* (count), *history refs* (count), each rendering JSON in an
  inset block.
- **API**: `GET /api/tasks/{id}/context` → 404 `NOT_FOUND` for unknown tasks; a valid
  but fresh task returns empty memory/history arrays and `observation: null`.

```bash
curl http://localhost:3000/api/tasks/task_1a2b3c4d/context
```

## Differences from MainState

The composition endpoint is a *view*, not the state itself. The authoritative state
(plan, subgoals, counters, rings of last 30 observations/actions) lives on the Task row
and is returned by `GET /api/tasks/{id}` as `state`. The context endpoint exists to
answer "what did the runtime know when it made this decision?" — the exact question the
five panels visualize.

## See also

- [Memory](memory.md) — what lands in the `memory` part.
- [History](history.md) — what lands in the `history` part.
- [Live Mode](../modes/live-mode.md) — context delta across cycles.
