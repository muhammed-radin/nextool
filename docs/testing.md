---
title: Testing
category: Operations
order: 2
---

# Testing

NexTool Q1 ships a focused **bun test** unit suite alongside `bun run lint`
and the manual verification workflows below.

```bash
bun test                     # runs tests/*.test.ts (36 tests / 91 assertions across 2 files)
bun run lint                 # eslint over the repo
bunx tsc --noEmit            # strict TypeScript check (zero errors)
```

## Unit suite

Pure-function coverage (no database required): `tests/nextool-v102.test.ts` (v1.0.2
core) and `tests/nextool-v103.test.ts` (v1.0.3 additions).

| Area | What is verified |
| --- | --- |
| Training preprocessing | tokenizer keeps `api-01`-style tokens, vectorizer is deterministic + L2-normalized, `prepareDataset` split carve is deterministic and counts skipped examples |
| js-function sandbox | `validateFunctionSource` catches real syntax errors (Bun defers `vm.Script` compilation — the probe executes the definition), source limits; `runJsTool` returns serializable results, exposes `context.mode/executionId`, collects `log()` lines, and blocks `require` |
| Tool params | `coerceParams` string→number / CSV→array coercion; `validateParams` required/enum/min-max errors |
| Icon parsing | `pngDimensions` reads real IHDR width/height, rejects non-PNG and absurd sizes |
| Status derivation | `deriveTaskRuntime` transitions (idle / running / planning / observing / terminal states, active tool tracking), `terminalStatusLine` cursor blinks **only** while a tool runs (spec §7-11), `deriveChecklist` plan + event fallback and null-percent honesty (spec §62-65) |
| **v1.0.3 Parquet adapter** | `@dsnp/parquetjs` capability probe reports the real package; real encode/decode round-trip through the adapter; per-row validation errors (missing category/request, non-object `expectedParams` JSON, invalid split) carry the row index |
| **v1.0.3 icon aliases** | `favicon-16x16.png`→`icon-16.png`, `favicon-32x32.png`→`icon-32.png`, `android-chrome-*`→sized icons, `apple-touch-icon-*`→`apple-touch-icon.png`; aliased content still passes real PNG dimension validation against the canonical size |
| **v1.0.3 parallel config** | task-config and settings zod schemas accept `parallelToolCalls` / `maxParallelToolCalls` (int 1–8) |
| **v1.0.3 checklist states** | each `PlanStep` status maps to the documented glyph state; a finishing step becomes completed dynamically (not hardcoded) |

The `tests/` directory also contains shell scripts that verify the **sandbox
infrastructure** (fake-`bun` harness around `db:push`, python-runtime
build/container checks). They test the hosting environment, not the application.

What is intentionally **not** unit-tested: Prisma/SQLite persistence paths and
the Next.js route handlers — those are covered by the scripted API smoke and
browser verification below (the sandbox runs the app in dev mode; no
production-build gate exists in this environment).

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

## v1.0.2 feature smoke (CLI + API)

```bash
# js-function tool: register → test → call (see docs/tool-development.md)
curl -s -X POST http://localhost:3000/api/tools/js -H 'Content-Type: application/json' \
  -d '{"name":"utility.wordcount","description":"count words","category":"utility",
       "schema":{"type":"object","properties":[{"name":"text","type":"string",
       "required":true,"description":"text"}]},
       "functionSource":"return { words: (params.text.match(/\\S+/g) ?? []).length };"}'
curl -s -X POST http://localhost:3000/api/tools/test -H 'Content-Type: application/json' \
  -d '{"name":"utility.wordcount","params":{"text":"one two three"}}'
# → data.status "completed", data.result.words 3, data.mode "test-source"

# dataset → train → benchmark → export (needs ≥ 4 labeled examples, ≥ 2 tools)
nextool dataset import ds.json -n smoke-ds -v 1.0.0
nextool train -d smoke-ds -e 3
nextool benchmark -d smoke-ds -m heuristic-fallback
nextool model export -m current -f tfjs -o ./exports/model.zip
nextool model import ./exports/model.zip      # round-trip; real TFJS load check

# parquet round-trip (v1.0.3 — the adapter is real)
nextool dataset import data.parquet -n x -v 1.0.0        # binary import via @dsnp/parquetjs
nextool dataset export x --format parquet -o ./out.parquet  # binary export (--output required)
curl -s http://localhost:3000/api/models | grep -o '"parquet":true'
```

Expected: a `tc-…` model registered by training, benchmark metrics over the labeled
examples, a writable zip in `exports/`, and a real Parquet import/export round-trip.

## Manual browser workflow (the release gate used for v1.0.x)

1. **Dashboard** — metric cards populated from `/api/system`, latency chart draws after
   the first task, recent tasks/events lists live.
2. **Task Console** — create a goal task (validation on empty request), then a live
   task with the amber opt-in + confirmation switch; submitting navigates to Task
   Preview.
3. **Task Preview** — live checklist/timeline (`[✓]/[-]/[ ]/[!]/[~]`, indeterminate bar
   without a plan), plan with step statuses, executions with result JSON in the JSON
   tree, MainState viewer, 5 context panels, live timeline merging REST + SSE,
   dynamic terminal (`[running]: Tool called …` while a tool executes, cursor stops
   when it ends); *Preview as Terminal* toggle persists across reloads (default OFF);
   Stop dialog cancels cleanly; Send Event dialog injects; Feedback dialog revises the
   active subgoal.
4. **Live Monitor** — live task shows interval/next-tick; press **Crash** on a server →
   recovery subgoal → health → restart → verified healthy; counters update.
5. **Tools + Tool IDE** — 15 built-ins with schema accordions; New Tool opens Monaco
   with `nextool-dark`; IntelliSense completes schema params; invalid schema JSON blocks
   save; Test Tool runs the sandbox (logs visible); Duplicate creates a js-function
   copy; toggle off → subsequent decisions avoid the tool; Delete has a confirm dialog.
6. **Training** — pick dataset, run a short job, per-epoch metrics grow, logs stream,
   cancel works between epochs; too-small dataset fails with the honest message.
7. **Benchmark** — run `heuristic-fallback`, then `llm-core`, then a trained model id;
   metric cards + per-case table render; history lists previous runs.
8. **Models** — Export dropdown downloads real zips; Import dialog accepts a `.nextool`
   package and rejects a corrupt zip with the surfaced TFJS error; bare-manifest import
   shows the *not runnable* warning.
9. **Memory / Live State** — add/delete memory entries; inject crash/degrade/recover
   and watch fleet + status pill flip.
10. **Settings → Branding & icons** — upload an icons.zip (missing favicon.ico → explicit
    rejection; wrong-sized `icon-192.png` → per-file reason; `favicon-16x16.png`-style
    names accepted via aliases; manifest/metadata files listed as skipped), preview,
    Apply, favicon swaps to the packaged one; DELETE discards a staged package.
11. **Docs view** — this documentation index renders (37 pages), search filters, pages
    open.
12. **Responsive pass** — 390×844 (bottom nav, More sheet, 2-col grids) and 1440×900;
    connection pill reflects real SSE state when you kill the dev server mid-session.

## Regression checklist (v1.0.2 focus areas, still valid in v1.0.3)

- Dynamic runtime status: no hardcoded `nextool@runtime:~$` prompt or static "Running";
  `[running]: Tool called <tool>` cursor behavior matches actual executions.
- JSON tree: no raw `JSON.stringify` dumps remain; depth-2 collapse + copy work.
- Tool sandbox: `fetch`/`require`/timers unavailable inside js tools (limitation, not
  bug); 64 KiB / depth-12 result limits enforced with readable errors.
- Training honesty: no pause control anywhere; `valLoss`/`valAccuracy` null without a
  holdout; cancel between epochs only.
- Benchmark honesty: `paramAccuracy` `-`/null without `expectedParams` or for
  classifiers; suite fixed to `tool-selection`.
- Version surfaces: header badge, status bar, `/api/system.appVersion`, `nextool
  version` all read 1.0.3; engine stays llm-core 1.0.0.
- Parallel batching (v1.0.3): a multi-step plan with independent steps emits
  `planner.parallel_batch`, executions share a `batchId` (grouped card in Task Preview),
  a failing sibling does not cancel the others (`planner.partial_failure`), and
  `parallelToolCalls: false` runs everything sequentially.
- Task output (v1.0.3): on a completed task the Live Checklist/Terminal area is gone and
  the *Final task output* section shows the recorded summary + metric tiles; the plan
  section renders as the animated checklist.

## Known gaps (by design)

- `loop.ts` state machines, the executor race paths, training/benchmark engines and
  settings clamping have no dedicated unit tests — these are covered
  only by the manual workflows above.
- No CI pipeline configuration in the repo.
- No load/soak testing tooling.
- Training has no pause/resume (cancel between epochs only).

If you add automated tests later, natural seams are: `vectorize`/`prepareDataset` and
`resolveTrainingConfig` (pure), `runJsTool` limits (`validateFunctionSource`,
`ensureSerializable` — pure), `coerceParams`/`validateParams` (pure),
`heuristicDecide` (pure), the settings clamp function, `pngDimensions` in `branding.ts`
(pure), and the `reconnectDelayMs` policy (pure) — all testable without a server.
