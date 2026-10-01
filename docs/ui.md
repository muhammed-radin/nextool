---
title: UI Design System
category: Frontend
order: 2
---

# UI Design System — Blue Gradient Glassmorphism

The v1.0.1 visual language: a deep navy field with blue gradient light, glass surfaces
at several blur depths, precise technical typography, and strictly reserved status
colors. Defined in `src/app/globals.css`; consumed as utility classes.

## Layer hierarchy

Back-to-front, each layer has a specific class — do not mix them:

| # | Layer | Class | Treatment |
| --- | --- | --- | --- |
| 1 | Ambient background | `.ambient-bg` | Fixed full-screen blue radial gradient field over `--background` (`oklch(0.145 0.028 262)`). |
| 2 | Technical grid | `.ambient-grid` | 44 px grid at 2.2% white, radially masked; **desktop only** (hidden < 768 px). |
| 3 | Application shell | `.glass-shell` | Header, sidebar, bottom nav, status bar. White 5.5→2% gradient, **blur 20**, border white/9%. |
| 4 | Section panels | `.glass-panel` | View sections. White 4.5→1.5%, **blur 14**, soft blue drop shadow. |
| 5 | Cards & rows | `.glass-card` (`.glass-card-hover`) | White 3.5%, **blur 10**; hover lifts border to sky/32%. |
| 6 | Solid controls | Buttons, inputs, badges, progress | No glass — high-contrast solid fills (primary `oklch(0.62 0.19 255)`) for readability on glass. |
| 7 | Overlays | `.glass-strong` | Popovers/dialogs/dropdowns/sheets: 92–94% opaque navy, **blur 22**, heavy shadow. |
| 8 | Insets | `.glass-inset` | Terminal & JSON wells: very dark 88%, **blur 8**, inner shadow. |

Accent utilities: `.bg-primary-gradient` / `.bg-primary-gradient-soft` (135° blue
gradient fills), `.text-gradient` (cyan→blue gradient text), `.glow-blue` (brand glow
for the logo mark / primary buttons), `.border-gradient` (gradient hairline).
`.nextool-terminal` adds the blue scanline texture; `.nextool-scroll` the thin blue
scrollbars.

## Typography

| Role | Font | Variable / class | Usage |
| --- | --- | --- | --- |
| Primary interface | **Readex Pro** 300–700 | `--font-readex-pro` (`font-sans`) | Headings, body, nav, forms. |
| Technical labels | **Michroma** 400 | `--font-michroma` (`font-tech`) | Version badges (`Q1 v1.0.3`), small-caps section labels like `Notifications`, `Runtime`, status bar markers. Michroma renders best small and uppercase with wide tracking. |
| Code | **Geist Mono** | `--font-geist-mono` (`font-mono`) | Terminal output, JSON blocks, ids, metrics, event types. |

Loaded in `layout.tsx` via `next/font/google`; variables set on `<html>`. Body uses
`font-feature-settings: "ss01" on`.

## Color semantics

- **Brand accent: blue.** Primary `oklch(0.62 0.19 255)`; accent highlights sky-300/400
  and cyan-300 (active nav items, tech labels, links, focus gradients).
- **Status colors are reserved for status meaning** — never decorative:
  - emerald = ok / healthy / connected
  - amber = warn / degraded / reconnecting / live-mode caution
  - rose = error / unhealthy / offline / critical
  - zinc/slate = neutral (queued, pending, stopped, disconnected)
- Use `text-foreground` / `text-muted-foreground` instead of raw zinc-* for text;
  borders live in the `white/[0.07–0.1]` band.
- Charts: `--chart-1..5` blue→cyan→teal→amber→red ramp.

## Do-not rules

1. **Never use emerald/teal for brand elements** — green is a *status* color only;
   brand actions and accents are blue.
2. **Never stack blur on blur** — a `.glass-card` inside a `.glass-panel` is fine;
   adding `.glass-strong` behind a popover that already has it is not.
3. **Never put solid-on-glass text without contrast** — body text on glass panels uses
   `text-foreground`; muted text ≥ 11 px.
4. **Never use Michroma for long text** — it is a display face for labels/badges.
5. **Never fabricate data to fill a panel** — empty/error states are part of the design
   (`EmptyState`, `ErrorCard`).
6. **Never hand-roll a connection indicator** — use `RuntimeConnectionStatus`.
7. **Never let the status bar detach** — keep the `min-h-screen flex flex-col` +
   `mt-auto` shell pattern.
8. **Never animate without need** — `prefers-reduced-motion: reduce` collapses all
   animation/transition durations to ~0; motion must remain optional.

## Component conventions

- **StatusChip / SourceDot / TypeChip** (`ui-bits.tsx`) are the only way statuses,
  event sources and event types are rendered — tones map through `statusTone`:
  running/completed/healthy/online → ok; waiting/degraded/timeout/restarting → warn;
  failed/unhealthy/offline → err; queued/pending/stopped/cancelled → neutral;
  goal → neutral, live → warn.
- **JsonBlock** renders JSON in `.glass-inset` wells with capped heights.
- **MetricCard** pairs a `TechLabel` (Michroma) with a large mono value in a
  `.glass-card`.
- **Terminal** (`terminal.tsx`) uses `.glass-panel` chrome, `nextool-terminal`
  scanlines, a runtime-derived status line (no hardcoded prompt), source-colored lines,
  auto-scroll, blink cursor.

## Mobile performance profile (< 768 px)

Blur is reduced and shadows removed to keep scrolling smooth: shell 20→12, panel 14→9,
card 10→6, strong 22→16, `.ambient-grid` hidden. The same reduced profile applies
automatically via `@media (max-width: 767px)` — components need no per-viewport
overrides for blur. See [Mobile](mobile.md) for layout specifics.

## Viewport / theming meta

`layout.tsx` sets `themeColor #050914`, `width=device-width`, `initialScale=1`,
`viewportFit=cover` (safe-area support), `color-scheme: dark`, and the app is
dark-only (`className="dark"`).
