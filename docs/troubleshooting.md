---
title: Troubleshooting
category: Operations
order: 3
---

# Troubleshooting

Symptom → cause → fix tables for the failures you are most likely to meet. All
console/entity references match the actual UI.

## Runtime not connecting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Header pill stuck on **Connecting** | Dev server not running / wrong port | Start `bun run dev` (port 3000); check `dev.log` for compile errors. |
| Pill flips between **Connected** and **Reconnecting** | Server restarts (HMR or crash) drop SSE | Expected during dev; production is stable. If repeated in prod, check server logs for crashes. |
| Pill shows **Error** (rose) | 8 reconnect attempts exhausted | Press *Reconnect now* in the pill popover, or switch tabs away and back (visibility refocus grants one fresh budget). |
| Status bar says `offline` but pill says Connected | `/api/system` poll failing (5 s) while SSE still up | Check `/api/system` manually; usually a transient DB error — see "DB issues" below. |
| "Runtime unavailable" error cards everywhere | Backend unreachable or returning non-JSON | Hit `/api/system` with curl; inspect `dev.log`/`server.log`. |

## SSE disconnected / stream problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Stream connects but no events | You are filtering by `taskId` with no events yet | Clear the task filter or create activity; the global stream replays the last 15 min. |
| Events stop after ~30–60 s behind a proxy | Proxy buffering or idle timeout | Ensure `X-Accel-Buffering: no` passes through / set `proxy_buffering off;` and raise `proxy_read_timeout` (see [Deployment](deployment.md)). |
| Duplicate events in a timeline | Should not happen — dedupe set survives reconnects | If seen, report: check that frames carry unique `id`s (`evt_…`). |
| Replay window seems short | In-memory ring holds only the last 500 events | For older history use `GET /api/tasks/{id}/events` or `/api/history` (DB-backed). |

## Tool problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| `tool.failed` with `UNKNOWN_TOOL` | Tool name not in registry (typo, or registered in a different process) | `GET /api/tools` to list actual names; dynamic tools must be registered in the running instance. |
| `tool.failed` with `INVALID_PARAMS` | Params failed coercion/validation (missing required, wrong type, out of min/max, bad enum) | Read the joined message on the event/execution; it names each violation. |
| `tool.failed` with `NO_HANDLER` | Definition exists but no handler bound (e.g. dynamic tool whose kind was dropped) | Re-register with a valid `handlerKind`. |
| Task failed `TOOL_FAILURE` after retry | Tool failed twice (Goal Mode retries once) | Check `planner.retry` + `tool.failed` events for the root cause; fix the tool or environment, then re-run. |
| Execution ends `timeout` (`TIMEOUT`) | Handler exceeded `toolTimeoutMs` (default 30 s, executor floor 250 ms) | Raise the task's `toolTimeoutMs` (max 300 000) or fix the slow handler; `delay.wait` caps at 10 s. |
| Tool won't toggle | Wrong name encoding | Tool names contain dots — URL-encode the path segment: `/api/tools/server.health/toggle`. |
| CoreModule says `cannot_execute` | Chosen tool disabled or excluded by the task's `enabledTools` allow-list | Re-enable the tool or widen the allow-list in Task Console. |
| **Test Tool blanked the editor** (function code gone) | Should be impossible since v1.0.5 — test runs never write back into the editor, and non-edit `onChange` events (model swaps) are coerced to the previous value | If you ever see it on an old build: hard-refresh the page (the stored source is untouched on the server — re-open the tool); on a current build please report it, the invariants are unit-tested |
| `Module "x" is not available in the NexTool Node.js environment.` | Expected sandbox behavior — a `nodejs` tool used `require()`/`import()` on a module outside the allowlist + virtual set (static: `buffer, crypto, events, path, querystring, string_decoder, url, util, assert, zlib`; virtual: `fs, os, timers, timers/promises, http, https, child_process`) | Rework the tool with the allowed modules, or move the capability into a dynamic handler / built-in; the live allowlist is served by `GET /api/tools/environments` and shown in the IDE References panel (see [Tool Development](../tools/tool-development.md)) |
| `NetworkPolicyError: HOST_BLOCKED` on `fetch` | The tool requested a localhost/private-range/link-local/metadata host — blocked by the network policy (by design; also enforced on every redirect hop) | Target a public http(s) host; the full policy is documented in [Tool Development](../tools/tool-development.md#network-policy-v106) and served by `GET /api/tools/environments` (`network`) |
| `VirtualFSAccessError: Access to the NexTool host filesystem is not permitted.` | A VFS operation decoded to a path escaping the tool's virtual workspace (encoded `..`, `file:` URL, backslash path, NUL byte) — rejected by design, never silently redirected | Fix the path to stay inside `/input /output /tmp /data /workspace`; limits + path rules are in [Tool Development](../tools/tool-development.md#the-virtual-file-system-v106) |
| `child_process` exits 126 / 127 | 126 = shell metacharacter (`;` `&&` `\|\|` `>` `<` …) or a policy limit (3 pipe stages, 32 args, 4 processes); 127 = unknown command | Use only the 22 documented virtual commands, simple single pipes only; the command table is in [Tool Development](../tools/tool-development.md#virtual-childprocess-v106) |

## Live task issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| Live task never triggers on schedule | Process restarted while the task was `waiting` — in-memory timer is gone | Stop and re-create the task (it stays `waiting` in the DB otherwise). |
| `task.waiting` but environment crash didn't wake it | Wake requires priority ≤ 5, or broadcast failed | Crash broadcasts use priority 2; check Events for `environment.server.crash`; verify with `POST /api/tasks/{id}/event` (`scheduled.force`). |
| Live task ignores user feedback | `learnFrom.feedback` off or feedback wasn't delivered | Send via the Task Preview Feedback dialog (priority 2); confirm the `user.feedback` event exists. |
| Recovery loop keeps failing | Server can't reach `healthy` (restart path verifies health) | Inspect the repair-pass events; inject `server.recover` manually to force health. |

## Approval, prompt and pause issues (v1.0.6)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Task stuck in `awaiting_approval` | A tool with `autoExecute: false` (the default) is waiting for its Allow/Deny decision | Open Task Preview or Live Monitor and use the pending-approval card (**Allow** / **Deny** with optional feedback); no decision within **5 minutes** → `tool.approval.timeout` and the task stops — it is never silently executed. Prevent the wait globally/per-task with `autoExecuteTools`, or per-tool via the IDE Auto-Execute switch. |
| Task shows `paused` but the tool prompt/approval card is still pending | Pause preserves the approval/prompt unresolved — never auto-allowed or denied | Resume the task and answer the card; the 5-minute approval timeout (and the 120 s prompt timeout) remain well-defined during pause. |
| Tool prompt waiting forever | `await prompt(...)` pauses that tool until someone answers, cancels, or 120 s elapse | Answer or cancel in the console's prompt card (Task Preview / Live Monitor, `POST /api/prompts`); after 120 s it resolves `null` by itself. Test runs never wait — the default (or `null`) is returned immediately. |
| Paused task can't resume after a server restart | Honest limitation — the run handle (and its resume signal) lives in memory; the task row stays `paused` in the DB | Stop the task and re-create it; Stop still works on an orphaned `paused` task. Avoid long pauses across deployments. |
| Paused task resumed but nothing happened yet | Resume restarts the live interval fresh (no burst of missed ticks) and processes retained events first | This is by design (§11.5); the first cycle runs after the next interval tick, or immediately after the retained event queue is drained (multi-event mode). |

## Model load failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| 400 `INVALID_MANIFEST` | One or more rules failed (name, semver-like version, `format:"nextool"`, architecture object, `compatibility.runtime`) | The error message lists every failed rule; fix and re-submit (see [Model Format](../ai-core/model-format.md)). |
| Loaded but engine still llm-core | Expected — a registered package does not replace the active engine; only trained classifiers run inside training/benchmark | Honest state; packages stay `registered` (see [Models](../ai-core/models.md)). |

## Training engine problems (v1.0.10)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Training job fails with `Variable with name dense_Dense1/kernel was already registered` — and every LATER job fails too | **Fixed in v1.0.10.** A previously FAILED training job leaked TF.js graph variables; each new job re-used the same layer names and crashed, poisoning every subsequent job in the same process | Update to v1.0.10 — jobs now build unique per-job model/layer names and dispose every tensor on failure, so a failed job can no longer break the next one. A server restart also clears any leaked variables from an old process. |
| Training crashes with `restoreBestWeights = True is not implemented` or `this.getMonitorValue is not a function` | The tf.js `EarlyStopping` callback is broken in this build (unimplemented `restoreBestWeights`, missing `getMonitorValue`) | **Fixed in v1.0.10** — early stopping is implemented MANUALLY in the epoch callback (monitors `val_loss`, patience `earlyStoppingPatience`, best weights restored before saving). The broken tf.js callback is no longer used; same documented behavior, no crash. |

## Planner issues (v1.0.10)

| Symptom | Cause | Fix |
| --- | --- | --- |
| One-by-one task failed with `SAFETY_LIMIT` / `limit_reached` | Expected safeguard, not a bug — the one-by-one loop is bounded by the same `maxIterations` / `safetyLimit` / `taskTimeoutMs` as pre-plan (a verification task hit `SAFETY_LIMIT` at `maxIterations=12` as designed); the goal may be unfinishable or need more cycles | Raise `maxIterations` / `safetyLimit` (within their 1–200 / 1–500 bounds) or `taskTimeoutMs`, or make the goal more finite/verifiable; check the `planner.one_by_one_*` events to see whether the loop was repeating (the endless-repetition guard replaces a third identical proposal with the failure-aware fallback). |

## Parquet dataset problems (v1.0.3)

The Parquet adapter (`@dsnp/parquetjs` **1.8.9**, pinned) is real — most failures are
data or dependency problems, and every message says which.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Parquet adapter is not available (…)` on import/export | The `@dsnp/parquetjs` dependency cannot be loaded in this runtime | Reinstall dependencies (`bun install`) and restart. `GET /api/models` → `adapters.parquet` shows the real capability (one import probe per process). |
| `Cannot find module '@dsnp/parquetjs'` / library fails to load | Wrong version installed — the adapter is pinned to **1.8.9 exactly**; newer 1.9.x npm tarballs have been published **without build artifacts** (no `dist/`), so the import fails | Check `package.json`/`bun.lock` for `"@dsnp/parquetjs": "1.8.9"`; remove stray copies from `node_modules` and reinstall. Do **not** upgrade to 1.9.x. |
| `Parquet row N: "category" and "request" are required non-empty strings.` | Data problem in the file, not a runtime fault | Fix row N: `category` and `request` are mandatory non-empty UTF8 columns. |
| `Parquet row N: expectedParams is not a JSON object string.` | `expectedParams` holds something other than a JSON-serialized object | Store params as a JSON object string, e.g. `"{\"serverId\":\"api-01\"}"` — not a bare string, array or number. |
| `Parquet row N: split must be one of train \| validation \| test` | Invalid `split` value in that row | Use exactly `train`, `validation` or `test` (blank defaults to `train`). |
| Large imports/exports rejected | Caps: **5000 examples** per dataset, **25 MiB** multipart upload limit | Split the file; both caps mirror the JSON import limits. |

## JSON tree visibility (v1.0.4 fix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| JSON syntax colors are all near-black (#002b36-ish) on the dark glass wells — keys/strings barely readable | The theme set `--json-tree-*` variables, but the installed `@uiw/react-json-view` (2.0.0-alpha.43) reads **only** `--w-rjv-*` custom properties, so everything fell back to the library's dark default | Fixed in v1.0.4 (`src/components/console/json-theme.ts` rewritten with the real `--w-rjv-*` tokens). If you reintroduce a theme, use only `--w-rjv-*` names; a `bun test` guard checks the namespace |
| Single values/primitives show as plain text, not a tree | By design — primitives render as formatted text in the inset well (`json-tree.tsx`) | Not a bug |

## Tool import problems (v1.0.4, extended by v1.0.91)

| Symptom | Cause | Fix |
| --- | --- | --- |
| `REQUEST_FAILED: Invalid response from /api/tools/test (HTTP 405)` in the Tool IDE "Test" | The `/api/tools/test` route file was missing (again) after the v1.0.8 restore — requests fell through to `/api/tools/[name]` (GET/PUT/DELETE only) and Next.js answered 405 | **Fixed in v1.0.91**: the dedicated `POST /api/tools/test` route is restored (same regression the v1.0.5 fix notes in api.md). Update to v1.0.91 or later; the route file must exist at `src/app/api/tools/test/route.ts` |
| Tool function gets `INVALID_URL` for `fetch("/api/…")` | Relative fetch URLs resolve against the application origin only when `network.selfOriginAccess` is enabled (default `true` since v1.0.91) | Re-enable the flag in `config/configuration-limits.json`, or use an absolute `https://` URL |
| "The file contains an array — import one tool at a time" (single importer) | An *Export all tools* bundle was fed to the legacy single-object parse path | Use **Import tools (JSON)…** (v1.0.91) — it accepts an array as a BULK import; a single object still imports as one tool |
| "No tools found in this JSON file." | The file contains an empty JSON array `[]` | Expected honest behavior (v1.0.91): nothing was registered and no import API call was made |
| "Invalid JSON file — …" | The file is not parseable JSON | Fix the syntax; nothing is imported (not even partially) |
| Bulk preview shows `✕ tool — Missing description` etc. | Per-item validation of the array — every item must pass the SAME pipeline as a single import | Fix the items or import only the valid ones; invalid items are never registered |
| "Duplicate tool name inside import file: `utility.test`" | Two valid items in one array share a name (v1.0.91 §2.9) | Resolve per row in the preview: later occurrences default to **Skip** or **Import as copy** — never two silent registrations |
| "Not a tool definition — expected a single JSON object …" | The file is not a portable tool JSON (wrong export, hand-written file) | Export a tool from the Tools view to see the expected format (see [Tools](../tools/tools.md#tool-export--import-as-json-v104)) |
| `"environment" must be "js-function" or "dynamic" … read-only registry tools` | The file carries `environment: "builtin"` or `"virtual-env"` | Built-in / virtual-env tools cannot be imported (they are read-only code); duplicate one into a `js-function` tool in the Tool IDE, then export that |
| `"functionSource" is required for js-function tools` | Export source was edited by hand and lost the source | Re-export from a working registry; the function source travels **as text** |
| `"functionSource" exceeds the 64,000 character sandbox limit` | Source longer than the js-function cap | Split the tool or move heavy logic into a dynamic handler / built-in |
| Warning: "does not visibly define execute(params, context)" | The source may not define the `execute` entry point the sandbox calls | Warning only — check the code; the sandbox invokes `execute()` |
| Import dialog says "Tool already exists" | A registry tool already uses that name | Choose **Replace existing tool** (PUT overwrite), **Import as copy** (auto `base.copy`, `base.copy-2` … name), or **Cancel** — nothing is overwritten without confirmation |
| Import rejected after preview with `REGISTER_FAILED` / syntax error | The backend re-validates source syntax with the real sandbox compiler | Fix the function source; the console editor shows the same compile error on save |

## Documentation viewer links (v1.0.5 fix)

| Symptom | Cause | Fix |
| --- | --- | --- |
| A docs link opened a 404 / broke out of the viewer | Pre-v1.0.5 the built-in viewer left internal markdown links (`../ai-core/core-module.md`) to the browser, which has no such path | Fixed in v1.0.5 — the centralized link resolver navigates internal links WITHIN the Docs view. Hard-refresh once if you still have a pre-1.0.5 bundle cached; genuinely missing pages show the in-viewer "Documentation page not found" card instead |
| An anchored link opened the page but did not scroll | The anchor predates the generated heading ids (dash-collapse edge case) | Fixed in v1.0.5 — cross-page anchors auto-scroll using the same GitHub-style heading slug; a fallback matches older dash-collapsed anchors |

## DB issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Environment variable not found: DATABASE_URL` | `.env` missing | Create it next to `package.json`; restart. |
| Prisma error P2021/P2022 (table/column missing) | Schema not pushed after changes | `bun run db:push`, restart the server. |
| `Invalid prisma… engine` on start | Client not generated | `bun run db:generate`. |
| Events/tasks exist but console shows empty | Looking at a different SQLite file than the server uses | Confirm `DATABASE_URL` path resolves to the same file (e.g. `db/custom.db`), then `bun run db:reset` only if a wipe is acceptable. |
| Writes intermittently fail with logged `[eventbus] persist failed` | Transient SQLite lock (single process should not hit this) | Check for a second process sharing the DB file. |

## Mobile layout issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| Content hidden behind bottom nav | View forgot bottom padding | Views must sit inside the shell's `pb-24 md:pb-6` main; keep fixed elements `pb-safe`. |
| More sheet missing some screens | Old build / not scrolled | The 70 dvh sheet scrolls and contains every view; Task Preview appears only once a task is selected. |
| Text blurry / panels heavy on phone | Expected: mobile reduces blur for performance | By design (< 768 px profile); not a bug. |
| Safe-area gaps on notched devices | `viewportFit=cover` not applied | It is set in `layout.tsx`; ensure you are on the v1.0.1 layout. |
| **Import model dialog overflows on mobile** | Should be fixed in v1.0.5 — the dialog is a flex column capped at `85dvh` with one scrollable body and stacked full-width buttons | If seen on an old build, hard-refresh; on a current build report it (verified at 320/390 px — see [Mobile](mobile.md#v105-mobile-refinements)) |

## Env / config problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Settings PUT seems ignored | Values clamped (e.g. maxIterations 500 → 200) or cache (10 s) served an old value | Read back with `GET /api/settings` (bypasses cache); check clamps in [Configuration](../getting-started/configuration.md). |
| Mode flipped to live unexpectedly | Should be impossible | Mode is never auto-switched — verify what you actually posted in `config.mode`. |
| Image generation fails `SERVICE_UNAVAILABLE` | SDK unavailable in the environment | Everything else keeps working; the failure is honest and per-call. |

## Build failure

| Symptom | Cause | Fix |
| --- | --- | --- |
| `next build` fails on a route | Runtime error at build time (all routes are force-dynamic, so rare) | Build with the DB present (`DATABASE_URL` set); check the offending route file. |
| Standalone server can't find assets | Copy steps skipped | Re-run `bun run build` (it copies `.next/static` and `public` into the standalone bundle). |
| Lint errors blocking you | `bun run lint` is the quality gate | Fix or annotate; builds do not gate on types (`ignoreBuildErrors: true`). |
| Types outdated after schema change | Prisma client stale | `bun run db:generate`; restart the TS server. |

## Escalation path

1. Reproduce with curl (bypasses the frontend) — narrows frontend vs runtime.
2. Read `dev.log` / `server.log` (both scripts tee output there).
3. Check the Events view / `TaskEvent` table — the runtime narrates itself.
4. Consult the per-module docs: [Runtime](../architecture/runtime.md),
   [Tool Runtime](../tools/tool-runtime.md), [Realtime](../realtime/realtime.md).
