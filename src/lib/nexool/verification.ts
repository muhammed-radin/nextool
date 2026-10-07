/**
 * NexTool v1.0.13 — the VERIFICATION LATCH.
 *
 * A tool flagged `verificationLatch: true` pauses AFTER completing: the
 * executor holds the execution open until the operator VERIFIES the result
 * in the console. This is the human-in-the-loop QUALITY GATE of the operator
 * console — it reviews RESULTS, not intentions (approval §9 gates execution
 * BEFORE it; the latch reviews the outcome AFTER it).
 *
 * Resolution outcomes:
 *  - verified  → the execution completes normally (its result flows to the
 *                planner/observer exactly as an unlatched result would).
 *  - rejected  → the execution is flipped to `failed` with the structured
 *                error VERIFICATION_REJECTED; the planner observes the
 *                rejection like any other tool failure (and the optional
 *                operator feedback becomes an observer event).
 *  - timeout   → AUTO-VERIFIED with an honest warning event. The latch is a
 *                review gate, deliberately NOT a security gate: an absent
 *                operator never destroys automation by walking away (this is
 *                the documented difference from approval §9.7, where a
 *                timeout STOPS the task).
 *  - cancelled → task stop/pause while waiting; the execution completes as
 *                cancelled (CANCELLED), matching §9.9 semantics.
 *
 * Registry + events mirror the approval module: tool.verification.required /
 * .verified / .rejected / .timeout, 5-minute window, per-task flush on stop.
 * Events carry { verificationId, executionId, tool, resultSummary, ... }.
 */

import { emitEvent } from './eventbus';

/** Verification wait window (mirrors APPROVAL_TIMEOUT_MS). */
export const VERIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

export type VerificationOutcome = 'verified' | 'rejected' | 'timeout' | 'cancelled';

export interface PendingVerification {
  verificationId: string;
  tool: string;
  /** Result summary offered to the operator (JSON-capped preview). */
  resultSummary?: string;
  requestedAt: string;
}

interface PendingVerificationEntry extends PendingVerification {
  taskId: string;
  executionId: string;
  resolve: (outcome: VerificationOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as { __nextoolVerifications?: Map<string, PendingVerificationEntry> };

function verificationRegistry(): Map<string, PendingVerificationEntry> {
  if (!g.__nextoolVerifications) g.__nextoolVerifications = new Map();
  return g.__nextoolVerifications;
}

/** Compact, UI-safe result preview (never the full payload). */
export function summarizeResult(result: unknown): string {
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else {
    try {
      text = JSON.stringify(result) ?? String(result);
    } catch {
      text = String(result);
    }
  }
  return text.length > 600 ? `${text.slice(0, 600)}… (+${text.length - 600} chars)` : text;
}

/** List pending verifications (optionally scoped to a task) — powers the console UI. */
export function listPendingVerifications(taskId?: string): (PendingVerification & { executionId: string })[] {
  const now = Date.now();
  const out: (PendingVerification & { executionId: string })[] = [];
  for (const [id, entry] of verificationRegistry()) {
    if (now - Date.parse(entry.requestedAt) > VERIFICATION_TIMEOUT_MS + 1000) {
      clearTimeout(entry.timer);
      verificationRegistry().delete(id);
      continue;
    }
    if (taskId && entry.taskId !== taskId) continue;
    const { taskId: _t, resolve: _r, timer: _timer, ...rest } = entry;
    void _t; void _r; void _timer;
    out.push(rest);
  }
  return out;
}

/**
 * Raise a verification request for a COMPLETED execution and WAIT.
 * Resolves with the operator's outcome (timeout auto-verifies).
 */
export function requestVerification(input: {
  taskId: string;
  executionId: string;
  tool: string;
  resultSummary?: string;
}): Promise<VerificationOutcome> {
  const verificationId = `ver_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAt = new Date().toISOString();
  const payload: PendingVerification = {
    verificationId,
    tool: input.tool,
    resultSummary: input.resultSummary,
    requestedAt,
  };

  void emitEvent({
    taskId: input.taskId,
    type: 'tool.verification.required',
    source: 'tool',
    message: `Verification required for ${input.tool} result (execution held open).`,
    data: { ...payload, executionId: input.executionId },
    priority: 2,
  });

  return new Promise<VerificationOutcome>((resolve) => {
    const entry: PendingVerificationEntry = {
      ...payload,
      taskId: input.taskId,
      executionId: input.executionId,
      resolve,
      timer: setTimeout(() => {
        verificationRegistry().delete(verificationId);
        // The latch is a review gate, not a security gate: a timed-out
        // verification AUTO-VERIFIES with an honest warning event.
        void emitEvent({
          taskId: input.taskId,
          type: 'tool.verification.timeout',
          source: 'runtime',
          message: `Verification for ${input.tool} timed out after 5 minutes — auto-verified so the task is never destroyed by an absent operator (review gate, not a security gate).`,
          data: { verificationId, tool: input.tool, executionId: input.executionId, autoVerified: true },
          priority: 3,
        });
        resolve('timeout');
      }, VERIFICATION_TIMEOUT_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    verificationRegistry().set(verificationId, entry);
  });
}

/**
 * Resolve a pending verification from the console UI. Returns false when
 * unknown/expired. Optional feedback (on rejection) becomes an observer event.
 */
export async function resolveVerification(
  verificationId: string,
  accepted: boolean,
  feedback?: string,
): Promise<boolean> {
  const entry = verificationRegistry().get(verificationId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  verificationRegistry().delete(verificationId);

  if (accepted) {
    void emitEvent({
      taskId: entry.taskId,
      type: 'tool.verification.verified',
      source: 'user',
      message: `Operator verified the ${entry.tool} result.`,
      data: { verificationId, tool: entry.tool, executionId: entry.executionId },
      priority: 4,
    });
    entry.resolve('verified');
    return true;
  }

  void emitEvent({
    taskId: entry.taskId,
    type: 'tool.verification.rejected',
    source: 'user',
    message: `Operator REJECTED the ${entry.tool} result — the execution is recorded as failed (VERIFICATION_REJECTED).`,
    data: { verificationId, tool: entry.tool, executionId: entry.executionId },
    priority: 2,
  });
  const trimmed = feedback?.trim();
  if (trimmed) {
    void emitEvent({
      taskId: entry.taskId,
      type: 'observer.feedback_applied',
      source: 'user',
      message: `Verification feedback: ${trimmed.slice(0, 300)}`,
      data: { verificationId, tool: entry.tool, verificationFeedback: trimmed.slice(0, 2000) },
      priority: 3,
    });
  }
  entry.resolve('rejected');
  return true;
}

/** Flush every pending verification for a task (task stop/pause transitions). */
export function cancelPendingVerificationsForTask(taskId: string): void {
  for (const [id, entry] of verificationRegistry()) {
    if (entry.taskId !== taskId) continue;
    clearTimeout(entry.timer);
    verificationRegistry().delete(id);
    entry.resolve('cancelled');
  }
}
