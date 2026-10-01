---
title: Benchmarks
category: AI Core
order: 7
---

# Benchmarks

Where latency and performance numbers come from, what they measure, and what they do
**not** claim.

## Source of truth: event-bus metrics

The only performance instrumentation in the runtime lives in
`src/lib/nexool/eventbus.ts`:

```ts
interface RuntimeMetrics {
  coreCalls: number;              // CoreModule decisions since process start
  totalCoreLatencyMs: number;     // cumulative decision latency
  lastDecisionAt?: string;        // ISO timestamp of the last decision
  startedAt: string;              // process/bus start (drives uptime)
  coreDecisionSeries: { at: string; ms: number }[];  // rolling window, last 50
}
```

`recordCoreDecision(latencyMs)` is called exactly once per `decide()` — covering the LLM
call(s), retry, validation and the allowed-tools gate — so the number represents the
full cost of one tool-matching decision, not just the network round-trip.

## Where the numbers surface

| Number | Location | Computation |
| --- | --- | --- |
| `coreCalls` | `/api/system` (`engine`), `/api/models` (`engine.coreCalls`), Dashboard engine card | counter |
| `avgCoreLatencyMs` / `avgLatencyMs` | same surfaces | `totalCoreLatencyMs / coreCalls`, rounded; 0 before the first decision |
| `lastDecisionAt` | same surfaces | timestamp |
| `latencySeries` | `/api/system`, Dashboard area chart | the rolling 50-sample series |
| `runtimeUptimeSec` | `/api/system`, status bar | `now - metrics.startedAt` |
| Tool avg ms | `/api/tools` (`stats.avgMs`), Tools view | `totalMs / callCount` from `ToolRecord` aggregates |
| Task duration | `Task.durationMs`, `FinalResult.durationMs` | wall clock from `runTask` start to finalize |

A measured average of ≈ **1.1 s per decision** was observed during the v1.0.0 E2E run
(recorded in `worklog.md`). That is an anecdote from one session, not a benchmark — the
live numbers in the console are authoritative for your environment.

## Honest status: what is NOT benchmarked

- **No quality benchmarks.** Tool-selection accuracy / parameter match rates over a
  dataset are planned but not implemented — see [Evaluation](evaluation.md) for the
  plan and the manual procedure you can run today.
- **No load tests.** Concurrency behavior (parallel tool groups, many SSE clients) is
  architecturally bounded but has no published throughput numbers.
- **No published model benchmark scores.** llm-core is consumed via
  `z-ai-web-dev-sdk`; its internal model properties are not exposed and we do not
  fabricate them (see [Models](models.md)).
- **Adapters are not installed** (TF.js, Parquet), so there is nothing to benchmark
  there; `/api/models` reports `tfjs: false, parquet: false` rather than placeholder
  numbers.

## Reading the Dashboard chart correctly

- The chart plots the **last 50 decisions** (rolling), oldest → newest, left → right.
- It resets when the process restarts (metrics are in-memory, HMR-safe via globalThis
  but not durable).
- The first decision of a session is typically the slowest (cold SDK connection); do
  not read the first sample as steady state.
- Spikes usually correlate with image-generation tasks or SDK retries — check the
  Events view (`core.decision`, `planner.retry`) at the spike timestamps.

## Reproducing a latency measurement

```bash
# generate some decisions
curl -s -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01"}'

# read the aggregate + series
curl -s http://localhost:3000/api/system \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{\
      const j=JSON.parse(s).data; \
      console.log(j.engine, 'series:', j.latencySeries.length) })"
```

## See also

- [CoreModule](core-module.md) — what a "decision" includes.
- [Evaluation](evaluation.md) — the quality benchmark plan.
- [API](../api/api.md) — `/api/system`, `/api/models` response shapes.
