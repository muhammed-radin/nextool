/**
 * NexTool v1.0.6 — Tool Auto-Execution Approval (spec §9).
 *
 * Resolution precedence (§9.4) — ONE model, enforced here, consumed by the
 * runtime loop (never a separate frontend interpretation):
 *
 *   Global Setting (settings.autoExecuteTools)
 *       ↓ true  → every tool executes automatically
 *       ↓ false → Per-Task configuration (config.autoExecuteTools)
 *                 ↓ true  → tools in this task execute automatically
 *                 ↓ false → Per-Tool configuration (tool.autoExecute, default false)
 *                           ↓ false → APPROVAL REQUIRED → WAIT
 *
 * An approval is a runtime event (§9.14): tool.approval.required →
 * allowed/denied/timeout → tool.execution.blocked on rejection. The waiting
 * tool does NOT continue automatically to dependent or sequential steps —
 * the task parks in `awaiting_approval` until the user decides.
 *
 * Timeout (§9.7): 5 minutes. No decision ⇒ the TASK STOPS — a timeout never
 * silently executes the tool (§9.11).
 */

import { emitEvent } from './eventbus';
import type { NexToolSettings, TaskConfig, ToolDefinition, PendingApproval } from './types';

/** §9.7 — maximum approval waiting time. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export type ApprovalOutcome = 'allowed' | 'denied' | 'timeout' | 'cancelled';

interface PendingApprovalEntry extends PendingApproval {
  taskId: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const g = globalThis as unknown as { __nextoolApprovals?: Map<string, PendingApprovalEntry> };

function approvalRegistry(): Map<string, PendingApprovalEntry> {
  if (!g.__nextoolApprovals) g.__nextoolApprovals = new Map();
  return g.__nextoolApprovals;
}

/**
 * §9.4 — the single precedence resolution. Exported so the runtime and tests
 * share exactly one interpretation.
 */
export function resolveAutoExecute(
  tool: Pick<ToolDefinition, 'autoExecute'>,
  taskConfig: Pick<TaskConfig, 'autoExecuteTools'> | undefined,
  settings: Pick<NexToolSettings, 'autoExecuteTools'>,
): boolean {
  // 1) Global override
  if (settings.autoExecuteTools === true) return true;
  // 2) Per-task configuration (when explicitly set)
  if (taskConfig?.autoExecuteTools === true) return true;
  // 3) Per-tool configuration — documented default false (§9.1/§23)
  return tool.autoExecute === true;
}

/** List pending approvals (optionally scoped to a task) — powers the console UI. */
export function listPendingApprovals(taskId?: string): PendingApproval[] {
  const now = Date.now();
  const out: PendingApproval[] = [];
  for (const [id, entry] of approvalRegistry()) {
    if (now - Date.parse(entry.requestedAt) > APPROVAL_TIMEOUT_MS + 1000) {
      clearTimeout(entry.timer);
      approvalRegistry().delete(id);
      continue;
    }
    if (taskId && entry.taskId !== taskId) continue;
    const { taskId: _t, resolve: _r, timer: _timer, ...rest } = entry;
    void _t; void _r; void _timer;
    out.push(rest);
  }
  return out;
}

/** §9.5 — raise an approval request and WAIT. Never auto-continues. */
export function requestApproval(input: {
  taskId: string;
  tool: string;
  params: Record<string, unknown>;
  purpose?: string;
  reason?: string;
  subgoal?: string;
}): Promise<ApprovalOutcome> {
  const approvalId = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAt = new Date().toISOString();
  const payload: PendingApproval = {
    approvalId,
    tool: input.tool,
    params: input.params,
    purpose: input.purpose,
    reason: input.reason,
    subgoal: input.subgoal,
    requestedAt,
  };

  void emitEvent({
    taskId: input.taskId,
    type: 'tool.approval.required',
    source: 'tool',
    message: `Approval required before executing ${input.tool}.`,
    data: { ...payload },
    priority: 2,
  });

  return new Promise<ApprovalOutcome>((resolve) => {
    const entry: PendingApprovalEntry = {
      ...payload,
      taskId: input.taskId,
      resolve,
      timer: setTimeout(() => {
        approvalRegistry().delete(approvalId);
        // §9.7/§9.11 — approval timeout: the caller STOPS the task; the tool
        // is never silently executed.
        void emitEvent({
          taskId: input.taskId,
          type: 'tool.approval.timeout',
          source: 'runtime',
          message: `Approval for ${input.tool} timed out after 5 minutes — the task will stop (the tool was NOT executed).`,
          data: { approvalId, tool: input.tool },
          priority: 2,
        });
        void emitEvent({
          taskId: input.taskId,
          type: 'tool.execution.blocked',
          source: 'runtime',
          message: `${input.tool} execution blocked: approval timeout.`,
          data: { approvalId, tool: input.tool, cause: 'approval_timeout' },
          priority: 2,
        });
        resolve('timeout');
      }, APPROVAL_TIMEOUT_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    approvalRegistry().set(approvalId, entry);
  });
}

/**
 * Resolve a pending approval from the console UI (§9.6/§9.8/§9.9).
 * deny feedback (optional) becomes a runtime feedback event.
 */
export async function resolveApproval(
  approvalId: string,
  decision: 'allow' | 'deny',
  feedback?: string,
): Promise<boolean> {
  const entry = approvalRegistry().get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  approvalRegistry().delete(approvalId);

  if (decision === 'allow') {
    void emitEvent({
      taskId: entry.taskId,
      type: 'tool.approval.allowed',
      source: 'user',
      message: `User approved execution of ${entry.tool}.`,
      data: { approvalId, tool: entry.tool },
      priority: 3,
    });
    entry.resolve('allowed');
    return true;
  }

  void emitEvent({
    taskId: entry.taskId,
    type: 'tool.approval.denied',
    source: 'user',
    message: `User denied execution of ${entry.tool} — the tool is skipped.`,
    data: { approvalId, tool: entry.tool },
    priority: 2,
  });
  void emitEvent({
    taskId: entry.taskId,
    type: 'tool.execution.blocked',
    source: 'runtime',
    message: `${entry.tool} execution blocked: denied by user.`,
    data: { approvalId, tool: entry.tool, cause: 'user_denied' },
    priority: 2,
  });
  // §9.9 — optional user feedback after denial → feedback event → runtime context
  const trimmed = feedback?.trim();
  if (trimmed) {
    void emitEvent({
      taskId: entry.taskId,
      type: 'observer.feedback_applied',
      source: 'user',
      message: `Denial feedback: ${trimmed.slice(0, 300)}`,
      data: { approvalId, tool: entry.tool, denialFeedback: trimmed.slice(0, 2000) },
      priority: 3,
    });
  }
  entry.resolve('denied');
  return true;
}

/** Flush every pending approval for a task (task stop/pause transitions). */
export function cancelPendingApprovalsForTask(taskId: string): void {
  for (const [id, entry] of approvalRegistry()) {
    if (entry.taskId !== taskId) continue;
    clearTimeout(entry.timer);
    approvalRegistry().delete(id);
    entry.resolve('cancelled');
  }
}
