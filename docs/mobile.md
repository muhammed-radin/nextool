---
title: Mobile & Responsive
category: Frontend
order: 3
---

# Mobile & Responsive

v1.0.1 shipped a mobile-first redesign: a bottom navigation shell, safe-area handling,
blur-reduced glass, and layouts that hold from a 320 px phone to a 1440 px desktop.

## Breakpoints & range

| Range | Layout |
| --- | --- |
| **320–767 px** (`<md`) | Mobile shell: bottom nav + hamburger Sheet, single/2-col grids, no sidebar, no status bar. Blur-reduced glass (see [UI](ui.md)). |
| **≥ 768 px** (`md`) | Desktop shell: glass sidebar (w-56), status bar footer, multi-column grids, full blur. |
| **≥ 1024 px** (`lg`) | Two-pane docs reader, wider metric grids. |
| **Up to 1440 px+** | Content is centered with `max-w-[1600px]`/`max-w-lg` caps where appropriate. |

## Bottom navigation (< md)

Fixed `glass-shell` nav (`fixed inset-x-0 bottom-0 z-40`, `pb-safe`) with a 5-column
grid:

| Slot | Destination | Icon |
| --- | --- | --- |
| 1 | **Dashboard** | LayoutDashboard |
| 2 | **Tasks** (Task Console) | TerminalSquare |
| 3 | **Live** (Live Monitor) | RadioTower |
| 4 | **Tools** | Wrench |
| 5 | **More** (bottom sheet) | MoreHorizontal |

- The active item is sky-300 with a small gradient bar at the top edge; the More slot
  shows active state for *any* non-primary view.
- **More sheet**: 70 dvh `glass-strong` bottom Sheet ("All sections") with a 2-column
  grid of *every* remaining view — Memory, Live State, Events, History, Models,
  Datasets, Documentation, Settings — plus Task Preview when a task is selected, so no
  screen is unreachable on mobile.
- Desktop parity: the sidebar holds the same 12 items + conditional Task Preview entry.

## Safe areas

- `viewportFit=cover` is set in `layout.tsx`, exposing the env insets.
- `.pb-safe` = `padding-bottom: env(safe-area-inset-bottom)` — applied to the bottom
  nav.
- `.h-safe-bottom-nav` = `3.75rem + env(safe-area-inset-bottom)` helper for reserving
  nav height.
- Main content uses `pb-24 md:pb-6` so nothing hides behind the floating nav.

## Touch targets & ergonomics

- Nav items are `min-h-[3.75rem]` (60 px) tall — comfortably above the 44 px minimum.
- Sidebar/links use `min-h-11` (44 px); More-sheet tiles `min-h-12` (48 px).
- Dialogs (stop confirm, send event, feedback) and dropdowns use `glass-strong` for
  maximum readability over glass.
- Form controls are the shadcn/Radix set — native-size touch targets, focus rings
  preserved (`outline-ring/50` + `focus-visible:ring-2` everywhere).

## Mobile performance: blur reduction < 768 px

`@media (max-width: 767px)` in `globals.css`:

| Class | Desktop blur | Mobile blur |
| --- | --- | --- |
| `.glass-shell` | 20 | 12 |
| `.glass-panel` | 14 | 9 (+ shadow removed) |
| `.glass-card` | 10 | 6 |
| `.glass-strong` | 22 | 16 |

`.ambient-grid` is hidden on mobile; `prefers-reduced-motion` disables animation
entirely. These reductions are automatic — components don't branch on viewport for
glass.

## Task Preview on mobile

The dedicated task screen stacks vertically: header badges → action buttons (stop /
send event / feedback dialogs) → goal + subgoal cards → plan → executions accordion →
MainState JSON → 5 context panels (single column) → event timeline → terminal. While a
task is active it polls detail every 2.5 s; the SSE timeline dedupes against REST
backfill. From the Task Console, submitting a task navigates straight into this
preview; on mobile the Task Preview entry also appears in the More sheet.

v1.0.3 mobile specifics: the plan section renders as the animated live checklist, the
Timeline tab's terminal disappears once the task reaches a terminal state (the events
timeline remains), and the live checklist/terminal area is replaced by the *Final task
output* section (summary, metric tiles, artifacts, final-result JSON).

## v1.0.4 mobile refinements

- **Models header stacks** — the header is a flex column on phones: title, then
  description, then the *Export Current Model* and *Import model* buttons stacked
  full-width (`min-h-11 w-full`, 44 px touch targets). From `sm` up they share a row
  again (`sm:flex-row sm:w-auto sm:min-h-9`); the desktop `lg` two-sided layout is
  unchanged.
- **Task Console examples** — the "Examples" label sits on its own row and the
  quick-fill buttons wrap below it (`flex flex-wrap gap-1.5`); each button is a compact
  secondary action (`h-8 px-2.5 text-[11px]`) so the example list no longer squeezes
  the title row on narrow screens while staying readable and tappable.
- **Real brand logo** — the mobile menu sheet header, the More-sheet header and the
  Tool IDE loading card show the actual NexTool logo from the active icon package
  (monogram fallback); see [Frontend](frontend.md#brand-logo-brand-logotsx-v104).
- **Tool selection required** — the tool multi-select is labeled *"Tool selection *"*
  with an amber "required — select at least 1" hint; submit is blocked (validation
  banner + toast) until at least one tool is chosen, so a phone user can no longer
  create a task the runtime would reject.

## v1.0.5 mobile refinements

- **Import model dialog fits the viewport** — the Models **Import model** dialog is a
  flex column capped at `85dvh` with a stable header/footer and a single scrollable
  body, so it no longer overflows on phones (verified at 320/390 px: dialog width =
  viewport − 2 rem, zero page horizontal overflow). The mobile flow is stacked:
  full-width choose button (≥ 44 px) → chosen-file chip (long names wrap with
  `break-all` + native tooltip) → error card → hairline divider → manifest textarea →
  full-width **Cancel** / **Validate & load** buttons. Validation errors render inside
  the dialog as rose `role="alert"` cards instead of only toasts (see
  [Models](../ai-core/models.md#the-import-model-dialog-v105-rework)).
- **Tool IDE mobile tabs** — the editor is a horizontally scrollable tab strip:
  **Details / Schema / Function (or Handler) / References / Test**. Details stacks the
  General, Execution environment and Metadata sections; the Function tab keeps a real
  420 px Monaco editor (or the textarea twin behind the toggle) plus the Test panel
  gets its own tab. Switching tabs unmounts Monaco safely — the shared source state is
  the fallback, so code is never lost (see
  [Tool Development](../tools/tool-development.md#editor-source-sync-guarantees-v105)).
- **Desktop unchanged** — from `lg` up the IDE keeps its two-pane split layout and the
  import dialog keeps its row footer; the changes only replace squeezing with stacking
  below the breakpoints.

## Live Monitor priority layout

Live Mode gets the priority treatment on small screens:

1. **Live tasks first** — status, current subgoal, observation/event counts, interval +
   next-tick estimate, stop button.
2. **Fleet second** — server cards (cpu/mem bars tinted by health) with the
   Crash/Degraded/Recover injections for driving event-driven automation from a phone.
3. **Event terminal last** — §55-filtered runtime stream (monitoring-relevant types).

## Verified responsive behavior

Browser-verified in the v1.0.0/1.0.1 runs at **390×844** (drawer nav, 2-col grids,
bottom nav, safe-area padding) and **1440×900** (sidebar, status bar), with zero page
or console errors and the sticky footer behaving correctly on both short and long
pages.

## Practical tips

- Test with the browser device toolbar at 320 px *and* 390 px — the narrow end exposes
  truncation in badges/ids (short ids mitigate this).
- Keep new views grid-based (`grid-cols-2 md:grid-cols-…` patterns) so they inherit
  the mobile density without custom breakpoints.
- Any fixed element added must respect `pb-safe`/`pb-24` just like the bottom nav.
