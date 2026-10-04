/**
 * SSE stream builder for /api/stream.
 * Protocol: hello → replay events after ?since → live push → ":keepalive" every 15s.
 */
import { recentEvents, registerSseController, unregisterSseController, subscribe } from '../eventbus';
import type { NexToolEvent } from '../types';

const encoder = new TextEncoder();

function formatSse(event: NexToolEvent): Uint8Array {
  return encoder.encode(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
}

export function buildEventStream(request: Request, taskId?: string, since?: string): Response {
  const connId = `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  let cleanupFn: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unregisterSseController(connId);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanupFn = cleanup;

      // hello
      safeEnqueue(encoder.encode(`event: hello\ndata: ${JSON.stringify({ ok: true, since: since ?? null, taskId: taskId ?? null })}\n\n`));

      // replay
      try {
        const replay = recentEvents(since, 300).filter((e) => !taskId || e.taskId === taskId);
        for (const e of replay) safeEnqueue(formatSse(e));
      } catch (err) {
        console.error('[sse] replay failed:', err);
      }

      // live subscription
      const unsubscribe = subscribe((e) => {
        if (taskId && e.taskId !== taskId) return;
        safeEnqueue(formatSse(e));
      });

      registerSseController(connId, controller);

      // heartbeat every 15s
      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(':keepalive\n\n'));
      }, 15_000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      // abort / client disconnect handling
      if (request.signal) {
        if (request.signal.aborted) cleanup();
        else request.signal.addEventListener('abort', cleanup, { once: true });
      }
    },
    cancel() {
      cleanupFn();
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
