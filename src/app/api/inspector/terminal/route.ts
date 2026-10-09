/**
 * NexTool v1.0.15 §37-§43 — FS Inspector REAL TERMINAL (sessions) + the
 * v1.0.13 one-shot exec (kept for compatibility).
 *
 * GET  /api/inspector/terminal
 *      → availability probe + live session list (id, pid, cwd, status,
 *        startedAt, exit code — the process lifecycle, §41).
 *
 * POST /api/inspector/terminal — TWO contracts:
 *
 * 1. SESSION OPS (spec §38-§41 — the real interactive terminal):
 *      { op: 'create',  cwd? }                    → spawn a persistent
 *        interactive bash (real process, PID, streaming via the SSE stream
 *        route, stdin, Ctrl+C, cwd tracking).
 *      { op: 'write',   sessionId, input, raw? }  → write to the process
 *        stdin. raw:true passes bytes verbatim (the xterm.js keystroke
 *        bridge — partial lines, arrows, \x03 Ctrl+C, Tab); raw:false (or
 *        omitted) is line mode for API compatibility. Input reaches
 *        INTERACTIVE programs — read / npm init / confirmation prompts are
 *        supported, never one-shot.
 *      { op: 'interrupt', sessionId }             → REAL Ctrl+C: SIGINT to
 *        the child process group + \x03 on stdin.
 *      { op: 'restart', sessionId }               → kill + respawn in place.
 *      { op: 'clear',   sessionId }               → wipe the replay buffer.
 *      { op: 'close',   sessionId }               → terminate + remove.
 *
 * 2. LEGACY ONE-SHOT (v1.0.13 §2.5 — unchanged behavior):
 *      { cwd, command } → bash -c with a 30 s hard timeout, 256 KiB output
 *        caps and cwd containment. Retained for API compatibility.
 *
 * The MCP environment has NO route to this terminal — MCP tools are confined
 * to the shared VFS (spec §4.3); the VFS "terminal" maps its commands onto
 * the VFS API. This surface is the REAL filesystem — the console labels it
 * REAL FILESYSTEM (§42).
 */
import { spawn } from 'node:child_process';
import nodePath from 'node:path';
import fsSync, { existsSync } from 'node:fs';
import { fail } from '@/lib/nexool/api-helpers';
import { FsInspectorError, resolveConfined, fsErrorStatus } from '@/lib/nexool/inspector/fs-containment';
import {
  closeSession, createTerminalSession, clearSession, getTerminalSession,
  interruptSession, listTerminalSessions, restartSession, writeToSession,
  PTY_COLS, PTY_ROWS,
} from '@/lib/nexool/inspector/terminal-sessions';

/** util-linux script availability (mirrors the session manager probe). */
const SCRIPT_BIN = existsSync('/usr/bin/script') ? '/usr/bin/script' : existsSync('/bin/script') ? '/bin/script' : null;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_OUTPUT_BYTES = 256 * 1024;
const HARD_TIMEOUT_MS = 30_000;

export async function GET() {
  return Response.json({
    ok: true,
    data: {
      available: true,
      shell: '/bin/bash',
      transport: SCRIPT_BIN ? 'pty' : 'pipes',
      pty: { cols: PTY_COLS, rows: PTY_ROWS },
      sessions: listTerminalSessions(),
      oneShotTimeoutMs: HARD_TIMEOUT_MS,
    },
  });
}

function needSession(sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new FsInspectorError('INVALID_PARAMS', '"sessionId" must be a non-empty string.');
  }
  const session = getTerminalSession(sessionId);
  if (!session) throw new FsInspectorError('ENOTFOUND', `Terminal session "${sessionId}" not found (it may have been closed).`);
  return session;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return fail('INVALID_PARAMS', 'Request body must be valid JSON.', 400);
  }

  const op = typeof body.op === 'string' ? body.op : undefined;

  // ---------- session ops (v1.0.15 §37-§43) ----------
  if (op) {
    try {
      switch (op) {
        case 'create': {
          const session = createTerminalSession(typeof body.cwd === 'string' ? body.cwd : undefined);
          return Response.json({ ok: true, data: { session } });
        }
        case 'write': {
          const session = needSession(body.sessionId);
          const input = typeof body.input === 'string' ? body.input : '';
          const raw = body.raw === true;
          const written = writeToSession(session, input, raw);
          if (!written) return fail('FS_TERMINAL_NOT_RUNNING', 'The session process is not running — restart the session.', 409);
          return Response.json({ ok: true, data: { written: true } });
        }
        case 'interrupt': {
          const session = needSession(body.sessionId);
          const ok = interruptSession(session);
          return Response.json({ ok: true, data: { interrupted: ok } });
        }
        case 'restart': {
          const session = needSession(body.sessionId);
          const sessionInfo = restartSession(session);
          return Response.json({ ok: true, data: { session: sessionInfo } });
        }
        case 'clear': {
          const session = needSession(body.sessionId);
          clearSession(session);
          return Response.json({ ok: true, data: { cleared: true } });
        }
        case 'close': {
          const session = needSession(body.sessionId);
          closeSession(session);
          return Response.json({ ok: true, data: { closed: true } });
        }
        default:
          return fail('INVALID_PARAMS', `Unknown terminal op "${op}".`, 400);
      }
    } catch (err) {
      if (err instanceof FsInspectorError) return fail(err.code, err.message, fsErrorStatus(err.code));
      const message = err instanceof Error ? err.message : 'terminal op failed';
      return fail('TERMINAL_CAP', message, 429);
    }
  }

  // ---------- legacy one-shot exec (v1.0.13 §2.5, unchanged) ----------
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!command) return fail('INVALID_PARAMS', '"command" (or "op") must be provided.', 400);
  const cwdRel = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : '.';

  let cwd: string;
  try {
    // Containment: resolve the requested cwd inside the runtime working dir.
    if (cwdRel === '.' || cwdRel === '/') {
      cwd = fsSync.realpathSync(process.cwd());
    } else {
      const resolved = resolveConfined(cwdRel);
      if (!fsSync.existsSync(resolved.real) || !fsSync.statSync(resolved.real).isDirectory()) {
        throw new FsInspectorError('ENOTDIR', `Terminal working directory '${cwdRel}' is not a directory.`);
      }
      cwd = resolved.real;
    }
  } catch (err) {
    if (err instanceof FsInspectorError) return fail(err.code, err.message, fsErrorStatus(err.code));
    return fail('FS_ERROR', err instanceof Error ? err.message : 'cwd resolution failed', 400);
  }

  return new Promise<Response>((resolve) => {
    let child;
    try {
      child = spawn('/bin/bash', ['-c', command], {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: cwd,
          TERM: 'dumb',
          LANG: 'C.UTF-8',
          NODE_ENV: process.env.NODE_ENV,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(fail('FS_CMD_SPAWN_FAILED', err instanceof Error ? err.message : 'Failed to spawn the shell.', 500));
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const capChunk = (current: string, chunk: Buffer): { text: string; truncated: boolean } => {
      if (current.length >= MAX_OUTPUT_BYTES) return { text: current, truncated: true };
      const room = MAX_OUTPUT_BYTES - current.length;
      if (chunk.length > room) return { text: current + chunk.subarray(0, room).toString('utf8'), truncated: true };
      return { text: current + chunk.toString('utf8'), truncated };
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, HARD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (c: Buffer) => {
      const r = capChunk(stdout, c);
      stdout = r.text;
      truncated = truncated || r.truncated;
    });
    child.stderr?.on('data', (c: Buffer) => {
      const r = capChunk(stderr, c);
      stderr = r.text;
      truncated = truncated || r.truncated;
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve(fail('FS_CMD_ERROR', err.message, 500));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Report the cwd as the RELATIVE display path (never the host absolute).
      const rel = nodePath.relative(fsSync.realpathSync(process.cwd()), cwd) || '.';
      resolve(
        Response.json(
          {
            ok: true,
            data: { stdout, stderr, code: code ?? null, signal: signal ?? null, truncated, timedOut, cwd: rel },
          },
          { status: 200 },
        ),
      );
    });
  });
}
