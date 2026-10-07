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
 * consecutive attempts, then status "offline" (manual reconnect / tab refocus
 * resets). The PRIMARY stream (no taskId) reports into the centralized
 * RuntimeConnection store — the single connection contract consumed by
 * RuntimeConnectionStatus and the status bar. Secondary (task-filtered)
 * streams keep their status local and never disturb the global indicator.
 *
 * v1.0.13 §11 — LIVE PREVIEW RECOVERY hardening (the Task Preview must never
 * freeze after a recovery/subgoal/state transition):
 *  - GAP REPLAY: the hook tracks the newest received event's createdAt and
 *    reconnects with ?since=<lastEventAt>, so events emitted while the
 *    socket was down are REPLAYED by the server (id-dedup makes this safe)
 *    instead of being silently lost;
 *  - BUDGET RECOVERY: a connection that stayed live for >30s resets the
 *    retry budget — a long-lived session + one dropped connection can no
 *    longer exhaust the 8-attempt lifetime and go permanently silent;
 *  - BOUNDED DEDUP: the id-dedup set is pruned to the recent window instead
 *    of growing unboundedly.
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
  // v1.0.13 §11 — newest seen event (ISO) → used as ?since on reconnects.
  const lastEventAtRef = useRef<string | null>(null);
  // Epoch ms of the last successful 'hello' (long-lived connections refresh
  // the retry budget so a single drop can never permanently exhaust it).
  const lastLiveAtRef = useRef<number>(0);
  // Bounded dedup order (oldest first) for pruning.
  const seenOrderRef = useRef<string[]>([]);

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
      // v1.0.13 §11 — the previous connection was live for a meaningful
      // window: this retry is a NEW episode, not a continuation of a failing
      // one. Resets the budget so flapping networks can't go permanently
      // silent after exactly RECONNECT_MAX_ATTEMPTS total attempts.
      if (lastLiveAtRef.current > 0 && Date.now() - lastLiveAtRef.current > 30_000) {
        attempts = 0;
      }
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
      // v1.0.13 §11 — replay the disconnect gap: reconnect with ?since= the
      // newest event we already hold. The server replays everything newer;
      // seenRef dedup makes overlap harmless. The EXPLICIT since option
      // (sinceKey) always wins.
      const effectiveSince = sinceKey || (attempts > 0 && lastEventAtRef.current ? lastEventAtRef.current : '');
      if (effectiveSince) params.set('since', effectiveSince);
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
        lastLiveAtRef.current = Date.now();
        if (primary) conn().reportConnected();
        setStatus('live');
      });

      es.addEventListener('event', (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as NexToolEvent;
          if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return;
          if (seenRef.current.has(parsed.id)) return;
          seenRef.current.add(parsed.id);
          seenOrderRef.current.push(parsed.id);
          // v1.0.13 §11 — bounded dedup: prune the oldest ids when the set
          // grows far beyond the live window (never an unbounded array).
          if (seenOrderRef.current.length > 3000) {
            const drop = seenOrderRef.current.slice(0, seenOrderRef.current.length - 1500);
            for (const id of drop) seenRef.current.delete(id);
            seenOrderRef.current = seenOrderRef.current.slice(-1500);
          }
          // Track the newest timestamp for ?since= reconnect replay.
          const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
          if (createdAt && (!lastEventAtRef.current || createdAt > lastEventAtRef.current)) {
            lastEventAtRef.current = createdAt;
          }
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
