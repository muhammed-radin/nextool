/**
 * NexTool v1.0.15 §37-§43 — REAL terminal session manager (fs environment).
 *
 * Each session is a PERSISTENT INTERACTIVE bash process (`bash --noprofile
 * --norc -i`) — a real host process with real stdin/stdout/stderr pipes, not
 * a simulated shell. This is intentionally powerful: the fs environment is
 * the real filesystem (freedom-node boundary), and the console labels it
 * "REAL FILESYSTEM".
 *
 * Session features (spec §38-§41):
 *  - command input + real stdout/stderr STREAMING (chunked, seq-numbered)
 *  - stdin: every input line reaches the running process (read / npm init /
 *    confirmation prompts work) — commands are never assumed one-shot
 *  - Ctrl+C / interrupt: SIGINT to the child PROCESS GROUP + \x03 on stdin
 *  - cwd tracking: PROMPT_COMMAND emits a __NEXOOL_CWD__ marker (with the
 *    last exit code) to stderr before every prompt; the backend parses it,
 *    strips it from the visible output and publishes cwd + exit status
 *  - lifecycle: starting → running → exited | stopped | failed, with PID,
 *    working directory, start time and exit code exposed
 *  - multiple sessions (cap 4), restart, clear, close; idle (10 min) and
 *    lifetime (30 min) watchdogs never leak processes
 *
 * Containment: the session START directory is confined to the NexTool
 * runtime working directory (resolveConfined). Afterwards the shell navigates
 * the real filesystem by design — this terminal IS the real-FS surface and
 * the UI says so unambiguously. The VFS terminal keeps the VFS-only boundary.
 */
import { spawn } from 'node:child_process';
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
  | { type: 'status'; sessionId: string; status: TerminalStatus; exitCode: number | null; exitSignal: string | null };

export interface TerminalSessionInfo {
  id: string;
  pid: number | null;
  cwd: string;
  status: TerminalStatus;
  startedAt: string;
  exitCode: number | null;
  exitSignal: string | null;
  lastActivityAt: string;
}

interface TerminalSession extends TerminalSessionInfo {
  child: ReturnType<typeof spawn> | null;
  chunks: TerminalChunk[];
  seq: number;
  listeners: Set<(ev: TerminalEvent) => void>;
  watchdog: ReturnType<typeof setInterval> | null;
  /** true once the FIRST prompt marker (bootstrap) was seen — exit codes are
   *  only published for markers that follow a user-submitted command. */
  sawFirstMarker: boolean;
}

const MAX_SESSIONS = 4;
const CHUNK_CAP = 800; // ring buffer of streamed chunks per session
const IDLE_KILL_MS = 10 * 60 * 1000; // 10 min without input/output
const LIFETIME_MS = 30 * 60 * 1000; // absolute lifetime
const MARKER = '__NEXOOL_CWD__';

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

function setStatus(session: TerminalSession, status: TerminalStatus, exitCode: number | null = null, exitSignal: string | null = null): void {
  session.status = status;
  session.exitCode = exitCode ?? session.exitCode;
  session.exitSignal = exitSignal ?? session.exitSignal;
  publish(session, { type: 'status', sessionId: session.id, status, exitCode, exitSignal });
}

/** Parse `cwd|exit` markers out of a stderr chunk; update cwd/exit state. */
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
      session.status = 'running';
      session.lastActivityAt = new Date().toISOString();
    }
  }
  return visible;
}

function attachChild(session: TerminalSession): void {
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    cwd: session.cwd === '.' ? process.cwd() : session.cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      TERM: 'dumb',
      LANG: process.env.LANG ?? 'C.UTF-8',
      FORCE_COLOR: '0',
      // v1.0.15 — inherited by the interactive shell WITHOUT a stdin
      // bootstrap: no echoed garbage, no parser confusion. Before every
      // prompt the shell emits a `cwd|lastExitCode` marker on stderr (parsed
      // and stripped by extractMarkers) so the UI can track the working
      // directory and publish exit statuses (§38/§41).
      PROMPT_COMMAND: `printf "${MARKER}%s|%s${MARKER}\\n" "$PWD" "$?" >&2`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // own process group → group SIGINT is a REAL Ctrl+C
  });
  session.child = child;
  session.pid = child.pid ?? null;
  session.status = 'starting';

  // (No stdin bootstrap: PROMPT_COMMAND travels through the environment —
  // see attachChild.)

  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    session.lastActivityAt = new Date().toISOString();
    const chunk: TerminalChunk = { seq: ++session.seq, stream: 'stdout', text };
    session.chunks.push(chunk);
    if (session.chunks.length > CHUNK_CAP) session.chunks.splice(0, session.chunks.length - CHUNK_CAP);
    publish(session, { type: 'chunk', sessionId: session.id, chunk });
  });

  child.stderr?.on('data', (buf: Buffer) => {
    const raw = buf.toString('utf8');
    session.lastActivityAt = new Date().toISOString();
    const text = extractMarkers(session, raw);
    if (!text) return;
    const chunk: TerminalChunk = { seq: ++session.seq, stream: 'stderr', text };
    session.chunks.push(chunk);
    if (session.chunks.length > CHUNK_CAP) session.chunks.splice(0, session.chunks.length - CHUNK_CAP);
    publish(session, { type: 'chunk', sessionId: session.id, chunk });
  });

  child.on('error', (err) => {
    const chunk: TerminalChunk = { seq: ++session.seq, stream: 'stderr', text: `\n[session error: ${err.message}]\n` };
    session.chunks.push(chunk);
    publish(session, { type: 'chunk', sessionId: session.id, chunk });
    setStatus(session, 'failed', null, null);
  });

  child.on('close', (code, signal) => {
    session.child = null;
    if (session.status !== 'stopped' && session.status !== 'failed') {
      setStatus(session, signal ? 'stopped' : 'exited', code, signal ?? null);
    }
    const tail: TerminalChunk = { seq: ++session.seq, stream: 'stderr', text: `\n[session ${signal ? `terminated by ${signal}` : `exited with code ${code ?? '?'}`}. Restart or open a new session.]\n` };
    session.chunks.push(tail);
    publish(session, { type: 'chunk', sessionId: session.id, chunk: tail });
  });

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

/** §37/§39 — create a REAL bash session (persistent interactive shell). */
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
    sawFirstMarker: false,
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

/** §40 — write a line (or raw bytes for stdin consumers) to the REAL process. */
export function writeToSession(session: TerminalSession, input: string): boolean {
  if (!session.child || !session.child.stdin?.writable) return false;
  session.lastActivityAt = new Date().toISOString();
  session.child.stdin.write(input.endsWith('\n') ? input : `${input}\n`);
  return true;
}

/** §38 — Ctrl+C: SIGINT the process group + \x03 on stdin (belt and braces). */
export function interruptSession(session: TerminalSession): boolean {
  if (!session.child) return false;
  session.lastActivityAt = new Date().toISOString();
  signalGroup(session, 'SIGINT');
  try { session.child.stdin?.write('\x03'); } catch { /* stdin gone */ }
  return true;
}

/** §38 — restart: terminate the old shell and spawn a fresh one in place. */
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

/** §38 — clear: wipe the replay buffer (the view starts empty). */
export function clearSession(session: TerminalSession): void {
  session.chunks = [];
}

/** §41 — close and remove the session entirely. */
export function closeSession(session: TerminalSession): void {
  if (session.child) {
    signalGroup(session, 'SIGTERM');
    setTimeout(() => { if (session.child) signalGroup(session, 'SIGKILL'); }, 1500);
  }
  setStatus(session, 'stopped');
  stopWatchdog(session);
  session.listeners.clear();
  registry().delete(session.id);
}
