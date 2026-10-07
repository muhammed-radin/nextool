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
| **Application version** | **1.0.14** — release name: *"THE LIVELY AI — event-driven Live Mode (events are first-class triggers, immediate wake, per-task Read & Act All Events queue, event admission/rejection lifecycle), AskSelf + AskForUser tools, Limitations control page with Standard/Unrestricted presets, fully interactive Tool Editor test runtime (await alert/confirm/askForUserAsChoice/prompt with advanced input types), production Assistant chat experience, real-directory VFS/"* — see [What's new in v1.0.14](#whats-new-in-v1014) and the [v1.0.13 release page](release-1.0.13.md) for history |
| **Model version** | **llm-core 1.0.0** (provider-served, NOT retrained — releases add tooling around it; locally trained tool-selection classifier checkpoints are generation **1.0.3** since v1.0.12 — MCP/VFS/identity-aware 447-example curriculum; unchanged in v1.0.14 — the app release does NOT change the model version; 1.0.2 in v1.0.11, 1.0.1 in v1.0.10). The UI always reads the version dynamically — never hard-coded. |
| **Realtime transport** | SSE (`/api/stream`) |
| **Honest unavailability** | WebSocket transport: not installed · Training pause/resume: not supported (the Parquet adapter **is installed** since v1.0.3 — `@dsnp/parquetjs` 1.8.9, see [Datasets](datasets.md)) |

## All pages

| Category | Page | Description |
| --- | --- | --- |
| Getting Started | [Getting Started](getting-started.md) | Clone → run: prerequisites, install, env, first task, first live task, first trained model. |
| Getting Started | [Installation](installation.md) | Detailed setup, dependencies, first-boot verification, install troubleshooting. |
| Getting Started | [Configuration](configuration.md) | Every setting field with type, default, min/max; per-task config; **v1.0.8 central configuration-limits.json architecture** (single authoritative limits file, startup validation, self-host customization); **v1.0.14 the Limitations page** (console → More → Limitations: render/save/export/import the limits JSON, Standard/Unrestricted presets, runtime hot reload); v1.0.7 tool timeout, application reset and maintenance cleanup. |
| Getting Started | [Project Structure](project-structure.md) | Every directory and file explained, with dependencies. |
| Architecture | [Architecture](architecture.md) | Full-stack diagram, Mermaid component map, end-to-end data flow; **v1.0.14 event-driven Live Mode state machine + access boundaries (real fs ↔ VFS/ ↔ mcp/restricted)**. |
| Architecture | [Main](main.md) | Orchestrator responsibilities, lifecycle, Goal vs Live. |
| Architecture | [Planner](planner.md) | Plan decomposition, parallel groups, fallback, events; **v1.0.10 planner modes: `pre-plan` + `one-by-one`** (per-task override, single-step contract, repetition guard); **v1.0.11 pre-plan failure recovery** (frozen main plan, recovery subgoal with its own pre-plan, bounded attempts, state-aware resume). |
| Architecture | [Observer](observer.md) | Interpretation rules and goal verification (LLM + heuristic). |
| Architecture | [Events](events.md) | Every emitted event type with priority, payload and source; **v1.0.14 the `event.*` lifecycle family (received/admitted/queued/processing/completed/rejected/failed/cancelled — the retired v1.0.6 `live.event.*` types)**. |
| Architecture | [Scheduler](scheduler.md) | Live wait/wake machinery, wake sources, repair passes. |
| Architecture | [Runtime](runtime.md) | Task lifecycle (incl. `awaiting_approval` / `paused` — v1.0.6), limits, timeouts, cancellation, error codes. |
| Architecture | [Security](security.md) | Sandbox boundaries: host filesystem isolation, Virtual FS, network policy, module allowlists, approval, honest limitations (v1.0.6). |
| AI Core | [CoreModule](core-module.md) | Tool matching, extractive/constructive params, output schema, engines. |
| AI Core | [Models](models.md) | llm-core 1.0.0, fallback engine, adapter states, trained checkpoints, export/import. |
| AI Core | [Model Format](model-format.md) | Export layouts (tfjs zip + `.nextool` package), metadata, import compatibility checks. |
| AI Core | [Datasets](datasets.md) | JSON + Parquet import/export, splits, versioning; the real Parquet adapter (`@dsnp/parquetjs`). |
| AI Core | [Training](training.md) | The real TF.js training engine: architecture, config ranges, job lifecycle, checkpoint output, honest limits; **v1.0.10: checkpoint selection, manual early stopping, `modelVersion` registration, deterministic pattern learning**; **v1.0.11: model + dataset generation 1.0.2 — 324-example long-context seed, vocabSize 512, honest error-analysis retrain story**. |
| AI Core | [Evaluation](evaluation.md) | Pre-engine evaluation notes and the manual procedure (kept for history). |
| AI Core | [Benchmarks](benchmarks.md) | The real `tool-selection` benchmark: model keys, split preference, exact metric definitions, history. |
| Modes | [Goal Mode](goal-mode.md) | Full lifecycle with sequence diagram and a real example. |
| Modes | [Live Mode](live-mode.md) | Activation, **v1.0.14 event-driven lifecycle (immediate wake, initial execution, per-task event queue, event admission lifecycle)**, pause/resume, feedback, stopping. |
| Tools | [Tools](tools.md) | Writing tools: definitions (incl. `nodejs` and the v1.0.11 `freedom-node` environments, metadata, `autoExecute`), handler kinds, **v1.0.14 `ask.self` (AskSelf) + `ask.user` (AskForUser) built-ins**, registration paths (incl. Tool IDE), JSON export/import (v1.0.4, nodejs + autoExecute round trip), full example. |
| Tools | [Tool Development](tool-development.md) | The Tool IDE: environments (`js-function` + `nodejs` with **the real-directory `VFS/`** — v1.0.14, controlled network, virtual child_process — v1.0.6; **`freedom-node` — intentionally unrestricted, configuration-gated — v1.0.11**), metadata editor, schema form, Monaco toggle, **v1.0.14 fully interactive test runtime + prompt() advanced input types**, editor source-sync, worked examples. |
| Tools | [Tool Runtime](tool-runtime.md) | Async execution, parallel groups, timeouts, failure/cancel states; v1.0.6 approval gate, `nodejs` runner + `/api/tools/environments` capability source. |
| Data | [Memory](memory.md) | Persistent Memory vs Live State — storage, retrieval, lifecycle. |
| Data | [Live State](live-state.md) | Virtual server fleet, runtimeStatus, counters. |
| Data | [Context](context.md) | Previous context + delta + observation + memory + history composition. |
| Data | [History](history.md) | HistoryEntry records, retention, querying. |
| Realtime | [Realtime](realtime.md) | SSE protocol, connection states, backoff policy, frontend wiring. |
| API | [API Reference](api.md) | Every endpoint: method, path, request/response, errors, curl. |
| Frontend | [Frontend](frontend.md) | SPA shell, real brand logo, docs-viewer link resolution (v1.0.5), approval/prompt/pause controls (v1.0.6), dynamic terminal/checklist, JSON tree, zustand + providers; **v1.0.14 Limitations + Assistant views (glassmorphism chat with the NexTool robot) + interactive Tool Editor test panel**. |
| Frontend | [UI Design System](ui.md) | Blue-gradient glassmorphism layers, typography, JSON-tree theme, do-not rules. |
| Frontend | [Mobile & Responsive](mobile.md) | Bottom nav, safe areas, breakpoints, touch targets, priority layouts. |
| Operations | [Deployment](deployment.md) | Env vars, standalone build/start, proxies, CLI availability, model/icon artifacts. |
| Operations | [CLI](cli.md) | `nextool` reference: train, benchmark, model, dataset (JSON + Parquet), tool, runtime, **v1.0.8 config limits/validate**, version. |
| Operations | [Testing](testing.md) | `bun test` unit suite (371 tests across 11 files) + lint + manual verification workflows. |
| Operations | [Troubleshooting](troubleshooting.md) | Symptom → cause → fix tables. |
| Reference | README (this page) | Index, version banner, release notes. |
| Reference | [Release 1.0.14](release-1.0.14.md) | THE LIVELY AI (current release page): event-driven Live Mode, per-task Read & Act All Events queue + event lifecycle, AskSelf/AskForUser, Limitations page + presets, interactive Tool Editor test runtime, Assistant chat, real-directory VFS/. |
| Reference | [Release 1.0.13](release-1.0.13.md) | THE OPERATOR CONSOLE (historical v1.0.13 page): single-user product model, environment rules, FS Inspector file manager, MCP customizable auth/OAuth, denial escalation, continuation, tool runtime interactivity. |

Pages are also readable inside the console under **Documentation** (served by
`/api/docs`), and as plain markdown files in `docs/`.

## What's new in v1.0.14

**One-line summary:** THE LIVELY AI — Live Mode becomes fully **event-driven** (events
are first-class triggers with immediate wake, initial execution on startup, a per-task
"Read & Act All Events" queue drained continuously, and an observable
`event.*` admission lifecycle), the **AskSelf + AskForUser** builtin tools, the
**Limitations** control page (render/save/import/export the central limits JSON with
Standard/Unrestricted presets and runtime hot reload), a **fully interactive Tool
Editor test runtime** (`await alert/confirm/askForUserAsChoice/prompt` wait for the
operator, with 14 advanced prompt input types incl. file upload), the production
**Assistant** chat experience (glassmorphism + the NexTool robot), and the **VFS
becomes a real `VFS/` directory** (automatic one-time migration from `data/vfs`).
llm-core stays 1.0.0 (provider-served, never retrained); the trained classifier
generation stays 1.0.3.

- **Event-driven Live Mode** — EVERY injected event wakes a live task IMMEDIATELY
  regardless of priority (the old priority ≤ 5 wake gate is REMOVED — priority is
  ordering/metadata only); the first cycle runs on startup (no first-interval wait);
  interval triggers are message-less while event triggers carry the FULL event into the
  decision context (`CONTEXT.trigger`); `user.message` is the live conversation channel
  and `user.feedback` runs an immediate correction cycle. Without "Read & Act All
  Events" there is NO backlog — extra events while an action runs are REJECTED with the
  observable reason "Live action already running and Read & Act All Events is
  disabled."; with it, each task's queue is drained continuously until empty. Stopping
  cancels pending/queued events observably; failed queued events never deadlock the
  queue. See [Live Mode](live-mode.md) and [Architecture](architecture.md).
- **Event lifecycle family** — `event.received / .admitted / .queued / .processing /
  .completed / .rejected / .ignored / .failed / .cancelled` make every admission
  decision observable in Events / Task Preview / Live Monitor. The v1.0.6
  `live.event.queued/processing/processed/dropped` types are RETIRED (replaced by the
  family). See [Events](events.md#the-event-lifecycle-family-v1014).
- **AskSelf + AskForUser** — new builtin tools: `ask.self` generates/derives content
  from NexTool itself (`{ success, opinion }`; usable as a subtool via
  `context.tools.call`), `ask.user` pauses the tool until the operator answers
  (`{ success, question, answer }` — `success: false` on timeout/cancel; never
  fabricates answers). See [Tools](tools.md#askself-askself-and-askforuser-askuser--v1014).
- **Limitations page** — console → More → Limitations: loads the complete
  configuration-limits JSON, renders every property with type/min/max/default/unit/
  enum/nullable metadata, saves via `PUT /api/config/limits` (validate-before-write,
  atomic file replace, hot reload ≤ 2 s), Export/Import JSON (validated server-side),
  the **Standard/Default** preset, the **⚠ Complete Unrestricted** preset (visually
  warned + confirm dialog — security boundaries can never be weakened) and a Raw JSON
  editor mode. See [Configuration](configuration.md#the-limitations-page-v1014).
- **Interactive Tool Editor test runtime** — `await alert()/confirm()/
  askForUserAsChoice()/prompt()` now WAIT for the operator in the Tool Editor test too
  (no auto-resolve; the test panel renders interaction cards and polls them);
  `prompt()` accepts advanced typed specs (text/textarea/number/email/password/url/
  search/date/time/datetime-local/month/week/color/file — `file` resolves to a JSON
  string `{ name, mimeType, size, content? }`, content only for small files ≤ 256 KB
  client-capped, 700 KB server compose cap); `alert()` is now an interactive OK dialog
  (pauses the tool; 120 s auto-dismiss) served by `GET/POST /api/alerts`. See
  [Tool Development](tool-development.md#alertmessage-promptmessage-defaultvalue-and-confirmmessage--runtime-interaction).
- **Assistant page** — the production chat experience (console view `assistant`):
  glassmorphism chat, the NexTool robot centerpiece with runtime-driven expressions,
  progress derived from real task events, humanized observations, interaction cards
  answered inline — no code/JSON internals rendered. See [Frontend](frontend.md#v1014-frontend-changes).
- **Real-directory VFS/** — the shared VFS root is now the real host directory `VFS/`
  inside the project storage root; the legacy `data/vfs` location is migrated once
  automatically on first VFS use (never deletes/overwrites; logged
  `[vfs] v1.0.14 migration`); the sandbox is unchanged (lexical validation +
  per-component lstat walk + symlink refusal + realpath-pinned root); VFS limits are
  enforced from the central config (Limitations-page changes take effect at runtime);
  the terminal stays virtual (`child_process` isolation); freedom-node can access
  `VFS/` because it physically exists in the host fs while mcp/restricted environments
  stay VFS-only. See [Tool Development](tool-development.md#the-virtual-file-system-v106)
  and [Architecture → Access boundaries](architecture.md#access-boundaries-real-fs--vfs--mpcrestricted).
- Also in v1.0.14: the FS Inspector file listing overflow fix (§36 — true
  `overflow-y-auto` container), `tool.user_alert.dismissed` + the `/api/alerts` route,
  and `tool.user_alert` becoming an interactive dialog that pauses the tool until
  dismissed.

### What's new in v1.0.11

**One-line summary:** THE EMPOWERMENT — pre-plan tasks recover from failed steps
instead of blind-retrying once and hard-stopping (frozen main plan → recovery subgoal
with its OWN bounded pre-plan → state-aware resume), a new **intentionally
unrestricted** `freedom-node` tool environment gated ONLY by the central configuration
file (fail closed, no Settings control), a centralized **auto-execution hierarchy**
(global → tool → task, with an observable effective source), and the locally trained
classifier generation **1.0.2** (324-example long-context dataset, vocabSize 512,
benchmarked 0.7179 on the frozen 39-case test split). llm-core stays 1.0.0
(provider-served, never retrained).

- **Pre-plan failure recovery** — a failed/timed-out pre-plan step FREEZES the main
  plan (later steps never run first), creates a recovery subgoal, gives it its own
  pre-plan (same `buildPlan` strategy, bounded `RECOVERY_PLAN_MAX_STEPS = 4` steps),
  executes it through the normal decide/execute/approval gate, and lets the Observer
  verify. Attempts are bounded by `task.recoveryMaxAttempts` (default 4, range 2–4);
  exhaustion ends the task honestly (`RECOVERY_EXHAUSTED`), an unrecoverable failure
  aborts immediately (`RECOVERY_UNRECOVERABLE`, no wasted retry budget). Resume is
  state-aware: a resolved condition marks the failed step completed, otherwise the step
  is re-queued at its original position — completed steps are never repeated. One-by-one
  semantics and Live-Mode repair passes are untouched. See [Planner](planner.md).
- **freedom-node environment** — `environment: "freedom-node"` tools get real
  `require()`/`import()` (Node builtins + npm packages), the REAL host filesystem (never
  the VFS), real network with NO Network Policy caps, and the real `process`/`Buffer` —
  deliberately unrestricted. The escape is authorized ONLY by the `fs` section of
  `config/configuration-limits.json` (configuration-file gate, fail closed →
  `FREEDOM_DISABLED`; the Settings UI has no control for it). Task lifecycle limits
  (deadline watchdog, vm sync cap, 5 MiB result transport, capped logs) are preserved;
  js-function/nodejs behavior is byte-for-byte unchanged. See
  [Tool Development](tool-development.md) and [Security](security.md).
- **Auto-execution hierarchy** — ONE resolver (`resolveAutoExecution`) decides with
  explicit precedence: global `true` → ON (global); else tool `true` → ON (tool); else
  task `true` → ON (task); else OFF (default). A lower layer can never override a higher
  enable; the effective source is observable via the new `tool.auto_execution` event and
  the Tool IDE's tri-state Auto-execution select + "Effective auto-execution:" display.
  See [Tool Runtime](tool-runtime.md) and [Configuration](configuration.md).
- **Training upgrade (model + dataset 1.0.2)** — shipped seed
  `config/training/seed-dataset-v1.0.2.json` (324 examples — 246/39/39, 17 categories,
  all 15 tools in ALL three splits, long Markdown documents and hard negative
  examples, frozen test/validation membership); trained with `vocabSize` 512 →
  **0.7179** tool-selection accuracy on the identical frozen 39-case held-out split vs
  **0.5641** for the 1.0.1 checkpoint and the heuristic floor (llm-core 0.8205,
  ~1120 ms — unchanged, provider-served). The first 1.0.2 attempt (vocab 128) scored
  **0.5385** — a regression, recorded honestly, fixed with the wider vocabulary + 61
  targeted train-only examples. Task/dataset request caps rose to 32 000 chars for
  large Markdown inputs. See [Training](training.md), [Benchmarks](benchmarks.md) and
  [Datasets](datasets.md).

### What's new in v1.0.10

**One-line summary:** two real planner strategies — the existing `pre-plan` and the new
`one-by-one` (plans exactly ONE next step per call from the latest state, with a
single-step sanitizer, failure-aware replanning and an endless-repetition guard),
per-task overridable and persisted at creation — plus the v1.0.1 training generation
(expanded 170-example seed dataset, validation-based checkpoint selection, manual early
stopping, `modelVersion` registration) and deterministic pattern learning over recorded
executions. llm-core stays 1.0.0 (provider-served, never retrained).

- **Planner modes** — `plannerType` (`pre-plan` default / `one-by-one`) on global
  Settings + per-task config, resolved at creation and persisted with the task;
  `prePlanMaxSteps` (1–122, default 10, central limit `task.prePlanMaxSteps`) makes the
  old hard-coded 8-step cap configurable; new planner events
  (`planner.mode_selected`, `planner.one_by_one_step_planned/.step_completed/
  .replanned/.goal_reached`) and Task Preview planner badges + one-by-one panel. See
  [Planner](planner.md) and [Configuration](configuration.md).
- **Training upgrade (model 1.0.1)** — shipped seed dataset
  `config/training/seed-dataset-v1.0.1.json` (170 examples — 121/23/26, all 15 tools in
  train AND test, zero duplicates); checkpoints snapshotted at the best
  validation-accuracy epoch; tf.js `EarlyStopping` (broken in this build) replaced by
  manual early stopping; unique per-job layer names + dispose-on-failure fix the
  `Variable with name dense_Dense1/kernel was already registered` crash; benchmarked
  **0.6923** vs **0.4231** for the old checkpoint on the identical 26-case test split
  (llm-core 0.9615, unchanged). See [Training](training.md), [Benchmarks](benchmarks.md)
  and [Datasets](datasets.md).
- **Pattern learning** — deterministic extraction over recorded executions into
  `PatternRecord` rows (sequence / verification / outcome / failure-recovery / live /
  early-completion), derived confidence (`successRate × min(1, total/3) − 0.15 ×
  contradictions`), `GET /api/patterns` with `?format=examples` conversion — additional
  evidence only, never a runtime dependency. See [Training](training.md) and
  [API](api.md).

### What v1.0.6 delivered (condensed)

- **Common runtime APIs in BOTH tool environments** — `js-function` and `nodejs`
  share a controlled baseline: `fetch` (one policy-controlled networking layer:
  http/https only, 10 s timeout, 1 MiB response cap, max 3 redirects with every hop
  re-validated, max 10 requests per execution, localhost/private/link-local/metadata
  hosts blocked), a REAL `XMLHttpRequest` implementation over the same policy (async
  only — sync mode is rejected honestly), and the async `await alert(message)` /
  `await prompt(message, defaultValue?)` runtime functions — `alert` emits a
  `tool.user_alert` event and resolves; `prompt` pauses **only the tool** (never the
  runtime) until the user answers or cancels in the console UI, or a 120 s timeout
  returns `null`. Standard globals (timers included, deadline-bounded) are documented
  per environment. In test mode `alert` resolves immediately and `prompt` returns its
  default (or `null`) — tests never hang. **(Changed in v1.0.14: ALL interactions are
  now interactive in every mode incl. the Tool Editor test — the runtime above is the
  historical v1.0.6 behavior.)** See [Tool Development](tool-development.md).
- **Virtual File System (VFS)** — a real, persistent **per-tool** filesystem backed by
  the `VirtualFile` SQLite table (never the host fs): scaffold `/input /output /tmp
  /data /workspace`, a Node-shaped `fs` module (`readFile`, `writeFile`, `mkdir`,
  `readdir`, `stat`, `rename`, `rm`, `realpath`, `exists`, Promise-first + `fs.promises`
  + `*Sync` + `fs.usage()`), path-safety with decode-before-validate, and node-shaped
  errors. Escape attempts fail with
  `VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.`
  **(Changed since: v1.0.12 made it ONE shared runtime-owned store; v1.0.14
  made the root the REAL `VFS/` directory with a one-time automatic migration from
  `data/vfs`.)** Limits: 512 KiB per file, 8 MiB total, 500 entries, path ≤ 512 chars, depth ≤ 24.
  Tool IDE tests run in an **ephemeral scratch workspace** wiped after the run. See
  [Tool Development](tool-development.md) and [Security](security.md).
- **Virtual Node.js environment expansion** — `nodejs` tools gain context-provided
  modules: `fs` (the VFS), `os` (virtualized values — `platform` is
  `nextool-virtual`), `timers` + `timers/promises`, `http`/`https` (the controlled
  network client), and `child_process` as a **restricted virtual command layer** (`ls`,
  `cat`, `grep`, `sort`, `mkdir`, `rm`, … executed against the VFS workspace — no real
  host process exists). `require()`/`import()` resolve through ONE centralized import
  resolver (allowlist → virtual modules → VFS files with a conservative ESM transform);
  URL imports are **disabled by default**. The static allowlist (`buffer`, `crypto`,
  `events`, `path`, `querystring`, `string_decoder`, `url`, `util`, `assert`, `zlib`)
  is unchanged; `cluster`, `vm`, `worker_threads`, `net`, `dgram`, `dns`, `process`,
  `perf_hooks`, `inspector`, `module`, `async_hooks` stay blocked. See
  [Tool Development](tool-development.md).
- **Tool auto-execution approval** — every tool gains an `autoExecute` definition flag
  (default `false` → **approval required**). Precedence: global setting → per-task
  config → per-tool flag. When approval is required the runtime emits
  `tool.approval.required`, parks the task in `awaiting_approval`, and renders an
  Allow/Deny card (with optional denial feedback) in Task Preview / Live Monitor.
  A 5-minute timeout **stops the task** — a timeout never silently executes. Parallel
  batches: each tool waits for its own decision. See [Tool Runtime](tool-runtime.md)
  and [Configuration](configuration.md).
- **Multi-event live processing** — the "Read & Act All Events" switch (global setting
  `allowMultipleEvents` + per-task config, default off = v1.0.5 behavior) makes events
  arriving while busy/paused/waiting land in a durable handle inbox, queue in task
  state (survives refresh/reconnect), and get processed **one-by-one** ordered by
  priority then arrival. Queue cap 50 (lowest priority dropped first, drops always
  recorded), 16 KiB payload cap, queue visible in Live Monitor + Task Preview. Distinct
  from `parallelToolCalls`. **(Changed in v1.0.14: the queue drains continuously with
  NO interval waits, the `live.event.*` event types were replaced by the `event.*`
  lifecycle family, and without the switch events are REJECTED observably instead of
  silently kept.)** See [Live Mode](live-mode.md).
- **Pause / resume live tasks** — `POST /api/tasks/{id}/pause` and `/resume`. Pause is
  not stop: task/plan/subgoal/context/Live State/event queue/history are preserved and
  only **new** autonomous actions stop (the current atomic tool execution finishes
  first); the scheduler holds while paused and restarts its interval fresh on resume —
  no tick bursts; events during pause are retained. A paused approval stays unresolved
  (its 5-minute timeout remains well-defined). Honest limitation: if the server process
  dies while a task is paused, the task cannot resume (runtime handles are in-memory);
  Stop still works. See [Runtime](runtime.md) and [Live Mode](live-mode.md).
- **API & UI surface** — `GET/POST /api/approvals`, `GET/POST /api/prompts`,
  `POST /api/tasks/{id}/pause`, `POST /api/tasks/{id}/resume`; `/api/tools/environments`
  now also returns `network`, `vfs`, `childProcess` and a `capabilities` matrix;
  `/api/tools/js` and `PUT /api/tools/{name}` accept `autoExecute`. Settings gained the
  "Auto-Execute Tools" and "Allow Multiple Events at Same Time" switches, Task Console
  the per-task toggles, Tool IDE the per-tool auto-execute switch + capability matrix,
  and Live Monitor/Task Preview the pause/resume buttons, approval cards, prompt cards
  and event-queue panels. See [API](api.md), [Frontend](frontend.md),
  [Events](events.md) and the new [Security](security.md) page.

### What v1.0.5 delivered (condensed)

v1.0.5 added the second authorable function environment — `nodejs`, a restricted
Node.js sandbox with the same `execute(params, context)` contract and a then-static
module allowlist (`buffer`, `crypto`, `events`, `path`, `querystring`,
`string_decoder`, `url`, `util`, `assert`, `zlib`; everything else — including `fs`,
`os`, `http`/`https`, `child_process` — failed with the blocked-module wording) —
plus the Tool IDE rework (sections: General · Execution environment · Metadata ·
Tool Schema · Function with a Monaco ⇄ textarea toggle), unit-tested editor
source-sync guarantees (tests never blank the editor), `GET /api/tools/environments`
as the single capability source, the restored environment-aware
`POST /api/tools/test`, the responsive Models **Import model** dialog (85 dvh flex
column, chosen-file chip, in-modal error cards), and docs-viewer internal link
resolution. v1.0.6 keeps all of this and expands the environment (see above).
Details remain on [Tool Development](tool-development.md), [Models](models.md) and
[Frontend](frontend.md).

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
- **CLI** — `nextool train / benchmark / model / dataset / tool / runtime / config limits / config validate / version`,
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
