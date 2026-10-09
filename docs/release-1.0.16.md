---
title: "Release v1.0.16 — Fast Hands, Sharp Mind"
category: Releases
order: 16
---

# NexTool v1.0.16 — FAST HANDS, SHARP MIND

| Component | Version / behavior |
| --- | --- |
| Application | **1.0.16** |
| Current trained checkpoint | **1.0.5** (`model-checkpoints/v1.0.5/model.zip` + `model.nextool`) |
| llm-core (provider-served) | 1.0.0 — NOT locally retrained (never fabricated) |

v1.0.16 repairs the unfinished work of earlier releases, makes task safety
limits approval-based and resumable, rebuilds the real-FS terminal as a genuine
interactive emulator, makes large Task Previews smooth, improves AI decisions
and planning speed, fixes the current-model export path and introduces the
portable SKILL.md **Skills** system.

## 1. Application version (§1)

`APP_VERSION` is **1.0.16** in `src/lib/nexool/version.ts` (the single source
of truth read by `/api/system`, the Dashboard, Settings, navigation, CLI and
the docs). `package.json` matches. Application version, model version and
dataset version remain three separate concepts — the active model is v1.0.5,
the application is NOT labeled v1.0.5.

## 2. Task safety-limit continuation (§2)

When a task reaches an extendable task-level budget — **task timeout**,
**maxIterations** or the **tool-call safetyLimit** — the runtime no longer
fails silently. It parks the task (`awaiting_approval`, plan preserved, no
background execution) and shows an actionable dialog in Task Preview and Live
Monitor:

```text
Task limit reached · 42s left
Reason: task timeout
Original time budget: 120 seconds
Elapsed time: 124 seconds
Continue with additional time?
Additional time: +120 seconds
New total budget: 240 seconds
[Stop task]  [Continue task]
```

- **Continue** extends the affected budget and RESUMES the task from its saved
  state (same task identity, plan, counters, results, events). Time extensions
  use a doubling policy (120 s → 240 s total); iteration/tool-call budgets grow
  by the configured extra. The elapsed clock is NEVER reset — the deadline is
  `start + original budget + Σ granted extras`, mirrored into the persisted
  task state so reloads/polling cannot reset it.
- **Stop / Reject** ends the task immediately (persisted stopped state).
- **No response in 60 seconds** ends the task — the deadline is enforced by a
  BACKEND timer (`LIMIT_CONTINUATION_TIMEOUT_MS = 60_000`), not a frontend
  countdown. A stale browser cannot approve an expired request.
- Duplicate clicks/requests are idempotent-safe (the pending record is removed
  before resolution — the same budget can never be extended twice).

Verified: continue→resume→extended-limit behavior, deny→stop, 60-second
no-response→stop, double-resolve rejection.

## 3. Real FS terminal — genuine interactive UI (§3)

The FS Inspector terminal is now a real terminal emulator (@xterm/xterm)
connected to PTY-backed real bash sessions:

- **Backend**: sessions run under util-linux `script` (a REAL controlling
  PTY): readline editing, command echo, arrow-key history, Tab completion,
  ANSI colors, honest `TERM=xterm-256color`. Fallback to raw pipes when
  `script` is absent (documented limitation).
- **Deterministic lifecycle (never stuck in `starting`)**:
  `created → starting → running` (first output marker OR a 1.5 s startup
  watchdog confirming the process is alive), `starting → failed` on spawn
  errors or death during startup, `running → exited | stopped | failed`.
  Every transition is reported over SSE.
- **Real bidirectional I/O**: keystrokes are batched (~25 ms) and written RAW
  to the process stdin — input reaches ALREADY-RUNNING interactive programs
  (`read`, interpreters, confirmation prompts); Ctrl+C is a real SIGINT via
  the PTY line discipline; stdout/stderr stream live with exit codes and cwd
  tracking.
- **Frontend**: Aceternity-style dark chrome (title bar, traffic lights,
  status pill), session tabs with per-session status, New/Restart/Clear/Copy/
  Ctrl+C controls, live/connection indicator, mobile layout (`h-[46vh]`
  minimum 260 px, horizontally scrollable tabs, touch-friendly controls).
- **Boundaries preserved**: fs terminal = real host filesystem (clearly
  labeled); VFS terminal = sandboxed interpreter locked to the VFS root
  (`VFS_ACCESS` refused on traversal); MCP has no route to this terminal.

Honest platform limitation: the PTY grid is fixed at 80×24 (util-linux
`script` cannot forward `TIOCSWINSZ` without a native node-pty binding) — the
view fits the container and the PTY wraps at its own grid. Input, output,
interrupt and exit status are fully interactive regardless.

## 4. Task Preview — 40-item incremental loading (§4)

- `/api/tasks/[id]/events?page=1` and `/api/tasks/[id]/executions?page=1`
  return `{ items, nextCursor, hasMore, totalCount }` — the newest 40 items
  per page with stable cursors (`evt_<time36>` ids and `timestamp|id` keys).
- The UI loads the newest 40 per collection up front; "Load 40 older" fetches
  the next batch on demand (dedup by id). Nothing is discarded — full history
  stays reachable.
- Event payloads render LAZILY (per-row expand) instead of a JSON tree per
  event — the historic large-task degradation source; rows are memoized.
- Live Mode: SSE appends incrementally, the 2.5 s poll refreshes only the
  newest window; ordering is preserved and live events appear without
  scrolling the operator away.

## 5. AI — coding capability v1.0.5 + fallback reduction (§5, §7)

- **Dataset v1.0.5** (932 examples): the full v1.0.4 curriculum plus 81 new
  coding examples covering HTML, CSS, JavaScript, TypeScript, JSX/TSX (React),
  Python, Markdown, JSON, C, C++, SQL and Shell/Bash — reading, writing,
  explaining, debugging, error messages, stack traces, package/dependency
  errors, refactoring, file editing, APIs, async/await, test writing,
  command-line workflows, multi-file projects and structured JSON requests.
- **Measured improvement** (held-out 90-case test split, same benchmark engine):
  tool-selection accuracy **49% (v1.0.4 baseline) → 59% (v1.0.5)**.
- **Training**: `dense-24-relu → dropout → dense-softmax`, vocab 1024,
  best-val checkpoint selection (val accuracy 0.588). Trained, registered and
  auto-promoted CURRENT through the real pipeline (`nextool train`).
- **Fallback reduction (root causes fixed, not disabled)**:
  - the trained-checkpoint hint now runs CONCURRENTLY with the LLM call
    (removed a serial pre-LLM await from every decision);
  - robust structured-output extraction (balanced-brace scanner + trailing
    comma repair) — a minor formatting slip no longer discards a good
    decision;
  - near-miss tool identifiers are repaired against the REAL tool set
    (case/separator normalization, unique-prefix match — never guesses);
  - a valid `no_tool` from llm-core is NOT a fallback and is not relabeled.
- **Observability**: every non-llm-core decision carries `fallbackReason`,
  `requestedEngine` and `toolCandidateCount`; the `core.decision` event stream
  exposes them (no secrets).

## 6. Planner — faster pre-plan and one-by-one (§6)

- Tool-schema serialization is cached per tool-set reference (no per-decision
  re-serialization of every schema).
- Duplicate goal verification is skipped when no relevant state changed since
  the last NOT-complete verdict (same input cannot produce a different answer).
- One-by-one still stops after successful verification, reuses prior tool
  results, handles skipped/rejected steps and never restarts the whole plan.

## 7. Current-model export — fixed (§8)

- `current` resolves to the ACTIVE checkpoint in ONE place (`exportModel`),
  shared by the Models UI, the export API and the CLI — `GET
  /api/models/export?id=current&format=tfjs|nextool` streams the real files.
- The Models page export uses a real fetch flow: busy state, correct filename
  from `Content-Disposition`, downloaded blob, success toast or a USEFUL error
  (never a permanent loading state).
- A missing current model produces an honest error ("no active checkpoint —
  train first"), never an unrelated model.

## 8. Checkpoint v1.0.5 (§9, §17)

```text
model-checkpoints/v1.0.5/model.zip      95,542 B — loads via tf.loadLayersModel
model-checkpoints/v1.0.5/model.nextool  96,225 B — loads via importModelPackage + verifyLoadable
```

Both artifacts represent the same trained model, are validated by REAL load
paths and pass 5/5 real-inference probes (`release-checkpoint.ts --version
1.0.5`). Earlier checkpoints (v1.0.3, v1.0.4) are preserved untouched.

## 9. Skills system (§10)

Portable folder-based `SKILL.md` workflows — see the dedicated
[Skills](skills.md) page. Highlights:

- `skills/<name>/SKILL.md` (+ optional `references/`, `scripts/`, `assets/`);
  strict YAML frontmatter (`name`, `description`) with useful validation
  errors; auto-generated root `skills.md` catalog.
- **Progressive loading**: discovery loads metadata only → deterministic
  per-task selection (top ≤3) → FULL instructions injected only for the
  selection → resources read only when needed → the task records its selection
  (`skills.selected` event).
- **Management UI** (Skills view): list, detail with editor, create, import
  ZIP (one top-level folder, validated, zip-slip guarded), export ZIP,
  enable/disable (persists across restarts), validation errors, reload.
- **Built-in skills**: `web-search` (real research workflow + honest tool
  availability reporting), `code-review` (+ review checklist reference),
  `debugging`.
- **Security**: skill content is untrusted INSTRUCTIONS — it cannot override
  system constraints, environment boundaries or approvals; `scripts/` are
  never auto-executed; a skill referencing a tool works only when that tool
  actually exists and is allowed for the task.

## 10. Regressions re-verified (§11-§15)

- Live Mode: first cycle immediate, events wake instantly with full payloads,
  queue mode, serialized actions, stop cancels queued work; user messages flow
  through events into CoreModule/Planner (verified end-to-end via the event
  API).
- Approvals: `[Skip] [Reject] [Accept]` all wired to real execution state —
  Accept executes, Skip records `skipped` and continues, Reject feeds the
  denial ladder (replan → stop on explicit denial).
- Real-FS search: valid/missing/empty paths all handled (no
  `INVALID_PARAMS` "non-empty string" regression).
- VFS/FS/MCP boundaries: VFS traversal refused (`VFS_ACCESS`), VFS search
  confined, MCP VFS-only.
