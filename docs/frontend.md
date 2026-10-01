---
title: Frontend
category: Frontend
order: 1
---

# Frontend Architecture

The console is a **single-page application**. The only server-rendered route is `/`
(`src/app/page.tsx` → `<ConsoleApp/>`); all 16 screens are client-side views switched by
a zustand store. No routing library, no other pages.

## SPA shell

`src/components/console/console-app.tsx` composes:

- **Header** (glass shell): brand button (the real NexTool logo via `BrandLogo` +
  `Q1 v1.0.5` tech badge), `RuntimeConnectionStatus` pill, notification bell with unread
  badge and dropdown.
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

## The 16 views

`ConsoleView` union in `console-store.ts` — each a file in `views/`:

| View | File | Purpose |
| --- | --- | --- |
| Dashboard | `dashboard.tsx` | Metric cards, latency area chart, recent tasks → preview, recent events. |
| Task Console | `task-console.tsx` | Create tasks: request, mode + live opt-in, L1–6, memory switch, limits (incl. v1.0.3 "Parallel tool calls" toggle + "Max parallel calls" in Execution limits), tool multi-select — **required** since v1.0.4 ("Tool selection *" label, amber "required — select at least 1" hint, submit blocked with "Select at least one tool before running the task."); compact quick-fill examples on their own wrapping row (v1.0.4). |
| Task Preview | `task-preview.tsx` | Dedicated per-task screen: badges, stop/send-event/feedback dialogs, live checklist/timeline **while the task is active** (removed + replaced by *Final task output* on terminal states — v1.0.3), plan-as-checklist, parallel-batch grouping, executions, MainState JSON, 5 context panels, events timeline, runtime terminal (+ *Preview as Terminal* toggle). |
| Live Monitor | `live-monitor.tsx` | Live tasks (3 s polls), fleet with injections, filtered event terminal, terminal preview toggle. |
| Tools | `tools.tsx` | Registry grid, enable switches, stats, schema accordions, register dialog; grid actions (New Tool / Edit / Duplicate / Test / Enable/Disable / Delete); v1.0.4 per-tool **Export** + dropdown **Import tool (JSON)…** / **Export all tools (JSON)** with preview + conflict dialogs — see [Tools](../tools/tools.md). |
| Tool IDE | `tool-editor.tsx` | v1.0.2: Monaco JS editor (`nextool-dark` theme), schema editor, IntelliSense, References pane, test panel — see [Tool Development](../tools/tool-development.md). v1.0.3: definite editor heights at every breakpoint. v1.0.4: `source` state is the single source of truth (Monaco controlled + writes back); save/test read the code directly from the Monaco model via a live editor ref; in-editor **Duplicate** registers a copy instead of renaming the original; per-session remount on tool switch. v1.0.5: sectioned form (General · Execution environment · Metadata · Schema), `js-function \| nodejs \| dynamic` environment selector fed by `GET /api/tools/environments`, structured metadata rows, schema form + JSON view, Monaco ⇄ textarea toggle (default ON), handler-kind selector with structured config for dynamic tools, and source-sync guards (`coerceEditorChange`/`readMonacoValue`) so a test can never clear the editor. |
| Training | `training.tsx` | v1.0.2: dataset + config picker, per-epoch metrics table, streamed log lines, job history, cancel/delete. |
| Benchmark | `benchmark.tsx` | v1.0.2: dataset + model-key picker, metrics cards, per-case results table, run history. |
| Memory | `memory.tsx` | Persistent Memory CRUD vs Live State explainer. |
| Live State | `live-state.tsx` | Fleet banner + cards + injections (3 s refresh). |
| Events | `events.tsx` | Filterable event stream: source, type search, priority ≥ slider, expandable rows. |
| History | `history.tsx` | 100-entry table, filters, expandable params/result. |
| Models | `models.tsx` | Active engine card, adapters panel, packages + manifests, load dialog, export dropdown + import model dialog (v1.0.2); v1.0.4 responsive header — title/description then full-width stacked *Export Current Model* + *Import model* buttons on mobile (`min-h-11 w-full` → `sm:min-h-9 sm:w-auto`), unchanged multi-column layout on desktop. v1.0.5: the import dialog itself is rebuilt — scrollable body between stable header/footer, stacked touch targets on mobile, chosen-file chip, in-modal error card (see [Models](../ai-core/models.md#the-import-model-dialog-v105-rework)). |
| Datasets | `datasets.tsx` | Split bars, example-schema panel, import dialog (JSON paste/file **or binary `.parquet` upload** — cyan selected-file panel, multipart), separate **JSON** and **Parquet** export buttons per card, cyan parquet format badge, delete. |
| Docs | `docs.tsx` | Built-in documentation reader (search, category index, two-pane); v1.0.5: the centralized link resolver navigates internal markdown links WITHIN the viewer (no 404s), cross-page anchors auto-scroll, and a genuinely missing page renders an in-viewer not-found state (see below). |
| Settings | `settings.tsx` | Bound settings form, unsaved-changes badge, SSE transport locked note; v1.0.3 "Parallel tool calls by default" + "Max parallel calls". v1.0.4: the *Branding & icons* card was **removed** from the UI — the icon infrastructure itself (uploads, `/api/icons`, staging/activation, favicon serving, the in-app `BrandLogo`) remains fully functional; manage packages via the API (see [Deployment](deployment.md)). |

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
`[idle] [queued] [starting] [planning] [running] [observing] [waiting] [completed]
[failed] [stopped] [cancelled]`. Task Preview, Live Monitor, the terminal and the status
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
  waiting for the 2.5 s poll.
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
