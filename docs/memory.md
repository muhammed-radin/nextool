---
title: Memory
category: Data
order: 1
---

# Memory — Persistent Memory vs Live State

NexTool has two completely different stores that are easy to confuse. They are not the
same thing, live in different places, and serve different purposes. The Memory view
keeps them visually separated; so does this page.

## At a glance

| | **Persistent Memory** | **Live State** |
| --- | --- | --- |
| Storage | SQLite `MemoryEntry` table (durable) | `globalThis.__nextoolEnv` in-process (ephemeral) |
| Shape | `{ key (unique), value (JSON), tags[], source, createdAt, updatedAt }` | `{ servers[], runtimeStatus, activeGoalTasks, activeLiveTasks, startedAt }` |
| Purpose | Long-term knowledge the runtime should remember across tasks and restarts | The mutable environment the runtime observes and acts on |
| Who writes | `memory.store` tool, `/api/memory`, feedback loop | Virtual fleet state machine, env event injections |
| Who reads | Context bundle (≤ 5 latest) when `useMemory`, `memory.recall`, Memory view, `/api/memory` | `server.*` tools, live observation cycles, `/api/state`, Live State view |
| Lifetime | Survives restarts | Resets on process restart |
| Own doc | this page | [Live State](live-state.md) |

## Persistent Memory

### Storage & shape

Rows in `MemoryEntry`: a unique `key`, an arbitrary JSON `value`, a JSON string array of
`tags`, and a `source` (`user | runtime | tool`). `updatedAt` orders recency.

### Retrieval

- **Into decisions**: the loop's context bundle loads the **5 most recently updated**
  entries (only when task config `useMemory` is true — default from settings) and passes
  them to CoreModule as `CONTEXT.memory`. Relevance today is recency-based, not
  semantic — there is no embedding search.
- **`memory.recall` tool**: exact `key` lookup, or fuzzy search over keys, tags and
  stringified values returning the top **5** matches. The observation sentence reports
  what was found (or honestly, that nothing was found).
- **API**: `GET /api/memory` (up to 200, newest first), `DELETE /api/memory?key=`.
- **Console**: Memory view lists entries with tags/source and offers add/delete with
  JSON validation.

### Updates

- **By the runtime**: `memory.store` upserts `{ key, value, tags }` with source `tool`.
- **By feedback**: a Live Mode `user.feedback` upserts key `feedback_<taskId>` with
  `{ message, correctAction, at }`, tags `['feedback','live']`, source `runtime` (when
  `learnFrom.feedback` is on).
- **By you**: `POST /api/memory` (`{ key, value, tags?, source? }`) upserts with source
  default `user`.

### Lifecycle & relevance

Entries live until deleted (explicitly via API/view; there is no TTL). Because the
context bundle only carries the 5 newest entries, keys you want considered should either
be recent or surfaced on demand through `memory.recall` inside a task.

## Live State

Full treatment in [Live State](live-state.md); the short version for contrast: it is the
in-memory virtual server fleet plus runtime counters. It is *input* to observation and
*target* of automation, not a knowledge store. Nothing in it is durable — restart the
process and the fleet reseeds (api-01/web-01/db-01, all healthy).

## How they meet

A typical Live Mode loop touches both:

1. A crash injection changes **Live State** (fleet: `api-01 unhealthy`).
2. The event wake runs a repair pass; the context bundle also carries the **memory**
   entry `feedback_task_x` recorded earlier ("restart db-01 first when prod degrades").
3. The revised subgoal and the fleet state together drive the recovery.

## API + tool summary

| Interface | Method/Tool | Effect |
| --- | --- | --- |
| `GET /api/memory` | REST | List up to 200 entries. |
| `POST /api/memory` | REST | Upsert `{ key, value, tags?, source? }` → 201. |
| `DELETE /api/memory?key=` | REST | Delete → `{ deleted: true }` (404 `NOT_FOUND` if absent). |
| `memory.store` | Tool | Runtime upsert; observation `Memory stored under key "…".` |
| `memory.recall` | Tool | Exact or fuzzy recall (top 5); observation reflects found/not-found. |

## See also

- [Live State](live-state.md) — the ephemeral counterpart.
- [Context](context.md) — where memory appears inside the decision context.
- [Live Mode](../modes/live-mode.md) — feedback → memory flow.
