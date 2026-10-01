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
| **Application version** | **1.0.2** — release name: *"Runtime UX, Tool IDE, Training & Benchmarking, Model Packaging, CLI, Timeline & Final UI Refinement"* |
| **Model version** | **llm-core 1.0.0** (unchanged in v1.0.2; the release adds tooling around it — trained classifier checkpoints carry their own versions) |
| **Realtime transport** | SSE (`/api/stream`) |
| **Honest unavailability** | Parquet adapter: not installed · WebSocket transport: not installed · Training pause/resume: not supported |

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
| AI Core | [Datasets](datasets.md) | JSON import format, splits, export, versioning; parquet status. |
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
| Operations | [CLI](cli.md) | v1.0.2 `nextool` reference: train, benchmark, model, dataset, tool, runtime, version. |
| Operations | [Testing](testing.md) | Manual verification workflows + lint; no automated suite (stated). |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.2

- **Tool IDE + `js-function` tools** — author a JavaScript tool in the console (Monaco,
  schema-driven IntelliSense, References pane), test it against the real `node:vm`
  sandbox, and save it into the live registry (create/edit/rename/duplicate/delete).
  Sandbox exposes only `params`, `context`, a capped `console` and ES builtins — no
  `require`/`process`/`fetch`/timers, honestly documented. See
  [Tool Development](tool-development.md).
- **Real training** — TensorFlow.js is installed (`@tensorflow/tfjs` 4.22.0, CPU
  backend). `nextool train` / the Training view run a real hashed bag-of-words → dense
  softmax classifier per dataset and register a runnable `tfjs-trained-classifier`
  checkpoint with per-epoch metrics, logs and cancellation. No pause — stated. See
  [Training](training.md).
- **Real benchmarking** — the `tool-selection` suite runs the actual decision unit
  (llm-core, heuristic-fallback or a trained classifier) per labeled example and
  persists metrics + per-case results. See [Benchmarks](benchmarks.md).
- **Model packaging** — export trained checkpoints as native tfjs zips or `.nextool`
  packages; import with a genuine TFJS load-validation (25 MiB cap, traversal-safe).
  See [Model Format](model-format.md).
- **CLI** — `nextool train / benchmark / model / dataset / tool / runtime / version`,
  sharing the exact service layer with the web console. See [CLI](cli.md).
- **Runtime UX** — dynamic terminal status derived from the real event stream
  (`[running]: Tool called …`, no hardcoded prompt), Live Mode checklist/timeline with
  honest progress, *Preview as Terminal* toggle, one consistent JSON tree viewer,
  global overflow/blank-space cleanup.
- **Branding & icons** — upload an icons.zip in Settings; real validation (favicon.ico
  required, PNG IHDR dimension checks, size caps), staged → preview → Apply, served
  from `public/icons/<packageId>/` via `generateMetadata`.

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
