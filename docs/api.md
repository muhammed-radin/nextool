---
title: API Reference
category: API
order: 1
---

# API Reference

Every HTTP endpoint in NexTool Q1 v1.0.1. All routes are Next.js route handlers
(`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`) under `src/app/api/`. JSON in/out,
except the SSE stream.

## Envelope contract

Every response is an `ApiEnvelope`:

```jsonc
// success
{ "ok": true, "data": <payload> }
// failure
{ "ok": false, "error": { "code": "MACHINE_CODE", "message": "human explanation" } }
```

Error codes used by routes: `INVALID_PARAMS`, `INVALID_REQUEST`, `TASK_CREATE_FAILED`,
`NOT_FOUND` (404), `REGISTER_FAILED`, `INVALID_MANIFEST`, `INVALID_EXAMPLES`,
`PARQUET_UNAVAILABLE`, `DOC_NOT_FOUND` (404). The frontend client adds
`network_error` / `bad_json` / `http_error` locally.

---

## System & Live State

### GET /api/system
Dashboard stats: app version, runtime status/uptime, engine counters
(`coreCalls`, `avgCoreLatencyMs`, `lastDecisionAt`), `datasetVersion`, task counts +
success rate, tool call aggregates, event count, memory entries, process info
(heap/rss/node/platform) and `latencySeries` (last 50 core decisions).

```bash
curl http://localhost:3000/api/system
```

### GET /api/state
`GlobalLiveState`: virtual fleet, `runtimeStatus`, active goal/live counts, startedAt.

### POST /api/env/event
Inject an environment event into the fleet and wake live tasks.
Request: `{ "type": "server.crash" | "server.degrade" | "server.recover", "serverId"? }`
(omitted serverId auto-picks a fitting server).
Response: new `GlobalLiveState` plus the `affected` server object.
Errors: `INVALID_PARAMS` (unknown type / unknown serverId).

```bash
curl -X POST http://localhost:3000/api/env/event -H 'Content-Type: application/json' \
  -d '{"type":"server.crash","serverId":"api-01"}'
```

---

## Tasks

### GET /api/tasks?status=&mode=&limit=
List summaries (newest first). `limit` default 50, clamp 1–200; `status` one of
queued/running/waiting/completed/failed/stopped; `mode` goal|live.

### POST /api/tasks
Create + start a task (async). Request: `{ "request": string (≤4000 chars),
"config"?: Partial<TaskConfig>, "mode"?, "reasoningLevel"? }` — top-level
`mode`/`reasoningLevel` merge into config. Response: 201 `TaskDetail`
(summary + config, state, plan, finalResult, error, sessionId).
Errors: `INVALID_REQUEST` (empty request), `TASK_CREATE_FAILED` (validation, e.g. too
long).

```bash
curl -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01","config":{"mode":"goal","reasoningLevel":4}}'
```

### GET /api/tasks/{id}
Full `TaskDetail`. Errors: `NOT_FOUND`.

### POST /api/tasks/{id}/stop
Cancel a goal/live task + abort the in-flight execution. Returns the (still mutating)
`TaskDetail`; errors: `NOT_FOUND`.

### POST /api/tasks/{id}/event
Inject a runtime event. Request:
`{ "type": string (required), "payload"?: object, "priority"?: 1–9 (default 5),
"source"?: one of runtime|planner|observer|core|tool|environment|user|system (default user) }`.
Response: 201 `NexToolEvent`. Priority ≤ 5 wakes a waiting live task.
Errors: `INVALID_PARAMS`.

```bash
curl -X POST http://localhost:3000/api/tasks/task_1a2b3c4d/event \
  -H 'Content-Type: application/json' \
  -d '{"type":"scheduled.force","priority":5}'
```

### POST /api/tasks/{id}/feedback
User correction. Request: `{ "message": string (required), "correctAction"? }` →
injects `user.feedback` (priority 2, source user). Response: 201 `NexToolEvent`.
Errors: `INVALID_PARAMS`, `NOT_FOUND`.

### GET /api/tasks/{id}/events?since=&limit=
Task events ascending. `limit` default 200 (server clamps 1–500), `since` ISO
timestamp. Returns `NexToolEvent[]`.

### GET /api/tasks/{id}/context
`ContextComposition` — previousContext + delta + observation + memory (≤5) + history
(≤5) + assembledAt. Errors: `NOT_FOUND`.

### GET /api/tasks/{id}/executions
The task's tool executions reconstructed from history (ascending, ≤200), execution ids
`hist_…`. Errors: none beyond empty array for unknown ids (returns `[]`).

---

## Realtime

### GET /api/stream?taskId=&since=
SSE. Frames: `hello` `{ ok:true, since, taskId }` → replayed `event` frames → live
`event` frames; `:keepalive` comment every 15 s. `since` accepts ISO or epoch ms.
Headers include `X-Accel-Buffering: no`. See [Realtime](../realtime/realtime.md).

```bash
curl -N "http://localhost:3000/api/stream?since=0" --max-time 5
```

---

## Tools

### GET /api/tools
Registry list (seeds built-ins on first call): `ToolEntry[]` with name, description,
category, environment, schema, handlerKind, enabled, stats (call/success/failure/
timeout counts, avgMs).

### POST /api/tools/register (alias: POST /api/tools)
Register a dynamic tool. Request:
`{ "definition": ToolDefinition, "handlerKind"?: "echo"|"delay"|"http_get"|"uuid",
"handlerConfig"?: object }`. Name must match `namespace.action` (lowercase). Dynamic
tools require a handler kind. Response: 201 `ToolEntry`.
Errors: `INVALID_PARAMS` (missing definition), `REGISTER_FAILED` (bad name, missing
handlerKind, `ALREADY_EXISTS`).

### POST /api/tools/{name}/toggle
Enable/disable. Request: `{ "enabled": boolean }` → `ToolEntry`. The path segment must
be URL-encoded (names contain dots, e.g. `server.health`). Errors: `INVALID_PARAMS`,
`NOT_FOUND` (404).

---

## Memory / History / Notifications / Images

### GET /api/memory — up to 200 entries, newest update first. `MemoryEntryDTO[]`
### POST /api/memory
Upsert `{ key (required), value (required), tags?, source? (default "user") }` →
201 `MemoryEntryDTO`. Errors: `INVALID_PARAMS`.
### DELETE /api/memory?key= — delete by key → `{ deleted: true }`; `NOT_FOUND` if absent.

### GET /api/history?taskId=&limit=
`HistoryEntryDTO[]`, newest first; `limit` default 100, clamp 1–200.

### GET /api/notifications?limit=
`NotificationDTO[]` (id, title, body, source, taskId, level info|warning|critical, read,
createdAt); `limit` default 50, clamp 1–200.

### POST /api/notifications/read-all (alias: POST /api/notifications)
Mark all read → `{ "ok": true }`.

### GET /api/images?limit=
`GeneratedImageDTO[]` (path under `/generated/…`, prompt, size, taskId); `limit`
default 50, clamp 1–200.

---

## Models

### GET /api/models
`{ engine: ActiveEngineInfo, packages: ModelPackageInfo[], adapters:
{ tfjs: false, nextoolManifest: true, parquet: false } }`.

### POST /api/models/load
Validate + register a `.nextool` manifest: `{ "manifest": { name, version, format:
"nextool", architecture: object, compatibility: { runtime } } }` → 201
`ModelPackageInfo` (status `registered`). Errors: `INVALID_MANIFEST` (400) listing every
failed rule. See [Model Format](../ai-core/model-format.md).

---

## Datasets

### GET /api/datasets — `DatasetInfo[]` (split sizes, categories), newest first.

### POST /api/datasets/import
`{ name, version, examples: [{ category, request, expectedTool?, expectedParams?,
split? }], note? }` → 201 `DatasetInfo`. Splits default to `train`; cap 5000 examples.
Errors: `INVALID_PARAMS`, `INVALID_EXAMPLES` (per-item issues).

### GET /api/datasets/{id}/export?format=json (alias: GET /api/datasets/{id})
`{ dataset: DatasetInfo, examples: DatasetExample[] }`. `format=parquet` → 400
`PARQUET_UNAVAILABLE` (adapter not installed); other formats → `INVALID_PARAMS`;
unknown id → `NOT_FOUND`.

### DELETE /api/datasets/{id} — `{ deleted: true }` or `NOT_FOUND`.

---

## Settings

### GET /api/settings — current `NexToolSettings` (cache bypassed).
### PUT /api/settings
Partial update; values are clamped server-side (see
[Configuration](../getting-started/configuration.md) for ranges). Returns the saved
settings. Note: an invalid-type body is treated as `{}` (no-op save).

```bash
curl -X PUT http://localhost:3000/api/settings -H 'Content-Type: application/json' \
  -d '{"maxIterations":40,"liveIntervalMs":20000}'
```

---

## Documentation

### GET /api/docs — `{ version: "1.0.1", count: n, docs: DocMetaDTO[] }` (slug, title,
category, order, excerpt), grouped by category then order.
### GET /api/docs/{slug}
`DocPage` = meta + `content` (markdown body, front-matter stripped) + `updatedAt`
(file mtime). Slugs limited to `[a-z0-9-]`. Errors: `DOC_NOT_FOUND` (404).

---

## Misc

### GET /api
Framework scaffold leftover: `{ "message": "Hello, world!" }` (plain JSON, **not**
enveloped). Not used by the console.

---

## TaskConfig quick reference

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string? | display name |
| `mode` | `goal \| live` | never auto-switched |
| `reasoningLevel` | 1–6 | default from settings (4) |
| `enabledTools` | string[]? | allow-list; empty = all |
| `useMemory` | boolean | default true |
| `learnFrom` | `{ feedback?, results? }` | default both true |
| `autoExecuteSubtools` | boolean | default true |
| `maxSubtoolCalls` | 1–200 | capped by safetyLimit |
| `safetyLimit` | 1–500 | |
| `maxIterations` | 1–200 | |
| `taskTimeoutMs` | 5 000–3 600 000 | |
| `toolTimeoutMs` | 1 000–300 000 | executor floor 250 ms |
| `liveIntervalMs` | 1 000–3 600 000 | |
| `sessionId`, `context` | free-form | |

For payload/response schemas of the domain objects (`TaskDetail`, `NexToolEvent`,
`GlobalLiveState`, …) see the type definitions in `src/lib/nexool/types.ts` and
`api-contract.ts`, and the per-domain pages under Architecture, Data and Realtime.
