/**
 * NexTool v1.0.15 §38 — REAL terminal output STREAMING (SSE).
 *
 * GET /api/inspector/terminal/stream?sessionId=…
 *
 * Server-Sent Events per terminal session. On connect the buffered chunks
 * are replayed, then every new chunk (stdout/stderr, seq-numbered), every
 * cwd/exit-code marker and every lifecycle change (running/exited/stopped/
 * failed — §41) is pushed as it happens. A heartbeat keeps intermediaries
 * from closing the stream. The runtime never polls and the process never
 * buffers until exit — output arrives while the command runs.
 */
import { fail } from '@/lib/nexool/api-helpers';
import { getTerminalSession, replayChunks, subscribe, type TerminalEvent } from '@/lib/nexool/inspector/terminal-sessions';

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
      send({ type: 'hello', sessionId: session.id, pid: session.pid, cwd: session.cwd, status: session.status });
      unsubscribe = subscribe(session, (ev: TerminalEvent) => send(ev));

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
