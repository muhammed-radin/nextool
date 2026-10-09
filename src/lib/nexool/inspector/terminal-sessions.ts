/**
 * NexTool v1.0.16 §3 — REAL terminal session manager (fs environment).
 *
 * Each session is a PERSISTENT INTERACTIVE bash shell running under a REAL
 * PTY. The PTY is provided by util-linux `script` (present on the host:
 * /usr/bin/script): `script -qfc "stty rows R cols C; exec bash --noprofile
 * --norc -i" /dev/null`. That gives the shell a genuine controlling terminal,
 * so readline editing, command echo, arrow-key history, ANSI colors and
 * Ctrl+C behave exactly like a local terminal, and interactive stdin
 * (read / python / confirmation prompts) works.
 *
 * Honest platform limitation (documented in docs/terminal.md): the PTY grid
 * is fixed at boot (80×24 by stty — utilities and readline wrap at 80
 * columns); util-linux `script` cannot forward later TIOCSWINSZ ioctls
 * without a native node-pty binding, so the browser view scrolls a fixed
 * grid instead of reflowing a live one. Input, output, interrupt and exit
 * status are fully interactive.
 *
 * Lifecycle (§3.4 — deterministic, never stuck in `starting`):
 *   created → starting → running (first output marker OR the startup
 *   watchdog confirms the process is alive after 1.5 s)
 *   starting → failed (spawn error, or the process died before running)
 *   running → exited | stopped | failed
 *
 * Other guarantees:
 *  - command input + streamed output (seq-numbered chunks, ring buffer)
 *  - stdin: every byte reaches the running process (raw write mode for the
 *    xterm.js keystroke bridge; line mode kept for API compatibility)
 *  - Ctrl+C: \x03 into the PTY (the line discipline delivers SIGINT) plus a
 *    SIGINT to the process group as belt-and-braces
 *  - cwd tracking: PROMPT_COMMAND emits a __NEXOOL_CWD__ marker (with the
 *    last exit code) before every prompt; parsed and stripped from the
 *    visible output
 *  - multiple sessions (cap 4), restart, clear, close; idle (10 min) and
 *    lifetime (30 min) watchdogs never leak processes
 *
 * Containment: the session START directory is confined to the NexTool
 * runtime working directory (resolveConfined). Afterwards the shell navigates
 * the real filesystem by design — this terminal IS the real-FS surface and
 * the UI says so unambiguously. The VFS terminal keeps the VFS-only boundary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveConfined } from './fs-containment';

export type TerminalStatus = 'starting' | 'running' | 'stopped' | 'exited' | 'failed';

export interface TerminalChunk {
  seq: number;
  stream: 'stdout' | 'stderr';
  text: string;
}

export type TerminalEvent =
  | { type: 'chunk'; sessionId: string; chunk: TerminalChunk }
  | { type: 'cwd'; sessionId: string; cwd: string; lastExitCode: number | null; first: boolean }
  | { type: 'status'; sessionId: string; status: TerminalStatus; exitCode: number | null; exitSignal: string | null; reason?: string };

export interface TerminalSessionInfo {
  id: string;
  pid: number | null;
  cwd: string;
  status: TerminalStatus;
  startedAt: string;
  exitCode: number | null;
  exitSignal: string | null;
  lastActivityAt: string;
  /** v1.0.16 §3.4 — how the session shell is backed ('pty' via script | 'pipes'). */
  transport: 'pty' | 'pipes';
}

interface TerminalSession extends TerminalSessionInfo {
  child: ChildProcess | null;
  chunks: TerminalChunk[];
  seq: number;
  listeners: Set<(ev: TerminalEvent) => void>;
  watchdog: ReturnType<typeof setInterval> | null;
  /** v1.0.16 §3.4 — startup handshake timer; guarantees the session never
   *  stays `starting` indefinitely. */
  startupTimer: ReturnType<typeof setTimeout> | null;
  /** true once the session reached `running` at least once. */
  reachedRunning: boolean;
  /** true once the FIRST prompt marker (bootstrap) was seen — exit codes are
   *  only published for markers that follow a user-submitted command. */
  sawFirstMarker: boolean;
}

const MAX_SESSIONS = 4;
const CHUNK_CAP = 800; // ring buffer of streamed chunks per session
const IDLE_KILL_MS = 10 * 60 * 1000; // 10 min without input/output
const LIFETIME_MS = 30 * 60 * 1000; // absolute lifetime
const MARKER = '__NEXOOL_CWD__';
const STARTUP_HANDSHAKE_MS = 1_500; // §3.4 — starting → running | failed

/** util-linux script — the host PTY provider. */
const SCRIPT_BIN = existsSync('/usr/bin/script') ? '/usr/bin/script' : existsSync('/bin/script') ? '/bin/script' : null;
/** Fixed PTY grid (see honest limitation in the header). */
export const PTY_COLS = 80;
export const PTY_ROWS = 24;

const g = globalThis as unknown as { __nextoolTerminalSessions?: Map<string, TerminalSession> };

function registry(): Map<string, TerminalSession> {
  if (!g.__nextoolTerminalSessions) g.__nextoolTerminalSessions = new Map();
  return g.__nextoolTerminalSessions;
}

function info(s: TerminalSession): TerminalSessionInfo {
  return {
    id: s.id,
    pid: s.pid,
    cwd: s.cwd,
    status: s.status,
    startedAt: s.startedAt,
    exitCode: s.exitCode,
    exitSignal: s.exitSignal,
    lastActivityAt: s.lastActivityAt,
    transport: s.transport,
  };
}

function publish(session: TerminalSession, ev: TerminalEvent): void {
  for (const fn of session.listeners) {
    try { fn(ev); } catch { /* a dead SSE subscriber must not break the shell */ }
  }
}

function signalGroup(session: TerminalSession, signal: NodeJS.Signals): void {
  const pid = session.child?.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
  try { session.child?.kill(signal); } catch { /* already gone */ }
}

function setStatus(session: TerminalSession, status: TerminalStatus, exitCode: number | null = null, exitSignal: string | null = null, reason?: string): void {
  session.status = status;
  session.exitCode = exitCode ?? session.exitCode;
  session.exitSignal = exitSignal ?? session.exitSignal;
  if (status === 'running') session.reachedRunning = true;
  publish(session, { type: 'status', sessionId: session.id, status, exitCode, exitSignal, reason });
}

/** Parse `cwd|exit` markers out of a PTY-merged chunk; update cwd/exit state. */
function extractMarkers(session: TerminalSession, text: string): string {
  let visible = text;
  const re = new RegExp(`${MARKER}(.*?)${MARKER}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    visible = visible.replace(m[0], '');
    const [cwd, exitRaw] = m[1].split('|');
    if (cwd && cwd.startsWith('/')) {
      session.cwd = cwd;
      const exitCode = exitRaw !== undefined && exitRaw !== '' && exitRaw !== '%s' ? Number(exitRaw) : null;
      publish(session, { type: 'cwd', sessionId: session.id, cwd, lastExitCode: Number.isFinite(exitCode as number) ? (exitCode as number) : null, first: !session.sawFirstMarker });
      session.sawFirstMarker = true;
      if (session.status === 'starting') setStatus(session, 'running');
      session.lastActivityAt = new Date().toISOString();
    }
  }
  return visible;
}

function pushChunk(session: TerminalSession, stream: TerminalChunk['stream'], text: string): void {
  if (!text) return;
  const chunk: TerminalChunk = { seq: ++session.seq, stream, text };
  session.chunks.push(chunk);
  if (session.chunks.length > CHUNK_CAP) session.chunks.splice(0, session.chunks.length - CHUNK_CAP);
  publish(session, { type: 'chunk', sessionId: session.id, chunk });
}

/** §3.4 — the startup handshake: never stay `starting` indefinitely. */
function armStartupHandshake(session: TerminalSession): void {
  if (session.startupTimer) clearTimeout(session.startupTimer);
  session.startupTimer = setTimeout(() => {
    session.startupTimer = null;
    if (session.status !== 'starting') return;
    if (session.child && session.child.exitCode === undefined && !session.child.killed) {
      // The process is alive — the shell IS running even if the first prompt
      // marker has not arrived yet (e.g. slow tty bootstrap).
      setStatus(session, 'running');
    } else {
      setStatus(session, 'failed', session.child?.exitCode ?? null, null, 'startup handshake timed out — the shell did not start');
      const tail = `\n[startup failed: the shell did not start within ${STARTUP_HANDSHAKE_MS} ms. Use RESTART or open a new session.]\n`;
      pushChunk(session, 'stderr', tail);
    }
  }, STARTUP_HANDSHAKE_MS);
  if (typeof session.startupTimer.unref === 'function') session.startupTimer.unref();
}

function watchChildOutput(session: TerminalSession): void {
  const child = session.child;
  if (!child) return;
  // PTY mode: script merges stdout+stderr of the shell into ONE stream.
  child.stdout?.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    session.lastActivityAt = new Date().toISOString();
    const text = session.transport === 'pty' ? extractMarkers(session, raw) : raw;
    if (session.status === 'starting') setStatus(session, 'running');
    pushChunk(session, 'stdout', text);
  });
  // Pipes fallback: stderr is a separate stream (markers stripped there).
  child.stderr?.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    session.lastActivityAt = new Date().toISOString();
    const text = session.transport === 'pty' ? raw : extractMarkers(session, raw);
    if (session.status === 'starting') setStatus(session, 'running');
    pushChunk(session, 'stderr', text);
  });

  child.on('error', (err) => {
    if (session.startupTimer) { clearTimeout(session.startupTimer); session.startupTimer = null; }
    pushChunk(session, 'stderr', `\n[session error: ${err.message}]\n`);
    setStatus(session, 'failed', null, null, err.message);
  });

  child.on('close', (code, signal) => {
    if (session.startupTimer) { clearTimeout(session.startupTimer); session.startupTimer = null; }
    session.child = null;
    if (session.status !== 'stopped' && session.status !== 'failed') {
      // §3.4 — a process that died BEFORE running is a FAILED startup.
      setStatus(session, session.reachedRunning ? (signal ? 'stopped' : 'exited') : 'failed', code, signal ?? null, session.reachedRunning ? undefined : 'the shell exited during startup');
    }
    const tail = `\n[session ${signal ? `terminated by ${signal}` : `exited with code ${code ?? '?'}`} — ${session.reachedRunning ? 'restart or open a new session' : 'startup failed'}.]\n`;
    pushChunk(session, 'stderr', tail);
  });
}

/** PTY shell: util-linux script wraps bash in a real controlling terminal. */
function spawnPty(session: TerminalSession): ChildProcess {
  const inner = `stty rows ${PTY_ROWS} cols ${PTY_COLS} 2>/dev/null; exec bash --noprofile --norc -i`;
  return spawn(SCRIPT_BIN as string, ['-qfc', inner, '/dev/null'], {
    cwd: session.cwd === '.' ? process.cwd() : session.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'xterm-256color',
      LANG: process.env.LANG ?? 'C.UTF-8',
      COLORDIFF_COLORS: 'never',
      FORCE_COLOR: '0',
      COLUMNS: String(PTY_COLS),
      LINES: String(PTY_ROWS),
      NODE_ENV: process.env.NODE_ENV,
      // Friendly NexTool prompt (PS1 is honored by interactive bash without
      // rc files): green operator@nexool, blue cwd, classic $.
      PS1: '\\[\\e[38;5;46m\\]operator@nexool\\[\\e[0m\\]:\\[\\e[38;5;75m\\]\\w\\[\\e[0m\\]\\$ ',
      // Before every prompt the shell emits a `cwd|lastExitCode` marker
      // (parsed and stripped by extractMarkers) so the UI can track the
      // working directory and publish exit statuses (§38/§41).
      PROMPT_COMMAND: `printf "${MARKER}%s|%s${MARKER}\\n" "$PWD" "$?" >&2`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group → group signals are real Ctrl+C/SIGTERM
  });
}

/** Pipes fallback (no util-linux script on the host): raw bash pipes. */
function spawnPipes(session: TerminalSession): ChildProcess {
  return spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    cwd: session.cwd === '.' ? process.cwd() : session.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'C.UTF-8',
      FORCE_COLOR: '0',
      NODE_ENV: process.env.NODE_ENV,
      PS1: 'operator@nexool:\\w\\$ ',
      PROMPT_COMMAND: `printf "${MARKER}%s|%s${MARKER}\\n" "$PWD" "$?" >&2`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
}

function attachChild(session: TerminalSession): void {
  try {
    session.child = SCRIPT_BIN ? spawnPty(session) : spawnPipes(session);
    session.transport = SCRIPT_BIN ? 'pty' : 'pipes';
  } catch (err) {
    // §3.4 — spawn failure is an IMMEDIATE failed state with the real error.
    const message = err instanceof Error ? err.message : 'spawn failed';
    pushChunk(session, 'stderr', `\n[startup failed: ${message}]\n`);
    setStatus(session, 'failed', null, null, message);
    return;
  }
  session.pid = session.child.pid ?? null;
  session.status = 'starting';
  session.reachedRunning = false;
  watchChildOutput(session);
  armStartupHandshake(session);
  setStatus(session, 'starting');
}

function startWatchdog(session: TerminalSession): void {
  if (session.watchdog) clearInterval(session.watchdog);
  session.watchdog = setInterval(() => {
    const idleFor = Date.now() - Date.parse(session.lastActivityAt);
    const livedFor = Date.now() - Date.parse(session.startedAt);
    if (session.child && (idleFor > IDLE_KILL_MS || livedFor > LIFETIME_MS)) {
      signalGroup(session, 'SIGTERM');
      setTimeout(() => { if (session.child) signalGroup(session, 'SIGKILL'); }, 2000);
      setStatus(session, 'stopped');
    }
    // drop registry entries for dead sessions with no subscribers for a while
    if (!session.child && session.listeners.size === 0 && Date.now() - Date.parse(session.lastActivityAt) > IDLE_KILL_MS) {
      stopWatchdog(session);
      registry().delete(session.id);
    }
  }, 30_000);
  if (typeof session.watchdog.unref === 'function') session.watchdog.unref();
}

function stopWatchdog(session: TerminalSession): void {
  if (session.watchdog) clearInterval(session.watchdog);
  session.watchdog = null;
}

/** §3.7/§37 — create a REAL bash session (persistent interactive shell). */
export function createTerminalSession(cwd: string | undefined): TerminalSessionInfo {
  const sessions = registry();
  // reap dead sessions first so the cap applies to LIVE shells
  for (const [id, s] of sessions) {
    if (!s.child && s.listeners.size === 0) {
      stopWatchdog(s);
      sessions.delete(id);
    }
  }
  if (sessions.size >= MAX_SESSIONS) {
    const err = new Error(`Terminal session cap reached (${MAX_SESSIONS}) — close a session first.`);
    (err as Error & { code?: string }).code = 'TERMINAL_CAP';
    throw err;
  }
  const resolved = resolveConfined(cwd && cwd.trim() ? cwd : '.');
  const realCwd = resolved.real;
  const id = `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const session: TerminalSession = {
    id,
    pid: null,
    cwd: realCwd,
    status: 'starting',
    startedAt: new Date().toISOString(),
    exitCode: null,
    exitSignal: null,
    lastActivityAt: new Date().toISOString(),
    child: null,
    chunks: [],
    seq: 0,
    listeners: new Set(),
    watchdog: null,
    startupTimer: null,
    reachedRunning: false,
    sawFirstMarker: false,
    transport: SCRIPT_BIN ? 'pty' : 'pipes',
  };
  sessions.set(id, session);
  attachChild(session);
  startWatchdog(session);
  return info(session);
}

export function listTerminalSessions(): TerminalSessionInfo[] {
  return [...registry().values()].map(info);
}

export function getTerminalSession(id: string): TerminalSession | undefined {
  return registry().get(id);
}

export function replayChunks(session: TerminalSession): TerminalChunk[] {
  return session.chunks;
}

export function subscribe(session: TerminalSession, fn: (ev: TerminalEvent) => void): () => void {
  session.listeners.add(fn);
  return () => session.listeners.delete(fn);
}

/**
 * §3.5 — write to the REAL process stdin.
 * raw: true  → bytes pass through verbatim (the xterm.js keystroke bridge:
 *              partial lines, arrows, \x03 Ctrl+C, Ctrl+D, Tab completion).
 * raw: false → line mode (API compatibility): a missing trailing newline is
 *              appended so `op:write` from older clients still executes.
 */
export function writeToSession(session: TerminalSession, input: string, raw = false): boolean {
  if (!session.child || !session.child.stdin?.writable) return false;
  session.lastActivityAt = new Date().toISOString();
  session.child.stdin.write(raw ? input : input.endsWith('\n') ? input : `${input}\n`);
  return true;
}

/** §3.5 — Ctrl+C: \x03 into the PTY (line discipline → SIGINT) + group SIGINT. */
export function interruptSession(session: TerminalSession): boolean {
  if (!session.child) return false;
  session.lastActivityAt = new Date().toISOString();
  signalGroup(session, 'SIGINT');
  try { session.child.stdin?.write('\x03'); } catch { /* stdin gone */ }
  return true;
}

/** §3.4 — restart: terminate the old shell and spawn a fresh one in place. */
export function restartSession(session: TerminalSession): TerminalSessionInfo {
  if (session.child) {
    signalGroup(session, 'SIGTERM');
    setTimeout(() => { if (session.child) signalGroup(session, 'SIGKILL'); }, 1500);
  }
  session.chunks = [];
  session.seq = 0;
  session.exitCode = null;
  session.exitSignal = null;
  session.startedAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  session.cwd = process.cwd();
  session.sawFirstMarker = false;
  attachChild(session);
  startWatchdog(session);
  return info(session);
}

/** §3.4 — clear: wipe the replay buffer (the view starts empty). */
export function clearSession(session: TerminalSession): void {
  session.chunks = [];
}

/** §3.4 — close and remove the session entirely. */
export function closeSession(session: TerminalSession): void {
  if (session.startupTimer) { clearTimeout(session.startupTimer); session.startupTimer = null; }
  if (session.child) {
    signalGroup(session, 'SIGTERM');
    setTimeout(() => { if (session.child) signalGroup(session, 'SIGKILL'); }, 1500);
  }
  setStatus(session, 'stopped');
  stopWatchdog(session);
  session.listeners.clear();
  registry().delete(session.id);
}
