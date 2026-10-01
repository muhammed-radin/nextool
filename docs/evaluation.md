---
title: Evaluation
category: AI Core
order: 6
---

# Evaluation

How NexTool evaluates decision quality today — and the concrete benchmark plan that
turns imported datasets into numbers.

## Current state (honest)

- There is **no automated evaluation runner** in v1.0.1. No script computes
  accuracy/F1 over a dataset, and none of the REST endpoints return aggregate quality
  metrics.
- What exists today:
  - **Per-decision visibility** — every CoreModule decision is a persisted event
    (`core.decision`) with `status`, `tool`, `params`, `confidence`, `engine`,
    `latencyMs` and the objective it was given.
  - **Outcome truth** — every tool execution lands in `HistoryEntry` with its status
    (`completed | failed | timeout | cancelled`), so "did the chosen call actually
    work" is answerable per task.
  - **Live metrics** — `coreCalls`, average latency and a rolling 50-decision latency
    series (event-bus metrics, exposed via `/api/system` and `/api/models`).
  - **Datasets with expectations** — `expectedTool` / `expectedParams` / `split` fields
    ready to be scored against (see [Datasets](datasets.md)).

The verification loop is itself a lightweight evaluator: `checkGoalComplete` decides
whether the *goal* was achieved based on observations, and that verdict gates task
completion. It measures task success, not decision quality across a corpus.

## Benchmark plan (pending execution)

Because the schema is already in place, the benchmark runner is a thin loop. The plan:

1. **Input** — pick a dataset version, use only its `test` split.
2. **Replay** — for each example, call CoreModule in "matching mode":
   objective = `request`, toolDefs = current enabled tools. This can run as a script
   against the exported JSON (no task rows needed) or as synthetic tasks.
3. **Score** — per example:
   - *Tool selection*: exact match of `decision.tool` vs `expectedTool`
     (examples without `expectedTool` are excluded from this metric).
   - *Parameters*: deep-equality on `expectedParams` (when present), after the same
     coercion pipeline (`coerceParams`) the runtime uses, so string/number drift does
     not count as an error.
   - *Behavior*: `clarification_required` counts as correct only when the example
     declares unfillable params; `no_tool` counts as correct when `expectedTool` is
     absent.
   - *Latency*: `latencyMs` distribution (p50/p95) per engine.
4. **Segment** — by `category`, by engine (`llm-core` vs `heuristic-fallback`), and by
   reasoning level.
5. **Report** — append results to this page and to `worklog.md`; store the raw per-
   example results as a new dataset version (`name: benchmarks`, versioned) so runs are
   comparable.

## Where the numbers will come from

| Future metric | Source today |
| --- | --- |
| Tool selection accuracy | `core.decision` events + `DatasetExample.expectedTool` |
| Parameter exact-match rate | decision `params` + `expectedParams` |
| p50/p95 decision latency | `eventbus` metrics (`coreDecisionSeries`) — see [Benchmarks](benchmarks.md) |
| Task success rate | `/api/system` `tasks.successRate` (completed / (completed+failed)) |
| Tool reliability | `ToolRecord` success/failure/timeout counts via `/api/tools` |

All of these except the dataset-scored ones are already live in the console (Dashboard
metric cards, Models view, Tools view stats row).

## Manual evaluation you can run today

1. Import a small dataset whose `test` split covers each tool with 3–5 phrasings
   (including typos — the heuristic path normalizes common ones).
2. Export it (`/export?format=json`) and, for each example, either:
   - create a real task (`POST /api/tasks`) with the `request`, then compare the task's
     executions (`GET /api/tasks/{id}/executions`) against `expectedTool` /
     `expectedParams`; or
   - read `core.decision` events (`GET /api/tasks/{id}/events`) for the raw decisions.
3. Note engine and latency from each decision event.

This is exactly what the v1.0.0 E2E verification did informally (goal health-check,
image generation, live crash recovery, typo tolerance) — the benchmark plan above
formalizes it.
