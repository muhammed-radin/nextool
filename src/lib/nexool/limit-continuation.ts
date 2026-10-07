/**
 * NexTool v1.0.13 — SAFETY-LIMIT CONTINUATION.
 *
 * When a goal-mode task reaches maxIterations or safetyLimit, the runtime no
 * longer fails silently: it ASKS THE OPERATOR (the single-user self-hosted
 * operator console). While the question pends the task parks in
 * `awaiting_approval` with an explicit statusDetail.
 *
 *   continue → BOTH limits grow by the configured extra budget
 *              (settings.safetyLimitContinuationExtra, central bounds 1..500,
 *              shipped 25) and the loop proceeds; a per-task counter
 *              (TaskConfig.limitContinuations, 0..5, default 1) caps how often
 *              this can happen.
 *   deny     → the task ends exactly as before (limit_reached / failed,
 *              SAFETY_LIMIT) — the operator chose the honest stop.
 *   timeout  → after LIMIT_CONTINUATION_TIMEOUT_MS (5 minutes) the pending
 *              request resolves 'timeout' and the task ends as before; the
 *              runtime never grows its own budget unattended.
 *   cancelled→ the task was stopped/paused while the question pended.
 *
 * Registry + events mirror the approval module: task.limit.continuation_required
 * / .continued / .continuation_denied / .continuation_timeout. The granted
 * budget is reported on every event so the console always shows the real
 * numbers.
 */

import { emitEvent } from './eventbus';

/** Continuation wait window (mirrors APPROVAL_TIMEOUT_MS). */
export const LIMIT_CONTINUATION_TIMEOUT_MS = 5 * 60 * 1000;

export type LimitContinuationOutcome = 'continued' | 'denied' | 'timeout' | 'cancelled';

export interface PendingLimitContinuation {
  continuationId: string;
  /** Which limit tripped: 'maxIterations' | 'safetyLimit' | 'both'. */
  limitKind: 'maxIterations' | 'safetyLimit' | 'both';
  iterations: number;
  toolCalls: number;
  /** The task's CURRENT effective limits at the moment of the request. */
  maxIterations: number;
  safetyLimit: number;
  /** Budget that will be granted to BOTH limits on 'continue'. */
  extraBudget: number;
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
  limitKind: PendingLimitContinuation['limitKind'];
  iterations: number;
  toolCalls: number;
  maxIterations: number;
  safetyLimit: number;
  extraBudget: number;
}): Promise<LimitContinuationOutcome> {
  const continuationId = `cnt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAt = new Date().toISOString();
  const payload: PendingLimitContinuation = {
    continuationId,
    limitKind: input.limitKind,
    iterations: input.iterations,
    toolCalls: input.toolCalls,
    maxIterations: input.maxIterations,
    safetyLimit: input.safetyLimit,
    extraBudget: input.extraBudget,
    requestedAt,
  };

  void emitEvent({
    taskId: input.taskId,
    type: 'task.limit.continuation_required',
    source: 'runtime',
    message: `Safety limit reached (${input.limitKind}) — asking the operator whether to continue with +${input.extraBudget} more steps/tool-calls.`,
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
          message: `Safety-limit continuation question timed out after 5 minutes — the task ends with limit_reached (the runtime never grows its own budget unattended).`,
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
    void emitEvent({
      taskId: entry.taskId,
      type: 'task.limit.continued',
      source: 'user',
      message: `Operator CONTINUED past the safety limit: maxIterations ${entry.maxIterations} → ${entry.maxIterations + entry.extraBudget}, safetyLimit ${entry.safetyLimit} → ${entry.safetyLimit + entry.extraBudget}.`,
      data: {
        continuationId,
        limitKind: entry.limitKind,
        newMaxIterations: entry.maxIterations + entry.extraBudget,
        newSafetyLimit: entry.safetyLimit + entry.extraBudget,
        extraBudget: entry.extraBudget,
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
    message: `Operator DENIED the safety-limit continuation — the task ends with limit_reached.`,
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
