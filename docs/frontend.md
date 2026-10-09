---
title: Frontend
category: Frontend
order: 1
---

# Frontend Architecture

The console is a **single-page application**. The only server-rendered route is `/`
(`src/app/page.tsx` → `<ConsoleApp/>`); all 20 screens are client-side views switched by
a zustand store. No routing library, no other pages.

## SPA shell

`src/components/console/console-app.tsx` composes:

- **Header** (glass shell): brand button (the real NexTool logo via `BrandLogo` +
  `Q1 v{APP_VERSION}` tech badge — always rendered from the dynamic version constant,
  never hardcoded), `RuntimeConnectionStatus` pill, notification
  bell with unread badge and dropdown.
- **Navigation**: desktop glass sidebar (12 items + a conditional *Task Preview* entry
  showing the short id once a task is selected); mobile bottom nav (see
  [Mobile](mobile.md)); view transitions via framer-motion `AnimatePresence`.
- **Status bar** (desktop-only footer): runtime dot + `active`/`live` counts, engine,
  uptime, `stream: <state>`, app version, 1 s local clock. Pinned with the
  `min-h-screen flex-col + mt-auto` pattern so it sits at the bottom on every screen.
- **Toaster** (sonner) for operation feedback.

## Brand logo (`brand-logo.tsx`, v1.0.4)

The product identity is the **real NexTool logo**, sourced from the active icon
package — the same package that feeds the favicon:

- `useBrandLogoUrl()` fetches the active branding manifest once from `GET /api/icons`
  (module-level cache + shared listeners — navigating between views never refetches,
  and every `BrandLogo` instance updates together) and picks the best square PNG in
  preference order `apple-touch-icon.png` → `icon-192.png` → `icon-512.png` →
  `icon-32.png` → `icon-16.png` (any other sized PNG as last resort, never the `.ico`).
- **`BrandLogo`** renders it as a rounded `size-7` tile (glow, `object-cover`); when no
  package is active (or while loading) it renders a plain **N** monogram tile on the
  brand gradient — typography only, deliberately **not** a recreated logo.
- Usage sites: header brand button, mobile menu sheet header, mobile More-sheet header,
  and the Tool IDE loading card. Functional nav icons (Wrench, Activity, …) are
  unchanged — only the brand tile is the logo. The browser-tab favicon continues to
  come from `layout.tsx` `generateMetadata` (unchanged mechanism).

## The views

`ConsoleView` union in `console-store.ts` — 21 views (v1.0.14 adds `limitations.tsx`
and `assistant.tsx`; v1.1.0 adds `products.tsx`; see the
[v1.1.0 section](#v110-frontend-changes) below):

| View | File | Purpose |
| --- | --- | --- |
| Dashboard | `dashboard.tsx` | Metric cards, latency area chart, recent tasks → preview, recent events. |
| Task Console | `task-console.tsx` | Create tasks: request, mode + live opt-in, L1–6, memory switch, limits (incl. v1.0.3 "Parallel tool calls" toggle + "Max parallel calls" in Execution limits), tool multi-select — **required** since v1.0.4 ("Tool selection *" label, amber "required — select at least 1" hint, submit blocked with "Select at least one tool before running the task."); compact quick-fill examples on their own wrapping row (v1.0.4); v1.0.6 per-task toggles: **Auto-Execute Tools** (shield icon) and **Allow Multiple Events at Same Time** ("Read & Act All Events"). v1.0.10: a planner select (`Pre-plan` / `One-by-one`, default from Settings) plus a "Pre-plan max steps" input (1–122) — the max-steps input shows for the pre-plan strategy only; one-by-one renders an honest "no pre-generated step list" note instead of a step-count field. **v1.0.11: the Auto-Execute switch is labeled "Task — lowest priority" (hierarchy badge) and shows "Controlled by global auto-execution setting — this task preference cannot override it." whenever the global switch is ON. v1.1.0: a collapsible "Start from a recent task (optional)" fork picker, a collapsible Skills selector (Automatic / Manual / Auto + selected) and — for the pre-plan planner — the "Execute every planned step, even after the goal is achieved" switch (details below).** |
| Task Preview | `task-preview.tsx` | Dedicated per-task screen: badges, stop/send-event/feedback dialogs, live checklist/timeline **while the task is active** (removed + replaced by *Final task output* on terminal states — v1.0.3), plan-as-checklist, parallel-batch grouping, executions, MainState JSON, 5 context panels, events timeline, runtime terminal (+ *Preview as Terminal* toggle); v1.0.6: **Pause/Resume** buttons, pending-**approval cards** (tool / purpose / params / subgoal + Allow/Deny + optional deny feedback), **prompt cards** (answer/cancel) and the **event-queue panel**; `paused` renders sky-blue, `awaiting_approval` amber. v1.0.10: the Plan section renders a "Planner: Pre-plan" badge (the resolved strategy), and one-by-one tasks get a dedicated "One-by-one Planner" panel — Current Subgoal → / Previous ✓ / Next: Waiting for observation… — fed by the new planner events. **v1.0.11: a dedicated Recovery panel for pre-plan recovery (never hidden in the generic event list) — the failed step + failure reason, the recovery pre-plan steps with live status glyphs, the attempt counter (`Recovering n/m` → `Main plan resumed (n/m)` or an honest `Recovery failed n/m` message), and the resume note when the main plan continues.** |
| Live Monitor | `live-monitor.tsx` | Live tasks (3 s polls), fleet with injections, filtered event terminal, terminal preview toggle; v1.0.6: per-task **Pause/Resume**, pending-**approval cards** (Allow/Deny + feedback), **prompt cards** (answer/cancel) and the **event-queue panel** (from `state.eventQueue`). |
| Tools | `tools.tsx` | Registry grid, enable switches, stats, schema accordions, register dialog; grid actions (New Tool / Edit / Duplicate / Test / Enable/Disable / Delete); v1.0.4 per-tool **Export** + dropdown **Export all tools (JSON)**; **v1.0.91: Import tools (JSON)… accepts a single tool object OR a JSON array (bulk) — per-item validation preview, per-row Replace/Import-as-copy/Skip conflict resolution, progress bar + final Imported/Skipped/Failed summary**; v1.0.7 responsive **"Search tools..."** filter (live, no reload — matches name/description/category/environment/handler kind/metadata; "N of M tools match" counter; honest "No tools found" empty state with **Clear search**) — see [Tools](../tools/tools.md). |
| Tool IDE | `tool-editor.tsx` | v1.0.2: Monaco JS editor (`nextool-dark` theme), schema editor, IntelliSense, References pane, test panel — see [Tool Development](../tools/tool-development.md). v1.0.3: definite editor heights at every breakpoint. v1.0.4: `source` state is the single source of truth (Monaco controlled + writes back); save/test read the code directly from the Monaco model via a live editor ref; in-editor **Duplicate** registers a copy instead of renaming the original; per-session remount on tool switch. v1.0.5: sectioned form (General · Execution environment · Metadata · Schema), `js-function \| nodejs \| dynamic` environment selector fed by `GET /api/tools/environments`, structured metadata rows, schema form + JSON view, Monaco ⇄ textarea toggle (default ON), handler-kind selector with structured config for dynamic tools, and source-sync guards (`coerceEditorChange`/`readMonacoValue`) so a test can never clear the editor. v1.0.6: per-tool **Auto-Execute Tools** switch (General section, default off = approval required) and a **capability matrix** table rendered from the endpoint's `capabilities` array; the nodejs reference panel shows the VFS limits, virtual child_process commands and network policy. v1.0.7: the Execution Environment section gains the per-tool **"Execution timeout (ms)"** field (empty = global default; caption "Default: 10 seconds (10000) · Maximum: 1 hour (3600000)"), which round-trips through create/edit/duplicate/export/import. **v1.0.11: the environment selector includes `freedom-node` with the exact warning "freedom-node — Full host Node.js access. File system, network, processes, and host-level capabilities may be available."; the Auto-Execute control becomes a tri-state select (Enabled / Disabled / Inherit — stored as boolean\|undefined=inherit) with a live "Effective auto-execution:" display (`GLOBAL ENABLED — this setting cannot override the global switch.` / `TOOL ENABLED…` / `TOOL DISABLED…` / `INHERIT…`); the capability matrix gains the freedomNode column and the reference panel renders the `freedomNode` gate block.** |
| Training | `training.tsx` | v1.0.2: dataset + config picker, per-epoch metrics table, streamed log lines, job history, cancel/delete. |
| Benchmark | `benchmark.tsx` | v1.0.2: dataset + model-key picker, metrics cards, per-case results table, run history. |
| Memory | `memory.tsx` | Persistent Memory CRUD vs Live State explainer. |
| Live State | `live-state.tsx` | Fleet banner + cards + injections (3 s refresh). |
| Events | `events.tsx` | Filterable event stream: source, type search, priority ≥ slider, expandable rows. |
| History | `history.tsx` | 100-entry table, filters, expandable params/result. |
| Models | `models.tsx` | Active engine card, adapters panel, packages + manifests, load dialog, export dropdown + import model dialog (v1.0.2); v1.0.4 responsive header — title/description then full-width stacked *Export Current Model* + *Import model* buttons on mobile (`min-h-11 w-full` → `sm:min-h-9 sm:w-auto`), unchanged multi-column layout on desktop. v1.0.5: the import dialog itself is rebuilt — scrollable body between stable header/footer, stacked touch targets on mobile, chosen-file chip, in-modal error card (see [Models](../ai-core/models.md#the-import-model-dialog-v105-rework)). |
| Datasets | `datasets.tsx` | Split bars, example-schema panel, import dialog (JSON paste/file **or binary `.parquet` upload** — cyan selected-file panel, multipart), separate **JSON** and **Parquet** export buttons per card, cyan parquet format badge, delete. |
| Docs | `docs.tsx` | Built-in documentation reader (search, category index, two-pane); v1.0.5: the centralized link resolver navigates internal markdown links WITHIN the viewer (no 404s), cross-page anchors auto-scroll, and a genuinely missing page renders an in-viewer not-found state (see below). |
| Settings | `settings.tsx` | Bound settings form, unsaved-changes badge, SSE transport locked note; v1.0.3 "Parallel tool calls by default" + "Max parallel calls"; v1.0.6 "**Auto-Execute Tools**" + "**Allow Multiple Events at Same Time**" switches (persisted via `PUT /api/settings`). v1.0.4: the *Branding & icons* card was **removed** from the UI — the icon infrastructure itself (uploads, `/api/icons`, staging/activation, favicon serving, the in-app `BrandLogo`) remains fully functional; manage packages via the API (see [Deployment](deployment.md)). v1.0.7: the Execution-limits grid shows **"Tool timeout (ms)"** with the "Default: 10 seconds (10000) · Maximum: 1 hour (3600000)" caption plus a **preset select** (10 s / 30 s / 1 min / 5 min / 30 min / 1 hour); a new **Maintenance** section ("Validate dependencies" + dependency-aware "Analyze (dry run)" / "Clean up" with the traceable protected/candidates/removed report); and a new **Danger zone** section with the destructive **"Reset Application Data"** action — rose-styled button, confirmation dialog listing what is cleared (and what is protected), and the final button enabled only after typing the exact phrase `RESET`. v1.0.10: a new Planning section — "Default planner" (`pre-plan` / `one-by-one`) + "Pre-plan max steps" (1–122, default 10). **v1.0.11: the Planning section gains "Recovery attempts per failed step" (`recoveryMaxAttempts`, 2–4, default 4); the Auto-Execute switch is badged "Global — Highest priority" with the hierarchy explanation; there is deliberately NO control for the freedom-node `fs` gate.** |

Shared widgets live in `ui-bits.tsx` (StatusChip, SourceDot, TypeChip, EventRow,
JsonBlock, MetricCard, SectionTitle, EmptyState, ErrorCard, SkeletonBlock, PulsingDot,
TimeAgo, formatters + the v1.0.2 derivation helpers), `server-card.tsx` (fleet card),
`terminal.tsx` (runtime terminal), `json-tree.tsx`/`json-theme.ts` (JSON viewer),
`brand-logo.tsx` (v1.0.4 brand identity — see above) and `task-checklist.tsx` (live
checklist/timeline). Every view follows the same discipline: skeletons while loading,
honest empty states, error cards with retry, and full cleanup on unmount.

## Dynamic runtime status, terminal and checklist (v1.0.2)

There is no hardcoded "Running" anywhere. One derivation function — `deriveTaskRuntime`
in `ui-bits.tsx` — maps a task's status + event stream to the real phase:
`[idle] [queued] [starting] [planning] [running] [observing] [waiting]
[awaiting_approval] [paused] [completed] [failed] [stopped] [cancelled]`
(v1.0.6 adds `awaiting_approval` — amber/warn, "waiting for the user to approve tool
execution (timeout 5 min)" — and `paused` — sky-blue/info, "paused by user — state
preserved, resume to continue"; neither blinks a cursor since no tool is active).
Task Preview, Live Monitor, the terminal and the status
bar all consume it (single source of truth; pages cannot invent statuses).

- **Runtime terminal** — the old hardcoded `nextool@runtime:~$` prompt is gone. The
  status line is derived: while a tool executes it reads `[running]: Tool called
  server.health` with a blinking cursor that **stops** when the execution ends; event
  lines are the real runtime events.
- **Live checklist / timeline** (`task-checklist.tsx`) — the default Live Mode
  visualization (animated timeline): `[✓]` completed, `[-]` running, `[ ]` pending,
  `[!]` failed, `[~]` waiting. Derived from the actual `PlanStep[]` (or real task events
  when no plan exists). A progress % renders only when a meaningful percentage exists
  (plan-based); otherwise the bar is indeterminate — never an invented number.
  v1.0.4: the vertical timeline rail that used to run alongside the steps was removed —
  `ChecklistItems` is now a clean checklist/card structure; **all** states, the moving
  highlight, the completion pulse and the spring glyph are unchanged, and
  `deriveChecklist` remains the single state source.
- **Preview as Terminal toggle** — Task Preview (and Live Monitor) can switch the
  visualization to a terminal; **OFF is the default** and the choice persists in
  `localStorage` (`nextool.previewAsTerminal`). Both views consume the same runtime
  state, so the toggle changes presentation only.

## Task Preview v1.0.3 — live-area lifecycle, final output, plan checklist

- **Live area exists only while the task is active.** The Live Checklist / Live
  Terminal section renders only for `queued` / `running` / `waiting`. On a terminal
  state (`completed` / `failed` / `cancelled` / `stopped`) it is removed **entirely** —
  no empty container, no blank gap. The mobile Timeline tab's terminal is hidden after
  completion too (the events timeline remains).
- **Final task output section** takes its place on terminal states: the
  runtime-recorded `FinalResult` summary, four metric tiles (result status, steps, tool
  calls, duration), artifacts badges (when the result carries an `artifacts` array) and
  the full final-result JSON tree. Real data only — `—` when a value is absent.
  Historical sections (plan, executions, state, context, events timeline) remain.
- **Plan section is a live checklist** — the Plan card renders the same animated
  `ChecklistItems` component as the Live checklist, with states derived from the actual
  plan + event stream via `deriveChecklist` (`[✓]` completed, `[-]` running,
  `[ ]` pending, `[!]` failed, `[~]` waiting/skipped) and framer-motion transitions
  (moving highlight on the running step, completion pulse, spring glyph on state
  change). One state source — plan and checklist cannot disagree.
- **Immediate SSE-driven refresh** — tool/task events (`tool.completed/failed/timeout/
cancelled`, `task.started/completed/failed/cancelled`, `planner.plan/parallel_batch/
partial_failure`, `subgoal.created`) trigger an instant detail + executions refresh,
  so plan/checklist update the moment the runtime reports a transition instead of
  waiting for the 2.5 s poll. **v1.0.10: the refresh regex also includes the new
  planner events** (`planner.mode_selected`, `planner.one_by_one_step_planned`,
  `planner.one_by_one_step_completed`, `planner.one_by_one_replanned`,
  `planner.one_by_one_goal_reached`) — and one-by-one planning emits `planner.plan`
  per step, so the checklist refreshes on every one-by-one transition. **v1.0.11: the
  regex also covers all eight recovery events (`planner.recovery_started`,
  `planner.recovery_plan_built`, `planner.recovery_attempt`, `planner.recovery_succeeded`,
  `planner.recovery_failed`, `planner.recovery_exhausted`, `planner.main_plan_resumed`,
  `planner.main_plan_aborted`) and `tool.auto_execution`** — the Recovery panel updates
  the instant an attempt transitions.
- **Parallel batch grouping** — executions returned by
  `GET /api/tasks/{id}/executions` carry `batchId`/`parallelGroup`; consecutive
  executions sharing a `batchId` render inside one labeled group card:
  "parallel batch · N concurrent".

## JSON tree viewer (v1.0.2, theme fixed in v1.0.4)

All JSON is rendered by ONE consistent viewer (`json-tree.tsx`, built on
`@uiw/react-json-view` with a NexTool theme): expand/collapse (default depth 2), copy
support, long strings wrap instead of breaking layout, containers scroll inside a capped
height. Every previous `JSON.stringify` dump was replaced by it.

**v1.0.4 root cause + fix** (`json-theme.ts` rewritten): the installed library version
(2.0.0-alpha.43) reads `--w-rjv-*` CSS custom properties **only**. The old theme set
`--json-tree-*` variables, which the library ignores — so every syntax color silently
fell back to the library default `#002b36` (near-black), almost invisible on the dark
`.glass-inset` background. The theme now sets the real `--w-rjv-*` tokens with a bright
dark-console palette: keys bright sky (lightness ≥ 0.88), strings bright green, ints /
floats amber, booleans orange, null rose, undefined slate, braces/brackets cyan, arrows
sky; the background stays transparent so the `.glass-inset` well shows through. The
component itself is unchanged (copy support, collapsed depth 2, wrapped long strings).

## Documentation viewer link resolution (v1.0.5)

The docs sources are flat markdown files, but pages link each other with category-style
paths (`../ai-core/core-module.md`, `tools.md#anchor`). The viewer now classifies every
markdown link through ONE centralized resolver (`src/lib/nexool/docs-link-resolver.ts`,
unit-tested) instead of leaving them to the browser:

- **Internal doc links** (`x.md`, `./x.md`, `../category/x.md`, bare slugs, with or
  without `#anchor`) are normalized to their basename slug, validated against the REAL
  `/api/docs` index, and — when they resolve — navigate **within the Docs view**
  (`setSlug`), keeping the URL on `/`. No more 404s from in-page navigation; the
  sidebar selection follows.
- **Cross-page anchors** (`tools.md#tool-export--import-as-json-v104`) open the target
  page and auto-scroll to the heading; heading ids are generated with the same
  GitHub-style `headingSlug` used by the authored anchors, with a dash-collapse
  fallback for older links.
- **In-page anchors** (`#section`) scroll natively inside the current page.
- **External links** (http/https/mailto/tel) are unchanged — `target="_blank"`
  `rel="noreferrer"`.
- **Missing pages** — a link whose slug is genuinely absent from the index renders an
  in-viewer **"Documentation page not found."** card (with the requested slug and a
  *Return to Documentation* button) instead of a browser 404. Real content has zero
  unresolvable links, so the state is reachable only via a stale index — defensive by
  design.
- Index clicks, search, category grouping and the mobile back button all route through
  the same `openDoc()` entry, so stale not-found/anchor state always clears.

## State management

**zustand** (v5) for UI + connection state:

- `useConsoleStore` — `activeView`, `selectedTaskId`, `sidebarOpen`,
  `openTaskPreview(taskId)` (select + switch), plus `shortId` helper (first 8 chars).
- `useRuntimeConnection` — the 5-state realtime connection contract
  (see [Realtime](../realtime/realtime.md)).

**Context providers** (`providers.tsx`) wrap the app and own polling/subscriptions:

| Provider | Mechanism | Interval | Feeds |
| --- | --- | --- | --- |
| `SystemStatsProvider` | `GET /api/system` | 5 s | Dashboard cards, header uptime/engine, status bar. |
| `GlobalStreamProvider` | ONE shared EventSource (`useNexoolStream`, `since` = now−15 min, `max` 500, `primary: true`) | continuous | Events, Live Monitor, Task Preview merge, connection indicator. |
| `NotificationsProvider` | `GET /api/notifications?limit=30` | 10 s | Bell + unread count; `markAllRead` optimistic update. |

Refresh helpers guard against overlapping in-flight requests; errors surface as
`ApiClientError` messages, never fabricated data.

## Client API layer — `src/lib/nexool/client.ts`

`apiFetch<T>(path, init)` enforces the envelope contract for every call:

1. Fetch with `Content-Type: application/json`, `cache: 'no-store'`.
2. Network failure → `ApiClientError('Network unreachable — runtime may be offline',
   'network_error', 0)`.
3. Non-JSON body → `ApiClientError(..., 'bad_json', status)`.
4. `ok !== true` or missing `data` → `ApiClientError(error.message || 'Request failed…',
   error.code || 'http_error', status)`.
5. Success → returns `env.data` directly (callers never see the envelope).

Typed helpers cover the whole endpoint surface (`getSystemStats`, `createTask`,
`stopTask`, `sendTaskFeedback`, `getTaskContext`, `getTaskExecutions`, `registerTool`,
`toggleTool` (URL-encodes dotted names), `addMemory`, `listHistory`, `getModels`,
`loadModel`, `importDataset`, `importDatasetFile` (v1.0.3 multipart upload for binary
`.parquet` files), `exportDatasetUrl` (json | parquet), `updateSettings`,
`getDocsIndex`, `getDocPage`, …). Result DTOs: `DocsIndex` /
`DocPage` for the docs system, `ModelsInfo` for models.

## Streaming hooks

- `useNexoolStream` — SSE subscription with dedupe, capped buffer, backoff reconnect,
  primary/secondary reporting (full protocol in [Realtime](../realtime/realtime.md)).
- Task Preview runs its own secondary stream (`taskId` filtered) plus a 2.5 s detail
  poll while the task is active, merging REST backfill with live events.

## Rendering & theming

- Dark-only theme (`color-scheme: dark`), tokens in `globals.css`, blue-gradient
  glassmorphism utility layers (`.glass-shell/.glass-panel/.glass-card/.glass-strong/
  .glass-inset`), semantic status colors (emerald/amber/rose) reserved for status —
  full design rules in [UI](ui.md).
- Fonts via `next/font/google`: Readex Pro (sans), Michroma (`font-tech`), Geist Mono
  (`font-mono`), variables set on `<html>`.
- The **Documentation** view fetches `/api/docs` + `/api/docs/{slug}` through
  `getDocsIndex`/`getDocPage` and renders markdown with `react-markdown` (code blocks
  styled as inset glass wells); front-matter is parsed server-side in `docs.ts`.

## Data-flow rules

- Views never `fetch` ad hoc; they use `client.ts` helpers, providers, or the stream.
- Nothing is cached beyond provider state — reloads are always truthful.
- Any panel can be in `loading | error | empty | data` — all four are rendered honestly.

## v1.0.14 frontend changes

- **Limitations view** (nav: **More → Limitations**): the operator control page for the
  central configuration limits — structured editors for every property (rendered from
  the real `type / min / max / default / unit / enum / nullable` metadata of
  `GET /api/config/limits`), a **Raw JSON editor mode**, **Export/Import JSON**
  (import validated server-side before anything is written), the **Standard/Default**
  preset, and the **⚠ Complete Unrestricted** preset with a persistent warning banner +
  confirmation dialog. Save runs `PUT /api/config/limits` (validate-before-write,
  atomic replace, runtime hot reload ≤ 2 s); a failed import lists every validation
  issue and overwrites nothing. See [Configuration](configuration.md#the-limitations-page-v1014).
- **Assistant view** (nav: **Assistant**; console view `assistant`): the production
  chat experience — glassmorphism conversation, the **NexTool robot centerpiece**
  (`nexool-robot.tsx`: SVG robot with 10 runtime-driven moods — idle/thinking/working/
  waiting/asking/success/warning/error/confused/happy — with per-mood antenna tone and
  blink/bob animations), progress steps derived from REAL `tool.*` events,
  **humanized observations** (no raw JSON or tool prefixes in replies — §23.5), and
  inline interaction cards (alerts / prompts incl. typed + file inputs / confirmations /
  choices) answered right in the chat. The first message creates a persisted LIVE task
  (one-by-one planner, Read & Act All Events ON, safe builtin toolset incl.
  `ask.self`/`ask.user`); every later message is a `user.message` EVENT — the v1.0.14
  runtime wakes immediately. Stop + New + Task Preview handoff included; NO code/JSON
  internals are rendered.
- **Interactive Tool Editor test panel**: the Test section renders the same interaction
  cards as production — prompt cards (typed inputs, file chooser), confirm, alert (OK)
  and choice cards — and polls them until answered. `await alert()/confirm()/
  askForUserAsChoice()/prompt()` no longer auto-resolve in tests (v1.0.6–v1.0.13
  behavior: alert immediate, prompt/confirm defaults — superseded).
- **Task Preview + Live Monitor**: interactive **alert cards** (OK dismiss via
  `/api/alerts`; the alert pauses only its tool) join the approval/prompt/confirmation/
  choice cards; the event stream renders the v1.0.14 `event.*` lifecycle records.
- **FS Inspector overflow fix (§36)**: the file listing is wrapped in a true
  `overflow-y-auto` container (`glass-card nextool-scroll max-h-[55vh] sm:max-h-[26rem]
  md:max-h-96`) — rows now clip INSIDE the card (Radix ScrollArea's max-height did not
  bound its viewport, which let rows leak onto the page); name truncation handles
  horizontal overflow; the "Copy path" menu item no longer passes the click event into
  `copyPath`. Verified with 40 files (internal scroll engages, page scroll intact) on
  mobile 375×812 and desktop 1280×800.

## v1.0.13 frontend changes

- **FS Inspector view** (nav: "FS Inspector"): the operator console's read-only
  window onto BOTH filesystems. Two tabs — **Virtual FS** (the ONE shared VFS via
  `/api/inspector/vfs`) and **Real FS** (`/api/inspector/fs`, read-only, confined
  to the runtime working directory). Each tab offers a path bar (Go / Up / Root /
  Refresh), an entry table (kind badges, humanized sizes, updated timestamps) and
  a preview card (64 KiB text cap, truncated badge, honest error alerts). The
  header shows the live VFS usage (usedBytes / files / limits).
- **Operator interaction cards** in Live Monitor + Task Preview, below the
  confirmation cards, each with its own accent and polling integration:
  - **Operator choice** (violet): one button per `askForUserAsChoice()` option
    (+ Cancel) — resolved via `/api/choices`; never fabricates an answer.
  - **Verification required** (cyan): the latched execution's result summary in a
    mono block with **Verify result** / **Reject** actions — resolved via
    `/api/verifications`; rejecting fails the execution (`VERIFICATION_REJECTED`).
  - **Safety limit** (amber): the tripped limit with real numbers and the budget
    on offer — **Continue +N** / **End task** — resolved via
    `/api/limits/continuations`; denying ends the task as `limit_reached`.
- **Tool IDE**: a **Verification latch** switch joins the Auto-execution block
  (per-tool, default off), and the structured schema form ⇄ JSON draft projection
  (§17) is fully wired.
- **Task Console**: a **Safety-limit continuations** numeric field (0–5, default
  1; 0 = fail at the limit as before) travels in every submitted task config.
- **Settings**: "Ask before safety-limit failure" switch + "Continuation budget"
  field (both bounded by the central `task.limitContinuationExtra` limits).

## v1.0.11 frontend changes

- **Task Preview Recovery panel**: when a pre-plan task enters recovery
  (`MainState.recovery`), a dedicated **Recovery** card renders — never buried in the
  generic event list. It shows the failed step (title + failure reason), the recovery
  pre-plan steps with live status glyphs, the attempt counter (`Recovering n/m`,
  amber while recovering), a `Main plan resumed (n/m)` state with the resume note when
  the Observer confirms recovery, and an honest `Recovery failed n/m` message when the
  attempt budget is exhausted.
- **Task Console**: the per-task Auto-Execute switch is labeled **"Task — lowest
  priority"** and shows "Controlled by global auto-execution setting — this task
  preference cannot override it." whenever the global switch is ON (the hierarchy made
  visible at the point of decision).
- **Tool IDE**: the environment selector includes **`freedom-node`** with the exact
  warning *"freedom-node — Full host Node.js access. File system, network, processes,
  and host-level capabilities may be available."*; the Auto-Execute control becomes a
  **tri-state select** (Enabled / Disabled / **Inherit** — stored as
  `boolean | undefined` = inherit) with a live **"Effective auto-execution:"** display
  that shows `GLOBAL ENABLED` whenever the global switch forces the decision; the
  capability matrix gains a **freedomNode** column and the reference panel renders the
  `freedomNode` gate block (live `enabled` state + `fsConfig` + note + preserved
  limits) from `GET /api/tools/environments`.
- **Settings**: the Planning section gains **"Recovery attempts per failed step"**
  (`recoveryMaxAttempts`, 2–4, default 4 — min/max derived from the central limit); the
  global Auto-Execute switch is badged **"Global — Highest priority"** with the
  hierarchy explanation. There is deliberately **no** control for the freedom-node
  `fs` gate (configuration-file only).
- **SSE refresh regex** extended with the eight recovery events + `tool.auto_execution`
  (see the Task Preview section above).

## v1.0.10 frontend changes

- **Task Console planner controls**: per-task **planner select** (`Pre-plan` /
  `One-by-one`) and a **"Pre-plan max steps"** input (1–122, min/max derived from the
  central `task.prePlanMaxSteps` metadata like every other numeric field). The
  max-steps input is shown only when the pre-plan strategy is selected; one-by-one
  shows the honest note that there is **no pre-generated step list** (steps are planned
  one at a time from live state).
- **Settings "Planning" section**: "Default planner" select (`defaultPlannerType`) +
  "Pre-plan max steps" (`prePlanMaxSteps`, default 10), persisted via
  `PUT /api/settings` and validated from the central limits.
- **Task Preview planner presentation**: the Plan section carries a
  **"Planner: Pre-plan"** badge; tasks running the one-by-one strategy instead render a
  dedicated **"One-by-one Planner"** panel with the state triplet — *Current Subgoal →*,
  *Previous ✓*, *Next: Waiting for observation…* — driven by the new planner events.
- **SSE refresh regex** extended with `planner.mode_selected` and the four
  `planner.one_by_one_*` events (see the Task Preview section above).

## v1.0.8 frontend changes

- **Settings loads limits first** (§8): the resolved metadata of
  `config/configuration-limits.json` arrives via `GET /api/config/limits` before the
  editable values are rendered; every numeric input derives min/max/default/unit from
  the metadata (never duplicated in components). An invalid limits file fails clearly
  inside the view.
- **Confirmation cards** (§1.5): Task Preview and Live Monitor render pending
  `confirm()` requests as Confirm/Cancel cards (amber accent); after the answer the
  `tool.confirm.responded` event shows *Confirmation allowed/denied* in the feed. The
  task-detail refresh trigger includes `tool.confirm.*`.
- **Task Console artificial blank space removed** (§19): the shell is a positioned
  ancestor and the tool-selection scroll container anchors Radix's hidden form inputs —
  the document now ends exactly at the footer on mobile/tablet/desktop/large desktop
  (no overflow is hidden).
- **Tool IDE**: the execution-timeout input's ceiling, the js-result caption and the
  nodejs reference rows (VFS / child_process / network) all read the live central limits
  via `GET /api/tools/environments`.

## v1.1.0 frontend changes

- **CoreModule Live Output (Task Preview)** — a collapsible **CoreModule Live Output**
  section (`core-live-output.tsx`) fed by the dedicated SSE channel
  `GET /api/core/stream`. Incoming provider deltas land in a ref buffer and a 120 ms
  ticker flushes **~10 words at a time** to the visible transcript — batching paces the
  RENDER only; whitespace and order are preserved exactly. Per-request status chips
  (Streaming / Completed / Failed / Cancelled), elapsed time, word count, seq-based
  dedup, bounded snapshot replay on reconnect, auto-scroll with pause/resume, copy and
  save. Debug metadata (requested vs actual engine, `streamed` flag, configured
  deadline, fallback reason) is shown — never credentials. Late frames for cancelled
  requests are ignored by the renderer.
- **Continue Task dialog** — terminal tasks (completed/stopped/failed) gain a
  **Continue Task** header action (mobile tabs + desktop grid) opening
  `continue-task-dialog.tsx`: it asks for the NEXT prompt, shows the context classes
  that will carry over, and creates a NEW linked task
  (`config.continuationOfTaskId`) — the original task is never mutated.
- **Task Console fork control** — the collapsible **"Start from a recent task
  (optional)"** picker (between Instructions and the reasoning area): the 20 most
  recent completed/stopped/failed tasks (client-side filter, text filter past 8
  items), per-source detail line (status chip, completion time, tool-execution count)
  and a **"Context to reuse"** checkbox grid mapping `contextOptions` — result, plan,
  executions, memory, skills — all default CHECKED. Submit sends
  `forkedFromTaskId` + the chosen `contextOptions` only when a source is selected;
  the fork selection (and only it) is cleared after a successful submit.
- **Task Console skills selector** — a collapsible **Skills** section after Tool
  selection, fed by `GET /api/skills` (enabled + valid only, sorted by name — never a
  hard-coded list). Mode select **Automatic / Manual / Auto + selected**; checkbox
  grid with a `n/12 selected` counter (extra checkboxes disabled at the cap; a
  defensive validate() guard). Collapsed header shows a minimal summary
  ("automatic selection" or "n/12 selected · manual"). `skillsMode` is sent only when
  it is not `auto`; `skills` only when the mode is not `auto` and the selection is
  non-empty.
- **Task Console execute-all switch** — a **"Execute every planned step, even after
  the goal is achieved"** switch rendered only for the pre-plan planner; submits
  `executeAllPlannedSteps: true` only when enabled.
- **Our Products page** — the new `products.tsx` view (nav entry **Our Products**,
  Rocket icon): responsive cards from `GET /api/products` with category, technology
  chips, honest status badges (`live | demo | in-development`), optional external
  link and screenshot; `demoView` entries open the demo INSIDE the console (the
  Assistant chat and the Dashboard are the shipped demo entries). Honest loading,
  empty and error states.
- **Shared ShellTerminal** — one xterm.js shell component (`shell-terminal.tsx`)
  renders BOTH the real-FS terminal (`fs-terminal.tsx` adapter) and the VFS terminal
  (`vfs-terminal.tsx` adapter, distinct amber accent theme) in line mode: local echo,
  Up/Down command history, Ctrl+C/Ctrl+L, replay-with-prompt fidelity on reconnect and
  an explicitly configured **bold block cursor** (`cursorStyle: 'block'`, blink,
  bright cursorAccent — never a default theme). Session tabs, New/Restart/Clear/Copy/
  interrupt controls and the mobile layout are preserved; Enter now submits the
  command as a real child process (see [Terminal](terminal.md)).
