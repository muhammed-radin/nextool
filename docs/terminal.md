---
title: Terminal (real FS)
category: FS Inspector
order: 41
---

# Real FS Terminal (v1.1.0 rebuild)

The FS Inspector **Terminal** tab is a genuine web terminal: a real xterm.js
emulator in the browser driving REAL bash child processes on the host. It is not
a chat box, not a typewriter demo — every visible byte comes from the actual
process.

> **v1.1.0 architecture change**: the v1.0.16 design wrapped a persistent
> interactive bash in util-linux `script` (a PTY). In real use it was unreliable —
> sessions died during the PTY bootstrap while the UI kept them listed, and
> keystroke writes raced dead shells (`FS_TERMINAL_NOT_RUNNING` 409 bursts): the
> reported "terminal stuck in starting / never executes" failure. v1.1.0 replaces
> the whole mechanism with plain `node:child_process` spawn-per-command execution.

## Architecture

```text
Browser xterm.js (@xterm/xterm + fit addon) — line-mode shell UI
    ⇅  POST {op:'exec', command} on Enter         streamed chunks, cwd, status/exit
SSE stream route (/api/inspector/terminal/stream?sessionId=…)
    ⇅  hello + buffered replay + chunk|cwd|status|exit events + heartbeat
Terminal session manager (src/lib/nexool/inspector/terminal-sessions.ts)
    ⇅  spawn / kill (process-group signals)
Real child process: spawn('/bin/bash', ['-c', <command + cwd-marker wrapper>])
```

- **One child process per command** — Enter submits `spawn('/bin/bash', ['-c', …])`
  with a clean environment (`TERM=dumb`, `stdio: ['ignore', 'pipe', 'pipe']`). There
  is NO long-lived shell to keep alive.
- **The wrapper preserves the exit code and tracks `cd` deterministically**: the
  command runs, then the wrapper prints the resulting `$PWD` to stderr inside
  control-character markers (`\u0001…\u0001`) and exits with the command's real
  `$?`. The manager strips the marker before display — no PTY and no prompt
  scraping.
- **Detached process groups** — every command runs in its own process group, so
  interrupt (Ctrl+C / Stop), the configured timeout and session close kill the
  WHOLE tree (bash defers a bare SIGTERM while a foreground child such as `sleep`
  or `npm` runs — the group signal is the reliable path). Escalation is
  SIGTERM → SIGKILL (2 s).
- **Separate stdout/stderr streaming** — output is chunked into the session's
  bounded ring (1 200 chunks) as `in` (echoed command), `out`, `err` and `meta`
  records, each seq-numbered, and pushed over SSE as it arrives.
- Every configurable limit comes from the central configuration (`terminal.*`):
  `maxSessions` (default 4), `execTimeoutMs` (default 5 min; `null` = run until
  exit or interrupt), `maxOutputBytes` (default 1 MiB — excess output is discarded
  with a visible `[output cap … reached]` marker; the process itself keeps
  running) and `historyLimit` (default 100 Up/Down entries).

## Session lifecycle (deterministic — no `starting` state)

A session is a CONTAINER (cwd + history + chunk ring + the running command), not a
process. Its status is one of:

```text
idle ──── exec accepted ────► running
running ── close/error/timeout ──► exit reported ──► idle   (real exit code + duration)
spawn error ──► failed (real error surfaced; restart or close)
```

- There is **no `starting` state to get stuck in** — a session is created `idle`
  and every command reports its own real lifecycle with the REAL exit code (a
  missing binary surfaces bash's actual exit code **127** and its stderr).
- The `FS_TERMINAL_NOT_RUNNING` 409 race class is eliminated (verified): writes
  cannot race a dead shell because there is no persistent shell.
- One command at a time per session — a second `exec` while one runs is refused
  with 409 `FS_TERMINAL_BUSY` ("A command is already running — interrupt it
  first").
- Idle, subscriber-less sessions are reaped after 30 minutes.

## Features

| Feature | How |
| --- | --- |
| Command execution | type + Enter → a real child process runs; output streams live (stdout/stderr separately) |
| Real exit codes / duration | every command reports `[exit N · Xs]` (timeout and truncation flagged) |
| `cd` tracking | wrapper cwd marker parsed per command; the prompt and `cwd` events follow |
| Ctrl+C / interrupt | SIGTERM → SIGKILL to the process group (toolbar button or Ctrl+C) |
| Command history | session-scoped Up/Down (`terminal.historyLimit`, default 100) |
| Real-time output | SSE chunks (seq-numbered, replay ring) + `exit`/`status`/`cwd` events |
| Multiple sessions / tabs | cap `terminal.maxSessions`; tabs with per-session status + close |
| Restart / Clear / Copy | toolbar actions (restart resets the container in place) |
| Reconnect | EventSource auto-reconnect with seq-based replay dedup |
| Selection / paste | xterm selection + clipboard integration |
| Shared shell UI | one `shell-terminal.tsx` xterm.js component with an explicitly configured **bold block cursor** (`cursorStyle: 'block'`, blink, bright cursorAccent) — the VFS terminal reuses it with a distinct amber theme |
| Mobile | `h-[46vh]` (min 260 px) surface, horizontal tab scroll, 44 px controls |

Honest limitations of the spawn-per-command design (by design):

- **No interactive stdin** — the terminal is line-mode only: a submitted command
  runs to completion (or is interrupted). You cannot feed keystrokes into a
  running program (`read x; …` prompts, interactive installers, interpreters' REPLs).
- **No PTY anymore** — no server-side readline/Tab completion/TTY features and no
  `TIOCSWINSZ` handling is needed; the terminal feel (echo, history, cursor) lives
  in the xterm.js UI.
- **No chaining/piping in the VFS shell** (see below); the real-FS terminal hands
  the whole line to `bash -c`, so shell syntax works there — one process per
  submitted line.

## VFS shell (server-side, same UI — distinct theme)

The VFS terminal is no longer a client-side interpreter with a hard-coded command
list. Since v1.1.0 it runs in the BACKEND (`inspector/vfs-shell.ts` +
`/api/inspector/vfs/shell` + `/stream`) with the SAME interaction protocol as the
real terminal, so the frontend renders both with one shared xterm.js shell
component (the VFS adapter applies a distinct amber accent theme):

- **Server-side enforcement of the allowed commands** — the permitted list comes
  from the central `vfsTerminal.allowedCommands` limit (default: the 13 implemented
  commands `pwd help clear ls cd cat mkdir touch rm cp mv find echo`; `null` = every
  IMPLEMENTED command) and is checked on EVERY execution: a disallowed command
  exits **126** with a message naming the configuration, `help` marks disabled
  commands, unknown commands exit **127**.
- **Flat command surface** — one command per line: chaining/piping metacharacters
  (`&& || ; | \` $(`) are rejected with exit **2** instead of being silently
  ignored. `echo text > file` / `>> file` redirection IS supported.
- **VFS root boundary preserved** — every operation runs through the shared
  VirtualFsSession (path normalization + symlink refusal), so traversal attempts
  surface the documented `VFS_ACCESS` error exactly as before. **The
  allowed-command list is an application cap for the shell UX — it is never a
  path out of the VFS.**
- Commands run synchronously server-side (no interactive stdin here either).

## Environment boundaries (server-enforced)

| Environment | Boundary |
| --- | --- |
| `fs` (this terminal) | REAL host filesystem — the UI labels it "REAL FILESYSTEM"; the start cwd is confined to the runtime working directory, afterwards the shell roams the real machine BY DESIGN |
| `vfs` shell | server-side sandboxed shell executing INSIDE the shared VFS only (`allowedCommands` enforced server-side); traversal is refused (`VFS_ACCESS`); it can never reach the host shell |
| `mcp` | no route to either terminal (VFS-only environment) |

Process hygiene: sessions cap at `terminal.maxSessions` (default 4); closing or
restarting a session kills its running command tree; dead/idle sessions are reaped;
a disconnected frontend cannot leak orphaned processes beyond the configured
`execTimeoutMs`.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/inspector/terminal` | probe (`{ available, shell: '/bin/bash', transport: 'child-process', sessions, limits }` — the ACTIVE central limits; no PTY fields anymore) + session list |
| `POST {op:'create', cwd?}` | new session container (status `idle`; 429 `TERMINAL_CAP` when the cap is reached) |
| `POST {op:'exec', sessionId, command, timeoutMs?}` | spawn a real child process (a per-request `timeoutMs` may only shorten `terminal.execTimeoutMs`); 409 `FS_TERMINAL_BUSY` when busy |
| `POST {op:'interrupt'\|'restart'\|'clear'\|'close', sessionId}` | lifecycle ops (interrupt = SIGTERM → SIGKILL to the group) |
| `GET /api/inspector/terminal/stream?sessionId=` | SSE: buffered replay + `chunk` (`in`/`out`/`err`/`meta`), `cwd`, `status` and `exit` events + 15 s heartbeat |
| `GET /api/inspector/vfs/shell` | VFS shell probe (`transport: 'vfs-shell'`, `implementedCommands`, `allowedCommands`) |
| `POST /api/inspector/vfs/shell {op:'create'\|'exec'\|'clear'\|'close'}` | server-side VFS shell ops |
| `GET /api/inspector/vfs/shell/stream?sessionId=` | VFS shell SSE (same event shapes) |

The v1.0.16 raw-keystroke `write` op and the legacy one-shot exec are REMOVED —
caps live exclusively in the central configuration.

## Acceptance checks (verified in v1.1.0)

- `pwd`/`ls`/`echo`/`node`/`git` execute as real child processes; stdout and stderr
  stream live over SSE.
- A missing binary reports the REAL bash exit code 127 and its stderr.
- `cd` changes are tracked deterministically across commands (cwd marker).
- Ctrl+C interrupts a running command in ~0.7 s; the whole process group dies.
- A second `exec` while a command runs is refused with 409 `FS_TERMINAL_BUSY`.
- Sessions are never stuck in `starting` — the v1.0.16 409-race class is gone.
- The VFS shell executes inside the VFS, returns 126 for non-allowed commands and
  refuses escape attempts (`VFS_ACCESS`).
- Both terminals render through the shared xterm.js shell UI with the bold block
  cursor and work on the mobile layout.
