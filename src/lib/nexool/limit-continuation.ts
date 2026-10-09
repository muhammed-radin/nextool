/**
 * NexTool v1.0.13 → v1.0.16 — SAFETY-LIMIT CONTINUATION.
 *
 * When a task reaches an extendable task-level execution budget — the task
 * TIMEOUT, maxIterations or the tool-call safetyLimit — the runtime no longer
 * fails silently: it ASKS THE OPERATOR (the single-user self-hosted operator
 * console). While the question pends the task parks in `awaiting_approval`
 * with an explicit statusDetail, the current plan/state is preserved and NO
 * tools run in the background.
 *
 *   continue → the affected budget grows (see the per-kind math below) and
 *              the loop RESUMES from its current saved state — the same task,
 *              plan, counters, results, events and identity.
 *   deny     → the task ends exactly as before (limit_reached / failed,
 *              SAFETY_LIMIT / TIMEOUT) — the operator chose the honest stop.
 *   timeout  → after LIMIT_CONTINUATION_TIMEOUT_MS (60 SECONDS, v1.0.16 —
 *              enforced by the backend timer, not the frontend) the pending
 *              request resolves 'timeout' and the task ends as before; the
 *              runtime never grows its own budget unattended.
 *   cancelled→ the task was stopped/paused while the question pended.
 *
 * Budget math (centralized here so UI and backend agree):
 *   taskTimeout   → additional = ORIGINAL time budget (doubling policy:
 *                   120 s original → 240 s total). The extension is added to
 *                   the ALLOWED TOTAL ELAPSED RUNTIME (startedAt + original +
 *                   Σ granted extras); the elapsed clock is NEVER reset.
 *   maxIterations → both maxIterations and safetyLimit grow by the configured
 *                   extra budget (settings.safetyLimitContinuationExtra,
 *                   central bounds 1..500, shipped 25). Counters are preserved.
 *
 * Every request carries the exact numbers (current limit, current usage,
 * additional budget, updated total budget) so the console UI renders the real
 * proposal without duplicating the calculation.
 *
 * Registry + events mirror the approval module: task.limit.continuation_required
 * / .continued / .continuation_denied / .continuation_timeout.
 */

import { emitEvent } from './eventbus';

/** Continuation wait window — 60 SECONDS (v1.0.16 §2.5), backend-enforced. */
export const LIMIT_CONTINUATION_TIMEOUT_MS = 60 * 1000;

export type LimitContinuationOutcome = 'continued' | 'denied' | 'timeout' | 'cancelled';

export type LimitContinuationKind = 'maxIterations' | 'safetyLimit' | 'both' | 'taskTimeout';

export interface PendingLimitContinuation {
  continuationId: string;
  /** Which extendable budget tripped: 'maxIterations' | 'safetyLimit' | 'both' | 'taskTimeout'. */
  limitKind: LimitContinuationKind;
  iterations: number;
  toolCalls: number;
  /** The task's CURRENT effective limits at the moment of the request. */
  maxIterations: number;
  safetyLimit: number;
  /** 'maxIterations'/'safetyLimit'/'both': budget granted to BOTH limits on 'continue'. */
  extraBudget: number;
  /** 'taskTimeout' — the ORIGINAL time budget (ms) and the elapsed runtime (ms). */
  originalTimeBudgetMs?: number;
  elapsedMs?: number;
  /** 'taskTimeout' — additional milliseconds granted on 'continue' (doubling policy). */
  additionalMs?: number;
  /** 'taskTimeout' — new TOTAL time budget in ms after the grant. */
  newTotalBudgetMs?: number;
  /** Pre-computed updated totals for iteration continuations (UI parity). */
  newMaxIterations?: number;
  newSafetyLimit?: number;
  requestedAt: string;
}

interface PendingLimitContinuationEntry extends PendingLimitContinuation {
  taskId: string;
  resolve: (outcome: LimitContinuationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as { __nextoolLimitContinuations?: Map<string, PendingLimitContinuationEntry> };

function continuationRegistry(): Map<string, PendingLimitContinuationEntry> {
  if (!g.__nextoolLimitContinuations) g.__nextoolLimitContinuations = new Map();
  return g.__nextoolLimitContinuations;
}

/** List pending continuation questions (optionally scoped to a task) — powers the console UI. */
export function listPendingLimitContinuations(taskId?: string): PendingLimitContinuation[] {
  const now = Date.now();
  const out: PendingLimitContinuation[] = [];
  for (const [id, entry] of continuationRegistry()) {
    if (now - Date.parse(entry.requestedAt) > LIMIT_CONTINUATION_TIMEOUT_MS + 1000) {
      clearTimeout(entry.timer);
      continuationRegistry().delete(id);
      continue;
    }
    if (taskId && entry.taskId !== taskId) continue;
    const { taskId: _t, resolve: _r, timer: _timer, ...rest } = entry;
    void _t; void _r; void _timer;
    out.push(rest);
  }
  return out;
}

/** Raise a safety-limit continuation question and WAIT for the operator. */
export function requestLimitContinuation(input: {
  taskId: string;
  limitKind: LimitContinuationKind;
  iterations: number;
  toolCalls: number;
  maxIterations: number;
  safetyLimit: number;
  extraBudget: number;
  originalTimeBudgetMs?: number;
  elapsedMs?: number;
  additionalMs?: number;
}): Promise<LimitContinuationOutcome> {
  const continuationId = `cnt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAt = new Date().toISOString();
  const isTimeout = input.limitKind === 'taskTimeout';
  const payload: PendingLimitContinuation = {
    continuationId,
    limitKind: input.limitKind,
    iterations: input.iterations,
    toolCalls: input.toolCalls,
    maxIterations: input.maxIterations,
    safetyLimit: input.safetyLimit,
    extraBudget: input.extraBudget,
    originalTimeBudgetMs: input.originalTimeBudgetMs,
    elapsedMs: input.elapsedMs,
    additionalMs: input.additionalMs,
    newTotalBudgetMs: isTimeout ? (input.originalTimeBudgetMs ?? 0) + (input.additionalMs ?? 0) : undefined,
    newMaxIterations: isTimeout ? undefined : input.maxIterations + input.extraBudget,
    newSafetyLimit: isTimeout ? undefined : input.safetyLimit + input.extraBudget,
    requestedAt,
  };

  const reasonLabel = isTimeout
    ? `Task timeout reached (elapsed ${Math.round((input.elapsedMs ?? 0) / 1000)}s of the ${Math.round((input.originalTimeBudgetMs ?? 0) / 1000)}s budget)`
    : `Safety limit reached (${input.limitKind})`;
  const offerLabel = isTimeout
    ? `+${Math.round((input.additionalMs ?? 0) / 1000)}s more time (total ${Math.round((payload.newTotalBudgetMs ?? 0) / 1000)}s)`
    : `+${input.extraBudget} more steps/tool-calls`;
  void emitEvent({
    taskId: input.taskId,
    type: 'task.limit.continuation_required',
    source: 'runtime',
    message: `${reasonLabel} — asking the operator whether to continue with ${offerLabel}.`,
    data: { ...payload },
    priority: 2,
  });

  return new Promise<LimitContinuationOutcome>((resolve) => {
    const entry: PendingLimitContinuationEntry = {
      ...payload,
      taskId: input.taskId,
      resolve,
      timer: setTimeout(() => {
        continuationRegistry().delete(continuationId);
        void emitEvent({
          taskId: input.taskId,
          type: 'task.limit.continuation_timeout',
          source: 'runtime',
          message: `Safety-limit continuation question timed out after 60 seconds — the task stops with ${isTimeout ? 'TIMEOUT' : 'limit_reached'} (the runtime never grows its own budget unattended).`,
          data: { continuationId, limitKind: input.limitKind },
          priority: 3,
        });
        resolve('timeout');
      }, LIMIT_CONTINUATION_TIMEOUT_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    continuationRegistry().set(continuationId, entry);
  });
}

/**
 * Resolve a pending continuation question from the console UI.
 * decision 'continue' grants the budget; 'deny' ends the task as before.
 * Optional feedback (on denial) becomes an observer event.
 * Idempotent-safe: the registry entry is removed FIRST, so duplicate clicks or
 * duplicate API requests can never extend the same budget twice.
 */
export async function resolveLimitContinuation(
  continuationId: string,
  decision: 'continue' | 'deny',
  feedback?: string,
): Promise<boolean> {
  const entry = continuationRegistry().get(continuationId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  continuationRegistry().delete(continuationId);

  if (decision === 'continue') {
    const isTimeout = entry.limitKind === 'taskTimeout';
    void emitEvent({
      taskId: entry.taskId,
      type: 'task.limit.continued',
      source: 'user',
      message: isTimeout
        ? `Operator CONTINUED past the task timeout: total time budget ${Math.round((entry.originalTimeBudgetMs ?? 0) / 1000)}s → ${Math.round((entry.newTotalBudgetMs ?? 0) / 1000)}s (elapsed clock NOT reset).`
        : `Operator CONTINUED past the safety limit: maxIterations ${entry.maxIterations} → ${entry.newMaxIterations}, safetyLimit ${entry.safetyLimit} → ${entry.newSafetyLimit}.`,
      data: {
        continuationId,
        limitKind: entry.limitKind,
        newMaxIterations: entry.newMaxIterations,
        newSafetyLimit: entry.newSafetyLimit,
        extraBudget: entry.extraBudget,
        originalTimeBudgetMs: entry.originalTimeBudgetMs,
        additionalMs: entry.additionalMs,
        newTotalBudgetMs: entry.newTotalBudgetMs,
      },
      priority: 3,
    });
    entry.resolve('continued');
    return true;
  }

  void emitEvent({
    taskId: entry.taskId,
    type: 'task.limit.continuation_denied',
    source: 'user',
    message: `Operator DENIED the safety-limit continuation — the task stops.`,
    data: { continuationId, limitKind: entry.limitKind },
    priority: 2,
  });
  const trimmed = feedback?.trim();
  if (trimmed) {
    void emitEvent({
      taskId: entry.taskId,
      type: 'observer.feedback_applied',
      source: 'user',
      message: `Continuation denial feedback: ${trimmed.slice(0, 300)}`,
      data: { continuationId, denialFeedback: trimmed.slice(0, 2000) },
      priority: 3,
    });
  }
  entry.resolve('denied');
  return true;
}

/** Flush every pending continuation question for a task (task stop transitions). */
export function cancelPendingLimitContinuationsForTask(taskId: string): void {
  for (const [id, entry] of continuationRegistry()) {
    if (entry.taskId !== taskId) continue;
    clearTimeout(entry.timer);
    continuationRegistry().delete(id);
    entry.resolve('cancelled');
  }
}
