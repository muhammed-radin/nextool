'use client';

/**
 * useNexoolStream — subscribes to the NexTool runtime SSE stream.
 *
 * Protocol (BINDING, see src/lib/nexool/api-contract.ts):
 *   GET /api/stream?taskId=&since=   (text/event-stream)
 *   - event: hello   data: {"ok":true,...}        → connection is live
 *   - event: event   data: NexToolEvent JSON      → appended, newest last
 *   - comment ":keepalive" every 15s              → keeps socket alive
 *
 * Reconnection (v1.0.1): exponential backoff with jitter (1s→10s cap), max 8
 * consecutive attempts, then status "error" (manual reconnect / tab refocus
 * resets). The PRIMARY stream (no taskId) reports into the centralized
 * RuntimeConnection store — the single connection contract consumed by
 * RuntimeConnectionStatus and the status bar. Secondary (task-filtered)
 * streams keep their status local and never disturb the global indicator.
 */

import { useEffect, useRef, useState } from 'react';
import type { NexToolEvent } from '@/lib/nexool/types';
import { RECONNECT_MAX_ATTEMPTS, reconnectDelayMs, useRuntimeConnection } from '@/lib/nexool/connection';

export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface NexoolStreamOptions {
  /** Only receive events for this task */
  taskId?: string;
  /** ISO string or epoch ms — server replays events with createdAt > since */
  since?: string | number;
  /** Max events kept in memory (newest last). Default 500 */
  max?: number;
  /** Primary stream drives the global RuntimeConnection store. Default false. */
  primary?: boolean;
}

export interface NexoolStream {
  events: NexToolEvent[];
  connected: boolean;
  status: StreamStatus;
}

export function useNexoolStream(opts: NexoolStreamOptions = {}): NexoolStream {
  const { taskId, since, max = 500, primary = false } = opts;

  const [events, setEvents] = useState<NexToolEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  const maxRef = useRef(max);
  useEffect(() => {
    maxRef.current = max;
  }, [max]);

  // Dedup set persists across reconnect rebuilds so replays never duplicate.
  const seenRef = useRef<Set<string>>(new Set());

  // Stable keys so changing options rebuilds the connection.
  const taskIdKey = taskId ?? '';
  const sinceKey = since === undefined ? '' : String(since);
  const reconnectRequestedAt = useRuntimeConnection((s) => s.reconnectRequestedAt);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let attempts = 0;
    const conn = useRuntimeConnection.getState;

    const clearRetry = () => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const scheduleRetry = () => {
      if (disposed) return;
      if (attempts >= RECONNECT_MAX_ATTEMPTS) {
        if (primary) conn().reportError();
        setStatus('offline');
        return;
      }
      attempts += 1;
      const delay = reconnectDelayMs(attempts);
      if (primary) conn().reportRetryScheduled(attempts, Date.now() + delay);
      setStatus('offline');
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;
      if (primary) conn().reportConnecting();

      const params = new URLSearchParams();
      if (taskIdKey) params.set('taskId', taskIdKey);
      if (sinceKey) params.set('since', sinceKey);
      const query = params.toString();

      try {
        es = new EventSource(`/api/stream${query ? `?${query}` : ''}`);
      } catch {
        es = null;
        scheduleRetry();
        return;
      }

      es.addEventListener('hello', () => {
        attempts = 0;
        clearRetry();
        if (primary) conn().reportConnected();
        setStatus('live');
      });

      es.addEventListener('event', (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as NexToolEvent;
          if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return;
          if (seenRef.current.has(parsed.id)) return;
          seenRef.current.add(parsed.id);
          if (primary) conn().reportEvent();
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
        scheduleRetry();
      };
    };

    connect();

    // Sensible recovery: if auto-retry gave up ("error"), a tab refocus gives
    // it one fresh budget instead of looping in a hidden background tab.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (es || retryTimer || disposed) return;
      const gaveUp = primary ? conn().status === 'error' : !primary;
      if (gaveUp) {
        attempts = 0;
        if (primary) conn().reset();
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      clearRetry();
      document.removeEventListener('visibilitychange', onVisibility);
      es?.close();
      es = null;
      if (primary) conn().reportTeardown();
    };
  }, [taskIdKey, sinceKey, primary, reconnectRequestedAt]);

  return { events, connected: status === 'live', status };
}
