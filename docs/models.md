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
| Version | `1.0.0` — **unchanged in v1.0.2**; the release added tooling (Tool IDE, training, benchmarking, packaging) around it, not a new decision unit. |
| Architecture | "LLM CoreModule (tool-matching + parameter generation heads via structured prompting)" |
| Backend | `z-ai-web-dev-sdk` (server-side only — never imported in client code) |
| Status | `active` |
| Notes | The TensorFlow.js runtime **is installed since v1.0.2** (`@tensorflow/tfjs` 4.22.0, CPU backend). It powers trained-classifier inference and benchmarking — it does **not** replace llm-core as the active engine. |

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
{ "adapters": { "tfjs": true, "nextoolManifest": true, "parquet": true } }
```

| Adapter | Installed? | Meaning |
| --- | --- | --- |
| TensorFlow.js (`tfjs`) | **Yes — since v1.0.2** (`@tensorflow/tfjs` 4.22.0, CPU/pure-JS backend in Node). | Real training (`runTrainingJob`), real classifier inference (`tf.loadLayersModel(tf.io.fromMemory)` + `tf.predict` in the benchmark engine), and real load-validation on import. |
| `.nextool` manifest validator | Yes | `POST /api/models/load` validates and registers manifests (status `registered`); the v1.0.2 import path additionally accepts binary packages. |
| Parquet | **Yes — since v1.0.3** (`@dsnp/parquetjs` 1.8.9, pinned; pure JS, Node/Bun). | Binary Parquet dataset import/export through `src/lib/nexool/datasets/parquet.ts`; the boolean comes from `parquetAdapterInfo()`, a real dynamic-import probe (one per process). See [Datasets](datasets.md). |

## Trained classifier checkpoints (v1.0.2)

A completed training job registers a real runnable package with
`format: 'tfjs-trained-classifier'`: the manifest embeds `modelTopology`, `weightSpecs`
and base64 `weightData`, plus `classes`, `vocabSize`, `trainingConfig`, `finalMetrics`,
dataset lineage and `parameterCount`. Checkpoints are used by the benchmark engine
(model key = the record id) and can be exported as binary zips. They are tool
*selectors* — they never generate parameters and are never activated as the runtime
engine. See [Training](training.md).

## Export & import (v1.0.2)

| Operation | How |
| --- | --- |
| Export dropdown | Models view → package row → **Export Current Model** → `tfjs` zip or `.nextool` package (see [Model Format](model-format.md)). |
| Export API | `GET /api/models/export?id={modelRecordId}&format=tfjs\|nextool` — streams the zip. Only manifests with native TFJS weights are exportable. |
| Import dialog | Models view → **Import model** → upload `.nextool`, native tfjs zip, or bare `.json` manifest (v1.0.1 compatibility, imported with a *not runnable* warning). v1.0.5 rework below. |
| Import API | `POST /api/models/import` (multipart `file`, ≤ 25 MiB). Binary packages must pass a real `tf.loadLayersModel` compatibility check; failures surface verbatim. |
| CLI | `nextool model export / import / list / info` (see [CLI](../operations/cli.md)). |

## The Import model dialog (v1.0.5 rework)

The **Import model** dialog was rebuilt responsively (the shadcn width caps were
already viewport-safe; the rework is about height, layout and error surfacing):

- **Scrollable body between stable rails** — the modal is a flex column capped at
  `85dvh`: title + description stay pinned on top, the action buttons stay pinned in
  the footer, and only the middle (file section, manifest textarea, errors) scrolls —
  long manifests can no longer push the buttons off-screen.
- **Stacked mobile layout** — on phones the flow is one column: choose button
  (full-width, ≥ 44 px tall) → chosen-file chip → error card → hairline divider
  ("or paste a bare manifest") → manifest textarea → full-width **Cancel** and
  **Validate & load** buttons. Desktop keeps the row footer, right-aligned.
- **Chosen-file chip** — after picking a file, its name renders in a mono chip with
  `break-all` (long names wrap inside the modal instead of widening it) plus a native
  tooltip carrying the full filename and its size (B/KB/MB). Re-choosing the **same**
  file after an error re-triggers the input (the selection is reset).
- **Validation errors render INSIDE the modal** — a rose `role="alert"` card shows
  manifest parse failures and `POST /api/models/load` / `POST /api/models/import`
  rejections (e.g. `Package rejected / Invalid .nextool manifest: version must be
  semver-like…`) with the message preserved verbatim. The card clears on a new file,
  on starting either flow, and whenever the dialog reopens.
- Everything else is unchanged: hidden `accept=".nextool,.zip,.json"` input,
  manifest-paste flow, success/warning toasts, and the load() refresh on success.

See [Mobile](mobile.md#v105-mobile-refinements) for the verified breakpoints.

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

## Cleanup & protection (v1.0.7)

The dependency-aware maintenance cleanup (`GET|POST /api/maintenance/cleanup`,
Settings → Maintenance, CLI `nextool maintenance cleanup`) removes a ModelRecord ONLY
when dependency analysis proves it is orphaned: no training job references it
(`modelRecordId`), no benchmark run references it (`modelKey`), and its status is not
`active`. The active engine (llm-core, built-in) is not a record and can never be
removed. Models are never removed for being old, duplicate-named or lower-versioned.
The report lists protected / removed / failed resources; the cleanup is idempotent.
`GET /api/maintenance/validate` reports broken manifests or missing references as
clear errors — nothing is silently recreated.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/models` | Engine info + packages (max 100, newest first) + adapter booleans. |
| `POST /api/models/load` | Validate + register a `.nextool` manifest → `400 INVALID_MANIFEST` on failure. |
| `GET /api/models/export?id=&format=tfjs\|nextool` | Download the zip package (v1.0.2). |
| `POST /api/models/import` | Multipart import: `.nextool` / tfjs zip / bare manifest (v1.0.2). |

## Related

- [Model Format](model-format.md) — both export layouts, metadata fields, import checks.
- [Training](training.md) / [Benchmarks](benchmarks.md) — producing and scoring
  trained classifiers.
