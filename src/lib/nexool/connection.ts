'use client';

/**
 * Runtime Connection Contract (v1.0.1) — centralized client-side state for the
 * frontend ↔ NexTool runtime realtime connection.
 *
 * ONE source of truth. The primary SSE stream (see use-nexool-stream.ts,
 * GlobalStreamProvider) reports its lifecycle here; UI components
 * (RuntimeConnectionStatus, StatusBar) consume this store instead of owning
 * scattered connection logic.
 *
 * State machine:
 *   connecting → connected → reconnecting → connected
 *                                 └→ error (auto-retry budget exhausted;
 *                                    manual reconnect or tab refocus resets)
 *
 * Reconnect policy: exponential backoff 1s → 2s → 4s → 8s → 10s (cap) with
 * jitter, max 8 consecutive attempts. No aggressive infinite loops.
 */

import { create } from 'zustand';
import { APP_NAME, REALTIME_ENDPOINT, REALTIME_TRANSPORT, RUNTIME_BRAND } from './version';

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export interface RuntimeConnectionState {
  /** Aggregate connection state of the primary runtime stream. */
  status: ConnectionState;
  /** Transport + endpoint of the realtime connection contract. */
  transport: typeof REALTIME_TRANSPORT;
  endpoint: string;
  runtimeName: string;
  /** When the frontend application itself finished loading (NOT runtime). */
  frontendLoadedAt: string;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  /** Consecutive failed reconnect attempts for the current outage. */
  reconnectAttempts: number;
  /** Epoch ms of the next scheduled automatic retry (reconnecting only). */
  nextRetryAt: number | null;
  /** Nonce — bumped by "Reconnect now" to force the stream to rebuild. */
  reconnectRequestedAt: number;
}

export interface RuntimeConnectionActions {
  reportConnecting: () => void;
  reportConnected: () => void;
  /** An automatic retry was scheduled after a connection loss. */
  reportRetryScheduled: (attempts: number, nextRetryAt: number) => void;
  /** Auto-retry budget exhausted — stop reconnecting until manual action. */
  reportError: () => void;
  reportEvent: () => void;
  /** Stream torn down intentionally (navigation/unmount) — not an outage. */
  reportTeardown: () => void;
  requestReconnect: () => void;
  reset: () => void;
}

export type RuntimeConnectionStore = RuntimeConnectionState & RuntimeConnectionActions;

const now = () => new Date().toISOString();

export const useRuntimeConnection = create<RuntimeConnectionStore>((set) => ({
  status: 'connecting',
  transport: REALTIME_TRANSPORT,
  endpoint: REALTIME_ENDPOINT,
  runtimeName: `${RUNTIME_BRAND} (${APP_NAME})`,
  frontendLoadedAt: now(),
  lastConnectedAt: null,
  lastEventAt: null,
  reconnectAttempts: 0,
  nextRetryAt: null,
  reconnectRequestedAt: 0,

  reportConnecting: () =>
    set((s) => (s.status === 'connected' ? s : { status: 'connecting' })),
  reportConnected: () =>
    set({ status: 'connected', lastConnectedAt: now(), reconnectAttempts: 0, nextRetryAt: null }),
  reportRetryScheduled: (attempts, nextRetryAt) =>
    set({ status: 'reconnecting', reconnectAttempts: attempts, nextRetryAt }),
  reportError: () =>
    set({ status: 'error', nextRetryAt: null }),
  reportEvent: () => set({ lastEventAt: now() }),
  reportTeardown: () => set({ status: 'disconnected', nextRetryAt: null }),
  requestReconnect: () =>
    set({ reconnectRequestedAt: Date.now(), reconnectAttempts: 0, nextRetryAt: null }),
  reset: () =>
    set({
      status: 'connecting',
      reconnectAttempts: 0,
      nextRetryAt: null,
    }),
}));

/** Reconnect backoff policy shared by the stream hook. */
export const RECONNECT_MAX_ATTEMPTS = 8;

export function reconnectDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 10_000);
  const jitter = base * 0.15 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}
