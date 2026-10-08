/**
 * NexTool v1.0.6 — Tool Auto-Execution Approval (spec §9).
 * v1.0.11 — the resolution becomes an EXPLICIT HIERARCHY (§34–§42):
 *
 *   1. GLOBAL auto-execution (Settings)   — highest priority
 *   2. TOOL auto-execution (Create/Edit)  — overrides the task console
 *   3. TASK CONSOLE preference            — lowest task-specific preference
 *   4. default OFF                        — approval required
 *
 * Global ENABLED forces auto-execution for every tool regardless of the
 * lower layers. When global does not force the enable, the tool config wins
 * over the task console; the task console never overrides a higher layer.
 * One centralized resolver (resolveAutoExecution) produces the decision AND
 * its effective source; every auto-execution decision in the runtime goes
 * through it (no accidental boolean merging).
 *
 * An approval is a runtime event (§9.14): tool.approval.required →
 * allowed/skipped/denied/timeout → tool.execution.blocked on rejection.
 * v1.0.15 §31-§36 — THREE operator choices: [Skip] [Reject] [Accept] with
 * the explicit state machine pending → accepted | skipped | rejected
 * (+ cancelled on task stop):
 *   - ACCEPT  → the tool executes normally and the plan continues.
 *   - SKIP    → the tool does NOT execute; the execution is recorded as
 *               `skipped` and the plan continues to the next logical step —
 *               the planner receives "Tool X was skipped by the user".
 *               A skip is NOT a denial: it never burns the denial ladder.
 *   - REJECT  → the tool is blocked (v1.0.13 denial/recovery ladder; the
 *               planner must revise the plan or stop, never repeat the
 *               rejected action).
 * The waiting tool does NOT continue automatically to dependent or
 * sequential steps — the task parks in `awaiting_approval` until the user
 * decides.
 *
 * Timeout (§9.7): 5 minutes. No decision ⇒ the TASK STOPS — a timeout never
 * silently executes the tool (§9.11).
 */

import { emitEvent } from './eventbus';
import type { NexToolSettings, TaskConfig, ToolDefinition, PendingApproval } from './types';

/** §9.7 — maximum approval waiting time. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * v1.0.13 §10 — tools that must ALWAYS collect an explicit user confirmation
 * before execution, regardless of the auto-execution hierarchy (global ON,
 * tool ON or task ON never bypass this). fs.cmd executes host shell commands
 * — §10/§19 make explicit user confirmation a product requirement, so the
 * task gate refuses the auto-execution shortcut for these tools and the
 * handler keeps a second gate for subtool/test contexts.
 */
export const FORCE_APPROVAL_TOOLS: ReadonlySet<string> = new Set(['fs.cmd']);

export type ApprovalOutcome = 'allowed' | 'denied' | 'skipped' | 'timeout' | 'cancelled';

/** v1.0.11 §38 — where an auto-execution decision came from. */
export type AutoExecutionSource = 'global' | 'tool' | 'task' | 'default';

export interface AutoExecutionDecision {
  enabled: boolean;
  source: AutoExecutionSource;
}

/**
 * v1.0.11 §34–§39 — THE one auto-execution resolver. Precedence:
 *   1. global === true                      → { enabled: true,  source: 'global' }
 *   2. tool === true                        → { enabled: true,  source: 'tool' }
 *   3. task === true                        → { enabled: true,  source: 'task' }
 *   4. otherwise                            → { enabled: false, source: 'default' }
 *
 * `undefined` (inherit / not set) never forces a decision. A lower layer can
 * NEVER override a higher-priority enable. Test matrix (§39):
 *   Global ON  / Tool OFF / Task OFF → ON  (global)
 *   Global ON  / Tool ON  / Task OFF → ON  (global)
 *   Global OFF / Tool ON  / Task OFF → ON  (tool)
 *   Global OFF / Tool OFF / Task ON  → ON  (task)
 *   Global OFF / Tool OFF / Task OFF → OFF (default)
 */
export function resolveAutoExecution(
  global: boolean | undefined,
  tool: boolean | undefined,
  task: boolean | undefined,
): AutoExecutionDecision {
  if (global === true) return { enabled: true, source: 'global' };
  if (tool === true) return { enabled: true, source: 'tool' };
  if (task === true) return { enabled: true, source: 'task' };
  return { enabled: false, source: 'default' };
}

/**
 * §9.4 — back-compat boolean view over resolveAutoExecution (same signature
 * as v1.0.6). The runtime itself uses resolveAutoExecution so the effective
 * source stays observable; tests share this single interpretation.
 */
export function resolveAutoExecute(
  tool: Pick<ToolDefinition, 'autoExecute'>,
  taskConfig: Pick<TaskConfig, 'autoExecuteTools'> | undefined,
  settings: Pick<NexToolSettings, 'autoExecuteTools'>,
): boolean {
  return resolveAutoExecution(
    settings.autoExecuteTools,
    tool.autoExecute,
    taskConfig?.autoExecuteTools,
  ).enabled;
}

interface PendingApprovalEntry extends PendingApproval {
  taskId?: string;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  /** v1.0.13 §13 — user-supplied denial feedback (reason), when provided. */
  feedback?: string;
}

const g = globalThis as unknown as { __nextoolApprovals?: Map<string, PendingApprovalEntry> };

function approvalRegistry(): Map<string, PendingApprovalEntry> {
  if (!g.__nextoolApprovals) g.__nextoolApprovals = new Map();
  return g.__nextoolApprovals;
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
    const { taskId: _t, resolve: _r, timer: _timer, feedback: _f, ...rest } = entry;
    void _t; void _r; void _timer; void _f;
    out.push({ ...rest, state: rest.state ?? 'pending' });
  }
  return out;
}

/** §9.5 — raise an approval request and WAIT. Never auto-continues.
 *  v1.0.13 §13 — the resolution also carries the user's OPTIONAL denial
 *  feedback (reason) so the escalation flow can understand the rejection.
 *  taskId is optional: handler-level gates (subtool/test contexts) may have
 *  no task — a fabricated id would violate the taskEvent FK on persist. */
export function requestApproval(input: {
  taskId?: string;
  tool: string;
  params: Record<string, unknown>;
  purpose?: string;
  reason?: string;
  description?: string;
  environment?: string;
  subgoal?: string;
}): Promise<{ outcome: ApprovalOutcome; feedback?: string }> {
  const approvalId = `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const requestedAt = new Date().toISOString();
  const payload: PendingApproval = {
    approvalId,
    tool: input.tool,
    params: input.params,
    purpose: input.purpose,
    reason: input.reason,
    description: input.description,
    environment: input.environment,
    state: 'pending',
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

  return new Promise<{ outcome: ApprovalOutcome; feedback?: string }>((resolve) => {
    const entry: PendingApprovalEntry = {
      ...payload,
      taskId: input.taskId,
      resolve: (outcome) => resolve({ outcome, feedback: entry.feedback }),
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
        resolve({ outcome: 'timeout' });
      }, APPROVAL_TIMEOUT_MS),
    };
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    approvalRegistry().set(approvalId, entry);
  });
}

/**
 * Resolve a pending approval from the console UI (§9.6/§9.8/§9.9).
 * v1.0.15 §31-§34 — decisions: 'allow' (ACCEPT — execute + continue),
 * 'skip' (SKIP — do not execute, record `skipped`, continue to the next
 * logical step; the planner is told via the outcome), 'deny' (REJECT —
 * blocked, v1.0.13 denial/recovery ladder). Denial/skip feedback (optional)
 * becomes a runtime feedback event.
 */
export async function resolveApproval(
  approvalId: string,
  decision: 'allow' | 'deny' | 'skip',
  feedback?: string,
): Promise<boolean> {
  const entry = approvalRegistry().get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  approvalRegistry().delete(approvalId);

  const trimmed = feedback?.trim();
  if (trimmed) {
    entry.feedback = trimmed.slice(0, 2000);
  }

  if (decision === 'allow') {
    entry.state = 'accepted';
    void emitEvent({
      taskId: entry.taskId,
      type: 'tool.approval.allowed',
      source: 'user',
      message: `User approved execution of ${entry.tool}.`,
      data: { approvalId, tool: entry.tool, state: 'accepted' },
      priority: 3,
    });
    entry.resolve('allowed');
    return true;
  }

  if (decision === 'skip') {
    // v1.0.15 §33 — SKIP: do not execute, record the skip observably, and
    // let the plan continue. NOT a denial (the escalation ladder is not
    // burned) and NOT a silent drop (the planner receives the skip).
    entry.state = 'skipped';
    void emitEvent({
      taskId: entry.taskId,
      type: 'tool.approval.skipped',
      source: 'user',
      message: `Tool ${entry.tool} was skipped by the user — the plan continues with the next logical step.`,
      data: { approvalId, tool: entry.tool, state: 'skipped' },
      priority: 3,
    });
    if (entry.feedback) {
      void emitEvent({
        taskId: entry.taskId,
        type: 'observer.feedback_applied',
        source: 'user',
        message: `Skip feedback: ${entry.feedback.slice(0, 300)}`,
        data: { approvalId, tool: entry.tool, skipFeedback: entry.feedback },
        priority: 3,
      });
    }
    entry.resolve('skipped');
    return true;
  }

  // decision === 'deny' → REJECT (§34): the execution is blocked; the
  // v1.0.13 denial/recovery ladder decides retry vs plan change vs stop.
  entry.state = 'rejected';
  void emitEvent({
    taskId: entry.taskId,
    type: 'tool.approval.denied',
    source: 'user',
    message: `User rejected execution of ${entry.tool}.`,
    data: { approvalId, tool: entry.tool, state: 'rejected' },
    priority: 2,
  });
  void emitEvent({
    taskId: entry.taskId,
    type: 'tool.execution.blocked',
    source: 'runtime',
    message: `${entry.tool} execution blocked: rejected by user.`,
    data: { approvalId, tool: entry.tool, cause: 'user_denied', state: 'rejected' },
    priority: 2,
  });
  // §9.9 — optional user feedback after rejection → feedback event → context
  if (entry.feedback) {
    void emitEvent({
      taskId: entry.taskId,
      type: 'observer.feedback_applied',
      source: 'user',
      message: `Denial feedback: ${entry.feedback.slice(0, 300)}`,
      data: { approvalId, tool: entry.tool, denialFeedback: entry.feedback },
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
    entry.state = 'cancelled';
    entry.resolve('cancelled');
  }
}
