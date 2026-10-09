---
title: NexTool v1.1.0 — First Minor-Batch Promotion
category: Reference
order: 2
---

# NexTool v1.1.0 — FIRST MINOR-BATCH PROMOTION

| Component | Version / behavior |
| --- | --- |
| Application | **1.1.0** (batch promotion of the completed v1.0.13 – v1.0.16 series — NOT v1.0.17) |
| Current trained checkpoint | **1.0.5** (`model-checkpoints/v1.0.5/model.zip` + `model.nextool`) — **unchanged by this promotion**; application and model versions are independent concepts |
| llm-core (provider-served) | 1.0.0 — NOT locally retrained (never fabricated) |

v1.0.13 through v1.0.16 are complete, so the application advances to **v1.1.0** — the
first minor-version bump instead of a v1.0.17 patch. v1.1.0 makes CoreModule generation
debuggable in real time (**Live Output** over a dedicated SSE channel), removes the hidden
25-second CoreModule timeout in favor of configurable deadlines, makes task continuity a
first-class workflow (**Continue Task** + **fork-from-recent**), adds four precise
**file-editing tools**, ships the **Our Products** showcase, rebuilds the real-FS terminal
on dependable `node:child_process` spawn-per-command execution with a shared xterm.js
shell UI, **centralizes every remaining application limit** (with Standard and Complete
Unrestricted presets), adds **multi-skill selection** to the Task Console, makes **stop**
reliably forceful, and adds the **`executeAllPlannedSteps`** pre-plan option.

## 1. Application version (§0)

`APP_VERSION` is **1.1.0** in `src/lib/nexool/version.ts` (the single source of truth read
by `/api/system`, the Dashboard, Settings, navigation, the CLI and the docs); `package.json`
matches. `TRAINED_MODEL_VERSION` stays **1.0.5** — the checkpoint trained in v1.0.16 is
still the current model, and the application promotion does not touch it. llm-core stays
1.0.0 (provider-served).

## 2. CoreModule Live Output — real token streaming over SSE (§1)

Task Preview gains a collapsible **CoreModule Live Output** section fed by a DEDICATED SSE
channel. This is actual incremental streaming, not a typewriter animation:

- **Shared provider layer** (`core/llm-call.ts`) — every LLM path (CoreModule decisions,
  Planner plans, Observer verifications, subgoal proposals) goes through one call layer
  that requests `stream: true`, parses the OpenAI-compatible SSE body
  (`data:` delta frames), and forwards provider deltas AS THEY ARRIVE via
  `onDelta(delta, fullText)`. The full text is still assembled and returned for the
  normal parse/validate pipeline. If the provider answers with a plain JSON body instead,
  the response is used as-is and `streamed: false` is reported honestly — **never fake
  token chunks**.
- **Live Output registry** (`core/live-output.ts`) — one record per LLM pass
  (`requestId` `core_<time36>_<rand>`, `label` `"decision"` or `"decision (strict retry)"`),
  a bounded per-request text buffer (`coreModule.liveOutputBufferBytes`, default 64 KiB —
  when the cap is hit, OLDER bytes are dropped from the replay window only and
  `truncated` is set; the final parsed decision is unaffected), a monotone `chunkSeq`
  per record, and an in-memory subscriber set. The registry keeps at most 40 records
  (30-minute TTL for finished ones). Late chunks for cancelled/superseded requests are
  ignored (appends are a no-op once a record leaves `streaming`).
- **Persisted lifecycle events** — `core.output.started` / `core.output.completed` /
  `core.output.failed` are persisted as real task events (source `core`, priority 6).
  Token chunks are deliberately NOT persisted as Prisma rows (that would write one row
  per provider frame) — they live in the bounded registry and replay from the buffer.
- **SSE channel** — `GET /api/core/stream?taskId=<id>[&requestId=<id>]` sends `hello`,
  then replays `core.snapshot` frames for the task's recent requests (bounded), then
  pushes live `core.started` / `core.chunk` / `core.completed` / `core.failed` /
  `core.cancelled` frames. Chunks are identified by `(requestId, seq)` so clients dedup
  and replay safely on reconnect; a 15 s keepalive keeps intermediaries open.
- **Rendering** (`core-live-output.tsx`) — incoming chunks land in a ref buffer and a
  120 ms ticker flushes **~10 words at a time** to the visible transcript (`WORDS_PER_FLUSH
  = 10`). Batching only paces the RENDER — whitespace and order are preserved exactly.
  The section offers auto-scroll/pause/resume, copy, save, per-request status
  (Streaming/Completed/Failed/Cancelled), elapsed time, word count, seq-dedup and
  snapshot replay. Debug metadata (requested vs actual engine, `streamed` flag, elapsed,
  configured deadline, parse/validation result, fallback reason) is shown — **never
  credentials or hidden reasoning**: the channel carries exactly what the model generated.
- **Observability only (§1.4)** — frames on this channel are never executed. The final
  decision still flows through the normal parse/validate pipeline and the persisted
  `core.decision` event.

Verified end-to-end via API: real `core.chunk` deltas streamed while a task ran, the
decision parsed from the assembled text, and the task completed (with an approval gate).

## 3. CoreModule/Planner timeouts — configurable, diagnostics-reported (§11)

The hidden hard-coded deadlines are REMOVED:

| Removed constant | Was | Replacement (central limit) | Default | `null` semantics |
| --- | --- | --- | --- | --- |
| `CORE_TIMEOUT_MS` | 25 s | `coreModule.llmTimeoutMs` | 300 000 ms (5 min) | **no application-level timeout** — the call runs until the provider answers or fails on its own |
| `PLANNER_TIMEOUT_MS` | 25 s | `planner.llmTimeoutMs` | 60 000 ms | no application-level timeout |
| `VERIFY_TIMEOUT_MS` | 6 s | `planner.verifyTimeoutMs` | 6 000 ms | no application-level timeout |
| `RECOVERY_PLAN_MAX_STEPS` | 4 | `planner.recoveryMaxPlanSteps` | 4 (range 1–16) | not nullable |

- All calls flow through the shared `callLlm` layer with a MANUAL timer + abort-listener
  cleanup (a completed call never leaves a dangling `setTimeout` or a listener on the
  long-lived task signal).
- **Diagnostics**: every `CoreModuleOutput` now carries `coreTimeoutMs` (the configured
  deadline, `null` when unlimited) and `failureStage` — e.g.
  `invalid structured output (first pass)`, `invalid structured output (strict retry too)`,
  `validation rejected the structured result`, `provider timeout (configured deadline
  reached)`, `provider failure`, `cancelled`. Both flow into the persisted `core.decision`
  event payload.
- **No premature heuristic fallback**: a reached deadline is recorded honestly as
  `provider timeout (configured deadline reached)`; slow generation is never silently
  relabeled as an unrelated model error, and the fallback ladder (trained-classifier
  hint → deterministic heuristic) runs ONLY on genuine failures — provider error,
  reached deadline, or unparseable/invalid output. A valid `no_tool` from llm-core is
  still not a fallback.
- The Planner deadline is intentionally SEPARATE from `coreModule.llmTimeoutMs`,
  `task.taskTimeoutMs` and tool timeouts; it governs `buildPlan` (pre-plan),
  `planOneByOneStep` (one-by-one) and subgoal proposals. `planner.verifyTimeoutMs`
  governs the goal-verification LLM call (`checkGoalComplete`) and recovery assessment
  (`assessRecovery`); when the deadline fires, verification falls back to the
  deterministic heuristic — it never aborts the task.

## 4. Continue Task + fork-from-recent — task continuity (§2, §3)

Both features create a NEW task seeded with a bounded, relevance-selected context block
from a source task. **The source task is never mutated and its history is never dumped
wholesale into the new prompt — old tool calls are never replayed automatically.**

| | Continue Task (§2) | Fork from recent (§3) |
| --- | --- | --- |
| Entry point | **Continue Task** action on terminal tasks (completed/stopped/failed) in Task Preview — a dialog asks for the NEXT prompt | Task Console creation form — the "Start from a recent task (optional)" collapsible picks a source from the 20 most recent completed/stopped/failed tasks (with a text filter past 8 items) |
| Config field | `config.continuationOfTaskId` | `config.forkedFromTaskId` |
| Context default | result + observations, plan, executions, skills | operator-selected `contextOptions` (all default CHECKED in the dialog) |
| Intent | follow-up prompt continuing the same work | a new task that REUSES chosen context classes from a finished one |

- **`contextOptions`** (`{ result, plan, executions, memory, skills }`, all optional
  booleans) selects the context classes; both fields are zod-validated
  (`^task_[a-z0-9]+$`) in `POST /api/tasks` and persisted into the stored config.
- **`buildPriorContext`** (`main/task-continuity.ts`) renders a delimited
  `<prior-task-context source=… status=…>` block: header (source request clipped to
  300 chars + prior outcome), final result summary + the last observations
  (`continuity.maxObservations`, default 8, clipped), plan steps with their REAL statuses
  (≤ 30 rows), recent tool-execution rows (`continuity.maxExecutionRows`, default 12 —
  summaries only, explicitly marked *"do NOT re-run these automatically"*), relevant
  memory entries, and the inherited skill selection. The whole block is capped at
  `continuity.maxContextChars` (default 12 000 chars) with an explicit truncation marker.
  The builder NEVER throws — a missing/unreadable source yields an honest
  "could not be read — no context was attached" event instead of a broken creation.
- The new task emits **`task.context_seeded`** (source `runtime`, priority 6) with
  `{ relation: 'continuation of' | 'forked from', sourceTaskId, sourceStatus, truncated,
  inheritedSkills }`.
- **Skills inheritance (§12.3)** — when the new task specifies no skills of its own, the
  source task's persisted `skills.selected` selection is inherited as MANUAL skills
  (`config.skills` + `config.skillsMode: 'manual'`); the operator can still change them.

Verified via API: lineage + inherited skills recorded, context block bounded, source task
untouched, config round-trip.

## 5. File-editing tools (§4)

Four new built-in filesystem tools (`src/lib/nexool/tools/fs-edit-tools.ts`) — all
operating EXCLUSIVELY through the shared directory-backed VFS
(`openGlobalVfs → normalizeVirtualPath → resolveSecure` + symlink refusal), exactly like
every `fs.*` sibling. They never touch the host filesystem and never widen any boundary.
Destructive usage flows through the standard approval hierarchy (autoExecuteTools
resolution) like `fs.writefile`.

| Tool | Semantics |
| --- | --- |
| `fs.apply_edits` | 1–50 edit operations (`op: replace_range \| insert_at \| remove_range`, `unit: line \| offset`) applied as ONE write. The ENTIRE set is validated FIRST — overlapping/conflicting ranges abort the whole call with `FS_EDITS_OVERLAP` before anything is written (all-or-nothing, never a partial patch). Line unit: 1-based lines, 0-based columns; `endColumn` omitted = end of line. Result: `success/path/operation/changed/editCount/beforeSize/afterSize/applied`. |
| `fs.find_replace` | Literal or regex mode. Regex is SAFELY BOUNDED: patterns > 500 chars refused, a pathological pattern that exceeds 200 000 match steps is refused with `REGEX_RISK` (it cannot pin the runtime); invalid patterns → `REGEX_INVALID`. Case sensitivity toggle (default sensitive), optional `{ startLine, endLine }` region, `maxReplacements` occurrence cap. **Honest zero-match**: `matchCount: 0` returns `success: true, changed: false` with the message "No occurrences found — the file was NOT modified" — never disguised as a replacement. Result reports `matchCount` + `replacementCount`. |
| `fs.insert_text` | Exactly ONE of `at: { line, column? }` (1-based line / 0-based column; beyond-EOF lines are rejected with an append hint) or `anchor: { find, occurrence?, position: before\|after }` (occurrence selection; a missing anchor fails with `FS_ANCHOR_NOT_FOUND`). The rest of the file is preserved. |
| `fs.append_text` | End-of-file append with newline fixup (`ensureNewline`, default true — inserts a leading newline when the file does not end with one) and optional creation (`createIfMissing`, default false — otherwise `FS_NOT_FOUND`). Reports `created`. |

Common behavior: text capped at 1 000 000 chars per edit/insert, files larger than ~4 M
chars refused with `FS_TOO_LARGE`, missing paths → `FS_NOT_FOUND`, VFS escape attempts →
`FS_ACCESS`, durable write-then-report. **Verified 32/32** by
`bun scripts/test-fs-edit-tools.ts` (multilingual text, empty files, overlaps, anchors,
regions, caps, VFS boundary).

## 6. Our Products page (§5)

- **Registry**: `config/products.json` — the single maintainable source, edited by the
  self-hosting operator (a `$meta` block documents the fields). Entries are showcased
  VERBATIM: only REAL products with TRUTHFUL links/status belong here — the registry
  never invents deployment URLs or claims a project is live when it is not.
- **API**: `GET /api/products` reads + validates the file (id/name required; `status`
  must be `live | demo | in-development`; `demoView` must name a console view;
  `url` must be an absolute http(s) URL; technologies capped at 12) with an
  mtime+size cache; invalid entries are reported, never silently shown. `PUT` is
  intentionally refused (`READ_ONLY`) — there is no API write path.
- **UI**: the **Our Products** console view (nav entry with the Rocket icon) renders
  responsive cards with category, technologies, status badges, optional external link
  and screenshot; `demoView` entries open the demo INSIDE the console (the existing
  Assistant chat and the Dashboard are shipped as the demo entries). Honest loading,
  empty and error states.
- The operator console functionality is unchanged — this is an additional page.

## 7. Real-FS terminal rebuilt — spawn-per-command (§6)

The v1.0.16 design wrapped a persistent interactive bash in util-linux `script` (a PTY).
In real use it was unreliable: sessions died during the PTY bootstrap while the UI kept
them listed, and keystroke writes raced dead shells (`FS_TERMINAL_NOT_RUNNING` 409
bursts) — exactly the reported "terminal stuck in starting / never executes" failure.
v1.1.0 replaces the whole mechanism:

```text
user presses Enter
     ↓ POST /api/inspector/terminal { op: 'exec', sessionId, command }
     ↓ spawn('/bin/bash', ['-c', <command + cwd-marker wrapper>])   (REAL child process)
     ↓ stdout/stderr stream separately into a bounded chunk ring (SSE)
     ↓ close → REAL exit code + duration (+ cwd tracking via the stderr marker)
     ↓ prompt becomes ready (status 'idle')
```

- **No persistent shell, no `starting` state**: a session is a CONTAINER (cwd + command
  history + chunk ring + the running command); its status is `idle | running | failed`.
  Every command reports its own real lifecycle `running → exited|failed|stopped` with
  the REAL exit code — a missing binary surfaces bash's actual exit code 127 and stderr.
  The `FS_TERMINAL_NOT_RUNNING` 409 race class is eliminated (verified).
- **Deterministic cwd tracking**: the wrapper shell prints the resulting `$PWD` to
  stderr inside control-character markers after EVERY command; the manager strips the
  marker and publishes a `cwd` event — no PTY, no prompt scraping.
- **Detached process groups**: every command runs in its own process group, so
  interrupt (Ctrl+C / Stop), the configured timeout and session close kill the WHOLE
  tree — bash defers a bare SIGTERM while a foreground child (`sleep`, `npm`, …) runs,
  so the group signal is the reliable path. Escalation is SIGTERM → SIGKILL (2 s).
- **Output discipline**: stdout and stderr stream separately over
  `/api/inspector/terminal/stream` (SSE: replay + `in`/`out`/`err`/`meta` chunks +
  `cwd` + `status`/`exit` events + 15 s heartbeat), bounded by
  `terminal.maxOutputBytes` (default 1 MiB — excess is discarded and flagged with a
  visible `[output cap … reached]` marker; the process itself keeps running).
- **Timeout**: `terminal.execTimeoutMs` (default 5 min; `null` = no automatic timeout —
  commands run until they exit or the operator interrupts them). A per-request
  `timeoutMs` may only SHORTEN it.
- **Session ops**: `create / exec / interrupt / restart / clear / close` (the v1.0.16
  raw-keystroke `write` op and the legacy v1.0.13 one-shot exec are GONE). One command
  at a time per session — a second `exec` is refused with 409 `FS_TERMINAL_BUSY`.
  The probe now reports `{ available, shell: '/bin/bash', transport: 'child-process',
  sessions, limits }` — no `script` dependency, no PTY grid field.
- **Shared shell UI**: one xterm.js shell component (`shell-terminal.tsx`) renders BOTH
  terminals in line mode — local echo, Up/Down history, Ctrl+C/Ctrl+L, replay fidelity
  (prompt + history redraw on reconnect) — with an explicitly configured **bold block
  cursor** (`cursorStyle: 'block'`, blink, bright cursorAccent; never a default theme).
  `fs-terminal.tsx` and `vfs-terminal.tsx` are thin adapters; the VFS terminal uses a
  distinct amber accent theme.
- **Server-side VFS shell (§6.6/§6.7)** — `inspector/vfs-shell.ts` + `/api/inspector/vfs/shell(+stream)`:
  the same interaction protocol as the real terminal, executed in the BACKEND (the
  v1.0.16 VFS "terminal" was a client-side interpreter with a hard-coded command list).
  The permitted command list comes from `vfsTerminal.allowedCommands` (default:
  `pwd help clear ls cd cat mkdir touch rm cp mv find echo`; `null` = every IMPLEMENTED
  command) and is enforced SERVER-SIDE on every execution — a disallowed command exits
  126 with a message naming the configuration; `help` marks disabled commands. The shell
  is a FLAT command surface: chaining/piping metacharacters (`&& || ; | \` $(`) are
  rejected with exit 2 (`echo x > file` / `>> file` redirection IS supported). Every
  operation runs through the shared VirtualFsSession (normalization + symlink refusal),
  so the VFS root boundary stays code-enforced — escape attempts surface `VFS_ACCESS`,
  unknown commands exit 127. **The allowed-command list is an application CAP for the
  shell UX — it is never a path out of the VFS.**

Honest limitations of the new design (by design, not oversights):
- The VFS shell is **one command per line** — no chaining, no piping.
- The real terminal has **no interactive stdin** — it is line-mode only: a submitted
  command runs to completion (or is interrupted); it cannot feed keystrokes into a
  running program (no `read` prompts, no interactive installers).
- There is **no PTY anymore** — no server-side readline/Tab completion/TTY features and
  no `TIOCSWINSZ` handling is needed; the xterm.js UI provides the terminal FEEL
  (history, echo, cursor) in the browser.

## 8. Centralized limits — every remaining cap configured (§7)

`config/configuration-limits.json` gains six new sections (loader `config-limits.ts`
extended with an `'array'` property type + `items`, nullable numeric validation and a
string-array resolver; a `null` default REQUIRES `nullable: true` and fails startup
validation otherwise):

| Section | Property | Default | Range | `null` meaning |
| --- | --- | --- | --- | --- |
| `coreModule` | `llmTimeoutMs` | 300 000 ms | 1 000–3 600 000 | **unlimited** — no application-level deadline |
| `coreModule` | `liveOutputBufferBytes` | 65 536 | 4 096–1 048 576 | — |
| `planner` | `llmTimeoutMs` | 60 000 ms | 1 000–3 600 000 | unlimited |
| `planner` | `verifyTimeoutMs` | 6 000 ms | 500–3 600 000 | unlimited |
| `planner` | `recoveryMaxPlanSteps` | 4 | 1–16 | — |
| `terminal` | `maxSessions` | 4 | 1–16 | — |
| `terminal` | `execTimeoutMs` | 300 000 ms | 1 000–3 600 000 | commands run until exit or interrupt |
| `terminal` | `maxOutputBytes` | 1 048 576 | 65 536–33 554 432 | — |
| `terminal` | `historyLimit` | 100 | 10–1 000 | — |
| `vfsTerminal` | `allowedCommands` | the 13 implemented commands | array of strings | **every IMPLEMENTED command is permitted** |
| `skills` | `maxLoadedPerTask` | 4 | 0–12 (0 = loading disabled) | — |
| `skills` | `maxInstructionChars` | 6 000 | 500–100 000 | — |
| `skills` | `maxResourceBytes` | 262 144 | 1 024–10 485 760 | — |
| `skills` | `maxZipBytes` | 8 388 608 | 10 240–52 428 800 | — |
| `events` | `recentRingSize` | 500 | 50–5 000 | — |
| `events` | `maxDataBytes` | 16 384 | 1 024–1 048 576 | — |
| `continuity` | `maxContextChars` | 12 000 | 2 000–200 000 | — |
| `continuity` | `maxExecutionRows` | 12 | 0–100 | — |
| `continuity` | `maxObservations` | 8 | 0–50 | — |

Most of these replace former hard-coded values (the 25 s/25 s/6 s LLM deadlines, the
4-session terminal cap, the 4-skills/6 KB/256 KiB/8 MiB skill caps, the 500-event ring,
the 16 KiB event payload cap, and the client-side VFS command list). The **Limitations**
page renders the new sections with a dedicated array editor (`allowedCommands`) and
"unlimited (null)" checkboxes for nullable numerics; the **Standard** preset snapshot was
extended, and the ⚠ **Complete Unrestricted** preset sets nullable numerics AND nullable
arrays to `null` (genuinely unlimited) while non-nullable values go to their shipped
maximums. As always, presets change CONFIGURED LIMITS only — security boundaries are
never configurable. Hot reload ≤ 2 s still applies.

## 9. Multi-skill selection (§8)

Task Console gains a Skills selector fed by the REAL registry (enabled + valid skills
only, sorted by name — never a hard-coded list) with three modes:

- **Automatic** (default) — the v1.0.16 deterministic selection (token overlap +
  stem-aware name matching, top ≤ `skills.maxLoadedPerTask`).
- **Manual** — exactly the operator's selection reaches the task.
- **Auto + selected** — the union of both (deduplicated, capped).

Runtime integration (`runTask`): manual names are validated against the registry;
disabled/invalid/unknown names are EXCLUDED **with an explanation** — the persisted
`skills.selected` event now carries `{ selected, installed, mode, manual, excluded }`
and the message names what was excluded and why. The 12-skill cap is enforced by the
zod schema (`skills` array, max 12) AND defensively in the console (counter, extra
checkboxes disabled at the cap). `skillsMode` is sent only when it is not `auto`;
`skills` only when the mode is not `auto` and the selection is non-empty. Continuations
inherit the source selection (see §4 above). Verified via API: manual
web-search + debugging loaded as requested, the auto path unchanged, exclusions reported.

## 10. Force-stop — stop that actually stops (§9)

`POST /api/tasks/{id}/stop` (`stopTask`) is upgraded to reliable force-stop semantics:

1. **Abort signals reach the provider calls** — the task `AbortSignal` is threaded into
   EVERY LLM call site (CoreModule `decide`/`decideForStep`, `buildPlan`,
   `planOneByOneStep`, `checkGoalComplete`, `assessRecovery`, `proposeNextSubgoal`);
   an aborted call unblocks immediately (`LlmCallCancelledError`, `failureStage:
   'cancelled'`, the Live Output record is marked cancelled) instead of waiting for the
   configured deadline.
2. **Task-owned child processes are terminated** — a per-task process registry
   (`main/task-processes.ts`) tracks every REAL host process spawned on the task's
   behalf (today: `fs.cmd` bash children, registered as `fs.cmd:<pid>`; the standalone
   FS Inspector terminal is NOT task-owned and is never killed by a task stop).
   Force-stop sends SIGTERM to all entries, waits 1.5 s, then SIGKILL to stragglers —
   group kills for detached children — and emits "Force-stop terminated N task-owned
   child process(es)."
3. **Cancellation is idempotent** — repeated stop requests reuse the same cancellation
   state (setting the flags again is harmless), never spawning duplicate cleanup or
   corrupting state.
4. **Everything pending resolves observably** — inbox events drained with
   `event.cancelled` records, pending approvals/alerts/prompts/confirmations/choices/
   verifications/limit-continuations resolved (false/null/cancelled, never fabricated).
5. **Stuck rows finalize** — when no live run handle exists (crashed runner, server
   restart), the stop request itself finalizes non-terminal rows
   (`running`/`queued`/`waiting`/`awaiting_approval`) as honestly `stopped` with the
   statusDetail "no live runner was attached (force-stop finalization)". A row that is
   already terminal is left untouched — a stop after completion never rewrites history.
6. **Late writes cannot undo the stop** — `persistTask` drops status fields from any
   write arriving after the row went terminal (a parallel-batch execution completing
   after a force-stop cannot flip the task back); the goal loop re-checks the stop flag
   after every in-flight decision so a decision that resolved during stop NEVER
   executes; `finalize` releases the run handle so no stale registry entry lingers.

## 11. executeAllPlannedSteps (§10)

A new pre-plan Boolean (`config.executeAllPlannedSteps`, default **false**, persisted at
creation; the Task Console shows the switch only for the pre-plan planner):

- **Disabled (default)** — normal early completion: the moment the goal is verified the
  task completes and the remaining planned steps are discarded.
- **Enabled** — after the goal IS verified, the runtime CONTINUES executing the remaining
  planned steps in order and completes when the plan reaches its terminal outcomes; the
  transition is announced ONCE via the `planner.execute_all_continue` event
  (`{ plannerType, executeAllPlannedSteps: true, pendingSteps, goal }`), and the final
  statusDetail notes "Goal verified — all planned steps executed (executeAllPlannedSteps)."

Guardrails (the flag never bypasses anything): implemented as a `resolveGoalVerification`
gate over the goal check in `runGoalMode`; decision-level terminal outcomes are NOT
affected (clarification_required, cannot_execute, no_tool, stop, approval timeout still
end the task); stop, pause, approvals, safety limits and environment boundaries remain
fully enforced during execute-all; one-by-one tasks are unchanged (there is no stored
plan to finish).

## 12. Verification evidence

| Area | Evidence |
| --- | --- |
| CoreModule streaming | Verified END-TO-END via API: real `core.chunk` deltas streamed over `/api/core/stream`, the decision parsed from the assembled text, task completed with an approval gate. |
| Terminal backend | API acceptance tests passed: `pwd`/`ls`/`echo`/`node`/`git`, real exit code 127 for missing binaries, stderr streaming, deterministic `cd` tracking, interrupt (~724 ms), busy-guard (409 on concurrent exec); the v1.0.16 409-race class is gone. |
| VFS shell | Verified via API: commands execute inside the VFS, non-allowed commands exit 126 with the configuration message, escape attempts are refused (`VFS_ACCESS`). |
| File-editing tools | **32/32** real-behavior tests pass (`bun scripts/test-fs-edit-tools.ts`): multilingual text, empty files, overlap rejection, anchors, regions, occurrence caps, honest zero-match, VFS boundary. |
| Continuity + skills | Verified via API: `task.context_seeded` (lineage + bounded block), inherited and excluded skill explanations, config round-trip, source task untouched. |
| UI | New/changed components lint-clean (`eslint`) and type-clean (`tsc --noEmit`); browser walkthrough of the new views is the remaining manual step. |

## 13. Honest limitations (by design)

- The **VFS shell is one-command-per-line** — chaining/piping is rejected (exit 2), not
  silently ignored. Only `echo … >|>> file` redirection is supported.
- The real-FS terminal has **no interactive stdin** — line-mode only: a submitted
  command runs to completion or is interrupted; you cannot feed a running program
  (no `read` prompts, no interactive installers).
- **The sandbox has no PTY anymore** (by design): no server-side readline/Tab completion
  and no TIOCSWINSZ handling — the terminal feel lives in the xterm.js UI.
- Live Output chunks are in-memory only (bounded replay window, `truncated` flag);
  reloads older than the registry window show the lifecycle events but not the full text.
- Approvals/limit-continuations remain in-memory: a server restart during a pending
  question finalizes the parked task as stale (unchanged since v1.0.13).
- The Products registry is file-maintained by intention — no API write path.
- `release-*.md` pages are still not listed by `/api/docs` (the SAFE_SLUG loader excludes
  dotted slugs — pre-existing).
