---
title: Terminal (real FS)
category: FS Inspector
order: 41
---

# Real FS Terminal (v1.0.16)

The FS Inspector **Terminal** tab is a genuine web terminal: a real xterm.js
emulator in the browser connected to REAL PTY-backed bash sessions on the
host. It is not a chat box, not a typewriter demo — every visible byte comes
from the actual process.

## Architecture

```text
Browser xterm.js (@xterm/xterm + fit addon)
    ⇅  raw keystrokes (batched ~25 ms)        streamed output, cwd, status
SSE stream route (/api/inspector/terminal/stream?sessionId=…)
    ⇅  hello + buffered replay + chunk|cwd|status events + heartbeat
Terminal session manager (src/lib/nexool/inspector/terminal-sessions.ts)
    ⇅  stdin / stdout / signals
Real shell: /usr/bin/script -qfc "stty …; exec bash --noprofile --norc -i" /dev/null
    ⇅  REAL PTY (util-linux) — readline, echo, history, Tab, ANSI, Ctrl+C
```

Why `script`? It gives the shell a REAL controlling terminal without a native
node-pty build: interactive stdin works (read/interpreters/confirmation
prompts), Ctrl+C is delivered by the PTY line discipline, bash runs with
readline (history, completion, colored prompt). Honest limitation: the PTY
grid is fixed at 80×24 — `script` cannot forward `TIOCSWINSZ` ioctls — so the
view fits the container while the process wraps at its own grid. When
`/usr/bin/script` is absent the manager falls back to raw pipes (same
lifecycle guarantees, no TTY features).

## Session lifecycle (deterministic — never stuck in `starting`)

```text
created
  ↓
starting ── spawn error / died before running ──→ failed (real error surfaced)
  ↓ first output marker OR 1.5 s alive-watchdog
running
  ├── exited   (process ended, exit code reported)
  ├── stopped  (SIGTERM/SIGKILL: user stop or watchdog)
  └── failed
```

- The 1.5 s startup handshake guarantees `starting` always resolves to
  `running` (process alive) or `failed` (with the actual error) — a wedged
  bootstrap can never hang the UI.
- Every transition is pushed over SSE and shown in the status bar
  (`pid · status · last exit · transport`).

## Features

| Feature | How |
| --- | --- |
| Interactive input | type directly into the emulator; keys batch 25 ms → raw stdin |
| Input to running processes | raw bytes reach `read`, python, prompts, etc. |
| Ctrl+C / interrupt | `\x03` via PTY (line discipline → SIGINT) + toolbar button |
| Command history / completion | bash readline through the real PTY |
| Real-time output | SSE chunks (seq-numbered, 800-chunk replay ring) |
| Exit codes / cwd | `PROMPT_COMMAND` marker parsed per prompt; `[exit N]`-style status in the bar |
| Multiple sessions / tabs | cap 4 live sessions; tabs with per-session status + close |
| Restart / Clear / Copy | toolbar actions (restart respawns in place; clear wipes view + buffer) |
| Reconnect | EventSource auto-reconnect with seq-based replay dedup |
| Selection / paste | xterm selection + clipboard integration |
| Mobile | `h-[46vh]` (min 260 px) surface, horizontal tab scroll, 44 px controls |

## Environment boundaries (server-enforced)

| Environment | Boundary |
| --- | --- |
| `fs` (this terminal) | REAL host filesystem — the UI labels it "REAL FILESYSTEM"; the start cwd is confined to the runtime working directory, afterwards the shell roams the real machine BY DESIGN |
| `vfs` terminal | sandboxed interpreter mapped onto the VFS API only; traversal is refused (`VFS_ACCESS`); it can never reach the host shell |
| `mcp` | no route to this terminal at all (VFS-only environment) |

Process hygiene: sessions cap at 4 live shells; a 10-minute idle watchdog and
a 30-minute lifetime watchdog SIGTERM→SIGKILL stragglers; dead sessions are
reaped; a disconnected frontend cannot leak orphaned processes.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/inspector/terminal` | probe (`transport: 'pty'\\|'pipes'`, PTY grid) + session list |
| `POST {op:'create', cwd?}` | spawn a session (returns id/pid/cwd/status/transport) |
| `POST {op:'write', sessionId, input, raw?}` | raw keystroke bridge (`raw:true`) or line mode |
| `POST {op:'interrupt'\\|'restart'\\|'clear'\\|'close', sessionId}` | lifecycle ops |
| `GET /api/inspector/terminal/stream?sessionId=` | SSE: replay + chunk/cwd/status events + 15 s heartbeat |

## Acceptance checks (verified in v1.0.16)

- `running` appears promptly (≤1.5 s) after create — never stuck on `starting`.
- `pwd`/`ls`/`echo`/version commands work; stdout+stderr stream live.
- Interactive stdin (`read x; echo got $x`) receives typed input.
- Ctrl+C interrupts a running foreground process.
- Exit codes and cwd changes are reported.
- Multiple tabs run independent sessions; switching preserves output.
- Startup failure surfaces as `failed` with the error + retry (Restart/New).
- VFS terminal stays confined to the VFS root.
