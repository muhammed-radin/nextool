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

## Live task issues

| Symptom | Cause | Fix |
| --- | --- | --- |
| Live task never triggers on schedule | Process restarted while the task was `waiting` — in-memory timer is gone | Stop and re-create the task (it stays `waiting` in the DB otherwise). |
| `task.waiting` but environment crash didn't wake it | Wake requires priority ≤ 5, or broadcast failed | Crash broadcasts use priority 2; check Events for `environment.server.crash`; verify with `POST /api/tasks/{id}/event` (`scheduled.force`). |
| Live task ignores user feedback | `learnFrom.feedback` off or feedback wasn't delivered | Send via the Task Preview Feedback dialog (priority 2); confirm the `user.feedback` event exists. |
| Recovery loop keeps failing | Server can't reach `healthy` (restart path verifies health) | Inspect the repair-pass events; inject `server.recover` manually to force health. |

## Model load failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| 400 `INVALID_MANIFEST` | One or more rules failed (name, semver-like version, `format:"nextool"`, architecture object, `compatibility.runtime`) | The error message lists every failed rule; fix and re-submit (see [Model Format](../ai-core/model-format.md)). |
| Loaded but engine still llm-core | Expected — inference adapter not installed | Honest state; packages stay `registered`. |
| `tfjs: false` / `parquet: false` in adapters | Adapters not installed in this environment | Not fixable by config; stated intentionally. |

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
