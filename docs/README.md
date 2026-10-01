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
| **Application version** | **1.0.5** — release name: *"Tool Runtime & Editor Improvements, Node.js Tool Environment, Responsive Model Import, and Documentation Routing"* |
| **Model version** | **llm-core 1.0.0** (unchanged since v1.0.0 — v1.0.2–v1.0.5 add tooling around it; trained classifier checkpoints carry their own versions) |
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
| Tools | [Tools](tools.md) | Writing tools: definitions (incl. `nodejs` environment + metadata), handler kinds, registration paths (incl. Tool IDE), JSON export/import (v1.0.4, nodejs round trip v1.0.5), full example. |
| Tools | [Tool Development](tool-development.md) | The Tool IDE: environments (`js-function` sandbox + `nodejs` restricted Node.js, v1.0.5), metadata editor, schema form, Monaco toggle, testing, editor source-sync, worked example. |
| Tools | [Tool Runtime](tool-runtime.md) | Async execution, parallel groups, timeouts, failure/cancel states; v1.0.5 `nodejs` runner + `/api/tools/environments` capability source. |
| Data | [Memory](memory.md) | Persistent Memory vs Live State — storage, retrieval, lifecycle. |
| Data | [Live State](live-state.md) | Virtual server fleet, runtimeStatus, counters. |
| Data | [Context](context.md) | Previous context + delta + observation + memory + history composition. |
| Data | [History](history.md) | HistoryEntry records, retention, querying. |
| Realtime | [Realtime](realtime.md) | SSE protocol, connection states, backoff policy, frontend wiring. |
| API | [API Reference](api.md) | Every endpoint: method, path, request/response, errors, curl. |
| Frontend | [Frontend](frontend.md) | SPA shell, 16 views, real brand logo, docs-viewer link resolution (v1.0.5), dynamic terminal/checklist, JSON tree, zustand + providers. |
| Frontend | [UI Design System](ui.md) | Blue-gradient glassmorphism layers, typography, JSON-tree theme, do-not rules. |
| Frontend | [Mobile & Responsive](mobile.md) | Bottom nav, safe areas, breakpoints, touch targets, priority layouts. |
| Operations | [Deployment](deployment.md) | Env vars, standalone build/start, proxies, CLI availability, model/icon artifacts. |
| Operations | [CLI](cli.md) | v1.0.2 `nextool` reference: train, benchmark, model, dataset (JSON + Parquet), tool, runtime, version. |
| Operations | [Testing](testing.md) | `bun test` unit suite (103 tests / 317 assertions) + lint + manual verification workflows. |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.5

- **`nodejs` tool environment** — a second authorable function environment: a
  **restricted Node.js JavaScript environment** (not unrestricted Node.js) with the SAME
  `execute(params, context)` contract as `js-function`, plus `require()` /
  `await import()` for an explicit module allowlist only (`buffer`, `crypto`,
  `events`, `path`, `querystring`, `string_decoder`, `url`, `util`, `assert`, `zlib`).
  Still sandboxed: no `process`, no timers, no `fetch`, no filesystem/network —
  blocked categories (`child_process`, `cluster`, `vm`, `worker_threads`, `fs`, `os`,
  `net`, `dgram`, `http`, `https`, `process`) fail with
  `Module "x" is not available in the NexTool Node.js environment.` Dynamic
  `import()` call sites are rewritten at compile time to an allowlist shim so it works
  without host vm flags. Limits: 10 s async watchdog, 4 s sync cap (now enforced at
  function invocation), 256 MiB heap-growth sentinel (an honest in-process guard),
  source ≤ 64 000 chars, result ≤ 64 KiB. See [Tool Development](tool-development.md)
  and [Tool Runtime](tool-runtime.md).
- **Tool IDE rework** — explicit sections: General, **Execution environment**
  (selector `js-function | nodejs | dynamic`; dynamic tools are locked to dynamic —
  duplicate into a function tool to change), structured **Metadata** key/value rows
  (strings, ≤ 50 pairs — not raw JSON), structured **Tool Schema** form with a JSON
  view, and a **Monaco ⇄ textarea toggle** (default ON; both editors share one source;
  code is preserved when switching). Dynamic tools get a real handler-kind selector
  (`echo`/`delay`/`http_get`/`uuid`) with structured config — `http_get` now exposes
  `url` (required) + `timeout` (ms, 1000–15000, default 8000). See
  [Tool Development](tool-development.md).
- **Editor source-sync guarantees** — the "Test blanked the editor" failure class is
  closed by construction: a test always reads the CURRENT editor code, unsaved code
  survives testing (success or failure never clears the editor), a non-edit
  `onChange` (model swap) can never wipe the source, and switching tools loads the
  stored source. Unit-tested invariants; see [Tool Development](tool-development.md).
- **`GET /api/tools/environments` + restored `POST /api/tools/test`** — the runtime's
  real capability payload (environments, handler kinds with config fields, module
  allowlist, globals, limits) is served by a new endpoint that the IDE consumes
  everywhere; the dedicated test route — missing since v1.0.2, so "Test Tool" requests
  fell through to `/api/tools/[name]` and 405'd — is back, and it is now
  environment-aware (test unsaved source as `nodejs` or `js-function`). See [API](api.md).
- **Responsive Import model modal** — the Models **Import model** dialog is rebuilt:
  viewport-safe at 320 px+, stacked full-width layout on mobile, a scrollable body
  between a stable header and footer, a chosen-file chip (long names break + tooltip),
  and validation errors rendered **inside the modal** (rose alert card) instead of only
  as toasts. See [Models](models.md) and [Mobile](mobile.md).
- **Documentation routing** — the built-in docs viewer resolves internal markdown
  links (`../ai-core/core-module.md`, `x.md#anchor`) and navigates **within** the
  viewer — no more 404s from category-style paths; genuinely missing pages render an
  in-viewer "Documentation page not found" state; heading anchors scroll to the target.
  See [Frontend](frontend.md).

### What v1.0.4 delivered (condensed)

- **Real in-app logo** — `BrandLogo` renders the product identity from the active icon
  package (`GET /api/icons`, preference `apple-touch-icon.png` → `icon-192` →
  `icon-512` → `icon-32` → `icon-16`); plain **N** monogram fallback. Functional nav
  icons and the favicon pipeline unchanged (see [Frontend](frontend.md)).
- **JSON tree readability fix** — the viewer reads `--w-rjv-*` tokens only; the theme
  was rewritten with the real namespace (the old `--json-tree-*` names collapsed every
  color to the library's near-black default).
- **Tool code ↔ Monaco sync + non-destructive Duplicate** — save/test read the exact
  on-screen code; Duplicate switches into register-a-copy mode instead of renaming the
  original.
- **Tool export / import (JSON)** — per-tool export, **Import tool (JSON)** and
  **Export all tools (JSON)** with client-side validation, preview and explicit
  conflict handling (Replace / Import as copy / Cancel).
- **Tasks require at least one tool** — Task Console blocks submission and
  `POST /api/tasks` enforces `config.enabledTools` (400 `TOOLS_REQUIRED`; explicit
  `[]` fails zod with `INVALID_REQUEST`).
- **UI refinements** — Models header stacks on mobile, compact wrapping Task Console
  examples, plan checklist without the vertical rail, Settings *Branding & icons* card
  removed (the icon API infrastructure remains).

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
