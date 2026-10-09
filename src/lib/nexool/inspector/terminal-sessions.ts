/**
 * NexTool v1.1.0 §6 — REAL FS TERMINAL BACKEND (rebuilt).
 *
 * The v1.0.16 design wrapped a persistent interactive bash in util-linux
 * `script` (a PTY). In real use it was unreliable: sessions died during the
 * PTY bootstrap while the UI kept them listed, and keystroke writes raced
 * dead shells (FS_TERMINAL_NOT_RUNNING 409 bursts) — exactly the reported
 * "terminal stuck in starting / never executes" failure.
 *
 * v1.1.0 replaces the whole mechanism with the intended architecture:
 * ordinary node:child_process execution in the backend, a genuine
 * interactive terminal interface in the web frontend.
 *
 *   user presses Enter
 *        ↓ POST /api/inspector/terminal {op:'exec', command}
 *        ↓ spawn('/bin/bash', ['-c', <command>])  (real child process)
 *        ↓ stdout/stderr stream separately into a bounded chunk ring
 *        ↓ close → REAL exit code + duration (+ cwd tracking via a
 *          control-char marker printed to stderr by the wrapper shell)
 *        ↓ prompt becomes ready (status 'idle')
 *
 * There is no long-lived shell and therefore no `starting` state to get
 * stuck in: a session is a container (cwd + history + ring); every command
 * reports its own real lifecycle `running → exited|failed|stopped`.
 * A command that cannot start (missing binary etc.) returns bash's real
 * exit code 127 and stderr — the actual error reaches the terminal.
 *
 * Every configurable limit (maxSessions, execTimeoutMs, maxOutputBytes,
 * historyLimit) comes from the central configuration (terminal.*).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { getResolvedLimits } from '../config-limits';
import { resolveConfined } from './fs-containment';

export type TerminalStatus = 'idle' | 'running' | 'failed';

export interface TerminalChunk {
  seq: number;
  /** in = echoed command line, out = stdout, err = stderr, meta = status/exit. */
  kind: 'in' | 'out' | 'err' | 'meta';
  text: string;
  at: string;
}

export interface RunningCommand {
  commandId: string;
  command: string;
  startedAt: string;
  timedOut: boolean;
  truncated: boolean;
  bytes: number;
}

export interface TerminalSession {
  id: string;
  cwd: string;
  status: TerminalStatus;
  failReason?: string;
  createdAt: string;
  lastActivityAt: string;
  history: string[];
  chunks: TerminalChunk[];
  seq: number;
  running: RunningCommand | null;
  lastExit: { commandId: string; code: number | null; signal: string | null; durationMs: number; timedOut: boolean } | null;
  subscribers: Set<(ev: TerminalEvent) => void>;
}

export type TerminalEvent =
  | { type: 'chunk'; sessionId: string; chunk: TerminalChunk }
  | { type: 'cwd'; sessionId: string; cwd: string }
  | { type: 'status'; sessionId: string; status: TerminalStatus; running?: RunningCommand | null; failReason?: string }
  | { type: 'exit'; sessionId: string; commandId: string; code: number | null; signal: string | null; durationMs: number; timedOut: boolean; truncated: boolean };

// ---------- central limits ----------

function terminalLimits(): { maxSessions: number; execTimeoutMs: number | null; maxOutputBytes: number; historyLimit: number } {
  try {
    const r = getResolvedLimits();
    return {
      maxSessions: r.terminal.maxSessions,
      execTimeoutMs: r.terminal.execTimeoutMs,
      maxOutputBytes: r.terminal.maxOutputBytes,
      historyLimit: r.terminal.historyLimit,
    };
  } catch {
    return { maxSessions: 4, execTimeoutMs: 300_000, maxOutputBytes: 1_048_576, historyLimit: 100 };
  }
}

/** The marker printed by the wrapper shell after EVERY command (stderr). */
const CWD_MARK = '\u0001';
const CWD_MARK_RE = /\u0001([^\u0001]*)\u0001/g;

// ---------- registry (globalThis — survives dev-server HMR) ----------

const g = globalThis as unknown as { __nextoolTerminalSessions?: Map<string, TerminalSession> };
function registry(): Map<string, TerminalSession> {
  if (!g.__nextoolTerminalSessions) g.__nextoolTerminalSessions = new Map();
  return g.__nextoolTerminalSessions;
}

export function listTerminalSessions(): {
  id: string; cwd: string; status: TerminalStatus; failReason?: string;
  createdAt: string; lastActivityAt: string; historyLen: number;
  running: { command: string; startedAt: string } | null;
  lastExit: TerminalSession['lastExit'];
}[] {
  return [...registry().values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => ({
      id: s.id,
      cwd: s.cwd,
      status: s.status,
      failReason: s.failReason,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      historyLen: s.history.length,
      running: s.running ? { command: s.running.command, startedAt: s.running.startedAt } : null,
      lastExit: s.lastExit,
    }));
}

export function getTerminalSession(id: string): TerminalSession | null {
  return registry().get(id) ?? null;
}

// ---------- publish + ring ----------

function publish(s: TerminalSession, ev: TerminalEvent): void {
  for (const fn of s.subscribers) {
    try {
      fn(ev);
    } catch {
      /* broken subscriber never breaks the session */
    }
  }
}

function pushChunk(s: TerminalSession, kind: TerminalChunk['kind'], text: string): void {
  if (!text) return;
  s.seq += 1;
  const chunk: TerminalChunk = { seq: s.seq, kind, text, at: new Date().toISOString() };
  s.chunks.push(chunk);
  const ringCap = 1200;
  if (s.chunks.length > ringCap) s.chunks.splice(0, s.chunks.length - ringCap);
  publish(s, { type: 'chunk', sessionId: s.id, chunk });
}

export function subscribeSession(s: TerminalSession, fn: (ev: TerminalEvent) => void): () => void {
  s.subscribers.add(fn);
  return () => s.subscribers.delete(fn);
}

export function replayChunks(s: TerminalSession): TerminalChunk[] {
  return [...s.chunks];
}

// ---------- lifecycle ops ----------

let sessionCounter = 0;

export function createTerminalSession(cwdInput?: string): TerminalSession {
  const { maxSessions } = terminalLimits();
  const reg = registry();
  // reap obviously dead sessions (no subscribers, idle, no running command)
  const now = Date.now();
  for (const [id, s] of reg) {
    if (
      s.subscribers.size === 0 && !s.running &&
      now - new Date(s.lastActivityAt).getTime() > 30 * 60 * 1000
    ) {
      reg.delete(id);
    }
  }
  if (reg.size >= maxSessions) {
    throw Object.assign(new Error(`Terminal session cap reached (${maxSessions}) — close a session first.`), { code: 'TERMINAL_CAP' });
  }
  let cwd: string;
  try {
    const resolved = resolveConfined(cwdInput && cwdInput.trim() ? cwdInput : '.');
    cwd = resolved.real;
  } catch {
    cwd = process.cwd();
  }
  sessionCounter += 1;
  const session: TerminalSession = {
    id: `term_${Date.now().toString(36)}_${sessionCounter}_${Math.random().toString(36).slice(2, 6)}`,
    cwd,
    status: 'idle',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    history: [],
    chunks: [],
    seq: 0,
    running: null,
    lastExit: null,
    subscribers: new Set(),
  };
  pushChunk(session, 'meta', `NexTool real-FS terminal — session ${session.id}\nReal host commands via node:child_process. Type a command and press Enter.\n`);
  reg.set(session.id, session);
  return session;
}

/** Resolve the effective per-exec timeout from the central limits. */
function effectiveTimeoutMs(override?: number): number | null {
  const { execTimeoutMs } = terminalLimits();
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return execTimeoutMs !== null ? Math.min(override, execTimeoutMs) : override;
  }
  return execTimeoutMs;
}

export interface ExecResult {
  commandId: string;
  ok: boolean;
  error?: string;
}

/**
 * Execute ONE real command in the session. Rejects (ok:false) when the
 * session is busy or the request is malformed — never leaves a command
 * stuck: every spawn reaches close/error/timeout and reports its exit code.
 */
export function execInSession(
  s: TerminalSession,
  commandInput: string,
  opts?: { timeoutMs?: number },
): ExecResult {
  const command = commandInput.trim();
  if (!command) return { commandId: '', ok: false, error: 'Empty command.' };
  if (s.running) {
    return { commandId: '', ok: false, error: `A command is already running (started ${s.running.startedAt}) — interrupt it first.` };
  }
  if (s.status === 'failed') {
    return { commandId: '', ok: false, error: s.failReason ?? 'Session failed — restart it.' };
  }

  const { maxOutputBytes, historyLimit } = terminalLimits();
  const timeoutMs = effectiveTimeoutMs(opts?.timeoutMs);
  const commandId = `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  // The wrapper prints the resulting cwd to stderr inside control-char
  // markers after EVERY command — deterministic cwd tracking with no PTY
  // and no prompt scraping. The marker is stripped before display.
  const wrapper = `${command}\n__nexool_rc=$?; printf '${CWD_MARK}%s${CWD_MARK}' "$PWD" 1>&2; exit $__nexool_rc`;

  let child: ChildProcess;
  try {
    child = spawn('/bin/bash', ['-c', wrapper], {
      cwd: s.cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        TERM: 'dumb',
        LANG: process.env.LANG ?? 'C.UTF-8',
        NODE_ENV: process.env.NODE_ENV,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // own process group → signals (interrupt/timeout/close) reach the whole
      // command tree: bash DEFERS a bare SIGTERM while a foreground child
      // (sleep, npm, …) runs, so killing the group is the reliable path.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    s.status = 'failed';
    s.failReason = `Failed to start the shell: ${err instanceof Error ? err.message : String(err)}`;
    pushChunk(s, 'err', `${s.failReason}\n`);
    publish(s, { type: 'status', sessionId: s.id, status: s.status, failReason: s.failReason });
    return { commandId, ok: false, error: s.failReason };
  }

  // echo the command line (the real terminal feel — the frontend renders the prompt)
  pushChunk(s, 'in', `${command}\n`);
  s.history.unshift(command);
  if (s.history.length > historyLimit) s.history.length = historyLimit;

  const running: RunningCommand = {
    commandId,
    command,
    startedAt: new Date().toISOString(),
    timedOut: false,
    truncated: false,
    bytes: 0,
  };
  s.running = running;
  s.status = 'running';
  s.lastActivityAt = new Date().toISOString();
  publish(s, { type: 'status', sessionId: s.id, status: s.status, running });

  const startedMs = Date.now();

  const capAndPush = (kind: 'out' | 'err', chunk: Buffer): void => {
    if (running.truncated || running.bytes >= maxOutputBytes) {
      running.truncated = true;
      return;
    }
    let text = chunk.toString('utf8');
    if (kind === 'err') {
      // extract + strip the cwd marker; emit the remainder as stderr
      text = text.replace(CWD_MARK_RE, (_m, cwdAfter: string) => {
        const resolved = cwdAfter.trim();
        if (resolved) {
          s.cwd = resolved;
          publish(s, { type: 'cwd', sessionId: s.id, cwd: s.cwd });
        }
        return '';
      });
    }
    if (!text) return;
    running.bytes += text.length;
    if (running.bytes >= maxOutputBytes) {
      running.truncated = true;
      const room = Math.max(0, text.length - (running.bytes - maxOutputBytes));
      if (room > 0) pushChunk(s, kind, text.slice(0, room));
      pushChunk(s, 'meta', `\n[output cap ${maxOutputBytes} bytes reached — further output discarded (terminal.maxOutputBytes)]\n`);
      return;
    }
    pushChunk(s, kind, text);
  };

  child.stdout?.on('data', (c: Buffer) => capAndPush('out', c));
  child.stderr?.on('data', (c: Buffer) => capAndPush('err', c));
  setRunningChild(s, child);

  let settled = false;
  const finish = (code: number | null, signal: string | null, timedOut: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    setRunningChild(s, null);
    const durationMs = Date.now() - startedMs;
    s.running = null;
    s.status = 'idle';
    s.lastActivityAt = new Date().toISOString();
    s.lastExit = { commandId, code, signal, durationMs, timedOut };
    const exitLine = `\n[exit ${code ?? 'null'}${signal ? ` (${signal})` : ''} · ${(durationMs / 1000).toFixed(1)}s${timedOut ? ' · TIMED OUT (SIGTERM→SIGKILL)' : ''}${running.truncated ? ' · output truncated' : ''}]\n`;
    pushChunk(s, 'meta', exitLine);
    publish(s, { type: 'exit', sessionId: s.id, commandId, code, signal, durationMs, timedOut, truncated: running.truncated });
    publish(s, { type: 'status', sessionId: s.id, status: s.status });
    publish(s, { type: 'cwd', sessionId: s.id, cwd: s.cwd });
  };

  const timer = setTimeout(() => {
    running.timedOut = true;
    killCommandTree(child, 'SIGTERM');
    setTimeout(() => killCommandTree(child, 'SIGKILL'), 2000);
  }, timeoutMs ?? 3_600_000);
  if (typeof timer.unref === 'function') timer.unref();

  child.on('error', (err) => {
    pushChunk(s, 'err', `spawn error: ${err.message}\n`);
    finish(null, null, running.timedOut);
  });
  child.on('close', (code, signal) => finish(code, signal ?? null, running.timedOut));

  return { commandId, ok: true };
}

/**
 * Kill a command tree: the child runs in its own process group (detached),
 * so the group signal reaches bash AND every descendant (sleep, npm, …).
 * Falls back to the direct kill when the group is already gone.
 */
function killCommandTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        /* group gone → direct kill */
      }
    }
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

/** Interrupt the running command (Ctrl+C / Stop button). SIGTERM → SIGKILL. */
export function interruptSession(s: TerminalSession): boolean {
  if (!s.running) return false;
  const child = getRunningChild(s);
  if (!child) return false;
  killCommandTree(child, 'SIGTERM');
  setTimeout(() => killCommandTree(child, 'SIGKILL'), 2000);
  pushChunk(s, 'meta', '^C — interrupt sent\n');
  return true;
}

// The child reference lives on the session under a symbol-ish key so
// interrupt can reach it without changing the public shape.
const CHILD_KEY = '__nexoolChild';

function setRunningChild(s: TerminalSession, child: ChildProcess | null): void {
  (s as unknown as Record<string, unknown>)[CHILD_KEY] = child;
}

function getRunningChild(s: TerminalSession): ChildProcess | null {
  return ((s as unknown as Record<string, unknown>)[CHILD_KEY] as ChildProcess | undefined) ?? null;
}

export function clearSession(s: TerminalSession): void {
  s.chunks = [];
  s.seq = 0;
  pushChunk(s, 'meta', '— cleared —\n');
}

/** Close a session: interrupts anything running and drops the container. */
export function closeSession(s: TerminalSession): void {
  const child = getRunningChild(s);
  if (child) {
    killCommandTree(child, 'SIGTERM');
  }
  for (const fn of s.subscribers) {
    try {
      fn({ type: 'status', sessionId: s.id, status: 'failed', failReason: 'Session closed.' });
    } catch { /* ignore */ }
  }
  s.subscribers.clear();
  registry().delete(s.id);
}

/** Restart = fresh container with the same id (history cleared, cwd reset). */
export function restartSession(s: TerminalSession): void {
  const child = getRunningChild(s);
  if (child) {
    killCommandTree(child, 'SIGTERM');
  }
  s.running = null;
  s.status = 'idle';
  s.failReason = undefined;
  s.cwd = process.cwd();
  s.history = [];
  s.chunks = [];
  s.seq = 0;
  s.lastExit = null;
  s.lastActivityAt = new Date().toISOString();
  pushChunk(s, 'meta', `— session restarted —\nReal host commands via node:child_process. Type a command and press Enter.\n`);
  publish(s, { type: 'status', sessionId: s.id, status: s.status });
  publish(s, { type: 'cwd', sessionId: s.id, cwd: s.cwd });
}

/** Probe payload for the UI (no `script` dependency anymore — always available). */
export function terminalProbe(): {
  available: boolean;
  shell: string;
  transport: 'child-process';
  sessions: ReturnType<typeof listTerminalSessions>;
  limits: { maxSessions: number; execTimeoutMs: number | null; maxOutputBytes: number; historyLimit: number };
} {
  const limits = terminalLimits();
  return {
    available: true,
    shell: '/bin/bash',
    transport: 'child-process',
    sessions: listTerminalSessions(),
    limits,
  };
}
