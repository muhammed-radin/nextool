/**
 * NexTool v1.1.0 §6.6/§7.4 — VFS shell API (server-side execution).
 *
 * GET  /api/inspector/vfs/shell → probe (implemented commands, the ACTIVE
 *      allowedCommands configuration, sessions).
 * POST { op: 'create' }                                → new VFS shell session.
 * POST { op: 'exec', sessionId, command }              → execute INSIDE the
 *      VFS (never a host shell); the permitted-command list comes from the
 *      central vfsTerminal.allowedCommands and is enforced here.
 * POST { op: 'clear' | 'close', sessionId }            → session ops.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { FsInspectorError, fsErrorStatus } from '@/lib/nexool/inspector/fs-containment';
import {
  clearVfsShellSession, closeVfsShellSession, createVfsShellSession,
  execVfsCommand, getVfsShellSession, vfsShellProbe,
} from '@/lib/nexool/inspector/vfs-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ ok: true, data: vfsShellProbe() });
}

function needSession(sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new FsInspectorError('INVALID_PARAMS', '"sessionId" must be a non-empty string.');
  }
  const session = getVfsShellSession(sessionId);
  if (!session) throw new FsInspectorError('ENOTFOUND', `VFS shell session "${sessionId}" not found (it may have been closed).`);
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
  if (!op) return fail('INVALID_PARAMS', '"op" must be provided (create | exec | clear | close).', 400);

  try {
    switch (op) {
      case 'create': {
        const session = createVfsShellSession();
        return Response.json({ ok: true, data: { session: { id: session.id, cwd: session.cwd } } });
      }
      case 'exec': {
        const session = needSession(body.sessionId);
        const command = typeof body.command === 'string' ? body.command : '';
        const result = execVfsCommand(session, command);
        return Response.json({ ok: true, data: result });
      }
      case 'clear': {
        const session = needSession(body.sessionId);
        clearVfsShellSession(session);
        return Response.json({ ok: true, data: { cleared: true } });
      }
      case 'close': {
        const session = needSession(body.sessionId);
        closeVfsShellSession(session);
        return Response.json({ ok: true, data: { closed: true } });
      }
      default:
        return fail('INVALID_PARAMS', `Unknown VFS shell op "${op}".`, 400);
    }
  } catch (err) {
    if (err instanceof FsInspectorError) return fail(err.code, err.message, fsErrorStatus(err.code));
    return fail('VFS_SHELL_ERROR', err instanceof Error ? err.message : 'vfs shell op failed', 500);
  }
}
