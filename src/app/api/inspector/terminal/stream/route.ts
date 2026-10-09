/**
 * NexTool v1.1.0 §6 — REAL terminal output STREAMING (SSE).
 *
 * GET /api/inspector/terminal/stream?sessionId=…
 *
 * Server-Sent Events per terminal session. On connect the buffered chunks
 * are replayed, then every new chunk (stdout/stderr/echo/meta, seq-numbered),
 * every cwd change and every status/exit event is pushed as it happens.
 * A heartbeat keeps intermediaries from closing the stream. Output arrives
 * while the command runs — the runtime never polls.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { getTerminalSession, replayChunks, subscribeSession, type TerminalEvent } from '@/lib/nexool/inspector/terminal-sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId') ?? '';
  const session = getTerminalSession(sessionId);
  if (!session) {
    return fail('ENOTFOUND', `Terminal session "${sessionId || '?'}" not found (it may have been closed).`, 404);
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
          // stream already closed — the unsubscribe below handles cleanup
        }
      };

      // replay the buffered output first, then subscribe live
      for (const chunk of replayChunks(session)) send({ type: 'chunk', sessionId: session.id, chunk });
      send({ type: 'hello', sessionId: session.id, cwd: session.cwd, status: session.status });
      unsubscribe = subscribeSession(session, (ev: TerminalEvent) => send(ev));

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
