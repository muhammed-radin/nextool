---
title: Live State
category: Data
order: 2
---

# Live State

Live State is the runtime's **in-process model of the environment it operates on**: a
virtual server fleet plus live counters. It is intentionally ephemeral and honestly
labeled — the registry marks every fleet tool `environment: 'virtual-env'`, and the
observation of a fleet listing literally says `Environment overview: …` against results
tagged `virtual-env`.

## Shape (GlobalLiveState)

```jsonc
{
  "servers": [
    { "id": "api-01", "health": "healthy", "cpu": 34, "memory": 51,
      "uptimeSec": 5731, "lastCheckAt": "2024-…" }
  ],
  "runtimeStatus": "online",        // online | degraded | offline
  "activeGoalTasks": 1,
  "activeLiveTasks": 1,
  "startedAt": "2024-…"
}
```

- **Fleet**: three seeded servers — `api-01` (cpu 34/mem 51), `web-01` (22/40),
  `db-01` (41/58), all `healthy`, uptime randomized 1h–25h at seed.
- **runtimeStatus** derives from fleet health: all healthy → `online`; any unhealthy →
  `offline`; otherwise (some degraded/restarting) → `degraded`.
- **Counters** come from DB counts: goal tasks = rows with mode `goal` in
  running/waiting/queued; live tasks = mode `live` in those statuses.

## Virtual server fleet state machine

| Health | Meaning | Transitions |
| --- | --- | --- |
| `healthy` | Normal. cpu/mem random-walk on each check (±12/±8, clamped). 10% chance per drift to become `degraded`. | → degraded (random), → restarting (restart tool), → unhealthy (crash injection) |
| `degraded` | Elevated load (cpu 70–90, mem 60–90). 25% chance per drift to self-heal to `healthy`. | → healthy (random), → restarting, → unhealthy |
| `unhealthy` | Crashed. cpu/mem 0. | → restarting (via restart tool), → healthy (recover injection) |
| `restarting` | Post-restart grace. cpu 30–60. | → healthy after `RESTART_DELAY_MS` = **2500 ms** (uptime reset, cpu 15–25), emits `env.server.recovered` |

Every mutation updates `lastCheckAt`; `server.health` checks additionally *drift* the
server (so repeated checks show realistic movement). The restart completion timer emits
`env.server.recovered` (priority 3) into the event stream.

## Who changes Live State

| Actor | Mechanism |
| --- | --- |
| Observation itself | `server.health` drifts the target server. |
| Runtime automation | `server.restart` / `service.restart` from repair passes or decisions. |
| You (console) | Crash / Degraded / Recover buttons on fleet cards (Live State + Live Monitor views, dashboard fleet). |
| You (API) | `POST /api/env/event` `{ type: 'server.crash' \| 'server.degrade' \| 'server.recover', serverId? }` — picks a fitting server if `serverId` is omitted, applies the change, then **broadcasts `environment.*` events to every active live task** (priority 2 for crash, 4 otherwise) so their waits are interrupted immediately. |

## Who reads Live State

- **Runtime decisions** — the context bundle includes a one-line fleet summary
  (`api-01=healthy,web-01=degraded,…`), and live observation objectives embed the
  serialized fleet.
- **Tools** — `server.list`, `server.health`, `server.restart`.
- **Console** — Live State view (banner: runtimeStatus + counters + startedAt; fleet
  cards with cpu/mem progress, uptime, injection buttons, 3 s refresh), Live Monitor,
  Dashboard server cards.
- **API** — `GET /api/state` returns `GlobalLiveState`; `POST /api/env/event` returns
  the new state plus the `affected` server.

## Counters and task coupling

`activeGoalTasks` / `activeLiveTasks` are recomputed on each `/api/state` read from the
Task table (`running | waiting | queued`), so they always match persisted reality. These
drive the status bar's `active`/`live` indicators and the Live Monitor header.

## Lifetime & restart behavior

Live State lives in `globalThis.__nextoolEnv` — process memory, HMR-safe in dev. On a
server restart the fleet reseeds from scratch; no persistence, by design. Any live task
that was `waiting` keeps its DB row but its scheduler died with the old process (see
[Scheduler](../architecture/scheduler.md#limitations-honest)).

## Relation to Persistent Memory

Live State is *not* memory: it is the volatile world being observed. Long-term knowledge
lives in `MemoryEntry` — see [Memory](memory.md) for the distinction table.
