/**
 * NexTool v1.1.0 §6.6 — VFS shell output STREAMING (SSE).
 * Same protocol as the real-FS terminal stream: chunk replay on connect,
 * live chunk/cwd/exit events, heartbeat. One shared frontend shell component
 * can therefore drive both terminals.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { getVfsShellSession, replayVfsChunks, subscribeVfsSession, type VfsShellEvent } from '@/lib/nexool/inspector/vfs-shell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId') ?? '';
  const session = getVfsShellSession(sessionId);
  if (!session) {
    return fail('ENOTFOUND', `VFS shell session "${sessionId || '?'}" not found (it may have been closed).`, 404);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // stream already closed
        }
      };

      for (const chunk of replayVfsChunks(session)) send({ type: 'chunk', sessionId: session.id, chunk });
      send({ type: 'hello', sessionId: session.id, cwd: session.cwd, status: 'idle' });
      unsubscribe = subscribeVfsSession(session, (ev: VfsShellEvent) => send(ev));

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch { /* closed */ }
      }, 15_000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      req.signal.addEventListener('abort', () => {
        if (unsubscribe) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (unsubscribe) unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
