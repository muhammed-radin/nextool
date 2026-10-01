---
title: NexTool Q1 Documentation
category: Reference
order: 1
---

# NexTool Q1 — Documentation Index

NexTool Q1 is a specialized AI task-processing, planning, observation, automation and
tool-execution runtime with a real-time operations console. It is **not a chatbot**:
requests become plans, plans drive a dynamic tool registry, executions are observed and
verified against goals — once (Goal Mode) or continuously (Live Mode).

| | |
| --- | --- |
| **Application version** | **1.0.3** — release name: *"Task Output Cleanup, Checklist State, Monaco Fix, Parquet Support, Icons & Parallel Tool Configuration"* |
| **Model version** | **llm-core 1.0.0** (unchanged since v1.0.0 — v1.0.2/v1.0.3 add tooling around it; trained classifier checkpoints carry their own versions) |
| **Realtime transport** | SSE (`/api/stream`) |
| **Honest unavailability** | WebSocket transport: not installed · Training pause/resume: not supported (the Parquet adapter **is installed** since v1.0.3 — `@dsnp/parquetjs` 1.8.9, see [Datasets](datasets.md)) |

## All pages

| Category | Page | Description |
| --- | --- | --- |
| Getting Started | [Getting Started](getting-started.md) | Clone → run: prerequisites, install, env, first task, first live task, first trained model. |
| Getting Started | [Installation](installation.md) | Detailed setup, dependencies, first-boot verification, install troubleshooting. |
| Getting Started | [Configuration](configuration.md) | Every setting field with type, default, min/max; per-task config. |
| Getting Started | [Project Structure](project-structure.md) | Every directory and file explained, with dependencies. |
| Architecture | [Architecture](architecture.md) | Full-stack diagram, Mermaid component map, end-to-end data flow. |
| Architecture | [Main](main.md) | Orchestrator responsibilities, lifecycle, Goal vs Live. |
| Architecture | [Planner](planner.md) | Plan decomposition, parallel groups, fallback, events. |
| Architecture | [Observer](observer.md) | Interpretation rules and goal verification (LLM + heuristic). |
| Architecture | [Events](events.md) | Every emitted event type with priority, payload and source. |
| Architecture | [Scheduler](scheduler.md) | Live wait/wake machinery, wake sources, repair passes. |
| Architecture | [Runtime](runtime.md) | Task lifecycle, limits, timeouts, cancellation, error codes. |
| AI Core | [CoreModule](core-module.md) | Tool matching, extractive/constructive params, output schema, engines. |
| AI Core | [Models](models.md) | llm-core 1.0.0, fallback engine, adapter states, trained checkpoints, export/import. |
| AI Core | [Model Format](model-format.md) | Export layouts (tfjs zip + `.nextool` package), metadata, import compatibility checks. |
| AI Core | [Datasets](datasets.md) | JSON + Parquet import/export, splits, versioning; the real Parquet adapter (`@dsnp/parquetjs`). |
| AI Core | [Training](training.md) | The real TF.js training engine: architecture, config ranges, job lifecycle, checkpoint output, honest limits. |
| AI Core | [Evaluation](evaluation.md) | Pre-engine evaluation notes and the manual procedure (kept for history). |
| AI Core | [Benchmarks](benchmarks.md) | The real `tool-selection` benchmark: model keys, split preference, exact metric definitions, history. |
| Modes | [Goal Mode](goal-mode.md) | Full lifecycle with sequence diagram and a real example. |
| Modes | [Live Mode](live-mode.md) | Activation, intervals, event-driven wake, feedback, stopping. |
| Tools | [Tools](tools.md) | Writing tools: definitions, handler kinds, registration paths (incl. Tool IDE), full example. |
| Tools | [Tool Development](tool-development.md) | v1.0.2 Tool IDE: schema editor, IntelliSense, `js-function` sandbox contract, testing, worked example. |
| Tools | [Tool Runtime](tool-runtime.md) | Async execution, parallel groups, timeouts, failure/cancel states. |
| Data | [Memory](memory.md) | Persistent Memory vs Live State — storage, retrieval, lifecycle. |
| Data | [Live State](live-state.md) | Virtual server fleet, runtimeStatus, counters. |
| Data | [Context](context.md) | Previous context + delta + observation + memory + history composition. |
| Data | [History](history.md) | HistoryEntry records, retention, querying. |
| Realtime | [Realtime](realtime.md) | SSE protocol, connection states, backoff policy, frontend wiring. |
| API | [API Reference](api.md) | Every endpoint: method, path, request/response, errors, curl. |
| Frontend | [Frontend](frontend.md) | SPA shell, 16 views, dynamic terminal/checklist, JSON tree, zustand + providers. |
| Frontend | [UI Design System](ui.md) | Blue-gradient glassmorphism layers, typography, do-not rules. |
| Frontend | [Mobile & Responsive](mobile.md) | Bottom nav, safe areas, breakpoints, touch targets, priority layouts. |
| Operations | [Deployment](deployment.md) | Env vars, standalone build/start, proxies, CLI availability, model/icon artifacts. |
| Operations | [CLI](cli.md) | v1.0.2 `nextool` reference: train, benchmark, model, dataset (JSON + Parquet), tool, runtime, version. |
| Operations | [Testing](testing.md) | Manual verification workflows + lint; no automated suite (stated). |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.3

- **Real Parquet interchange** — the Parquet adapter is installed (`@dsnp/parquetjs`
  **1.8.9**, pinned — see [Datasets](datasets.md)). `POST /api/datasets/import` accepts
  multipart `.parquet` uploads, `GET /api/datasets/{id}/export?format=parquet` returns a
  binary download, the CLI reads/writes `.parquet`, and `/api/models` now reports
  `adapters.parquet: true`. Columnar Parquet is the efficient interchange format for
  larger datasets; JSON stays the human-readable default.
- **Parallel tool calls configuration** — new explicit `parallelToolCalls` (default on)
  and `maxParallelToolCalls` (1–8, default 4) settings, overridable per task. The goal
  loop batches ≥ 2 consecutive independent action steps (same `parallelGroup`) and
  executes them concurrently via `executeParallelBatch` — capped waves, one sibling
  failing never cancels the others, `planner.parallel_batch` / `planner.partial_failure`
  events, and batch provenance on executions ("parallel batch" group cards in Task
  Preview). See [Configuration](configuration.md), [Planner](planner.md),
  [Tool Runtime](tool-runtime.md).
- **Task output cleanup** — the Live Checklist/Terminal area in Task Preview exists only
  while the task is active; on a terminal state it is removed entirely and replaced by a
  **Final task output** section (runtime-recorded summary, result status/steps/tool
  calls/duration tiles, artifacts, full FinalResult JSON). The mobile Timeline terminal
  hides after completion too. See [Frontend](frontend.md).
- **Plan is a live checklist** — the Task Preview plan section uses the same
  `deriveChecklist` states and animated `ChecklistItems` as the Live checklist
  (`[✓] [-] [ ] [!] [~]`), and plan/checklist refresh immediately when tool/task events
  arrive over SSE (no waiting for the 2.5 s poll).
- **Tool IDE Monaco fix** — the Function editor gets definite heights at every
  breakpoint (420 px mobile/tablet; `lg` fills the available viewport with a 480 px
  floor) — it no longer collapses to ~1 px on mobile.
- **Icons: favicon-generator aliases** — the icons ZIP upload also accepts common
  favicon-generator filenames (`favicon-16x16.png` → `icon-16.png`, `android-chrome-*`,
  `apple-touch-icon-*.png`, …); `site.webmanifest`/`manifest.json`/`browserconfig.xml`
  entries are skipped and returned in a new `ignored` list instead of rejected. Real PNG
  dimension validation and the staged → preview → activate flow are unchanged
  (see [Deployment](deployment.md) and [API](api.md)).

### What v1.0.2 delivered (condensed)

- **Tool IDE + `js-function` tools** — Monaco authoring, schema-driven IntelliSense,
  real `node:vm` sandbox test runs, full registry CRUD (see
  [Tool Development](tool-development.md)).
- **Real training & benchmarking** — `@tensorflow/tfjs` 4.22.0 installed: hashed
  bag-of-words → dense softmax classifier per dataset, per-epoch metrics/logs,
  cancellation; the `tool-selection` benchmark runs the actual decision unit per labeled
  example (see [Training](training.md) / [Benchmarks](benchmarks.md)).
- **Model packaging** — export native tfjs zips or `.nextool` packages; import with real
  TFJS load-validation (see [Model Format](model-format.md)).
- **CLI** — `nextool train / benchmark / model / dataset / tool / runtime / version`,
  sharing the service layer with the console (see [CLI](cli.md)).
- **Runtime UX** — event-derived terminal status, animated checklist/timeline,
  *Preview as Terminal* toggle, one consistent JSON tree viewer.
- **Branding & icons** — icons.zip upload with real PNG validation, staged → preview →
  Apply, served via `generateMetadata`.

### Carried over from v1.0.1

Blue-gradient glassmorphism with Readex Pro/Michroma/Geist Mono, the 5-state connection
indicator with details popover and backoff, mobile bottom-nav shell, zod validation on
all mutating endpoints, the in-console Documentation system, and llm-core 1.0.0 +
`heuristic-fallback` decision semantics — all unchanged.

## Where to start

- New operator → [Getting Started](getting-started.md)
- Integrating via HTTP → [API Reference](api.md)
- Writing a tool → [Tools](tools.md) then [Tool Development](tool-development.md)
- Training & benchmarking → [Training](training.md) / [Benchmarks](benchmarks.md)
- Automating from a terminal → [CLI](cli.md)
- Understanding the AI core → [CoreModule](core-module.md)
