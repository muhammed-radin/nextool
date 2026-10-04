---
title: Testing
category: Operations
order: 2
---

# Testing

NexTool Q1 ships a focused **bun test** unit suite alongside `bun run lint`
and the manual verification workflows below.

```bash
bun test                     # runs tests/*.test.ts (440 tests across 15 files, 0 failing)
bun run lint                 # eslint over the repo
bunx tsc --noEmit            # strict TypeScript check (zero errors)
```

## Unit suite

Pure-function coverage (no database required): `tests/nextool-v102.test.ts` (v1.0.2
core), `tests/nextool-v103.test.ts` (v1.0.3 additions), `tests/nextool-v104.test.ts`
(v1.0.4 additions), `tests/nextool-v105.test.ts` (v1.0.5 additions) and
`tests/nextool-v106.test.ts` (v1.0.6 additions — 53 tests) and
`tests/nextool-v107.test.ts` (v1.0.7 additions — 41 tests).
`tests/nextool-v108.test.ts` (v1.0.8 additions — 47 tests).
`tests/nextool-v109.test.ts` (v1.0.9 additions — 19 tests).
`tests/nextool-v1091.test.ts` (v1.0.91 additions — 30 tests).
`tests/nextool-v1010.test.ts` (v1.0.10 additions — 45 tests, ~1484 expects).
`tests/nextool-v1011.test.ts` (v1.0.11 additions — 32 tests).
Full suite: **371 tests / 0 fail across 11 files**.

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
| **v1.0.4 tool export** | `exportToolJson`/`exportToolsJson` round-trip through the portable envelope (`nexool.kind "nextool.tool"`, version 1, function source preserved as text, real schema field names); `toolExportFilename` sanitizes names |
| **v1.0.4 tool import validation** | arrays/bundles/non-objects rejected; missing/bad `name` and `description` rejected; js-function tools require `functionSource` (≤ 64 000 chars); schema rules (param types, `enumValues` array, names); `builtin`/`virtual-env` environments rejected (read-only registry tools); dynamic tools require a known `handlerKind`; a bare-array schema (register-dialog format) is tolerated |
| **v1.0.4 import parsing + conflicts** | `parseToolImport` readable errors for invalid JSON and multi-tool bundles; `proposeCopyName` yields `base.copy` then `base.copy-2`, `base.copy-3` … |
| **v1.0.4 task tool requirement** | `taskConfigSchema.enabledTools` accepts a non-empty list and rejects an explicit empty array / non-array values (zod `min(1)`) |
| **v1.0.4 JSON theme tokens** | every `NextoolDarkTheme` entry uses the `--w-rjv-*` namespace the library actually reads, and the core syntax tokens exist with bright values (contrast on the dark background) |
| **v1.0.5 editor source-sync invariants** | `coerceEditorChange` never lets a non-string onChange clear the source (a genuine user clearing is honored); `readMonacoValue` reads the live model and falls back to the shared state when the editor is disposed (tab switch); an unsaved-edit → test → no-write-back round trip preserves the code |
| **v1.0.5 metadata round trip** | `exportToolJson`/`validateImportedTool` preserve the structured string key/value pairs (≤ 50); non-string values and non-object metadata are rejected; tools without metadata export/import cleanly |
| **v1.0.5 nodejs sandbox** | allowed `require()`/`await import()` work (incl. `node:`-prefixed specifiers); blocked/unknown modules fail with the `Module "x" is not available…` wording; `process` is not a global; a no-`await` infinite loop is stopped by the vm sync timeout (`TIMEOUT`); oversized/non-serializable results rejected (`NOT_SERIALIZABLE`); source validation caps |
| **v1.0.5 dynamic-import transform** | `import()` call sites rewrite to the allowlist shim; property access, identifiers, string literals, comments, regex literals and template text are preserved while interpolated code transforms; the transformed source compiles standalone (no vm-module flag) and executes end-to-end |
| **v1.0.5 nodejs portability** | a `nodejs` tool exports with environment + exact source + metadata and round-trips losslessly; import requires `functionSource` for nodejs; unknown environments still rejected |
| **v1.0.5 schemas** | `registerJsToolSchema` accepts `environment: "nodejs"` + string-only metadata (rejects unknown environments / non-string values); `updateToolSchema` accepts the environment switch + `handlerKind`/`handlerConfig` (rejects unknown kinds); `testToolSchema` accepts the `nodejs` environment hint (rejects e.g. `"builtin"`) |
| **v1.0.5 docs link resolver** | external / in-page-anchor / internal classification; `./x.md`, `../dir/x.md`, `x.md` and bare-slug normalization; resolution against a real slug list; genuinely missing pages resolve to null (in-viewer not-found state); anchor extraction; GitHub-style `headingSlug` parity; case-insensitive fallback |
| **v1.0.6 network policy** | `parsePolicyUrl` rejects non-http(s) protocols and blocked hosts (`HOST_BLOCKED` for localhost/private/link-local/metadata); `policyFetch` enforces the request-count limit (`REQUEST_LIMIT`), response-size cap (`RESPONSE_TOO_LARGE`) and 3-redirect ceiling with per-hop re-validation; `NetworkPolicyError` carries stable codes |
| **v1.0.6 XMLHttpRequest** | the real XHR class over the policy layer: open/setRequestHeader/send/abort, readyState transitions, onload/onerror/onreadystatechange fire with captured status/responseText; sync mode rejected |
| **v1.0.6 VFS** | path traversal rejected (`..`, encoded `%2e%2e`, backslash, `file:` URLs, NUL) with the documented `VirtualFSAccessError`; real store/retrieve round trips (write → read → append → rename → rm), node-shaped errors (`ENOENT`/`EISDIR`), limits enforced (512 KiB file, total cap), workspace usage metadata |
| **v1.0.6 virtual child_process** | the 22 documented commands execute against the VFS (ls/cat/grep/wc/… pipelines); shell metacharacters → exit 126, unknown commands → exit 127, pipe-stage/process/output limits enforced; no host process is spawned |
| **v1.0.6 import resolver** | allowlist + virtual module resolution (incl. `node:` prefix), VFS-relative requires (`./lib.js`, JSON modules), conservative ESM transform (`export default` / named exports), `URL_IMPORTS_DISABLED` by default; js-function require() resolves VFS modules only |
| **v1.0.6 nodejs runtime expansion** | the sandbox executes the expanded runtime end-to-end: `fs` reads/writes the ephemeral workspace, virtual `os` values (`nextool-virtual`), `fetch` through the policy, dynamic import of a VFS module; blocked modules still fail with the documented wording |
| **v1.0.6 auto-execute precedence** | `resolveAutoExecute` — global `autoExecuteTools: true` overrides everything; per-task config next; per-tool `autoExecute` (default false → approval required); export/import round-trips the flag and tools without the field default false without invalidating |
| **v1.0.6 IntelliSense honesty** | the environments payload exposes `network`, `vfs`, `childProcess` and the `capabilities` matrix — the IDE capability table and reference panel render the real runtime config (no hardcoded copy) |
| **v1.0.7 timeout configuration** | defaults (`DEFAULT_TOOL_TIMEOUT_MS` = 10000, max = 3600000); `resolveEffectiveToolTimeout` precedence (default → task fallback → tool-specific), values above 1 hour capped with the `capped` flag, sub-second garbage floored; settings/task/tool zod schemas ACCEPT 10000…3600000 and REJECT 3600001+ |
| **v1.0.7 timeout propagation** | `createNetworkAccounting` carries the effective request timeout (bounded 1 s–1 h); `policyFetch` times out after the CONFIGURED value (stubbed abort-honoring fetch — the TIMEOUT message reports `1000ms`, not the 10 s default); `executeTool` end-to-end: a tool with `timeoutMs: 5000` completes while stamping `execution.timeoutMs = 5000`; a hanging tool with `timeoutMs: 1000` times out at ~1 s (not the 60 s fallback) with the real value in the error; the executor watchdog produces the spec-shaped error `Tool "delay.wait" timed out after 400ms.`; `ToolTimeoutError` carries tool/operation/effectiveTimeoutMs/elapsedMs/reason; virtual `child_process` accepts the raised ceiling |
| **v1.0.7 tool search** | `filterTools` matches name/description/category/environment/handler kind/metadata; case-insensitive + trimmed; AND semantics for multiple tokens; empty query returns everything; no result → empty array |
| **v1.0.7 dependency-aware cleanup** | analysis protects models referenced by training/benchmark jobs and `status: "active"`, protects referenced datasets, flags orphans; dry-run removes NOTHING; actual cleanup removes only confirmed orphans and leaves no broken references; **idempotency** — the second run removes nothing; validation reports the active model + resolved references |
| **v1.0.7 application reset** | wrong confirmation phrase → failures + nothing deleted; correct phrase clears tasks/events/history/memory/notifications/VFS + zeroes tool statistics; tools (with definitions), models, datasets, training/benchmark records and settings SURVIVE (no broad DB wipe); the API route rejects missing/incorrect phrases with 400 and performs the backend reset with the exact phrase; the zod schema is strict about `RESET` |
| **v1.0.8 central configuration limits** | the shipped JSON validates; every numeric property satisfies min ≤ default ≤ max; shipped defaults asserted (network 60 s / 5 MiB / 56 / 56 / URL imports enabled; VFS 2 MiB / 700 MiB / 4000 / 56; execution 10 s / 4 s / 256 MiB / 64000 / 64 KiB / 100; childProcess 8 s / 64 KiB / 64 / 3 / 32 / 25); invalid JSON / bad type / min>max / default>max / default<min / non-integer / bad boolean / bad enum ALL fail clearly; a corrupted limits FILE throws `ConfigurationLimitsError` (never a silent fallback); **dynamic limit test (§23)** — change one value in a temp file, reload: limits + settings + schema + sandbox getters all see it |
| **v1.0.8 confirm()** | js-function + nodejs `confirm()` resolve booleans; production mode waits, registry lists with task/execution/tool association; resolve true/false; cancellation and task stop resolve **false** (never true); `POST /api/confirmations` resolves; unknown id reports honestly; `tool.confirm.requested/responded` events carry the association |
| **v1.0.8 URL imports** | js-function + nodejs `await import('https://…')` (stubbed fetch): default + named + multiple exports; blocked protocol rejected in both environments; response size capped by `network.maxResponseBytes`; requests counted in the per-execution accounting; a blocked policy never bypassed through the module cache (§2.6); URL modules cannot reach host fs/process (§2.4); integration against real `unpkg.com` (skips offline) |
| **v1.0.8 virtual child_process** | ALL v1.0.6 commands preserved; new commands (cut/tr/sed/awk/tee/find/tree/du/df/which/whoami/uname/realpath/readlink/yes/clear); `cd` persists per-execution and cannot escape the VFS; host/dangerous commands blocked (127/126); `node` executes VFS programs inside the sandbox (fs→VFS, host fs blocked, execSync sync + honest async note); `npm init/install/ls` installs REAL (stubbed-registry) packages into VFS node_modules with host untouched; lifecycle scripts NOT auto-run (§3.7) but runnable explicitly; **§21 MERN workflow**: mkdir → cd → npm init → write src → npm install → node require('pkg') — all inside the VFS, host unchanged |
| **v1.0.8 limits flow** | `DEFAULT_SETTINGS` derive from central limits; settings/task/function-source schema bounds follow the metadata; js-runner getters (`maxFunctionSourceChars`/`syncTimeoutMs`/`maxResultBytes`/`maxLogLines`) are live; execution timeout precedence still holds with the live ceiling; **§5.4** — a lowered `maxFileBytes` preserves pre-existing larger files while new violating writes fail clearly |
| **v1.0.91 fetch self-origin** | `parsePolicyUrl("/api/tools/test")` resolves against the application origin (`getSelfOrigin`, `NEXTOOL_SELF_ORIGIN` override); `isSelfRelativePath` rejects `//host`; ABSOLUTE loopback/private URLs stay `HOST_BLOCKED` (SSRF guard untouched — even the app origin addressed absolutely); `selfOriginAccess: false` → honest `INVALID_URL`; `parseRedirectUrl` keeps the exemption for relative locations on self-origin requests, resolves relative locations on external hosts and blocks absolute loopback hops; `policyFetch` dispatches a relative POST with `Content-Type` + JSON body as POST (never rewritten to GET) while external `https://` requests keep their method/headers/body; **REAL loopback**: a js-function tool whose source `fetch("/api/tools/test", { method: "POST", … })` runs against a loopback server → HTTP 200, POST + JSON content-type observed server-side |
| **v1.0.91 POST /api/tools/test route** | route-level tests import the restored handler: test-source mode returns the documented envelope (`mode/status/result/logs`); registered tool runs by name (`mode: "registered"`); unknown name → 404 `NOT_FOUND` (not 405); both/neither name+functionSource → 400 `INVALID_PARAMS`; a sandboxed source POSTing to the relative endpoint inside the route gets `status: 200` |
| **v1.0.91 bulk import** | `parseToolsImport`: object → `single`, array → `bulk`, `[]` → honest `bulk-empty`, invalid JSON → clear `Invalid JSON file` error, `{tools:[…]}` bundle still rejected; legacy `parseToolImport` keeps its single-object contract; `buildBulkImportPlan` validates EVERY item through the same `validateImportedTool` pipeline (mixed validity → per-item reasons; non-object garbage never valid), detects duplicate names INSIDE the file (§2.9) and conflicts with existing registry names (§2.8); **export-all round trip** — `exportToolsJson` → JSON → parse → all items valid, names/source/metadata preserved; single-object import with metadata/autoExecute/timeoutMs unchanged |
| **v1.0.10 planner strategy resolution** | `resolvePlannerType` precedence (task override → global `defaultPlannerType` → `'pre-plan'`); invalid values fall back to `pre-plan`; resolved values are what `planner.mode_selected` carries |
| **v1.0.10 single-step sanitization** | `sanitizeOneStepResponse` keeps exactly ONE step (title/detail/kind normalization, id assignment); a `{"steps":[…]}` response retains the FIRST valid step and reports the rest as `discarded`; unparseable input → `buildOneByOneFallbackStep` (failure-aware when `knownFailures` exist, latest-observation-aware otherwise) — never zero steps |
| **v1.0.10 central limits + validation** | `task.prePlanMaxSteps` {integer, default 10, min 1, max 122} validates in `configuration-limits.json`; settings/task zod schemas accept 1–122 and reject 123+ (`INVALID_REQUEST`, "expected number to be <=122"); `plannerType` enum rejects unknown strategies; old configs without the fields stay valid |
| **v1.0.10 pattern confidence math** | `deriveConfidence` = `successRate × min(1, total/3) − 0.15 × contradictions` (floor 0): one observation → ≤ 0.333, repetition 0.333 → 0.667 at frequency 2, one-off patterns stay 0.333, contradictions weaken |
| **v1.0.10 pattern → example conversion** | `patternsToDatasetExamples` converts reliable single-action patterns (`early-completion:<tool>`, `outcome:unhealthy-detected->restart`) at `minConfidence` 0.5; multi-tool transitions are deliberately NOT converted; `?format=examples` endpoint shape verified |
| **v1.0.10 training `modelVersion`** | optional semver-validated config registers the checkpoint under the given version (default `TRAINED_MODEL_VERSION` `'1.0.1'`); `checkpointSelection` (best-val-accuracy strategy) and `modelSemanticVersion` land in the manifest; legacy `tc-<job>` `checkpointId` preserved |
| **v1.0.10 seed dataset integrity** | `config/training/seed-dataset-v1.0.1.json`: valid JSON, strict shape, 170 examples — 121/23/26 splits, all 15 tools in train AND test, zero duplicate requests (no split leakage), `expectedParams` conform to the real tool schemas |
| **v1.0.11 pre-plan recovery state machine** | a failed pre-plan step FREEZES the main plan (later steps never run first), creates a recovery subgoal and pre-plans it with `RECOVERY_PLAN_MAX_STEPS = 4`; the resume is STATE-AWARE — a resolved condition marks the failed step completed (detail gains `resolved by recovery attempt N`), otherwise the step is re-queued at its original position; completed steps are never repeated; attempt counts persist per failed step across entries (Map on the task run); exhaustion → `RECOVERY_EXHAUSTED` abort, unrecoverable → immediate `RECOVERY_UNRECOVERABLE` abort (no wasted budget), stop/approval-timeout → `RECOVERY_BLOCKED`; the eight `planner.recovery_*`/`main_plan_*` events carry the documented payloads |
| **v1.0.11 recovery attempt budget** | `task.recoveryMaxAttempts` {integer, default 4, min 2, max 4} validates in the central limits; settings + task zod schemas REJECT out-of-range values (400, not clamped); the recovery engine resolves the budget from the task config, never hard-codes it |
| **v1.0.11 freedom-node gate** | `isFreedomNodeAuthorized()`/`getFreedomFsConfig()` read the central `fs` section live ({enabled: true, restricted: false}); the gate FAILS CLOSED — a closed gate (or unreadable config) rejects every freedom-node execution with `FREEDOM_DISABLED` before anything runs; test runs route through the same runner + gate; `registerJsToolSchema`/`updateToolSchema`/`testToolSchema` accept `freedom-node`; portable import/export round-trips the environment string EXACTLY (`IMPORTABLE_ENVIRONMENTS` includes it) |
| **v1.0.11 auto-execution hierarchy** | `resolveAutoExecution(global, tool, task)` test matrix: G=T/O=F/Tk=F → ON (global); G=T/O=T/Tk=F → ON (global); G=F/O=T/Tk=F → ON (tool); G=F/O=F/Tk=T → ON (task); G=F/O=F/Tk=F → OFF (default); `undefined` never forces and a lower layer can never override a higher enable; back-compat `resolveAutoExecute` delegates to it; `tool.auto_execution` is emitted with `{ tool, enabled, source }` when a lower layer decides (global-forced stays silent) |
| **v1.0.11 seed dataset 1.0.2 integrity** | `config/training/seed-dataset-v1.0.2.json`: valid JSON, strict shape, 324 examples — 246/39/39 splits, 17 categories, all 15 tools in ALL THREE splits, zero duplicate requests, `expectedParams` conform to the real tool schemas, frozen test/validation membership |
| **v1.0.11 long-input caps** | `createTaskSchema.request` accepts 32 000 chars and rejects beyond; `datasetExampleSchema.request` likewise (8 000 → 32 000) |

The `tests/` directory also contains shell scripts that verify the **sandbox
infrastructure** (fake-`bun` harness around `db:push`, python-runtime
build/container checks). They test the hosting environment, not the application.

What is intentionally **not** unit-tested: Prisma/SQLite persistence paths and
the Next.js route handlers — those are covered by the scripted API smoke and
browser verification below. **Production build remains a documented sandbox
constraint** (the environment runs the app in dev mode, which compiles all routes on
demand; no production-build gate exists here — the same constraint as v1.0.2–v1.0.5;
`bun run build` is not run in this sandbox).

## Smoke workflow (API level)

Run against a fresh dev server (`bun run db:push && bun run dev`):

```bash
# 1. system healthy?
curl -s http://localhost:3000/api/system | grep -o '"runtimeStatus":"[a-z]*"'

# 2. tools seeded (15 built-ins)?
curl -s http://localhost:3000/api/tools | grep -o '"name":"[^"]*"' | wc -l

# 3. goal task completes (config.enabledTools is required since v1.0.4)
TASK=$(curl -s -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01","config":{"enabledTools":["server.health"]}}' | grep -o 'task_[0-9a-f]*')
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
   save; Test Tool runs the sandbox (logs visible); Duplicate registers a copy (the
   original is untouched); toggle off → subsequent decisions avoid the tool; Delete has
   a confirm dialog; Export downloads the tool JSON; Import accepts it back (and
   offers Replace / Import as copy on a name conflict).
6. **Training** — pick dataset, run a short job, per-epoch metrics grow, logs stream,
   cancel works between epochs; too-small dataset fails with the honest message.
7. **Benchmark** — run `heuristic-fallback`, then `llm-core`, then a trained model id;
   metric cards + per-case table render; history lists previous runs.
8. **Models** — Export dropdown downloads real zips; Import dialog accepts a `.nextool`
   package and rejects a corrupt zip with the surfaced TFJS error; bare-manifest import
   shows the *not runnable* warning.
9. **Memory / Live State** — add/delete memory entries; inject crash/degrade/recover
   and watch fleet + status pill flip.
10. **Icons (API-managed since v1.0.4)** — the Settings *Branding & icons* card was
    removed; upload an icons.zip via `curl -F file=@icons.zip` to `POST /api/icons`
    (missing favicon.ico → explicit rejection; wrong-sized `icon-192.png` → per-file
    reason; `favicon-16x16.png`-style names accepted via aliases; manifest/metadata
    files listed as skipped), `PATCH /api/icons` `{action:"activate"}` → the favicon
    swaps AND the in-app header/more-sheet logo renders the packaged icon; `DELETE`
    discards a staged package. Without an active package the in-app logo is the "N"
    monogram.
11. **Docs view** — this documentation index renders (37 pages), search filters, pages
    open.
12. **Responsive pass** — 390×844 (bottom nav, More sheet, 2-col grids) and 1440×900;
    connection pill reflects real SSE state when you kill the dev server mid-session.

## v1.0.12 suites (added)

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/nextool-v1012-mcp.test.ts` | 21 | MCP provider registry, schema conversion, connector lifecycle, credential isolation, discovery, import (identity-only definitions), execution through the connector, failure mapping, disconnect/reconnect availability, schema refresh with metadata preservation, export classification (§1.1–§1.19, §2.1–§2.2) — mock MCP client, no external credentials |
| `tests/nextool-v1012-vfs.test.ts` | 16 | shared VFS across tools/tasks, restart persistence, traversal/encoded/symlink escape rejection, whole-store limits, freedom-node exemption, all 10 fs.* tools (§3.1–§3.13, §4) |
| `tests/nextool-v1012-model.test.ts` | 11 | model 1.0.3 version surfaces, v1.0.3 curriculum integrity (447 examples, every registered tool in all three splits), trained checkpoint registered, both checkpoint exports on disk, real import path + REAL inference (§6.1–§6.11, §8.6) |
| `tests/nextool-v1012-instructions.test.ts` | 21 | instruction combining (file+textarea), persistence round-trip, planner/core/observer context wiring, hierarchy safety (system block always first), large/special-character markdown (§7.1–§7.9) |

## Regression checklist (v1.0.2 focus areas, still valid in v1.0.11)

- Dynamic runtime status: no hardcoded `nextool@runtime:~$` prompt or static "Running";
  `[running]: Tool called <tool>` cursor behavior matches actual executions.
- JSON tree: no raw `JSON.stringify` dumps remain; depth-2 collapse + copy work.
- Tool sandbox: the js-function sandbox is still restricted — no `process`, no Node
  modules (require() is VFS-modules-only since v1.0.6); the common APIs (`fetch`, XHR,
  alert/prompt, timers) go through the controlled layers; 64 KiB / depth-12 result
  limits enforced with readable errors.
- Training honesty: no pause control anywhere; `valLoss`/`valAccuracy` null without a
  holdout; cancel between epochs only.
- Benchmark honesty: `paramAccuracy` `-`/null without `expectedParams` or for
  classifiers; suite fixed to `tool-selection`.
- Version surfaces: header badge, status bar, `/api/system.appVersion`, `nextool
  version` all read 1.0.12; engine stays llm-core 1.0.0 (not retrained); trained
  checkpoints register under 1.0.3 (v1.0.12 curriculum).
- Parallel batching (v1.0.3): a multi-step plan with independent steps emits
  `planner.parallel_batch`, executions share a `batchId` (grouped card in Task Preview),
  a failing sibling does not cancel the others (`planner.partial_failure`), and
  `parallelToolCalls: false` runs everything sequentially.
- Task output (v1.0.3): on a completed task the Live Checklist/Terminal area is gone and
  the *Final task output* section shows the recorded summary + metric tiles; the plan
  section renders as the animated checklist.
- Tool requirement (v1.0.4): the Task Console blocks submit without a selected tool;
  `POST /api/tasks` without `config.enabledTools` → 400 `TOOLS_REQUIRED`; an explicit
  `[]` fails zod validation with `INVALID_REQUEST`.
- Tool code sync (v1.0.4): edit code in Monaco without touching anything else → Save
  persists exactly the on-screen code (re-open the tool to confirm); Test runs the
  same code; in-editor Duplicate + Save creates a NEW tool and leaves the original
  unchanged.
- Tool portability (v1.0.4): Export → Import the same file back; the import preview
  shows the exact source; importing under the same name offers Replace / Import as
  copy / Cancel — never a silent overwrite.
- JSON tree (v1.0.4): syntax colors are readable on the dark glass wells (bright
  palette), not the near-black library default.
- Plan checklist (v1.0.4): no vertical rail line alongside the steps; checklist states
  and animations unchanged.
- nodejs sandbox (v1.0.5): `require('crypto')` works inside a nodejs tool;
  `require('fs')` fails with the blocked-module wording; a nodejs tool registers,
  exports, imports and runs through `/api/tools/test` with `"environment": "nodejs"`.
- Editor sync (v1.0.5): edit code → Test Tool → the editor still shows the unsaved
  code (before == after); Save persists it; switching tools loads the stored source.
- IDE sections (v1.0.5): environment selector offers js-function/nodejs/dynamic (a
  dynamic tool is locked); metadata rows save ≤ 50 string pairs; schema form and JSON
  view agree; the Monaco ⇄ textarea toggle preserves the code in both directions.
- Docs routing (v1.0.5): an in-content link like [CoreModule](../ai-core/core-module.md)
  navigates within the Docs view (no browser 404); an anchored link lands on the
  heading; a genuinely missing slug shows the in-viewer not-found card.
- Import model modal (v1.0.5): at 320/390 px the dialog stays inside the viewport with
  a scrollable body, full-width stacked buttons, a wrapped chosen-file chip, and
  validation errors rendered as an in-modal alert card.
- Common runtime APIs (v1.0.6): a `js-function` tool can `await fetch()` a public
  https URL and gets `HOST_BLOCKED` for `http://localhost`; `await alert(...)` emits
  `tool.user_alert`; in a real task `await prompt(...)` pauses only the tool (the task
  loop keeps moving) and is answered from the console card; in a test run prompt
  returns its default immediately.
- Virtual FS (v1.0.6): a `nodejs` tool writes `/output/x.txt`, reads it back in a
  later execution (persistence), gets `VirtualFSAccessError` for `../` escapes, and
  `fs.usage()` reports real byte counts; a Test run's workspace is wiped.
- Virtual child_process (v1.0.6): `cp.exec('ls /data')` returns VFS listing (no host
  files), `cat x | grep y | wc -l` works (3 stages), `echo a && rm b` exits 126, an
  unknown command exits 127.
- Approval gate (v1.0.6): with defaults, a task-driven execution of a new tool emits
  `tool.approval.required` and parks the task in `awaiting_approval`; Allow proceeds,
  Deny skips (with `observer.feedback_applied` when feedback is typed); a 5-minute
  timeout stops the task. `autoExecuteTools: true` (global or per-task) bypasses the
  wait. Parallel batches: approving one tool does not approve its siblings.
- Multi-event mode (v1.0.6): with `allowMultipleEvents` on, events injected while a
  live task is busy queue (`live.event.queued`) and process one-by-one in priority →
  arrival order; the queue survives a page refresh (persisted in task state); queue
  full drops the lowest priority with a recorded `live.event.dropped`.
- Pause/Resume (v1.0.6): Pause on a live task flips status to `paused` (sky-blue)
  after the current execution finishes, `task.paused` fires; events injected during
  pause are retained; Resume continues (never restarts) and `task.resumed` fires; no
  tick burst on resume.
- Tool timeout (v1.0.7): set the global tool timeout to 30000, run a tool that sleeps
  ~15 s (e.g. a `nodejs` tool using `timers/promises.setTimeout`) — it completes; the
  `tool.started`/`tool.timeout` payloads carry the effective `timeoutMs`; set a tool's
  own `timeoutMs` in the Tool IDE and verify the global default no longer applies.
- Tool search (v1.0.7): type `server` into the Tools search field — the grid filters
  live; a nonsense query shows "No tools found" + "Clear search".
- Application reset (v1.0.7): Settings → Danger zone → Reset Application Data →
  without the phrase the button stays disabled; type `RESET` → confirm; tasks/events/
  memory/statistics are cleared while tools/models/datasets remain (verify the Tools
  and Models pages still render everything afterwards).
- Cleanup (v1.0.7): Settings → Maintenance → Analyze shows protected/orphaned
  resources without deleting; Clean up removes only orphans; running it a second time
  removes nothing (idempotent).
- Tool IDE test (v1.0.91): click **Test** on a registered tool and run a Tool IDE
  test on unsaved source — both return the execution envelope with HTTP 200 (the
  v1.0.91 route restoration removed the `HTTP 405` fallthrough).
- In-sandbox self-call (v1.0.91): a js-function tool that does
  `fetch("/api/tools/test", { method: "POST", headers: { "Content-Type":
  "application/json" }, body: JSON.stringify({ functionSource: "…", params: {} }) })`
  returns HTTP 200 with the test envelope; the same tool using an ABSOLUTE
  `http://127.0.0.1:3000/…` URL still fails with `HOST_BLOCKED`.
- Single import (v1.0.91): a single-tool JSON object imports exactly as v1.0.4 —
  preview → (conflict dialog when the name exists) → Register.
- Bulk import (v1.0.91): import an *Export all tools* array — the Bulk Import Tools
  preview lists every item with ✓/✕; tools that already exist show
  Replace/Import-as-copy/Skip per row (default Skip — never a silent overwrite);
  confirming runs with a live progress bar and ends in the
  Imported/Skipped/Failed summary; all imported tools appear in the registry and
  re-export identically (round trip).
- Empty/invalid bulk files (v1.0.91): `[]` shows "No tools found in this JSON file."
  and registers nothing; a malformed file shows "Invalid JSON file — …" and
  registers nothing.
- One-by-one ordering acceptance (v1.0.10, §47–§53): run a goal task with
  `plannerType: 'one-by-one'` and verify the EVENT TIMELINE order —
  `planner.mode_selected` → `planner.one_by_one_step_planned` (source `llm`,
  `discarded` count) → the tool events → `planner.one_by_one_step_completed`
  (tool + durationMs) → `planner.one_by_one_goal_reached` → `task.completed`; exactly
  one step is planned per cycle and no hidden future list exists.
- One-by-one live continuation (v1.0.10): with a live task on the one-by-one planner,
  each tick/event plans ONE action from the current world state, executes, observes and
  verifies the goal (evidence recorded); the task CONTINUES across ticks (never torn
  down by a passing goal check), and environment-driven repair passes still run for
  both planner types.
- Override precedence (v1.0.10): a task created with `plannerType: 'one-by-one'`
  keeps it after the global default is switched back to `pre-plan` (resolved AND
  persisted at creation — `planner.mode_selected` shows `taskOverride: true,
  globalDefault: 'pre-plan'`); a task created without the field follows the global
  default; safeguards (`maxIterations`, `safetyLimit`, `taskTimeoutMs`) still bound
  one-by-one loops (a test task hit `SAFETY_LIMIT` at `maxIterations=12` as designed).
- Server-side 122/123 rejection (v1.0.10): `POST /api/tasks` with
  `config.prePlanMaxSteps: 123` → 400 `INVALID_REQUEST` ("expected number to be
  <=122"); `plannerType: 'fast-forward'` → 400; `PUT /api/settings` validates both
  fields the same way; `prePlanMaxSteps: 10` (the default) is accepted and visible in
  the Task Console Planning controls.
- Pre-plan recovery acceptance (v1.0.11): run a pre-plan goal task whose step fails —
  the event timeline shows the main plan FROZEN (`planner.recovery_started`), a
  recovery subgoal with its OWN pre-plan (`planner.recovery_plan_built`, ≤ 4 steps),
  sequential recovery execution through the normal gates, then EITHER
  `planner.recovery_succeeded` + `planner.main_plan_resumed` (the failed step completed
  with "resolved by recovery attempt N" in its detail, or re-queued at its original
  position and re-executed for real) OR honest exhaustion (`planner.recovery_exhausted`
  + `planner.main_plan_aborted`, task failed with `RECOVERY_EXHAUSTED`). Completed
  steps are never repeated; later steps never run first.
- Recovery budget validation (v1.0.11): `POST /api/tasks` with
  `config.recoveryMaxAttempts: 5` → 400 `INVALID_REQUEST` (range 2–4, never clamped);
  `recoveryMaxAttempts: 1` → 400; the Settings → Planning field clamps within 2–4 from
  the central limit; exhausting the budget ends the task with the failed step named in
  the statusDetail.
- freedom-node gate (v1.0.11): with the shipped config (`fs.enabled: true`) a
  freedom-node tool reaches the real host fs / network; set `fs.enabled: false` in
  `config/configuration-limits.json` (the ONLY way — the Settings UI has no control,
  no API flips it) → every freedom-node execution AND Tool-IDE test run is rejected
  with `FREEDOM_DISABLED` and nothing executes; existing js-function/nodejs tools keep
  byte-for-byte behavior; export → import of a freedom-node tool round-trips the
  environment string exactly.
- Auto-execution hierarchy (v1.0.11): with the global switch OFF and a tool set to
  Enabled, a task-driven execution auto-runs and emits `tool.auto_execution` with
  `source: 'tool'`; with the global switch ON, the Task Console switch shows
  "Controlled by global auto-execution setting" and the emitted source (if any lower
  layer is involved) is `'global'`-forced behavior; the Tool IDE tri-state select with
  Inherit keeps approval-required unless a higher layer enables; `tool.approval.*`
  flows are unchanged.

## Known gaps (by design)

- `loop.ts` state machines, the training/benchmark engines and task-level
  settings clamping have no dedicated unit tests — these are covered
  only by the manual workflows above (the v1.0.7 executor timeout race IS covered).
- No CI pipeline configuration in the repo.
- No load/soak testing tooling.
- Training has no pause/resume (cancel between epochs only).

If you add automated tests later, natural seams are: `vectorize`/`prepareDataset` and
`resolveTrainingConfig` (pure), `runJsTool` limits (`validateFunctionSource`,
`ensureSerializable` — pure), `coerceParams`/`validateParams` (pure),
`heuristicDecide` (pure), the settings clamp function, `pngDimensions` in `branding.ts`
(pure), and the `reconnectDelayMs` policy (pure) — all testable without a server.
