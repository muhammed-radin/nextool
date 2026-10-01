---
title: Testing
category: Operations
order: 2
---

# Testing

Honest status first: **NexTool Q1 ships without an automated test suite.** There is no
unit, integration or E2E test code in the repository, and no test runner is configured.
What exists instead is `bun run lint` plus the manual verification workflows below —
the same ones used to verify v1.0.0 and v1.0.1 end-to-end in a real browser and with
curl.

## What you can run today

```bash
bun run lint         # eslint over the repo — the only automated gate
```

Everything else is manual but scripted below so it is repeatable.

## Smoke workflow (API level)

Run against a fresh dev server (`bun run db:push && bun run dev`):

```bash
# 1. system healthy?
curl -s http://localhost:3000/api/system | grep -o '"runtimeStatus":"[a-z]*"'

# 2. tools seeded (15 built-ins)?
curl -s http://localhost:3000/api/tools | grep -o '"name":"[^"]*"' | wc -l

# 3. goal task completes
TASK=$(curl -s -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01"}' | grep -o 'task_[0-9a-f]*')
sleep 12
curl -s http://localhost:3000/api/tasks/$TASK | grep -o '"status":"[a-z]*"' | head -1

# 4. history recorded, events streamed
curl -s "http://localhost:3000/api/tasks/$TASK/executions"
curl -s -N "http://localhost:3000/api/stream?since=0" --max-time 3 | head -4

# 5. settings round-trip
curl -s -X PUT http://localhost:3000/api/settings -H 'Content-Type: application/json' \
  -d '{"maxIterations":35}' | grep -o '"maxIterations":[0-9]*'
```

Expected: `online`, 15 tools, `"status":"completed"`, executions with
`server.health`, `hello` frame on the stream, `maxIterations:35`.

## Manual browser workflow (the release gate used for v1.0.x)

1. **Dashboard** — metric cards populated from `/api/system`, latency chart draws after
   the first task, recent tasks/events lists live.
2. **Task Console** — create a goal task (validation on empty request), then a live
   task with the amber opt-in + confirmation switch; submitting navigates to Task
   Preview.
3. **Task Preview** — plan with step statuses, executions with params/result JSON,
   MainState viewer, 5 context panels, live timeline merging REST + SSE, terminal;
   Stop dialog cancels cleanly; Send Event dialog injects (`scheduled.force` wakes a
   waiting live task); Feedback dialog revises the active subgoal.
4. **Live Monitor** — live task shows interval/next-tick; press **Crash** on a server →
   recovery subgoal → health → restart → verified healthy; counters update.
5. **Tools** — 15 built-ins with schema accordions; register a dynamic tool
   (`echo`/`http_get`); toggle off → subsequent decisions avoid it.
6. **Memory / Live State** — add/delete memory entries; inject crash/degrade/recover
   and watch fleet + status pill flip.
7. **Models / Datasets** — load dialog accepts a valid `.nextool` manifest and rejects
   an invalid one with the 400 reason; import a dataset (split bars), export, delete;
   parquet export shows the honest `PARQUET_UNAVAILABLE` error card.
8. **Docs view** — this documentation index renders, search filters, pages open.
9. **Settings** — edit + save round-trips; SSE transport shown as locked.
10. **Responsive pass** — 390×844 (bottom nav, More sheet, 2-col grids) and 1440×900;
    connection pill reflects real SSE state when you kill the dev server mid-session.

## Regression checklist (v1.0.1 focus areas)

- Connection indicator: real state, 5 states, popover details, manual reconnect,
  refocus recovery after `error`.
- Mobile shell: bottom nav 5 slots, More sheet reaches every view, safe-area padding.
- Glassmorphism: no emerald/teal brand accents; status colors only for status.
- Docs system: `/api/docs` index + `/api/docs/{slug}` render; unknown slug → friendly
  404 state; traversal-safe slugs rejected.
- Version surfaces: header badge, status bar, `/api/system.appVersion` all read 1.0.1;
  engine stays llm-core 1.0.0.

## Known gaps (by design in v1.0.1)

- No unit/integration tests for `loop.ts` state machines, executor races, or settings
  clamping — these are covered only by the manual workflows.
- No CI pipeline configuration in the repo.
- No load/soak testing tooling.
- The Evaluation page's benchmark runner is planned, not implemented.

If you add automated tests later, natural seams are: `coerceParams`/`validateParams`
(pure), `heuristicDecide` (pure), the settings clamp function, and the
`reconnectDelayMs` policy (pure) — all testable without a server.
