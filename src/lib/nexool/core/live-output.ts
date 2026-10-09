/**
 * NexTool v1.1.0 §1 — COREMODULE LIVE OUTPUT registry.
 *
 * A lightweight, in-memory channel that carries REAL CoreModule LLM output
 * to the Task Preview "CoreModule Live Output" section:
 *
 *   CoreModule request starts (stream: true)
 *        ↓ provider delta frames (parsed from the OpenAI-compatible SSE)
 *        ↓ appendCoreOutput() → bounded per-request text buffer
 *        ↓ subscribers (the dedicated /api/core/stream SSE route)
 *        ↓ Task Preview renders progressively (~10-word display batches)
 *        ↓ final output is parsed and validated by the normal pipeline
 *
 * DELIBERATE DESIGN BOUNDARIES (spec §1.4):
 *  - Token chunks are NOT persisted as Prisma TaskEvents (that would write
 *    one row per provider frame). Only the lifecycle events
 *    core.output.started / core.output.completed / core.output.failed are
 *    persisted (emitted by coremodule.ts); chunks live in this bounded
 *    registry and replay from the buffer on reconnect.
 *  - The buffer is capped by coreModule.liveOutputBufferBytes from the
 *    central limits; when the cap is hit, older bytes are dropped from the
 *    REPLAY window only (the flag `truncated` is set so the UI can say so) —
 *    the final parsed decision is unaffected.
 *  - No credentials, secrets or hidden reasoning ever enter this channel —
 *    it carries exactly what the model generated.
 *  - Late chunks for cancelled/superseded requests are ignored by callers
 *    (appendCoreOutput is a no-op once the record is no longer streaming).
 */

import { getResolvedLimits } from '../config-limits';

export type CoreOutputStatus = 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface CoreOutputRecord {
  requestId: string;
  taskId?: string;
  /** What the runtime asked for (always llm-core today). */
  requestedEngine: string;
  /** Human label, e.g. "decision" or "decision (strict retry)". */
  label: string;
  status: CoreOutputStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Bounded accumulated generated text. */
  text: string;
  truncated: boolean;
  /** Incremented for every appended delta — clients dedup/replay by seq. */
  chunkSeq: number;
  /** Set when the response arrived without streaming support (honest UI). */
  streaming: boolean;
  error?: string;
  /** Final pipeline metadata (parse/validation result, fallback reason…). */
  meta?: Record<string, unknown>;
}

export type CoreOutputEvent =
  | { kind: 'started'; record: CoreOutputRecord }
  | { kind: 'chunk'; requestId: string; taskId?: string; seq: number; delta: string; textLen: number; truncated: boolean }
  | { kind: 'completed'; requestId: string; taskId?: string; record: CoreOutputRecord }
  | { kind: 'failed'; requestId: string; taskId?: string; record: CoreOutputRecord }
  | { kind: 'cancelled'; requestId: string; taskId?: string; record: CoreOutputRecord };

type Subscriber = (ev: CoreOutputEvent) => void;

interface CoreOutputState {
  records: Map<string, CoreOutputRecord>;
  order: string[];
  subscribers: Set<Subscriber>;
}

const g = globalThis as unknown as { __nextoolCoreOutput?: CoreOutputState };

function state(): CoreOutputState {
  if (!g.__nextoolCoreOutput) {
    g.__nextoolCoreOutput = { records: new Map(), order: [], subscribers: new Set() };
  }
  return g.__nextoolCoreOutput;
}

/** Bounded registry hygiene: keep at most this many records. */
const MAX_RECORDS = 40;
const RECORD_TTL_MS = 30 * 60 * 1000;

function prune(): void {
  const s = state();
  const now = Date.now();
  for (const id of [...s.order]) {
    const rec = s.records.get(id);
    if (!rec) {
      s.order = s.order.filter((x) => x !== id);
      continue;
    }
    const done = rec.status !== 'streaming';
    if (done && rec.completedAt && now - new Date(rec.completedAt).getTime() > RECORD_TTL_MS) {
      s.records.delete(id);
      s.order = s.order.filter((x) => x !== id);
    }
  }
  while (s.order.length > MAX_RECORDS) {
    const oldest = s.order.shift();
    if (oldest) {
      const rec = s.records.get(oldest);
      // never evict a still-streaming record from the front needlessly —
      // but a hard cap protects memory; streaming records only reach the
      // front when something went wrong, so evicting is acceptable.
      if (rec?.status === 'streaming') s.order.push(oldest); // keep streaming, evict next
      else if (oldest) s.records.delete(oldest);
    }
    if (s.order.length <= MAX_RECORDS) break;
  }
}

function publish(ev: CoreOutputEvent): void {
  const s = state();
  for (const fn of s.subscribers) {
    try {
      fn(ev);
    } catch {
      /* a broken subscriber must never break the engine */
    }
  }
}

export interface StartCoreOutputInput {
  taskId?: string;
  label?: string;
  requestedEngine?: string;
}

/** Allocate a request id (correlates SSE frames, events and diagnostics). */
export function newCoreRequestId(): string {
  return `core_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Register a new CoreModule LLM request and announce it. */
export function startCoreOutput(input: StartCoreOutputInput): CoreOutputRecord {
  const record: CoreOutputRecord = {
    requestId: newCoreRequestId(),
    taskId: input.taskId,
    requestedEngine: input.requestedEngine ?? 'llm-core',
    label: input.label ?? 'decision',
    status: 'streaming',
    startedAt: new Date().toISOString(),
    text: '',
    truncated: false,
    chunkSeq: 0,
    streaming: true,
  };
  const s = state();
  s.records.set(record.requestId, record);
  s.order.push(record.requestId);
  prune();
  publish({ kind: 'started', record: snapshot(record) });
  return record;
}

/** Append a real provider delta. No-op once the record left `streaming`. */
export function appendCoreOutput(record: CoreOutputRecord, delta: string): void {
  if (record.status !== 'streaming' || !delta) return;
  let cap = 65536;
  try {
    cap = getResolvedLimits().coreModule.liveOutputBufferBytes;
  } catch {
    /* limits file problem — keep the built-in cap rather than dropping output */
  }
  if (record.text.length + delta.length > cap) {
    // drop from the FRONT (oldest bytes) — the replay window stays bounded
    const keep = Math.max(0, cap - delta.length);
    record.text = record.text.slice(record.text.length - keep);
    record.truncated = true;
  }
  record.text += delta;
  record.chunkSeq += 1;
  publish({
    kind: 'chunk',
    requestId: record.requestId,
    taskId: record.taskId,
    seq: record.chunkSeq,
    delta,
    textLen: record.text.length,
    truncated: record.truncated,
  });
}

function finish(record: CoreOutputRecord, status: CoreOutputStatus, error?: string): void {
  if (record.status !== 'streaming') return; // idempotent
  record.status = status;
  record.completedAt = new Date().toISOString();
  record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();
  if (error) record.error = error.slice(0, 500);
  if (status === 'completed') publish({ kind: 'completed', requestId: record.requestId, taskId: record.taskId, record: snapshot(record) });
  else if (status === 'failed') publish({ kind: 'failed', requestId: record.requestId, taskId: record.taskId, record: snapshot(record) });
  else publish({ kind: 'cancelled', requestId: record.requestId, taskId: record.taskId, record: snapshot(record) });
}

/** Mark a request as finished successfully. */
export function completeCoreOutput(record: CoreOutputRecord, meta?: Record<string, unknown>): void {
  if (meta) record.meta = { ...(record.meta ?? {}), ...meta };
  finish(record, 'completed');
}

/** Mark a request as failed (provider failure, timeout, invalid output…). */
export function failCoreOutput(record: CoreOutputRecord, error?: string, meta?: Record<string, unknown>): void {
  if (meta) record.meta = { ...(record.meta ?? {}), ...meta };
  finish(record, 'failed', error);
}

/** Mark a request as cancelled (force-stop, superseded). */
export function cancelCoreOutput(record: CoreOutputRecord): void {
  finish(record, 'cancelled');
}

function snapshot(rec: CoreOutputRecord): CoreOutputRecord {
  return { ...rec };
}

/** Subscribe to live core-output events. Returns an unsubscribe function. */
export function subscribeCoreOutput(fn: Subscriber): () => void {
  const s = state();
  s.subscribers.add(fn);
  return () => s.subscribers.delete(fn);
}

/** Snapshot of recent records (newest last), optionally filtered by task. */
export function listCoreOutputs(opts?: { taskId?: string; limit?: number }): CoreOutputRecord[] {
  const s = state();
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), MAX_RECORDS);
  const out: CoreOutputRecord[] = [];
  for (let i = s.order.length - 1; i >= 0 && out.length < limit; i--) {
    const rec = s.records.get(s.order[i]);
    if (!rec) continue;
    if (opts?.taskId && rec.taskId !== opts.taskId) continue;
    out.unshift(snapshot(rec));
  }
  return out;
}

export function getCoreOutput(requestId: string): CoreOutputRecord | null {
  const rec = state().records.get(requestId);
  return rec ? snapshot(rec) : null;
}

/** Cancel every in-flight record for a task (used by force-stop §9). */
export function cancelCoreOutputsForTask(taskId: string): number {
  const s = state();
  let n = 0;
  for (const rec of s.records.values()) {
    if (rec.taskId === taskId && rec.status === 'streaming') {
      finish(rec, 'cancelled');
      n++;
    }
  }
  return n;
}
