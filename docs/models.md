---
title: Models
category: AI Core
order: 2
---

# Models

What "model" means in NexTool, what is actually installed, and how the Models screen and
`/api/models` report it — honestly.

## The active engine: llm-core v1.0.0

| Attribute | Value (from `version.ts` / `/api/models`) |
| --- | --- |
| Name | `llm-core` |
| Version | `1.0.0` — **unchanged in v1.0.1**; only the application around it was enhanced. |
| Architecture | "LLM CoreModule (tool-matching + parameter generation heads via structured prompting)" |
| Backend | `z-ai-web-dev-sdk` (server-side only — never imported in client code) |
| Status | `active` |
| Notes | "TensorFlow.js runtime is not installed in this environment. The LLM CoreModule is the active engine; the heuristic-fallback matcher covers SDK outages." |

The engine powers four decision points, all with strict JSON output and timeouts:

| Consumer | Module | Timeout |
| --- | --- | --- |
| Tool matching + parameter generation | `core/coremodule.ts` | 25 s (+1 retry) |
| Plan decomposition + goal refinement | `main/planner.ts` | 25 s |
| Goal-completion verification | `main/observer.ts` | 6 s |
| Dynamic subgoal proposal & feedback revision | `main/loop.ts` | 10 s each |

The fallback engine `heuristic-fallback` is a deterministic token-overlap matcher — not a
model, but part of the AI core's resilience story (see
[CoreModule](core-module.md#engines)).

**What we deliberately do not claim**: parameter counts, training data, context window
sizes or benchmark scores for llm-core. The engine is consumed through
`z-ai-web-dev-sdk`; those properties are not exposed to the runtime, so the docs and UI
do not invent them.

## Fallback engine

`heuristic-fallback` (code, not a registered model): deterministic keyword/typo scoring,
threshold 0.18, confidence cap 0.72. It activates automatically when the SDK throws,
times out, or returns unparseable output — every such decision is tagged with
`engine: 'heuristic-fallback'` so degradation is visible.

## Adapters — installed vs not installed (honest state)

`GET /api/models` returns:

```json
{ "adapters": { "tfjs": false, "nextoolManifest": true, "parquet": false } }
```

| Adapter | Installed? | Meaning |
| --- | --- | --- |
| TensorFlow.js (`tfjs`) | **No — not installed in this environment.** | No local tensor inference today. The `.nextool` format and `model.json` + `.bin` layout exist as the standard TF.js packaging for a future adapter (see [Model Format](model-format.md)). |
| `.nextool` manifest validator | Yes | `POST /api/models/load` validates and registers manifests (status `registered`; inference stays on llm-core). |
| Parquet | **No — not installed.** | Dataset import/export is JSON-only; parquet requests get an honest 400 `PARQUET_UNAVAILABLE` (see [Datasets](datasets.md)). |

The Models view renders this exactly: the active engine card, an adapters panel with the
per-adapter booleans, and the registered packages list with their manifests as JSON.

## Dataset versioning

`SystemStats.datasetVersion` (shown on the Dashboard and status surfaces) is the version
string of the most recently updated `DatasetRecord`, or `null` when no dataset has been
imported. Datasets themselves are versioned by the importer (see
[Datasets](datasets.md)); importing the same name with a new version creates a new
record rather than mutating the old one.

## Engine metrics

`ActiveEngineInfo` includes live counters from the event-bus metrics:

- `coreCalls` — number of CoreModule decisions since process start.
- `avgLatencyMs` — `totalCoreLatencyMs / coreCalls` (0 until the first decision).
- `lastDecisionAt` — ISO timestamp of the latest decision.

These come from `recordCoreDecision` (rolling 50-sample latency series also exposed via
`/api/system.latencySeries` for the Dashboard chart). See [Benchmarks](benchmarks.md)
for what these numbers can and cannot tell you.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/models` | Engine info + packages (max 100, newest first) + adapter booleans. |
| `POST /api/models/load` | Validate + register a `.nextool` manifest → `400 INVALID_MANIFEST` on failure. |

## Related

- [Model Format](model-format.md) — the `.nextool` manifest contract.
- [Training](training.md) / [Evaluation](evaluation.md) — what exists today vs what
  awaits the TF.js adapter.
