/**
 * NexTool Event Manager — global event bus (survives HMR via globalThis).
 * Persists events to TaskEvent table, publishes to in-process subscribers and SSE stream.
 */
import { db } from '@/lib/db';
import type { NexToolEvent, EventSource } from './types';

interface BusState {
  subscribers: Set<(e: NexToolEvent) => void>;
  sseControllers: Map<string, ReadableStreamDefaultController<Uint8Array>>;
  metrics: RuntimeMetrics;
  recent: NexToolEvent[];
}

export interface RuntimeMetrics {
  coreCalls: number;
  totalCoreLatencyMs: number;
  lastDecisionAt?: string;
  startedAt: string;
  coreDecisionSeries: { at: string; ms: number }[];
}

const g = globalThis as unknown as { __nextoolBus?: BusState };

function state(): BusState {
  if (!g.__nextoolBus) {
    g.__nextoolBus = {
      subscribers: new Set(),
      sseControllers: new Map(),
      metrics: {
        coreCalls: 0,
        totalCoreLatencyMs: 0,
        startedAt: new Date().toISOString(),
        coreDecisionSeries: [],
      },
      recent: [],
    };
  }
  return g.__nextoolBus;
}

export function getMetrics(): RuntimeMetrics {
  return state().metrics;
}

export function recordCoreDecision(latencyMs: number): void {
  const s = state();
  s.metrics.coreCalls += 1;
  s.metrics.totalCoreLatencyMs += latencyMs;
  s.metrics.lastDecisionAt = new Date().toISOString();
  s.metrics.coreDecisionSeries.push({ at: s.metrics.lastDecisionAt, ms: Math.round(latencyMs) });
  if (s.metrics.coreDecisionSeries.length > 50) {
    s.metrics.coreDecisionSeries.splice(0, s.metrics.coreDecisionSeries.length - 50);
  }
}

export interface EmitInput {
  taskId?: string;
  type: string;
  source: EventSource;
  message: string;
  data?: Record<string, unknown>;
  priority?: number;
}

/** Emit an event: persist to DB (best-effort), publish to subscribers/SSE. Never throws. */
export async function emitEvent(input: EmitInput): Promise<NexToolEvent> {
  const event: NexToolEvent = {
    id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    taskId: input.taskId,
    type: input.type,
    source: input.source,
    message: input.message,
    data: input.data,
    priority: input.priority ?? 5,
    createdAt: new Date().toISOString(),
  };

  const s = state();
  s.recent.push(event);
  if (s.recent.length > 500) s.recent.splice(0, s.recent.length - 500);

  for (const fn of s.subscribers) {
    try {
      fn(event);
    } catch {
      /* subscriber errors never break the bus */
    }
  }

  // Persist (fire and forget, errors logged only)
  void db.taskEvent
    .create({
      data: {
        id: event.id,
        taskId: event.taskId ?? null,
        type: event.type,
        source: event.source,
        message: event.message,
        data: event.data ? JSON.stringify(event.data) : null,
        priority: event.priority,
        createdAt: new Date(event.createdAt),
      },
    })
    .catch((err: unknown) => console.error('[eventbus] persist failed:', err));

  return event;
}

export function subscribe(fn: (e: NexToolEvent) => void): () => void {
  const s = state();
  s.subscribers.add(fn);
  return () => {
    s.subscribers.delete(fn);
  };
}

// ---------- event lifecycle (v1.0.14 §12) ----------

/** v1.0.14 — canonical Live-event lifecycle states. Every injected event is
 *  received → admitted (or rejected/ignored) → queued (queue mode) →
 *  processing → completed (or failed/cancelled). The lifecycle is emitted as
 *  first-class `event.*` runtime events so admission decisions are observable
 *  in Events, Task Preview and Live Monitor — never silent. */
export type EventLifecycleState =
  | 'received'
  | 'admitted'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'rejected'
  | 'ignored'
  | 'failed'
  | 'cancelled';

/** Emit one `event.<state>` lifecycle record for a Live trigger event.
 *  Fire-and-forget (never throws, never blocks the scheduler). */
export function emitEventLifecycle(opts: {
  taskId?: string;
  eventId: string;
  eventType: string;
  state: EventLifecycleState;
  reason?: string;
  extra?: Record<string, unknown>;
  priority?: number;
}): void {
  const { taskId, eventId, eventType, state, reason, extra, priority } = opts;
  void emitEvent({
    taskId,
    type: `event.${state}`,
    source: 'runtime',
    message: `Event ${state}: ${eventType}${reason ? ` — ${reason}` : ''}.`,
    data: { eventId, eventType, lifecycle: state, ...(reason ? { reason } : {}), ...(extra ?? {}) },
    priority: priority ?? 8,
  });
}

/** Events seen in this process, newest last, optionally filtered by time. */
export function recentEvents(sinceIso?: string, limit = 200): NexToolEvent[] {
  const list = state().recent;
  const filtered = sinceIso ? list.filter((e) => e.createdAt > sinceIso) : [...list];
  return filtered.slice(-limit);
}

/**
 * v1.0.7 §3 — reset in-memory runtime statistics + the in-process event
 * buffer. Part of the application data reset (the DB event history is cleared
 * by the maintenance layer; this clears the process-local caches so the
 * Dashboard/Events views reflect the new empty runtime state immediately).
 */
export function resetBusRuntimeState(): void {
  const s = state();
  s.recent = [];
  s.metrics.coreCalls = 0;
  s.metrics.totalCoreLatencyMs = 0;
  s.metrics.lastDecisionAt = undefined;
  s.metrics.coreDecisionSeries = [];
  s.metrics.startedAt = new Date().toISOString();
}

export async function queryEvents(opts: {
  taskId?: string;
  since?: string;
  limit?: number;
}): Promise<NexToolEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: Record<string, unknown> = {};
  if (opts.taskId) where.taskId = opts.taskId;
  if (opts.since) where.createdAt = { gt: new Date(opts.since) };
  const rows = await db.taskEvent.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId ?? undefined,
    type: r.type,
    source: r.source as EventSource,
    message: r.message,
    data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : undefined,
    priority: r.priority,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ---------- SSE registry ----------

export function registerSseController(connId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
  state().sseControllers.set(connId, controller);
}

export function unregisterSseController(connId: string): void {
  state().sseControllers.delete(connId);
}

export function sseConnectionCount(): number {
  return state().sseControllers.size;
}
