'use client';

/**
 * App-wide data providers for the console:
 *  - SystemStatsProvider: polls GET /api/system every 5s (runtime health, metrics)
 *  - GlobalStreamProvider: ONE shared SSE connection (replay last 15min + live)
 *  - NotificationsProvider: polls GET /api/notifications every 10s (bell menu)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { NotificationDTO, SystemStats } from '@/lib/nexool/types';
import { ApiClientError, getSystemStats, listNotifications, markNotificationsRead } from '@/lib/nexool/client';
import { useNexoolStream } from '@/hooks/use-nexool-stream';
import { useRuntimeConnection, type RuntimeConnectionStore } from '@/lib/nexool/connection';

// ---------- System stats ----------

interface SystemStatsCtx {
  stats: SystemStats | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

const StatsContext = createContext<SystemStatsCtx>({ stats: null, error: null, loading: true, refresh: () => {} });

export function useSystemStats() {
  return useContext(StatsContext);
}

export function SystemStatsProvider({ children }: { children: ReactNode }) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await getSystemStats();
      setStats(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Runtime unavailable');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo(() => ({ stats, error, loading, refresh }), [stats, error, loading, refresh]);
  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
}

// ---------- Global event stream ----------

interface GlobalStreamCtx {
  events: ReturnType<typeof useNexoolStream>['events'];
  connected: boolean;
  /** Connection state of the primary runtime stream (5-state, v1.0.1). */
  status: RuntimeConnectionStore['status'];
}

const StreamContext = createContext<GlobalStreamCtx>({ events: [], connected: false, status: 'connecting' });

export function useGlobalStream() {
  return useContext(StreamContext);
}

export function GlobalStreamProvider({ children }: { children: ReactNode }) {
  // One shared EventSource: replay the last 15 minutes, then follow live.
  // primary: true — this is THE runtime connection feeding the global indicator.
  const since = useMemo(() => new Date(Date.now() - 15 * 60 * 1000).toISOString(), []);
  const stream = useNexoolStream({ since, max: 500, primary: true });
  const status = useRuntimeConnection((s) => s.status);
  const value = useMemo(
    () => ({ events: stream.events, connected: stream.connected, status }),
    [stream.events, stream.connected, status],
  );
  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

// ---------- Notifications ----------

interface NotificationsCtx {
  notifications: NotificationDTO[];
  unread: number;
  loading: boolean;
  error: string | null;
  markAllRead: () => Promise<void>;
  refresh: () => void;
}

const NotificationsContext = createContext<NotificationsCtx>({
  notifications: [],
  unread: 0,
  loading: true,
  error: null,
  markAllRead: async () => {},
  refresh: () => {},
});

export function useNotifications() {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listNotifications({ limit: 30 });
      setNotifications(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Notifications unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    try {
      await markNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch {
      // leave state as-is; next poll will reconcile
    }
  }, []);

  const unread = notifications.filter((n) => !n.read).length;
  const value = useMemo(
    () => ({ notifications, unread, loading, error, markAllRead, refresh }),
    [notifications, unread, loading, error, markAllRead, refresh],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
