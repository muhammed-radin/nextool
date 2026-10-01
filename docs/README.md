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
| **Application version** | **1.0.1** — release name: *"Enhancement, Responsive UI, Connectivity, Documentation & Completion"* |
| **Model version** | **llm-core 1.0.0** (unchanged in v1.0.1; the application around it was enhanced) |
| **Realtime transport** | SSE (`/api/stream`) |
| **Honest unavailability** | TensorFlow.js adapter: not installed · Parquet adapter: not installed · WebSocket transport: not installed |

## All pages

| Category | Page | Description |
| --- | --- | --- |
| Getting Started | [Getting Started](getting-started.md) | Clone → run: prerequisites, install, env, first task, first live task. |
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
| AI Core | [Models](models.md) | llm-core 1.0.0, fallback engine, honest adapter states, dataset versioning. |
| AI Core | [Model Format](model-format.md) | `.nextool` manifest validation and the TF.js `model.json`+`.bin` layout. |
| AI Core | [Datasets](datasets.md) | JSON import format, splits, export, versioning; parquet status. |
| AI Core | [Training](training.md) | What exists today vs what needs the pending TF.js adapter. |
| AI Core | [Evaluation](evaluation.md) | Current state and the concrete benchmark plan. |
| AI Core | [Benchmarks](benchmarks.md) | Where latency numbers come from; what is *not* benchmarked. |
| Modes | [Goal Mode](goal-mode.md) | Full lifecycle with sequence diagram and a real example. |
| Modes | [Live Mode](live-mode.md) | Activation, intervals, event-driven wake, feedback, stopping. |
| Tools | [Tools](tools.md) | Writing tools: definitions, handler kinds, registration, full example. |
| Tools | [Tool Runtime](tool-runtime.md) | Async execution, parallel groups, timeouts, failure/cancel states. |
| Data | [Memory](memory.md) | Persistent Memory vs Live State — storage, retrieval, lifecycle. |
| Data | [Live State](live-state.md) | Virtual server fleet, runtimeStatus, counters. |
| Data | [Context](context.md) | Previous context + delta + observation + memory + history composition. |
| Data | [History](history.md) | HistoryEntry records, retention, querying. |
| Realtime | [Realtime](realtime.md) | SSE protocol, connection states, backoff policy, frontend wiring. |
| API | [API Reference](api.md) | Every endpoint: method, path, request/response, errors, curl. |
| Frontend | [Frontend](frontend.md) | SPA shell, 13 views, zustand + providers, client contract. |
| Frontend | [UI Design System](ui.md) | Blue-gradient glassmorphism layers, typography, do-not rules. |
| Frontend | [Mobile & Responsive](mobile.md) | Bottom nav, safe areas, breakpoints, touch targets, priority layouts. |
| Operations | [Deployment](deployment.md) | Env vars, standalone build/start, proxies, model/dataset notes. |
| Operations | [Testing](testing.md) | Manual verification workflows + lint; no automated suite (stated). |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.1

- **Real connection indicator** — a new `RuntimeConnectionStatus` pill backed by a
  centralized 5-state connection store (`connecting · connected · disconnected ·
  reconnecting · error`), with retry countdown, connection details popover and manual
  reconnect. Connected means an active SSE stream to the runtime — not merely a loaded
  frontend.
- **Mobile redesign** — bottom navigation (Dashboard / Tasks / Live / Tools / More
  sheet with every remaining view), safe-area handling, 44 px+ touch targets, and a
  mobile performance profile that reduces glass blur below 768 px.
- **Blue-gradient glassmorphism theme** — layered design system (ambient field → glass
  shell → panels → cards → solid controls), Readex Pro + Michroma + Geist Mono
  typography, and status colors strictly reserved for status meaning.
- **Documentation system** — this very system: markdown with front-matter in `docs/`,
  served through `/api/docs` + `/api/docs/[slug]`, rendered by a built-in Documentation
  view with search and a two-pane reader.
- **Validation hardening** — `.nextool` manifest validation surfaced with per-rule
  errors, dataset import validation with per-example errors, clamped settings and task
  configs, URL-decoded tool toggles, and honest adapter/transport states everywhere.

### What was preserved

- The **llm-core 1.0.0** decision engine and the deterministic `heuristic-fallback`
  matcher are unchanged.
- Goal Mode and Live Mode semantics, including event-driven wake on priority ≤ 5,
  recovery repair passes and feedback-driven subgoal revision.
- The 15 built-in tools, the tool runtime contract (never throws, one retry in Goal
  Mode), and the ApiEnvelope REST contract (`{ ok, data | error }`).
- All v1.0.0 data (tasks, events, history, memory, stats) — v1.0.1 changed the
  presentation and connectivity layers, not the data model.

## Where to start

- New operator → [Getting Started](getting-started.md)
- Integrating via HTTP → [API Reference](api.md)
- Writing a tool → [Tools](tools.md)
- Understanding the AI core → [CoreModule](core-module.md)
