---
title: History
category: Data
order: 4
---

# History

History is the durable, row-per-execution record of everything the runtime actually did.
It is written by the tool executor on every terminal execution status and is the source
for the History view, per-task executions and the history slice of the decision context.

## HistoryEntry records

```jsonc
// GET /api/history → HistoryEntryDTO
{
  "id": "cuid",
  "taskId": "task_1a2b3c4d",          // optional; cascade-deleted with the task
  "action": "server.health",          // the tool name
  "params": { "serverId": "api-01" }, // JSON-parsed
  "result": { "serverId": "api-01", "health": "healthy", "cpu": 34, … },
  "status": "completed",              // completed | failed | timeout | cancelled
  "timestamp": "2024-…"
}
```

Write path (`executor.finalize`, fire-and-forget with logged failures):

- One row per execution reaching a terminal status (`completed`, `failed`, `timeout`,
  `cancelled`; a hypothetically still-running row would be recorded `failed`).
- `params` is the **coerced** param set actually handed to the handler; `result` is the
  raw handler return value serialized (or `null`).
- Indexed by `[taskId, timestamp]` for efficient per-task queries.
- Rows for tasks whose `action` contains a `.` (i.e. tool executions) are what
  `GET /api/tasks/{id}/executions` reconstructs into `ToolExecution[]` (execution ids
  `hist_<row id>`; error objects rebuilt as `FAILED`/`TIMEOUT` since structured errors
  are not stored in history — the task events carry the details).

## Retention

- **No automatic pruning** — rows live as long as their task (execution rows are
  cascade-deleted when a Task row is deleted) or forever for task-less rows.
- The tool-level *statistics* (call/success/failure/timeout counts, total ms) are kept
  separately on `ToolRecord` and survive even if history were pruned.
- There is intentionally no dedup: retries and repeated checks each leave a row, giving
  a faithful audit trail.

## Querying

### `GET /api/history?taskId=&limit=`

| Param | Default | Clamp | Notes |
| --- | --- | --- | --- |
| `taskId` | — | — | Filter to one task. |
| `limit` | 100 | 1–200 | Newest first (`timestamp desc`). |

Examples:

```bash
curl "http://localhost:3000/api/history?limit=50"
curl "http://localhost:3000/api/history?taskId=task_1a2b3c4d"
```

### `GET /api/tasks/{id}/executions`

The same data as execution-shaped DTOs for a single task (ascending, max 200 rows with
a `.` in the action). Task Preview's executions accordion and params/result JSON blocks
render exactly this.

### Console

- **History view** — 100-entry table (client filter box), task ids link into Task
  Preview, rows expand to show params/result JSON.
- **Task Preview** — executions accordion per tool call; the *history refs* context
  panel shows the 5 latest rows in decision context.

## History vs Events vs Executions

| | HistoryEntry | TaskEvent | Executions endpoint |
| --- | --- | --- | --- |
| Granularity | one terminal execution | every runtime occurrence | same rows as history, execution-shaped |
| Written by | executor finalize | eventbus emit | derived (read-only view) |
| Includes results | yes (result JSON) | payloads vary (tool events embed the execution) | yes |
| Survives restart | yes | yes | yes |
| Powers | History view, context, executions | timeline, SSE, replay | Task Preview executions |

## See also

- [Tool Runtime](../tools/tool-runtime.md) — what writes these rows and when.
- [Context](context.md) — how the 5 latest entries feed decisions.
- [API](../api/api.md) — response envelopes for both endpoints.
