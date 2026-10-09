/**
 * NexTool v1.1.0 §6 — FS Inspector REAL TERMINAL (rebuilt backend).
 *
 * GET  /api/inspector/terminal
 *      → probe + live session list + the ACTIVE central limits
 *        (terminal.maxSessions / execTimeoutMs / maxOutputBytes / historyLimit).
 *
 * POST /api/inspector/terminal — session ops:
 *      { op: 'create',    cwd? }               → new session container (idle).
 *      { op: 'exec',      sessionId, command, timeoutMs? }
 *                                              → spawn a REAL child process
 *        (`/bin/bash -c <command>`): stdout/stderr stream separately over the
 *        SSE stream route, the real exit code + duration are reported, `cd`
 *        is tracked deterministically (wrapper cwd marker), long-running
 *        commands hit the configured timeout (SIGTERM → SIGKILL).
 *      { op: 'interrupt', sessionId }          → Ctrl+C: SIGTERM → SIGKILL.
 *      { op: 'restart',   sessionId }          → reset the container in place.
 *      { op: 'clear',     sessionId }          → wipe the replay buffer.
 *      { op: 'close',     sessionId }          → drop the session.
 *
 * The v1.0.16 raw keystroke `write` op and the `script` PTY are GONE —
 * there is no persistent shell to keep alive, so the FS_TERMINAL_NOT_RUNNING
 * 409 race and the stuck-in-`starting` state cannot occur. The legacy v1.0.13
 * one-shot exec was removed too: it duplicated output/timeout caps that now
 * live exclusively in the central configuration.
 *
 * The MCP environment has NO route to this terminal — MCP tools are confined
 * to the shared VFS (spec §4.3). This surface is the REAL filesystem.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { FsInspectorError, fsErrorStatus } from '@/lib/nexool/inspector/fs-containment';
import {
  clearSession, closeSession, createTerminalSession, execInSession,
  getTerminalSession, interruptSession, listTerminalSessions,
  restartSession, terminalProbe,
} from '@/lib/nexool/inspector/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true, data: terminalProbe() });
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
  if (!op) return fail('INVALID_PARAMS', '"op" must be provided (create | exec | interrupt | restart | clear | close).', 400);

  try {
    switch (op) {
      case 'create': {
        const session = createTerminalSession(typeof body.cwd === 'string' ? body.cwd : undefined);
        return Response.json({ ok: true, data: { session: { id: session.id, cwd: session.cwd, status: session.status } } });
      }
      case 'exec': {
        const session = needSession(body.sessionId);
        const command = typeof body.command === 'string' ? body.command : '';
        const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
        const result = execInSession(session, command, { timeoutMs });
        if (!result.ok) {
          return fail('FS_TERMINAL_BUSY', result.error ?? 'Command rejected.', 409);
        }
        return Response.json({ ok: true, data: result });
      }
      case 'interrupt': {
        const session = needSession(body.sessionId);
        const ok = interruptSession(session);
        return Response.json({ ok: true, data: { interrupted: ok } });
      }
      case 'restart': {
        const session = needSession(body.sessionId);
        restartSession(session);
        return Response.json({ ok: true, data: { session: { id: session.id, cwd: session.cwd, status: session.status } } });
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
