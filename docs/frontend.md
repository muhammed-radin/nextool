---
title: Frontend
category: Frontend
order: 1
---

# Frontend Architecture

The console is a **single-page application**. The only server-rendered route is `/`
(`src/app/page.tsx` → `<ConsoleApp/>`); all 13 screens are client-side views switched by
a zustand store. No routing library, no other pages.

## SPA shell

`src/components/console/console-app.tsx` composes:

- **Header** (glass shell): brand button (logo + `Q1 v1.0.1` tech badge),
  `RuntimeConnectionStatus` pill, notification bell with unread badge and dropdown.
- **Navigation**: desktop glass sidebar (12 items + a conditional *Task Preview* entry
  showing the short id once a task is selected); mobile bottom nav (see
  [Mobile](mobile.md)); view transitions via framer-motion `AnimatePresence`.
- **Status bar** (desktop-only footer): runtime dot + `active`/`live` counts, engine,
  uptime, `stream: <state>`, app version, 1 s local clock. Pinned with the
  `min-h-screen flex-col + mt-auto` pattern so it sits at the bottom on every screen.
- **Toaster** (sonner) for operation feedback.

## The 13 views

`ConsoleView` union in `console-store.ts` — each a file in `views/`:

| View | File | Purpose |
| --- | --- | --- |
| Dashboard | `dashboard.tsx` | Metric cards, latency area chart, recent tasks → preview, recent events. |
| Task Console | `task-console.tsx` | Create tasks: request, mode + live opt-in, L1–6, memory switch, limits, tool multi-select. |
| Task Preview | `task-preview.tsx` | Dedicated per-task screen: badges, stop/send-event/feedback dialogs, plan, executions, MainState JSON, 5 context panels, timeline, terminal. |
| Live Monitor | `live-monitor.tsx` | Live tasks (3 s polls), fleet with injections, filtered event terminal. |
| Tools | `tools.tsx` | Registry grid, enable switches, stats, schema accordions, register dialog. |
| Memory | `memory.tsx` | Persistent Memory CRUD vs Live State explainer. |
| Live State | `live-state.tsx` | Fleet banner + cards + injections (3 s refresh). |
| Events | `events.tsx` | Filterable event stream: source, type search, priority ≥ slider, expandable rows. |
| History | `history.tsx` | 100-entry table, filters, expandable params/result. |
| Models | `models.tsx` | Active engine card, honest adapters panel, packages + manifests, load dialog. |
| Datasets | `datasets.tsx` | Split bars, import dialog with preview counts, export, delete. |
| Docs | `docs.tsx` | Built-in documentation reader (search, category index, two-pane). |
| Settings | `settings.tsx` | Bound settings form, unsaved-changes badge, SSE transport locked note. |

Shared widgets live in `ui-bits.tsx` (StatusChip, SourceDot, TypeChip, EventRow,
JsonBlock, MetricCard, SectionTitle, EmptyState, ErrorCard, SkeletonBlock, PulsingDot,
TimeAgo, formatters), `server-card.tsx` (fleet card) and `terminal.tsx` (runtime://
terminal with scanlines). Every view follows the same discipline: skeletons while
loading, honest empty states, error cards with retry, and full cleanup on unmount.

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

Typed helpers exist for all 30 endpoints (`getSystemStats`, `createTask`, `stopTask`,
`sendTaskFeedback`, `getTaskContext`, `registerTool`, `toggleTool` (URL-encodes dotted
names), `addMemory`, `listHistory`, `getModels`, `loadModel`, `importDataset`,
`exportDatasetUrl`, `getDocsIndex`, `getDocPage`, …). Result DTOs: `DocsIndex` /
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
