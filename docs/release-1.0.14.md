---
title: Release 1.0.14 — THE LIVELY AI
category: Reference
order: 0
---

# NexTool Q1 v1.0.14 — THE LIVELY AI

Major release on top of v1.0.13. This page documents every major change of the
release; it is the single reference for the event-driven Live Mode, the per-task
event queue, the new AskSelf/AskForUser tools, the Limitations control page,
the fully interactive Tool Editor test runtime, the production Assistant chat
experience and the real-directory VFS.

> **Core principle (v1.0.14):** «NexTool Live Mode is a lively, interactable AI,
> not a timer that occasionally checks a task.» Events are first-class triggers:
> the AI observes, understands, acts, waits, listens, responds, corrects itself
> and recovers — without waiting for an arbitrary timer.

---

## 0. Event-driven Live Mode (the fundamental change)

Live Mode is no longer "a scheduler that fires every interval". There are two
primary triggers that converge into ONE action pipeline (no second scheduler
was created — `runTask`/`runLiveMode`/`waitWithEvents`/`TaskRunHandle.wake`/
`injectEvent` were evolved in place):

```
event received                     interval elapsed
      │                                  │
      ▼                                  ▼
wake immediately                 scheduled check
      │                                  │
      └────────────┬─────────────────────┘
                   ▼
        observe → understand → act
                   ▼
             action completed
                   ▼
      drain the enabled event queue
                   ▼
             wait again
```

### What changed

| Rule (v1.0.14) | Behavior |
| --- | --- |
| Immediate startup | Every Live task runs its first full observation/action cycle on START — never "wait for the first interval". |
| Immediate event wake | ANY injected event wakes a waiting Live loop instantly. The old `priority <= 5` wake gate was REMOVED — priority is now ordering/metadata only and never silently filters an event. |
| Action serialization | Only one action pipeline per task. Events arriving while an action runs go to the task's inbox and are processed at the next safe point — never concurrently. |
| Per-task queue ("Read & Act All Events" ON) | Every incoming event is admitted to an ORDERED per-task queue (owned by the task, persisted in `Task.state.eventQueue`, cap `task.eventQueueCap`). After each action the queue is drained CONTINUOUSLY — no interval waits between queued events, until empty. |
| No backlog ("Read & Act All Events" OFF) | There is NO queue: while an action runs, additional events are REJECTED with an observable reason — *"Live action already running and Read & Act All Events is disabled."* Nothing is silently lost or hidden. Pause still retains events (v1.0.6 §11.4). |
| Event data is important | Event triggers carry the FULL event (id, type, source, message, data, priority, createdAt) into the decision context (`CONTEXT.trigger`) — never reduced to a generic "continue task" string. |
| Intervals are not events | Interval triggers are message-less (`{ type: 'interval' }`); no fabricated event message. The distinction is visible in the event stream (`observer.scheduled_tick` p9 vs `observer.event_wake` p5). |
| User ↔ AI conversation | `user.message` events ARE the live conversation channel — questions, feedback, corrections, instructions. `user.feedback` additionally revises the active subgoal and runs an immediate correction/recovery cycle. |
| Stop during processing | Stop cancels pending interactions, cancels every inbox event observably (`event.cancelled`), marks persisted queue entries cancelled and stops the loop — nothing continues after the stop. |
| Failure resilience | A failed event cycle never deadlocks the queue: the failure is recorded (`event.failed`) and the next queued event proceeds. |

### Event lifecycle (observable everywhere)

Every injected event produces a canonical lifecycle trail, visible in Events,
Task Preview and Live Monitor:

```
event.received → event.admitted → event.queued → event.processing
      │                                                  │
      └── event.rejected (reason) ────────────── event.completed
                                                 event.failed
                                                 event.cancelled
```

The legacy `live.event.queued/processing/processed/dropped` types are RETIRED
(replaced by this family — the drop policies are unchanged and every drop now
carries an explicit reason).

---

## 15. New tool — AskSelf (`ask.self`)

*Ask NexTool itself to generate/derive content rather than execute an external
action.*

- Input: `prompt` (required), plus `context`, `memory`, `pattern`, `history`.
- Return shape: `{ success: boolean, opinion: string }`.
- Usable as a SUBTOOL: `await context.tools.call('ask.self', { … })` — builtins
  are allowed in the subtool API in both production and the Tool Editor test
  runtime (test mode keeps the builtin-only restriction).
- Example: generating choice lists, explanations, self-description
  ("What about you? Who are you?" → the tool returns NexTool's own description).

## 16. New tool — AskForUser (`ask.user`)

*Ask the human operator for information NexTool does not have or should not
guess.* The tool PAUSES until the user answers through the interaction UI
(Task Preview, Live Monitor or the Assistant chat), the request is cancelled,
or the 120 s window expires.

- Input: `message` (required), optional `placeholder`, `defaultValue`.
- Return: `{ success: true, question, answer, answeredAt }` — or
  `{ success: false, … }` on cancel/timeout. **Never a fabricated answer.**

---

## 17–19. Limitations control page

New console view (sidebar → **Limitations**; mobile → More → Limitations) built
directly on the ONE authoritative `config/configuration-limits.json`:

- **Load Current** — renders EVERY configurable property from the live file
  with its real metadata (type / min / max / default / unit / description /
  enum / nullable / requiresRestart). No fake subset.
- **Full customization** — edit every supported limit (network, VFS, execution,
  child-process/terminal, task & Live Mode, freedom-node gate) with type-aware
  controls; a Raw JSON editor mode is included.
- **Save** — `PUT /api/config/limits` validates structure, types, required
  fields and ranges BEFORE writing (nothing is overwritten on validation
  failure), replaces the file atomically and hot-reloads the runtime within
  ~2 s — the change is REAL (§27: VFS/execution/network/terminal limits
  actually change; verified in v1.0.14 E2E).
- **Export JSON / Import JSON** — import is validated server-side with useful
  per-property errors; the working copy is only replaced after a successful
  save.
- **Standard / Default preset** — restores the shipped configuration snapshot.
- **⚠ Complete Unrestricted preset** — every numeric limit at its shipped
  maximum, capability booleans fully opened (`fs.restricted` → false). Visually
  warned (yellow, persistent banner + confirmation dialog). Security boundaries
  (VFS sandbox isolation, network host policy, sandbox escapes) can never be
  weakened by raising a limit.

---

## 20–22. Fully interactive Tool Editor test runtime

`await alert()`, `await confirm()`, `await askForUserAsChoice()` and
`await prompt()` are REAL interactions in EVERY runtime — including the Tool
Editor **Test** mode. Nothing auto-resolves anymore:

```
run tool → await alert(...) → test = waiting_for_user
        → interaction card appears in the test panel
        → user responds → Promise resolves → tool continues → test finishes
```

- `alert()` is now an interactive OK dialog (120 s auto-dismiss) backed by the
  new `/api/alerts` route.
- `prompt()` advanced input types (§22): the message may be a structured spec
  `{ message, type?, placeholder?, defaultValue? }` with types `text`,
  `textarea`, `number`, `email`, `password`, `url`, `search`, `date`, `time`,
  `datetime-local`, `month`, `week`, `color`, `file`.
- `type: "file"` renders a file chooser and resolves to a JSON string
  `{ name, mimeType, size, content? }` — content only for small files
  (≤256 KB client cap; server compose cap 700 KB). Huge contents are never
  blindly injected.
- The test output shows the interaction lifecycle; Task Preview and Live
  Monitor render the same interactions for production tasks (alerts, typed
  prompts, confirmations, choices).

---

## 23. Production Assistant page

New console view (**Assistant**; mobile → More → Assistant) — a
production-oriented chat application built ON TOP of the NexTool runtime,
separate from the operator console:

- **Glassmorphism chat** — clean, responsive (desktop + mobile), strong visual
  hierarchy, minimal technical noise.
- **Cute robot centerpiece** — an SVG character whose expression reflects REAL
  runtime state: idle, thinking, working, waiting, asking, success, warning,
  error, confused, happy (antenna tone + eyes/mouth per mood, gentle CSS
  animations).
- **Live progress** — multi-step progress derived from real runtime events
  (`tool.started/completed/failed`) under the robot — never simulated.
- **Conversation through events** — the first message creates a Live task
  (one-by-one planner, safe builtin toolset incl. `ask.self`/`ask.user`,
  "Read & Act All Events" queue enabled); every following message is a
  `user.message` EVENT the AI reacts to IMMEDIATELY. The robot shows
  "asking you something" and the question card appears inline when AskForUser
  fires.
- **No code visible (§23.5)** — observations are humanized (embedded tool JSON
  rewritten to its friendliest field, tool-lifecycle prefixes stripped); no
  source code, Monaco, raw schemas or debug payloads. Operators can still open
  the full Task Preview from the header when needed.

---

## 24–26. VFS is a REAL directory

The Virtual FS was ALREADY a genuine host directory (never a simulated store);
v1.0.14 completes the architecture requirement:

- The VFS root is now the real directory **`VFS/`** inside the project storage
  root (previously `data/vfs`).
- **Automatic migration (§24.5):** on first VFS use the runtime moves existing
  `data/vfs` contents into `VFS/` (verify-then-move, never overwrites, never
  deletes user data; logged as `[vfs] v1.0.14 migration: moved N entries …`).
- The sandbox is UNCHANGED and airtight: lexical path validation + per-
  component `lstat` walk + symlink refusal + `realpath`-pinned root. `../`,
  absolute host paths, URL-encoded and Windows-style escapes are resolved-and-
  refused server-side.
- **Real FS can inspect VFS (§24.3):** `fs`/`freedom-node` reach the VFS
  because it physically exists inside the host filesystem; `mcp` and the
  restricted node/js environments remain locked to the VFS root.
- **Terminal (§26):** VFS terminal commands run inside the fully virtual
  child_process layer (allowlisted commands, no real spawn) — `cd ..` can
  never leave the VFS; the real-bash surfaces (`fs.cmd`, inspector FS
  terminal) remain the explicit, operator-gated freedom environment.
- **Limits are live (§27):** `vfs.*` limits resolve from the central
  configuration at every enforcement point — the Limitations page changes take
  effect at runtime (verified: lowering `vfs.maxFileBytes` to 4 KB made a
  10 KB write fail and the Standard preset restored it).

---

## 36. FS Inspector Y-overflow fix

The file listing scrolls INSIDE its glass card (`overflow-y: auto`, bounded to
55 vh on mobile / 26 rem ≥sm / 24 rem ≥md) on desktop, tablet and mobile — the
rows can never overflow the container or grow the page, and long filenames
truncate with a tooltip. Also fixed: the row "Copy path" action passed the
click event where an entry object was expected (pre-existing v1.0.13 bug).

---

## 35. Version metadata

`APP_VERSION` = **1.0.14**, release name *"THE LIVELY AI — event-driven Live
Mode …"*. The model version (`llm-core` 1.0.0) and the locally trained
classifier generation (1.0.3) stay independent and dynamically sourced — no
hard-coded version strings anywhere in the UI.

---

## Acceptance criteria (v1.0.14 §46 — verification summary)

All criteria were verified at runtime on the running dev server (API-level
E2E + browser E2E via Playwright):

- [x] FS Inspector Y overflow fixed with internal vertical scrolling.
- [x] Live Mode runs immediately when started; no first-interval wait.
- [x] Events wake Live Mode immediately; never delayed to the next interval.
- [x] Active actions are serialized; no concurrent Live cycles (interval/event races settle through the single wake slot + loop-top drain).
- [x] Read & Act All Events enables an ordered per-task queue; queued events execute immediately one after another (3 events drained in 7 s with a 300 s interval).
- [x] Queue is not used when disabled; extra events are rejected with an observable reason, no hidden backlog.
- [x] All events are triggers regardless of priority; messages/data reach the decision pipeline; intervals stay message-less.
- [x] Users converse with the Live AI through events; corrections arrive and are acted upon immediately.
- [x] Stopping a task cancels event processing cleanly (inbox + persisted queue).
- [x] AskSelf exists (`{ success, opinion }`), works as a subtool; AskForUser pauses until answered.
- [x] Limitations page: current JSON loads, all limits editable, Standard preset, Unrestricted preset (visibly warned), import validates before applying, export works, VFS limits affect the runtime.
- [x] Tool Editor interactive functions no longer auto-resolve; alert/confirm/askForUserAsChoice/prompt (incl. date/color/file types) all work.
- [x] Production chat page with robot centerpiece, state-driven expressions, real progress, hidden internals, working follow-ups and AskSelf explanations.
- [x] VFS is a real directory with safe migration, strictly sandboxed; real FS/freedom-node can access it; MCP/restricted stay VFS-only; terminal cannot escape.
- [x] Documentation updated; version is v1.0.14; v1.0.13 functionality remains intact (single-user architecture, Task Console, FS Inspector, MCP + connector auth, one-by-one completion, denial recovery, subtool API, safety continuation, dynamic versions).
