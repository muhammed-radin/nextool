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
| **Application version** | **1.0.4** — release name: *"UI Refinements, Tool Sync, Tool Import/Export & Responsive Improvements"* |
| **Model version** | **llm-core 1.0.0** (unchanged since v1.0.0 — v1.0.2–v1.0.4 add tooling around it; trained classifier checkpoints carry their own versions) |
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
| Tools | [Tools](tools.md) | Writing tools: definitions, handler kinds, registration paths (incl. Tool IDE), JSON export/import (v1.0.4), full example. |
| Tools | [Tool Development](tool-development.md) | v1.0.2 Tool IDE: schema editor, IntelliSense, `js-function` sandbox contract, testing, editor↔code sync (v1.0.4), worked example. |
| Tools | [Tool Runtime](tool-runtime.md) | Async execution, parallel groups, timeouts, failure/cancel states. |
| Data | [Memory](memory.md) | Persistent Memory vs Live State — storage, retrieval, lifecycle. |
| Data | [Live State](live-state.md) | Virtual server fleet, runtimeStatus, counters. |
| Data | [Context](context.md) | Previous context + delta + observation + memory + history composition. |
| Data | [History](history.md) | HistoryEntry records, retention, querying. |
| Realtime | [Realtime](realtime.md) | SSE protocol, connection states, backoff policy, frontend wiring. |
| API | [API Reference](api.md) | Every endpoint: method, path, request/response, errors, curl. |
| Frontend | [Frontend](frontend.md) | SPA shell, 16 views, real brand logo, dynamic terminal/checklist, JSON tree, zustand + providers. |
| Frontend | [UI Design System](ui.md) | Blue-gradient glassmorphism layers, typography, JSON-tree theme, do-not rules. |
| Frontend | [Mobile & Responsive](mobile.md) | Bottom nav, safe areas, breakpoints, touch targets, priority layouts. |
| Operations | [Deployment](deployment.md) | Env vars, standalone build/start, proxies, CLI availability, model/icon artifacts. |
| Operations | [CLI](cli.md) | v1.0.2 `nextool` reference: train, benchmark, model, dataset (JSON + Parquet), tool, runtime, version. |
| Operations | [Testing](testing.md) | `bun test` unit suite (56 tests / 200 assertions) + lint + manual verification workflows. |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.4

- **The real NexTool logo in-app** — a new `BrandLogo` component
  (`src/components/console/brand-logo.tsx`) renders the product identity from the
  **active icon package** (fetched once from `GET /api/icons`; prefers
  `apple-touch-icon.png` → `icon-192.png` → `icon-512.png` → `icon-32.png` →
  `icon-16.png`). Used by the header brand button, the mobile menu sheet header, the
  More-sheet header and the Tool IDE loading card. Without an active package it falls
  back to a plain **N** monogram tile on the brand gradient — deliberately not a
  recreated logo. Functional nav icons are unchanged; the browser-tab favicon keeps
  coming from `layout.tsx` `generateMetadata`. See [Frontend](frontend.md) and [UI](ui.md).
- **JSON tree readability fix** — the installed `@uiw/react-json-view` (2.0.0-alpha.43)
  reads `--w-rjv-*` CSS custom properties **only**; the previous theme set
  `--json-tree-*` variables the library ignores, so every syntax color silently fell
  back to the library default `#002b36` (near-black — almost invisible on the dark
  glass background). The theme now uses the real `--w-rjv-*` tokens with a bright
  dark-console palette: keys bright sky, strings bright green, numbers amber,
  booleans orange, null rose, braces cyan, transparent background. See
  [Frontend](frontend.md) and [Troubleshooting](troubleshooting.md).
- **Tool code ↔ Monaco sync + non-destructive Duplicate** — at save **and** test time
  the function code is read directly from the Monaco model through a live editor ref,
  so the exact on-screen code is saved (never a stale React state value). The
  in-editor **Duplicate** button no longer renames the original (the old behavior was
  destructive); it switches the session into register-a-copy mode — the copy keeps the
  exact function code + schema and Save POSTs a **new** tool. Switching tools remounts
  the editor so state always re-initializes from the freshly loaded definition. See
  [Tool Development](tool-development.md).
- **Tool export / import (JSON)** — every tool can be exported as a portable JSON file
  (function source preserved **as text**), and Tools gains **Import tool (JSON)** +
  **Export all tools (JSON)**. Import validates client-side (name, description,
  environment, source ≤ 64 000 chars, schema), shows a preview, and resolves name
  conflicts explicitly (Replace / Import as copy / Cancel — never silent overwrite).
  Built on the existing registry endpoints — no new API routes. See
  [Tools](tools.md).
- **Tasks require at least one tool** — the Task Console blocks submission without a
  tool selection ("Select at least one tool before running the task."), and
  `POST /api/tasks` enforces it server-side: a missing or empty `config.enabledTools`
  fails with 400 `TOOLS_REQUIRED` (the zod schema also rejects an explicit empty
  array). Defense in depth: frontend + zod + route. See [API](api.md) and
  [Configuration](configuration.md).
- **UI refinements** — Models header stacks its full-width *Export Current Model* /
  *Import model* buttons on mobile (unchanged on desktop); Task Console examples get
  their own title row with compact wrapping quick-fill buttons; the plan checklist
  drops the vertical timeline rail (clean card rows — all checklist states and
  animations unchanged); the Settings **Branding & icons** card was removed (the icon
  system itself — `/api/icons`, staging/activation, favicon serving, the in-app logo —
  remains fully functional; manage packages via the API). See [Frontend](frontend.md),
  [Mobile](mobile.md) and [Deployment](deployment.md).

### What v1.0.3 delivered (condensed)

- **Real Parquet interchange** — the Parquet adapter is installed (`@dsnp/parquetjs`
  **1.8.9**, pinned — see [Datasets](datasets.md)): multipart `.parquet` import, binary
  export, CLI support, `adapters.parquet: true`.
- **Parallel tool calls configuration** — `parallelToolCalls` (default on) and
  `maxParallelToolCalls` (1–8, default 4), per-task overridable; capped waves via
  `executeParallelBatch`, `planner.parallel_batch` / `planner.partial_failure` events,
  batch provenance on executions. See [Tool Runtime](tool-runtime.md).
- **Task output cleanup** — the Live Checklist/Terminal area exists only while the task
  is active; terminal states show a **Final task output** section instead.
- **Plan is a live checklist** — same `deriveChecklist` states and animated
  `ChecklistItems` in the plan section, with immediate SSE-driven refresh.
- **Tool IDE Monaco fix** — definite editor heights at every breakpoint (420 px mobile;
  `lg` fills the viewport with a 480 px floor).
- **Icons: favicon-generator aliases** — `favicon-16x16.png`-style names are aliased to
  canonical `icon-<size>.png` names; metadata files are skipped into an `ignored` list
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
  activate, served via `generateMetadata`. (The Settings card for it was removed in
  v1.0.4; the pipeline itself remains and now also feeds the in-app logo.)

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
