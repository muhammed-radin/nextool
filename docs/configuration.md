---
title: Configuration
category: Getting Started
order: 3
---

# Configuration

NexTool has two configuration surfaces:

1. **Global settings** — one JSON row in the `Setting` table (key `nextool`), editable in
   the **Settings** view or via `GET/PUT /api/settings`, with a 10-second in-memory cache
   (`settings.ts`).
2. **Per-task config** — a `TaskConfig` supplied at creation, clamped against the global
   settings (`nexool.ts` createTask, `loop.ts` mergeConfig).

## Global settings (NexToolSetting)

Defaults live in `src/lib/nexool/settings.ts` (`DEFAULT_SETTINGS`). Ranges below are the
clamp ranges enforced by `updateSettings`.

| Field | Type | Default | Min | Max | Meaning |
| --- | --- | --- | --- | --- | --- |
| `defaultMode` | `'goal' \| 'live'` | `goal` | — | — | Mode used when a task does not specify one. Invalid values fall back to `goal`. |
| `defaultReasoningLevel` | `1..6` | `4` | 1 | 6 | Default L1–L6 reasoning level. |
| `maxSubtoolCalls` | number | `20` | 1 | 200 | Cap on tool calls per parallel group slice / subtool auto-execution. |
| `safetyLimit` | number | `100` | 1 | 500 | Hard cap on total tool calls per task. |
| `maxIterations` | number | `30` | 1 | 200 | Max main-loop iterations (Goal Mode). |
| `taskTimeoutMs` | number (ms) | `120000` | 5000 | 3600000 | Wall-clock budget for a task (per live cycle in Live Mode). |
| `toolTimeoutMs` | number (ms) | `30000` | 1000 | 300000 | Per-tool-execution timeout (executor clamps 250–300000). |
| `liveIntervalMs` | number (ms) | `60000` | 1000 | 3600000 | Scheduled tick interval for Live Mode. |
| `useMemory` | boolean | `true` | — | — | Whether the context bundle loads persistent memory entries. |
| `logLevel` | `'info' \| 'debug' \| 'error'` | `info` | — | — | Coarse log level; invalid values revert to `info`. |
| `realTimeTransport` | `'sse'` | `sse` | — | — | Locked to `sse`. A WebSocket adapter is **not installed** in this environment; the Settings UI shows it as locked with a note. |

Non-numeric invalid inputs are replaced by the range minimum (`clampNum`); values are
rounded to integers. Settings are served fresh via `GET /api/settings`
(`getSettings(true)` bypasses the cache) and cached for 10 s elsewhere.

### Reading and writing

```bash
curl http://localhost:3000/api/settings

curl -X PUT http://localhost:3000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"maxIterations":50,"liveIntervalMs":20000}'
```

## Per-task config (TaskConfig)

Sent as `config` in `POST /api/tasks` (or `body.config`). `mode` is used **exactly as
provided** — it defaults to `settings.defaultMode` but is never auto-switched to `live`.

| Field | Type | Default source | Clamp / notes |
| --- | --- | --- | --- |
| `name` | string? | — | Optional display name. |
| `mode` | `'goal' \| 'live'` | `settings.defaultMode` | Other values are deleted at creation; Live Mode is explicit opt-in. |
| `reasoningLevel` | `1..6` | `settings.defaultReasoningLevel` | 1–6. |
| `enabledTools` | string[]? | all enabled tools | Empty/undefined = every enabled tool; otherwise an allow-list. |
| `useMemory` | boolean | `settings.useMemory` | Enables memory in the context bundle. |
| `learnFrom` | `{feedback?, results?}` | both `true` | `feedback: true` stores user feedback into memory (key `feedback_<taskId>`). |
| `autoExecuteSubtools` | boolean | `true` | Enables parallel group execution. |
| `maxSubtoolCalls` | number | `settings.maxSubtoolCalls` | 1–200, additionally capped by `safetyLimit`. |
| `safetyLimit` | number | `settings.safetyLimit` | 1–500. |
| `maxIterations` | number | `settings.maxIterations` | 1–200. |
| `taskTimeoutMs` | number | `settings.taskTimeoutMs` | 5000–3600000. |
| `toolTimeoutMs` | number | `settings.toolTimeoutMs` | 1000–300000. |
| `liveIntervalMs` | number | `settings.liveIntervalMs` | 1000–3600000. |
| `sessionId` | string? | — | Free-form session correlation. |
| `context` | object? | — | Arbitrary initial context. |

If `maxSubtoolCalls > safetyLimit`, creation clamps it down to `safetyLimit`.

## Where limits bite (runtime behavior)

- **Goal Mode** loop: stops with `limit_reached` when `iterationCount ≥ maxIterations` or
  `toolCallCount ≥ safetyLimit`; stops with `TIMEOUT` when the task exceeds
  `taskTimeoutMs`.
- **Live Mode**: each wake/scheduled cycle is bounded by `taskTimeoutMs` (per-cycle
  deadline); the scheduled tick fires every `liveIntervalMs`.
- **Tool executions**: `toolTimeoutMs` per call (executor hard-clamps 250 ms–300 s);
  failures get exactly one retry in Goal Mode.

## Environment variables

Only `DATABASE_URL` is read (Prisma SQLite connection). There are no other application
env vars; the image-generation and LLM credentials are resolved by `z-ai-web-dev-sdk`
from its own sandbox configuration, not from project files.

## Related pages

- [Runtime](../architecture/runtime.md) — lifecycle, limits and cancellation semantics.
- [Scheduler](../architecture/scheduler.md) — how `liveIntervalMs` and event wakes interact.
- [API](../api/api.md) — `/api/settings` endpoint details.
