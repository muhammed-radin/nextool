---
title: Benchmarks
category: AI Core
order: 7
---

# Benchmarks

v1.0.2 replaces the "planned benchmark" with a **real benchmark engine**
(`src/lib/nexool/training/benchmark.ts`): it runs the *actual* decision unit against
each labeled example of a dataset and compares the decision with the example's
`expectedTool`. The Web Console (Benchmark view + `/api/benchmark`) and the CLI
(`nextool benchmark`) call the same module, and every run is persisted to
`BenchmarkRunRecord` for history and comparison.

## Scope — honest

The only implemented suite is **`tool-selection`** (`suite: 'tool-selection'` is a
literal in the API schema). It measures one thing: *given a request, does the decision
unit pick the expected tool?* There is no planning benchmark, no end-to-end task
benchmark, no load test. Latency aggregates in the Dashboard/status surfaces remain the
event-bus runtime metrics (see [CoreModule](core-module.md)); this page is about dataset
runs.

## Model keys

| `modelKey` | What runs per case |
| --- | --- |
| `llm-core` | The live LLM CoreModule (`decide()` — real SDK calls, full tool inventory of enabled tools, reasoning level 3, empty context bundle). Bounded by `timeoutPerCaseMs` (1 000–120 000, default 30 000); a timeout counts as a `no_tool` case. |
| `heuristic-fallback` | The deterministic matcher (`heuristicDecide`) — no network, reproducible. |
| a trained model id | A `tfjs-trained-classifier` `ModelRecord`: weights restored via `tf.loadLayersModel(tf.io.fromMemory)`, request vectorized with the checkpoint's own `vocabSize`, argmax over `tf.predict` probabilities. Classifiers do **not** generate params (`params = {}`, `paramAccuracy` → `null`). Engine label in per-case rows: `trained:<packageName>`. |

The tool inventory is whatever tools are **enabled** at run time — disabling tools
changes the benchmark's decision space.

## Split preference

Cases are selected from the dataset in this order: **`test` split → `validation` split →
all labeled examples** (reported as "all (no explicit splits)"). Only examples with
`expectedTool` are used; `--limit` / `limit` truncates after selection. Note honestly:
the engine records which split it *used* only in its logs — the run record persists the
dataset lineage and config, so check the dataset's split sizes when interpreting.

## Metrics — exact definitions

| Metric | Definition |
| --- | --- |
| `cases` | Examples actually evaluated (skipped/unlabeled excluded). |
| `toolSelectionAccuracy` | Share of cases where `decidedTool === expectedTool`. `no_tool`/`cannot_execute`/`stop` count as incorrect (unless the expectation is also no-tool, which the format cannot express — label such datasets accordingly). |
| `noToolRate` | Share of cases whose status was `no_tool`, `cannot_execute` or `stop`. |
| `paramAccuracy` | Strict deep equality (deterministic JSON stringify, sorted keys) of generated params vs `expectedParams`. **`null`** when no example carries non-empty `expectedParams`, or when the model is a trained classifier. Cases that did not decide `tool_call` count as mismatches. |
| `schemaValidity` | Share of `tool_call` decisions whose params pass the tool's schema validation (`validateParams`). 0 when no case produced a validatable tool call. |
| `avgDecisionLatencyMs` | Mean wall-clock per case (whole decision, including LLM round-trips for `llm-core`). |
| `p95DecisionLatencyMs` | 95th percentile over the sorted per-case latencies (nearest-rank). |
| `avgConfidence` | Mean decision confidence (0–1), rounded to 3 decimals per case. |
| `avgCoreCallsPerCase` | Always 1 — each case is exactly one decision; there is no replanning inside a case. |

All rates are 0–1 fractions (the CLI renders percentages). Per-case rows are persisted
(`request` truncated to 240 chars, `expectedTool`, `decidedTool`, `status`, `correct`,
`confidence`, `latencyMs`, `engine`) so you can inspect *which* cases failed, not just
the aggregate.

## Reading results without fooling yourself

- **Small datasets are noisy.** A 6-example dataset at 83% accuracy differs from 100%
  by *one* case. Compare runs with the same dataset version and the same tool
  inventory, and prefer accuracy differences that exceed several cases.
- **Compare like with like**: same `datasetVersion`, same enabled tools, same split.
  The history list shows model key + dataset name/version per run — use them.
- `llm-core` runs are slower and non-deterministic (temperature, SDK variance);
  `heuristic-fallback` runs are deterministic and instant — treat them as a floor /
  regression tripwire, not a ceiling.
- `noToolRate` is not an error rate: for ambiguous requests it can be the *correct*
  outcome. Check per-case rows before judging.
- `schemaValidity` measures schema conformance, not semantic correctness of params.

## History, inspection and workflows

Runs are stored in `BenchmarkRunRecord` (id, label, modelKey, dataset lineage, config,
metrics JSON, per-case JSON capped at 500 rows, durationMs, status
`queued|running|completed|failed`). `GET /api/benchmark` returns the newest 50;
`GET /api/benchmark/{id}` returns the full record including cases.

### Console

**Benchmark** view → pick dataset + model key (llm-core / heuristic-fallback / any
trained classifier) → optional limit/timeout/label → run. Metrics render as cards; the
per-case table exposes status/correctness/confidence/latency per example; the history
list lets you re-open previous runs.

### CLI

```bash
nextool benchmark -d tool-selection -m heuristic-fallback
nextool benchmark -d tool-selection -m llm-core --limit 20 --label "pre-release"
```

prints the aggregate metrics block (see
[CLI](../operations/cli.md#benchmark--score-a-decision-unit-against-a-dataset)); the run
is persisted identically to a console run.

## See also

- [Training](training.md) — producing the classifiers this engine can benchmark.
- [Evaluation](evaluation.md) — the earlier manual procedure, kept for history.
- [Models](models.md) — adapter states and the model registry.
