'use client';

/**
 * useNexoolStream — subscribes to the NexTool runtime SSE stream.
 *
 * Protocol (BINDING, see src/lib/nexool/api-contract.ts):
 *   GET /api/stream?taskId=&since=   (text/event-stream)
 *   - event: hello   data: {"ok":true,...}        → connection is live
 *   - event: event   data: NexToolEvent JSON      → appended, newest last
 *   - comment ":keepalive" every 15s              → keeps socket alive
 * On error: close + exponential backoff reconnect (1s→2s→4s… capped 10s).
 */

import { useEffect, useRef, useState } from 'react';
import type { NexToolEvent } from '@/lib/nexool/types';

export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface NexoolStreamOptions {
  /** Only receive events for this task */
  taskId?: string;
  /** ISO string or epoch ms — server replays events with createdAt > since */
  since?: string | number;
  /** Max events kept in memory (newest last). Default 500 */
  max?: number;
}

export interface NexoolStream {
  events: NexToolEvent[];
  connected: boolean;
  status: StreamStatus;
}

export function useNexoolStream(opts: NexoolStreamOptions = {}): NexoolStream {
  const { taskId, since, max = 500 } = opts;

  const [events, setEvents] = useState<NexToolEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  const maxRef = useRef(max);
  useEffect(() => {
    maxRef.current = max;
  }, [max]);

  // Stable keys so changing options rebuilds the connection.
  const taskIdKey = taskId ?? '';
  const sinceKey = since === undefined ? '' : String(since);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;
    let disposed = false;
    const seen = new Set<string>();

    const connect = () => {
      if (disposed) return;
      setStatus((s) => (s === 'live' ? 'connecting' : s));

      const params = new URLSearchParams();
      if (taskIdKey) params.set('taskId', taskIdKey);
      if (sinceKey) params.set('since', sinceKey);
      const query = params.toString();

      es = new EventSource(`/api/stream${query ? `?${query}` : ''}`);

      es.addEventListener('hello', () => {
        backoffMs = 1000;
        setStatus('live');
      });

      es.addEventListener('event', (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as NexToolEvent;
          if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return;
          if (seen.has(parsed.id)) return;
          seen.add(parsed.id);
          setEvents((prev) => {
            const next = [...prev, parsed];
            const cap = maxRef.current;
            return next.length > cap ? next.slice(next.length - cap) : next;
          });
        } catch {
          // Malformed frame — ignore, keep the stream alive.
        }
      });

      es.onerror = () => {
        es?.close();
        es = null;
        setStatus('offline');
        if (disposed) return;
        retryTimer = setTimeout(() => {
          backoffMs = Math.min(backoffMs * 2, 10_000);
          connect();
        }, backoffMs);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
    };
  }, [taskIdKey, sinceKey]);

  return { events, connected: status === 'live', status };
}
