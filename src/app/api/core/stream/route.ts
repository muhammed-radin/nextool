/**
 * NexTool v1.1.0 §1 — CoreModule Live Output SSE channel.
 *
 * GET /api/core/stream?taskId=<id>[&requestId=<id>]
 *
 * Replays the bounded buffered output of the task's recent CoreModule LLM
 * requests (snapshot per request — reconnects never lose already-emitted
 * chunks), then pushes live chunk/completion frames. Chunks are identified
 * by (requestId, seq) so the client can dedup; late frames for cancelled or
 * superseded requests are marked cancelled and ignored by the renderer.
 *
 * This channel is OBSERVABILITY ONLY: it never carries credentials and its
 * frames are never executed — the final decision still flows through the
 * normal parse/validate pipeline and the persisted core.decision event.
 */

import { listCoreOutputs, subscribeCoreOutput } from '@/lib/nexool/core/live-output';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  const requestId = url.searchParams.get('requestId') ?? undefined;

  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const push = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(sse(event, data));
        } catch {
          closed = true;
        }
      };

      // hello + bounded replay of recent requests for this task/filter
      push('hello', { ok: true, taskId: taskId ?? null, requestId: requestId ?? null, at: new Date().toISOString() });
      const recent = listCoreOutputs({ taskId, limit: 12 }).filter((r) => !requestId || r.requestId === requestId);
      for (const rec of recent) {
        push('core.snapshot', rec);
      }

      unsub = subscribeCoreOutput((ev) => {
        if (closed) return;
        if (requestId && 'requestId' in ev && ev.requestId !== requestId) return;
        if (taskId && 'taskId' in ev && ev.taskId !== taskId) return;
        switch (ev.kind) {
          case 'started':
            push('core.started', ev.record);
            break;
          case 'chunk':
            push('core.chunk', { requestId: ev.requestId, taskId: ev.taskId, seq: ev.seq, delta: ev.delta, textLen: ev.textLen, truncated: ev.truncated });
            break;
          case 'completed':
            push('core.completed', ev.record);
            break;
          case 'failed':
            push('core.failed', ev.record);
            break;
          case 'cancelled':
            push('core.cancelled', ev.record);
            break;
        }
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          closed = true;
        }
      }, 15_000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      req.signal.addEventListener('abort', () => {
        closed = true;
        unsub?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsub?.();
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
