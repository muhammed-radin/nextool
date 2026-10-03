---
title: API Reference
category: API
order: 1
---

# API Reference

Every HTTP endpoint in NexTool Q1 v1.0.7. All routes are Next.js route handlers
(`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`) under `src/app/api/`. JSON in/out,
except the SSE stream, the model export download (zip), the dataset Parquet export
(binary), the icons upload (multipart) and the multipart dataset import variant.
Mutating endpoints validate bodies with zod schemas (`src/lib/nexool/schemas.ts`) —
field-level failures return 400 `INVALID_PARAMS`/`INVALID_REQUEST`.

## Envelope contract

Every response is an `ApiEnvelope`:

```jsonc
// success
{ "ok": true, "data": <payload> }
// failure
{ "ok": false, "error": { "code": "MACHINE_CODE", "message": "human explanation" } }
```

Error codes used by routes: `INVALID_PARAMS`, `INVALID_REQUEST`, `TASK_CREATE_FAILED`,
`TOOLS_REQUIRED` (v1.0.4 — task without tools), `NOT_FOUND` (404), `REGISTER_FAILED`,
`ALREADY_EXISTS` (409), `READ_ONLY` (403),
`INVALID_MANIFEST`, `INVALID_EXAMPLES`, `PARQUET_EXPORT_FAILED`, `BENCHMARK_FAILED`,
`EXPORT_FAILED`, `ICONS_INVALID`, `DOC_NOT_FOUND` (404), plus per-domain 500 codes
(`TRAINING_*`, `BENCHMARK_*`, `ICONS_*`). The frontend client adds
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
queued/running/waiting/awaiting_approval/paused/completed/failed/stopped (v1.0.6 adds
`awaiting_approval` and `paused`); `mode` goal|live.

### POST /api/tasks
Create + start a task (async). Request: `{ "request": string (≤4000 chars),
"config"?: Partial<TaskConfig>, "mode"?, "reasoningLevel"? }` — top-level
`mode`/`reasoningLevel` merge into config. `config` is zod-validated and may include
the v1.0.3 parallel policy fields `parallelToolCalls` (boolean) and
`maxParallelToolCalls` (int 1–8) plus the v1.0.6 fields `autoExecuteTools` (boolean)
and `allowMultipleEvents` (boolean). **v1.0.4: `config.enabledTools` is required and must
be a non-empty array of tool names** — the zod schema rejects an explicit empty array
(`INVALID_REQUEST`) and the route rejects a missing/empty list with 400
`TOOLS_REQUIRED` ("Select at least one tool before running the task."). The console
always sends `config.enabledTools: [...]`. Response: 201 `TaskDetail`
(summary + config, state, plan, finalResult, error, sessionId).
Errors: `INVALID_REQUEST` (empty request, empty `enabledTools` array),
`TOOLS_REQUIRED` (missing/empty tool selection), `TASK_CREATE_FAILED` (validation,
e.g. too long).

```bash
curl -X POST http://localhost:3000/api/tasks -H 'Content-Type: application/json' \
  -d '{"request":"Check the health of server api-01","config":{"mode":"goal","enabledTools":["server.health"],"parallelToolCalls":true,"maxParallelToolCalls":4}}'
```

### GET /api/tasks/{id}
Full `TaskDetail`. Errors: `NOT_FOUND`.

### POST /api/tasks/{id}/stop
Cancel a goal/live task + abort the in-flight execution. Returns the (still mutating)
`TaskDetail`; errors: `NOT_FOUND`. Stopping also flushes any pending approvals
(resolved `cancelled`) and pending tool prompts (resolved `null`).

### POST /api/tasks/{id}/pause (v1.0.6)
Suspend a running/waiting/awaiting-approval task: status → `paused`, `task.paused`
event, state preserved (plan, subgoal, context, Live State, event queue, history), no
new autonomous actions, scheduler holds. The current atomic tool execution finishes
first. An approval pending at pause time stays unresolved. Response: `TaskDetail`.
Errors: `NOT_FOUND`.

### POST /api/tasks/{id}/resume (v1.0.6)
Continue a paused task from its preserved state — never a restart. Live tasks return
to `waiting`, goal tasks to `running`; a task paused while awaiting approval returns
to `awaiting_approval`. `task.resumed` is emitted. Response: `TaskDetail`. Errors:
`NOT_FOUND` (also when the task is not `paused`).

```bash
curl -X POST http://localhost:3000/api/tasks/task_1a2b3c4d/pause
curl -X POST http://localhost:3000/api/tasks/task_1a2b3c4d/resume
```

### GET /api/approvals?taskId= (v1.0.6)
Pending tool-execution approvals: `{ approvals: PendingApproval[] }` with
`approvalId`, `tool`, `params`, `purpose?`, `reason?`, `subgoal?`, `requestedAt`.
Scoped to a task when `taskId` is given.

### POST /api/approvals (v1.0.6)
Resolve a pending approval. Request:
`{ "approvalId": string (required), "decision": "allow" | "deny" (required),
"feedback"?: string (≤ 2000 chars, denial feedback) }`. Allow → `tool.approval.allowed`
and the execution proceeds; deny → `tool.approval.denied` + `tool.execution.blocked`,
the tool is skipped and optional feedback becomes an `observer.feedback_applied`
event. Response: `{ resolved: true, decision }` — or
`{ resolved: false, reason }` when the approval is unknown, already resolved or
expired (5-minute timeout). Errors: `INVALID_PARAMS`.

### GET /api/prompts?taskId= (v1.0.6)
Pending tool `prompt()` interactions: `{ prompts: PendingPrompt[] }` with `promptId`,
`taskId?`, `toolName?`, `message`, `requestedAt`. These pause **only their tool**
(120 s timeout resolves `null`).

### POST /api/prompts (v1.0.6)
Answer or cancel a pending prompt. Request:
`{ "promptId": string (required), "value"?: string (≤ 4000 chars), "cancel"?: boolean }`
(cancel wins → resolves `null`). Emits `tool.user_prompt.responded`. Response:
`{ resolved: true }` — or `{ resolved: false, reason }` when unknown/expired. Errors:
`INVALID_PARAMS`.

### GET /api/confirmations?taskId= (v1.0.8)

Pending tool `confirm()` requests. `data.confirmations[]`: `{ confirmId, taskId?, toolName?, message, requestedAt }` — rendered as Confirm/Cancel cards in Task Preview and Live Monitor.

### POST /api/confirmations (v1.0.8)

Resolve a pending confirmation: `{ confirmId, accepted }` (`accepted` boolean, required — never implicit). The waiting tool receives the boolean; cancellation/timeout resolve `false`. Emits `tool.confirm.responded`.

### GET /api/config/limits (v1.0.8)

The Configuration Registry — the resolved metadata of `config/configuration-limits.json`: `{ limits, resolved, source }`. `limits` carries every property's type/nullable/default/min/max/unit/description; `resolved` is the typed snapshot the Settings UI, backend validation and runtime enforcement all share. Exposes configuration METADATA only — no secrets.

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
`hist_…`. Since v1.0.3 each execution additionally carries `batchId` (string) and
`parallelGroup` (int) when it ran inside a parallel batch — Task Preview groups
consecutive executions sharing a `batchId` into one "parallel batch · N concurrent"
card. Errors: none beyond empty array for unknown ids (returns `[]`).

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
category, environment (`builtin` | `virtual-env` | `dynamic` | `js-function` |
`nodejs`), schema, handlerKind, metadata (v1.0.5 — when set), `autoExecute`
(v1.0.6 — present on the definition; default false = approval required), enabled,
stats (call/success/failure/timeout counts, avgMs). The console's tool **export/import**
(v1.0.4) is a client-side flow built entirely on the endpoints below
(`GET /api/tools` for the export list, `POST /api/tools/js` / `POST /api/tools/register`
/ `PUT /api/tools/{name}` for import/replace) — there are **no new endpoints**; the
portable JSON format is documented in
[Tools](../tools/tools.md#tool-export--import-as-json-v104).

### GET /api/tools/environments
The REAL tool-environment configuration (v1.0.5, expanded v1.0.6) — the single
capability source the Tool IDE selector, handler-kind UI, capability matrix, Node.js
References panel and IntelliSense all read (no hardcoded frontend copy). Response
(envelope data):

```jsonc
{
  "environments": [
    // authorable: js-function ("JavaScript sandbox"), nodejs ("Node.js sandbox"),
    // dynamic ("Dynamic handler"); read-only: builtin, virtual-env.
    { "id": "nodejs", "label": "Node.js sandbox",
      "description": "Restricted Node.js environment — same execute contract plus the Virtual FS, controlled http/https, a virtual child_process layer and require()/import() through the centralized import resolver.",
      "authorable": true, "execution": "node-vm" }
  ],
  "handlerKinds": [
    // the real runtime registry: echo, delay, http_get, uuid — each with label,
    // description and configFields[] (http_get: url (required) + timeout (ms,
    // min 1000, max 15000, default 8000))
    { "kind": "http_get", "label": "HTTP GET", "configFields": [ /* … */ ] }
  ],
  "functionSandbox": { "timeoutMs": 10000, "syncTimeoutMs": 4000,
                       "maxSourceChars": 64000, "maxResultBytes": 65536, "maxLogLines": 100 },
  "network": {                       // v1.0.6 — the NETWORK_POLICY
    "allowedProtocols": ["https:", "http:"],
    "requestTimeoutMs": 10000, "maxResponseBytes": 1048576,
    "maxRedirects": 3, "maxRequestsPerExecution": 10,
    "urlImportsEnabled": false
  },
  "vfs": {                           // v1.0.6 — Virtual FS limits + scaffold
    "limits": { "maxFileBytes": 524288, "maxTotalBytes": 8388608, "maxFileCount": 500,
                "maxPathLength": 512, "maxDepth": 24,
                "maxReadBytes": 524288, "maxWriteBytes": 524288 },
    "workspaceDirectories": ["/input", "/output", "/tmp", "/data", "/workspace"]
  },
  "childProcess": {                  // v1.0.6 — virtual child_process policy
    "limits": { "timeoutMs": 8000, "maxOutputBytes": 65536,
                "maxProcessesPerExecution": 4, "maxPipeStages": 3, "maxArgs": 32 },
    "virtualCommands": ["ls", "cat", "head", "tail", "echo", "printf", "pwd", "wc",
                        "grep", "sort", "uniq", "date", "mkdir", "touch", "rm", "cp",
                        "mv", "basename", "dirname", "env", "true", "false"]
  },
  "capabilities": [                  // v1.0.6 — capability × environment matrix
    { "capability": "fetch", "jsFunction": "Yes (policy-controlled)", "nodejs": "Yes (policy-controlled)" },
    { "capability": "Virtual FS", "jsFunction": "VFS modules via require() only", "nodejs": "Full VFS API (fs module)" }
    // … JavaScript standard APIs, XMLHttpRequest, alert/prompt, timers, require(),
    // ESM, URL imports, fs, http/https, child_process …
  ],
  "node": {
    "modules": { "crypto": { "description": "…", "methods": [ "createHash", "…" ] },
                 // 10 static modules + 7 virtual entries (fs, os, timers,
                 // timers/promises, http, https, child_process — flagged "virtual": true)
                 "fs": { "description": "The NexTool Virtual File System …", "virtual": true } },
    "blocked":  { "process": "process manipulation is never allowed" /* name → reason */ },
    "globals":  [ { "name": "Buffer", "type": "Buffer", "description": "…" } ],
    "limits":   { "timeoutMs": 10000, "syncTimeoutMs": 4000, "memoryLimitMb": 256,
                  "maxSourceChars": 64000, "maxResultBytes": 65536, "maxLogLines": 100,
                  "moduleAllowlist": [ "buffer", "crypto", "events", "path", "querystring",
                                        "string_decoder", "url", "util", "assert", "zlib",
                                        "fs", "os", "timers", "timers/promises", "http",
                                        "https", "child_process" ],
                  "childProcess": { /* CHILD_PROCESS_LIMITS */ },
                  "virtualCommands": [ /* the 22 commands */ ] }
  }
}
```

```bash
curl http://localhost:3000/api/tools/environments
```

Errors: none (static capability payload; `force-dynamic`, never cached).

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

### GET /api/tools/{name}
Full entry for one tool (definition, stats, enabled, and `functionSource` +
`toolVersion` + `metadata` for function tools — `js-function` and `nodejs`). The path
segment is URL-decoded server-side. Errors: `NOT_FOUND` (404).

### POST /api/tools/js
Register a function tool authored in the Tool IDE (`environment` `js-function` — the
default — or `nodejs` since v1.0.5). Request:
`{ name (namespace.action, required), description?, purpose?, category?, toolVersion?,
environment?: "js-function" | "nodejs", metadata?: Record<string,string> (≤ 50 pairs),
autoExecute?: boolean (v1.0.6 — default false → approval required),
timeoutMs?: int (v1.0.7 — tool-specific execution timeout, 1000–3600000; values above
1 hour are rejected),
schema: { type: "object", properties: ToolParamDef[] (≤ 40) }, functionSource (required,
≤ 64 000 chars), enabled? }`. The source is syntax-validated server-side before the row
is written (validated with the runner of the chosen environment). Response: 201
`ToolEntry`. Errors: `INVALID_PARAMS` (zod, missing source, bad metadata — values must
be strings), `ALREADY_EXISTS` (409), `REGISTER_FAILED` (500 wrapper).

### PUT /api/tools/{name}
Partial update of a user-editable tool (`dynamic` | `js-function` | `nodejs`; built-ins
and virtual-env are read-only). Body is any subset of `{ name (rename), description,
purpose, category, toolVersion, schema, functionSource, enabled, environment
(v1.0.5 — js-function ⇄ nodejs switch), metadata (v1.0.5 — flat string record; omitted
keeps the stored pairs, an object replaces them), handlerKind, handlerConfig,
autoExecute (v1.0.6 — omitted keeps the stored flag), timeoutMs (v1.0.7 — int
1000–3600000; omitted keeps the stored value) }` — at least one field required.
Response: updated `ToolEntry`. Errors: `NOT_FOUND` (404),
`READ_ONLY` (403), `INVALID_PARAMS`.

### DELETE /api/tools/{name}
Delete a user tool. Built-ins are rejected with `READ_ONLY` (403) — disable them
instead. Response: `{ "deleted": true, "name": "…" }`. Errors: `NOT_FOUND`, `READ_ONLY`.

### POST /api/tools/test
Controlled test execution. **RESTORED again in v1.0.91** — the route file went missing
once more after the v1.0.8 backup restore, so Tool IDE "Test Tool" requests fell
through to `/api/tools/[name]` (GET/PUT/DELETE only) and failed with HTTP 405
(`REQUEST_FAILED: Invalid response from /api/tools/test (HTTP 405)`); the v1.0.5 fix
had documented the same regression. The dedicated route is the ONLY test path (and it
never mutates editor or registry state). Request: exactly one of
`{ name, params? }` (registered tool — runs its real handler pipeline; js/nodejs tools
run their saved source with `mode: "test"`), `{ functionSource, params?, environment? }
(unsaved Tool IDE source, sandboxed — v1.0.5: pass `"environment": "nodejs"` to run it
in the Node.js sandbox; default `js-function`), optional `timeoutMs` (v1.0.7 —
effective execution timeout for the run, 1000–3600000; registered-tool mode uses the
tool's own configured timeout by default) and optional `networkTimeoutMs` (v1.0.9 —
Network Policy request timeout for the run). Response:
`{ mode: "test-source" | "registered", environment, status: "completed" | "failed" |
"timeout", durationMs, result, error, params, logs: string[] }` — logs are captured
for sandbox runs. Since v1.0.6, nodejs test runs execute against an **ephemeral scratch
VFS workspace** (wiped after the run), so `require("fs")` resolves to the Virtual FS —
files written during a test do not persist. Interactive functions are honest in test
mode: `alert` resolves immediately, `prompt` returns its default (or `null`); tests
never hang (see [Tool Development](../tools/tool-development.md)). Tests never mutate
task state. Since v1.0.91, a tool function executing INSIDE the sandbox can call this
endpoint itself: `fetch("/api/tools/test", { method: "POST" })` resolves the relative
URL against the application origin (see [Tool Development](../tools/tool-development.md)).
Errors: `NOT_FOUND` (404), `INVALID_PARAMS` (bad environment hint),
`TEST_FAILED` (500).

```bash
curl -X POST http://localhost:3000/api/tools/test -H 'Content-Type: application/json' \
  -d '{ "functionSource": "async function execute() { const c = require(\"crypto\"); return { id: c.randomUUID() }; }",
        "params": {}, "environment": "nodejs" }'
```

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
{ tfjs: true, nextoolManifest: true, parquet: true } }` — TensorFlow.js is installed
since v1.0.2 (CPU backend) and the Parquet adapter since v1.0.3 (`@dsnp/parquetjs`
1.8.9; capability comes from the real `parquetAdapterInfo()` import probe).

### POST /api/models/load
Validate + register a `.nextool` manifest: `{ "manifest": { name, version, format:
"nextool", architecture: object, compatibility: { runtime } } }` → 201
`ModelPackageInfo` (status `registered`). Errors: `INVALID_MANIFEST` (400) listing every
failed rule. See [Model Format](../ai-core/model-format.md).

### GET /api/models/export?id={modelRecordId}&format=tfjs|nextool
Download a REAL zip artifact (`application/zip` or `application/octet-stream` +
`Content-Disposition: attachment`). `format=tfjs` → `model.json` +
`group1-shard1of1.bin` + `metadata.json`; `format=nextool` → the `.nextool` package
layout (see [Model Format](../ai-core/model-format.md)). Only models whose manifest
carries native TFJS topology + weights are exportable. Errors: `INVALID_PARAMS`,
`EXPORT_FAILED` (400, e.g. manifest without weights or unknown id).

### POST /api/models/import
Multipart upload (`file`). Accepts a `.nextool` zip, a native tfjs zip, or a bare JSON
manifest (v1.0.1 compatibility — imported with the warning *"…not runnable"*). Binary
packages must pass a real compatibility check (`tf.loadLayersModel`) before
registration; the TFJS error surfaces to the caller. Limit 25 MiB; zip entry names are
filtered against path traversal. Response 201: `{ name, version, format,
modelRecordId, runnable, metadata: ExportedModelMetadata, warnings: string[] }`.
Errors: 400 with a readable reason.

---

## Training

### GET /api/training
Newest 50 `TrainingJobSummary[]` (id, dataset lineage, status
`queued|starting|running|completed|failed|cancelled`, config, epochs, epochsDone,
error, modelRecordId, timestamps).

### POST /api/training
Create + START a real training job (fire-and-forget; progress is polled on the job
row). Request: `{ datasetId (required), config?: TrainingConfig }` — config fields are
zod-validated and clamped: `epochs` 1–100 (20), `batchSize` 1–128 (8), `learningRate`
0.0001–1 (0.01), `validationSplit` 0–0.5 (0.2), `shuffle` (true), `vocabSize` 16–1024
(128), `earlyStoppingPatience` 0–50 (0 = off). Response: 202 `TrainingJobSummary`.
Errors: `NOT_FOUND` (unknown datasetId), `INVALID_PARAMS`, `TRAINING_CREATE_FAILED`.

### GET /api/training/{id}
Full `TrainingJobDetail`: summary fields + `metrics: TrainingEpochMetrics[]`
(`{at, epoch, loss, valLoss, accuracy, valAccuracy, elapsedMs}` per epoch) +
`logs: TrainingLogLine[]` (`{at, level, message}`, capped 400) + `finalMetrics`
(`{loss, valLoss, accuracy, valAccuracy, trainMs}`) when completed. Errors:
`NOT_FOUND`.

### DELETE /api/training/{id}
Active job (`queued|starting|running`) → cancellation signal, `{ cancelled: true }`
(the runner stops between epochs; no pause exists). Finished job → deleted,
`{ deleted: true }`. Errors: `NOT_FOUND`, `TRAINING_CANCEL_FAILED`.

---

## Benchmarks

### POST /api/benchmark
Run the real benchmark synchronously. Request: `{ modelKey: "llm-core" |
"heuristic-fallback" | <trained model id>, datasetId, suite: "tool-selection",
limit? (1–500), timeoutPerCaseMs? (1 000–120 000, default 30 000) }` (strict schema —
unknown fields are rejected). Response: 201 `BenchmarkRunSummary` (id, label, modelKey,
dataset lineage, status, `metrics: BenchmarkMetrics`, durationMs). Split preference:
dataset `test` → `validation` → all labeled examples. A run `label` can be attached
from the CLI (`nextool benchmark --label …`), which calls the same engine directly.
Errors: `NOT_FOUND`, `INVALID_PARAMS`, `BENCHMARK_FAILED` (400, e.g. no labeled
examples / unknown model).

### GET /api/benchmark
Newest 50 run summaries (history).

### GET /api/benchmark/{id}
Full run record including per-case rows (request truncated to 240 chars, expectedTool,
decidedTool, status, correct, confidence, latencyMs, engine). Errors: `NOT_FOUND`.

---

## Branding & icons

### GET /api/icons
`{ manifest, active }` — the stored branding manifest (staged or active, `null` when
none) and the active one used by `generateMetadata`. Since v1.0.4 this endpoint is
also the source of the in-app **BrandLogo** (the console fetches it once to pick the
logo PNG — see [Frontend](../frontend/frontend.md)); note the Settings *Branding &
icons* card was removed in v1.0.4, so packages are managed via these endpoints only.

### POST /api/icons
Multipart upload of an icons ZIP (`file` field, ≤ 8 MiB). Validated for real: only
`.png`/`.ico` with safe names, PNG IHDR dimension parsing, `icon-<size>.png` must be
exactly `<size>×<size>` (sizes 16/32/48/72/96/128/144/152/192/384/512),
`apple-touch-icon.png` optional, ≤ 2 MiB per file, `favicon.ico` required in the zip
root. Since v1.0.3, common favicon-generator filenames are **aliased** to canonical
names after validation (`favicon-16x16.png` → `icon-16.png`, `favicon-32x32.png` →
`icon-32.png`, `android-chrome-192x192.png` → `icon-192.png`, `android-chrome-512x512.png`
→ `icon-512.png`, `apple-touch-icon-<anything>.png` → `apple-touch-icon.png`), and
well-known metadata files (`site.webmanifest`, `manifest.json`, `browserconfig.xml`)
are skipped instead of rejected. Duplicate canonical names keep the first occurrence
(extras reported as `ignored`). Accepted files are staged under
`public/icons/<packageId>/` with `status: "staged"`. Response: 201
`{ packageId, manifest, accepted, rejected, ignored }` — `rejected` entries carry
per-file failure reasons, `ignored` entries carry the skip reason. Errors:
`ICONS_INVALID` (400).

### PATCH /api/icons
Activate the staged package: `{ action: "activate", packageId }` → the active manifest
(favicon/apple/icons are then served from `/icons/<packageId>/`, falling back to
`/logo.svg`). Errors: `INVALID_PARAMS`, `NOT_FOUND` (nothing staged),
`ICONS_ACTIVATE_FAILED`.

### DELETE /api/icons
Discard the staged package (files + manifest row); an **active** package survives.
Response: `{ discarded: boolean }`.

---

## Datasets

### GET /api/datasets — `DatasetInfo[]` (split sizes, categories), newest first.

### POST /api/datasets/import
Two content types (v1.0.3):

- `application/json` — `{ name, version, examples: [{ category, request, expectedTool?,
  expectedParams?, split? }], note? }` → 201 `DatasetInfo`. Splits default to `train`;
  cap 5000 examples. Errors: `INVALID_PARAMS`, `INVALID_EXAMPLES` (per-item issues).
- `multipart/form-data` — `file` (a `.parquet` or `.json` file, ≤ 25 MiB) plus optional
  `name`/`version`/`note` form fields. `.parquet` is decoded by the real Parquet adapter
  (`@dsnp/parquetjs`) and validated with the same rules; the record's `format` reflects
  the import format (`parquet` | `json`). Decode/validation failures → 400
  `INVALID_PARAMS` with the adapter's message (e.g. `Parquet row 3: …`).

### GET /api/datasets/{id}/export?format=json|parquet (alias: GET /api/datasets/{id})
`format=json` (default) → `{ dataset: DatasetInfo, examples: DatasetExample[] }`.
`format=parquet` → binary download (`application/octet-stream`, `Content-Disposition:
attachment; filename="<name>-v<version>.parquet"`); encoding failure → 500
`PARQUET_EXPORT_FAILED`. Other formats → `INVALID_PARAMS`; unknown id → `NOT_FOUND`.

### DELETE /api/datasets/{id} — `{ deleted: true }` or `NOT_FOUND`.

---

## Settings

### GET /api/settings — current `NexToolSettings` (cache bypassed).
### PUT /api/settings
Partial update; values are clamped server-side (see
[Configuration](../getting-started/configuration.md) for ranges). Accepts the v1.0.3
parallel policy fields `parallelToolCalls` (boolean) and `maxParallelToolCalls`
(int 1–8), the v1.0.6 fields `autoExecuteTools` (boolean — global auto-execution
override) and `allowMultipleEvents` (boolean — multi-event live processing), and the
v1.0.7 field `toolTimeoutMs` (int 1000–3600000 — the default tool execution timeout;
**values above 1 hour are rejected** with 400 `INVALID_PARAMS`). Returns the saved
settings. Note: an invalid-type body is treated as `{}`
(no-op save).

```bash
curl -X PUT http://localhost:3000/api/settings -H 'Content-Type: application/json' \
  -d '{"toolTimeoutMs":300000}'
```

### POST /api/settings/reset (v1.0.7)
**Destructive, explicitly confirmed.** Resets application RUNTIME data. Body must be
exactly `{ "confirm": "RESET" }` — any other phrase or shape → 400
`CONFIRMATION_REQUIRED` and nothing is touched. The backend clears: tasks, task events,
execution/history entries, memory entries, notifications, generated images (rows +
files), tool Virtual FS workspaces and zeroes tool usage statistics. Tools (definitions
+ source), models, datasets, training/benchmark records and settings are structurally
protected (see [Configuration → Application data reset](../getting-started/configuration.md)).
Response: a reset report `{ ok, confirmPhrase, startedAt, completedAt, durationMs,
cleared: { store: count… }, filesRemoved, failures: [], protectedResources: [...] }`.
Errors: `CONFIRMATION_REQUIRED` (400), `RESET_FAILED` (500). Emits
`system.reset.started` / `system.reset.completed` / `system.reset.failed`.

### GET /api/maintenance/cleanup (v1.0.7)
Dependency analysis + **dry-run** cleanup report (never deletes). Response: `{ dryRun:
true, ran: false, models: { protected[], candidates[], removed[], failed[] }, datasets:
{ … }, warnings[], analyzedAt }` — resources are classified by real references
(training jobs, benchmark runs, active status), never by name/age.

### POST /api/maintenance/cleanup (v1.0.7)
Body `{ "dryRun": false }` executes the **idempotent** cleanup: removes ONLY confirmed
orphaned models/datasets (no inbound references, not the active model). Body `{}` or
`{ "dryRun": true }` behaves like the GET. Response: the same report with
`removed`/`failed` populated. Emits `system.maintenance.cleanup` when something was
removed. Errors: `INVALID_PARAMS`.

### GET /api/maintenance/validate (v1.0.7)
Startup/on-demand dependency validation: active model (`llm-core`) present, model
manifest/artifact metadata parses, required datasets exist, every model/dataset
reference resolves. Response: `{ ok, checkedAt, activeModel, fallbackModel, checks:
{ models, datasets, trainingJobs, benchmarkRuns, manifestParses }, problems: [{
severity, resource, message }] }`. Reports clear errors — never creates replacements.

---

## Documentation

### GET /api/docs — `{ version: "1.0.7", count: n, docs: DocMetaDTO[] }` (slug, title,
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
| `enabledTools` | string[] | **required, non-empty at creation since v1.0.4** (`TOOLS_REQUIRED` when missing/empty); an allow-list of tool names |
| `useMemory` | boolean | default true |
| `learnFrom` | `{ feedback?, results? }` | default both true |
| `autoExecuteSubtools` | boolean | default true |
| `maxSubtoolCalls` | 1–200 | capped by safetyLimit |
| `safetyLimit` | 1–500 | |
| `maxIterations` | 1–200 | |
| `taskTimeoutMs` | 5 000–3 600 000 | |
| `toolTimeoutMs` | 1 000–300 000 | executor floor 250 ms |
| `liveIntervalMs` | 1 000–3 600 000 | |
| `parallelToolCalls` | boolean | v1.0.3 — default true (settings); `false` = strictly sequential |
| `maxParallelToolCalls` | 1–8 | v1.0.3 — default 4; calls beyond the cap run in later waves |
| `autoExecuteTools` | boolean | v1.0.6 — per-task auto-execution override (global `settings.autoExecuteTools: true` still wins); default false |
| `allowMultipleEvents` | boolean | v1.0.6 — "Read & Act All Events"; enables the live event queue for this task; default false |
| `sessionId`, `context` | free-form | |

For payload/response schemas of the domain objects (`TaskDetail`, `NexToolEvent`,
`GlobalLiveState`, …) see the type definitions in `src/lib/nexool/types.ts` and
`api-contract.ts`, and the per-domain pages under Architecture, Data and Realtime.
