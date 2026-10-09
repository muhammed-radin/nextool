/**
 * NexTool v1.0.11 — PRE-PLAN FAILURE RECOVERY (spec §1–§15, "THE EMPOWERMENT").
 *
 * When a PRE-PLAN step fails or produces an unexpected/unusable result, the
 * runtime no longer blind-retries once and hard-stops. Instead:
 *
 *   MAIN GOAL → PRE-PLAN → STEP n FAILS
 *        ↓
 *   STOP NORMAL PLAN TEMPORARILY (main plan is FROZEN — step n+1 is NOT run)
 *        ↓
 *   OBSERVE FAILURE → CREATE RECOVERY SUBGOAL
 *        ↓
 *   PRE-PLAN THE RECOVERY SUBGOAL (the SAME pre-plan strategy)
 *        ↓
 *   EXECUTE RECOVERY STEPS → VERIFY (Observer is the authority)
 *        ↓
 *   SUCCESS → restore main plan (state-aware) → CONTINUE
 *   FAILURE → retry/ replan recovery up to task.recoveryMaxAttempts (2..4, default 4)
 *   EXHAUSTED / UNRECOVERABLE → end the task honestly
 *
 * Attempt definition (§9): ONE attempt = observe failure → create/revise the
 * recovery subgoal → pre-plan recovery → execute the recovery plan → verify.
 * UI refreshes, SSE replays, status polling and ordinary planner events never
 * increment the counter.
 *
 * Scope: PRE-PLAN only (§15). The v1.0.10 one-by-one planner already replans
 * from the latest state after every failure and is untouched. Live Mode keeps
 * its v1.0.9 repair passes. Task-level safeguards (task timeout, safetyLimit,
 * stop/pause/abort, approval gates) all remain active during recovery.
 *
 * This module receives a narrow "host" surface from loop.ts (decision
 * execution, recording, persistence, goal verification) — no circular
 * imports, one implementation, used by exactly one call site.
 */

import { emitEvent } from '../eventbus';
import { buildPlan } from './planner';
import { assessRecovery } from './observer';
import { getResolvedLimits } from '../config-limits';
import type { MainState, PlanStep, TaskRecoveryState, ToolDefinition, ToolExecution } from '../types';

/** v1.0.11 — a recovery pre-plan is deliberately SMALL: the goal is to unblock
 *  the failed step, not to re-accomplish the whole task.
 *  v1.1.0 — the cap is the configurable `planner.recoveryMaxPlanSteps`
 *  central limit (previously the hard-coded 4); the export keeps the legacy
 *  name as the documented fallback when the limits file is unreadable. */
export const RECOVERY_PLAN_MAX_STEPS = 4;

/** v1.1.0 — resolve the recovery plan cap from the central limits. */
export function recoveryPlanMaxSteps(): number {
  try {
    return getResolvedLimits().planner.recoveryMaxPlanSteps;
  } catch {
    return RECOVERY_PLAN_MAX_STEPS;
  }
}

export interface RecoveryFailureInput {
  /** Main-plan step id (undefined when a dynamic-subgoal action failed). */
  failedStepId?: string;
  failedStepTitle: string;
  failedStepDetail?: string;
  failedTool?: string;
  failureStatus: string;
  failureMessage: string;
}

export type RecoveryOutcome =
  | { kind: 'resumed'; resumeNote: string; satisfiedStep: boolean }
  | { kind: 'completed'; summary: string }
  | {
      kind: 'aborted';
      statusDetail: string;
      errorCode: 'RECOVERY_EXHAUSTED' | 'RECOVERY_UNRECOVERABLE' | 'RECOVERY_BLOCKED';
    };

/** Narrow surface of loop.ts the recovery engine drives. */
export interface RecoveryHost {
  taskId: string;
  request: string;
  goal: string;
  toolDefs: ToolDefinition[];
  reasoningLevel: number;
  /** v1.0.11 — central task.recoveryMaxAttempts limit resolved for this task
   *  (2..4, default 4). Never hard-coded at the call site (spec §8). */
  recoveryMaxAttempts: number;
  /** v1.1.0 — the task's AbortSignal: a force-stop unblocks the recovery
   *  assessment LLM call instead of leaving it dangling. */
  signal?: AbortSignal;
  state: MainState;
  /** Completed recovery cycles per failed-step key (§9 attempt counting) —
   *  in-memory on the task run, persists across separate recovery entries. */
  recoveryAttempts: Map<string, number>;
  decideAndExecute(objective: string, overrides?: { lastObservation?: string }): Promise<{ decision: { status: string; reason?: string; confidence?: number }; result?: { execution: ToolExecution; observation: string } }>;
  recordExecution(tool: string, result: { execution: ToolExecution; observation: string }): void;
  persistState(): Promise<void>;
  verifyGoal(): Promise<boolean>;
  blockedStopReason(): string | null;
  /** v1.0.11 — recovery pre-plan hook (defaults to the shared buildPlan;
   *  injectable so tests exercise the recovery state machine without the LLM). */
  planRecovery?(request: string, goal: string, toolDefs: ToolDefinition[], reasoningLevel: number, taskId: string, maxSteps: number): Promise<{ steps: Omit<PlanStep, 'id' | 'status'>[]; goal: string }>;
}

function truncate(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function recoveryStepId(attempt: number, i: number): string {
  return `recovery_${attempt}_${i + 1}`;
}

/** The failed step's objective may already be satisfied by the recovery
 *  actions (§7) — the re-evaluation decides between mark-completed and
 *  re-queue instead of blindly continuing at the array index. */
function markStepSatisfied(host: RecoveryHost, failedStepId: string | undefined, attempt: number): void {
  if (!failedStepId) return;
  const step = host.state.plan.find((s) => s.id === failedStepId);
  if (!step) return;
  step.status = 'completed';
  const attribution = ` — resolved by recovery attempt ${attempt}`;
  step.detail = truncate(`${step.detail ?? ''}${attribution}`, 400);
}

function requeueStep(host: RecoveryHost, failedStepId: string | undefined): void {
  if (!failedStepId) return;
  const step = host.state.plan.find((s) => s.id === failedStepId);
  if (!step) return;
  // Re-queue AT ITS ORIGINAL POSITION — the main plan stays frozen around it;
  // completed steps are never repeated (§6), later steps never run first (§4).
  step.status = 'pending';
}

function setRecoveryState(host: RecoveryHost, patch: Partial<TaskRecoveryState> & { status: TaskRecoveryState['status'] }): TaskRecoveryState {
  const now = new Date().toISOString();
  const next: TaskRecoveryState = {
    reason: '',
    attempt: 0,
    maxAttempts: 0,
    steps: [],
    startedAt: now,
    updatedAt: now,
    ...host.state.recovery,
    ...patch,
  };
  next.updatedAt = now;
  host.state.recovery = next;
  return next;
}

/**
 * Run the bounded recovery flow for ONE failed pre-plan step. NEVER throws —
 * the outcome object is the single source of truth for the caller.
 */
export async function runPrePlanRecovery(
  host: RecoveryHost,
  failure: RecoveryFailureInput,
): Promise<RecoveryOutcome> {
  const maxAttempts = Math.max(2, Math.min(4, host.recoveryMaxAttempts || 4));
  const attemptKey = failure.failedStepId ?? `dynamic:${host.state.activeSubgoal?.id ?? 'action'}`;
  // attemptsUsed counts COMPLETED recovery cycles for THIS failed step (§9).
  // The map persists across separate recovery entries (re-queued step fails
  // again → next attempt), so the bound is real.
  const attemptsUsed = host.recoveryAttempts.get(attemptKey) ?? 0;
  const reason = truncate(
    `${failure.failedTool ?? 'tool'} ${failure.failureStatus}: ${failure.failureMessage || 'unexpected result'}`,
    300,
  );

  // Preserve the main plan's active subgoal — restored when the main plan resumes.
  const prevActiveSubgoal = host.state.activeSubgoal;

  for (let attempt = attemptsUsed + 1; attempt <= maxAttempts; attempt++) {
    // A meaningful recovery cycle starts — count it (§9: observe → subgoal →
    // pre-plan → execute → verify; UI refreshes/SSE never increment this).
    host.recoveryAttempts.set(attemptKey, attempt);
    // §2 — STOP NORMAL PLAN TEMPORARILY: the caller froze the loop; publish
    // the recovery subgoal + its own pre-plan.
    const subgoal = {
      id: `rec_${Date.now().toString(36)}_${attempt}_${Math.random().toString(36).slice(2, 6)}`,
      title: truncate(`Recover from failed step: ${failure.failedStepTitle}`, 200),
      reason: truncate(`Recovery attempt ${attempt}/${maxAttempts} — ${reason}`, 300),
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    };
    host.state.subgoals.push(subgoal);
    host.state.activeSubgoal = subgoal;

    setRecoveryState(host, {
      status: 'recovering',
      reason,
      failedStepId: failure.failedStepId,
      failedStepTitle: truncate(failure.failedStepTitle, 200),
      attempt,
      maxAttempts,
      subgoalId: subgoal.id,
      steps: [],
      resumeNote: undefined,
    });

    void emitEvent({
      taskId: host.taskId,
      type: 'planner.recovery_started',
      source: 'planner',
      message: `Recovery started (attempt ${attempt}/${maxAttempts}) for "${truncate(failure.failedStepTitle, 80)}" — main plan paused.`,
      data: {
        failedStepId: failure.failedStepId,
        failedStepTitle: truncate(failure.failedStepTitle, 200),
        failedTool: failure.failedTool,
        attempt,
        maxAttempts,
        reason,
      },
      priority: 3,
    });
    await host.persistState();

    // §5 — the recovery subgoal uses the SAME pre-plan strategy (buildPlan,
    // or the host-injected planner in tests).
    const recoveryRequest = [
      'RECOVERY SUBGOAL — recover from a failed step so the main task can continue.',
      `Main goal: ${host.goal}`,
      `Failed step: "${truncate(failure.failedStepTitle, 200)}"${failure.failedStepDetail ? ` (${truncate(failure.failedStepDetail, 300)})` : ''}`,
      `Failure: ${reason}`,
      `Plan the MINIMAL recovery actions: inspect the current state, apply an alternate path, verify the result. At most ${recoveryPlanMaxSteps()} steps.`,
    ].join('\n');

    const plan = host.planRecovery
      ? await host.planRecovery(recoveryRequest, subgoal.title, host.toolDefs, host.reasoningLevel, host.taskId, recoveryPlanMaxSteps())
      : await buildPlan(
        recoveryRequest,
        subgoal.title,
        host.toolDefs,
        host.reasoningLevel,
        host.taskId,
        recoveryPlanMaxSteps(),
      );
    const recoverySteps: PlanStep[] = plan.steps.map((s, i) => ({
      ...s,
      id: recoveryStepId(attempt, i),
      status: 'pending',
    }));

    setRecoveryState(host, { status: 'recovering', attempt, maxAttempts, steps: recoverySteps, subgoalId: subgoal.id });
    void emitEvent({
      taskId: host.taskId,
      type: 'planner.recovery_plan_built',
      source: 'planner',
      message: `Recovery pre-plan built: ${recoverySteps.length} step(s) (attempt ${attempt}/${maxAttempts}).`,
      data: {
        attempt,
        maxAttempts,
        subgoalId: subgoal.id,
        steps: recoverySteps.map((s) => ({ id: s.id, title: s.title, kind: s.kind })),
      },
      priority: 4,
    });
    void emitEvent({
      taskId: host.taskId,
      type: 'planner.recovery_attempt',
      source: 'planner',
      message: `Recovery attempt ${attempt}/${maxAttempts} executing (${recoverySteps.length} step(s)).`,
      data: { attempt, maxAttempts, stepCount: recoverySteps.length },
      priority: 4,
    });
    await host.persistState();

    // Execute the recovery pre-plan sequentially (bounded: ≤ 4 steps × ≤ 4
    // attempts; every execution passes the standard approval gate).
    let planFailed = false;
    let lastObservation = '';
    for (const step of recoverySteps) {
      if (host.state.recovery) {
        host.state.recovery.updatedAt = new Date().toISOString();
      }
      step.status = 'in_progress';
      await host.persistState();

      const { decision, result } = await host.decideAndExecute(step.title, {
        lastObservation: lastObservation
          ? `Recovery context — previous recovery observation: ${lastObservation}`
          : `Recovery context — the main-plan step "${truncate(failure.failedStepTitle, 120)}" failed (${reason}).`,
      });

      const blocked = host.blockedStopReason();
      if (blocked) {
        // Approval timeout/stop during recovery — surface to the caller, which
        // ends the task as 'stopped' (§9.7 semantics preserved).
        setRecoveryState(host, { status: 'exhausted', attempt, maxAttempts, steps: recoverySteps });
        return {
          kind: 'aborted',
          statusDetail: `Recovery blocked: ${blocked}`,
          errorCode: 'RECOVERY_BLOCKED',
        };
      }

      if (decision.status === 'stop') {
        setRecoveryState(host, { status: 'exhausted', attempt, maxAttempts, steps: recoverySteps });
        return { kind: 'aborted', statusDetail: 'Stop requested during recovery.', errorCode: 'RECOVERY_BLOCKED' };
      }

      // §12 — Observer determines recoverability. A recovery step that cannot
      // even be DECIDED (missing parameters / no capable tool / no tool and
      // not informational) is unrecoverable: end immediately, do not waste
      // the remaining retry budget.
      const informationalNoTool = decision.status === 'no_tool'
        && (/no .*(registered|suitable|matching) tool|not require|informational|no tool provides/i.test(decision.reason ?? '')
          || (decision.confidence ?? 0) >= 0.6);
      if (decision.status === 'clarification_required' || decision.status === 'cannot_execute'
        || (decision.status === 'no_tool' && !informationalNoTool)) {
        const detail = truncate(decision.reason ?? decision.status, 300);
        void emitEvent({
          taskId: host.taskId,
          type: 'planner.recovery_failed',
          source: 'planner',
          message: `Recovery attempt ${attempt}/${maxAttempts} failed: ${detail}`,
          data: { attempt, maxAttempts, reason: detail, recoverable: false },
          priority: 3,
        });
        void emitEvent({
          taskId: host.taskId,
          type: 'planner.main_plan_aborted',
          source: 'planner',
          message: `Main plan aborted — recovery is unrecoverable (attempt ${attempt}/${maxAttempts}).`,
          data: { failedStepId: failure.failedStepId, attempt, maxAttempts, reason: detail },
          priority: 2,
        });
        setRecoveryState(host, { status: 'exhausted', attempt, maxAttempts, steps: recoverySteps });
        return {
          kind: 'aborted',
          statusDetail: `Recovery unrecoverable (attempt ${attempt}/${maxAttempts}): ${detail}`,
          errorCode: 'RECOVERY_UNRECOVERABLE',
        };
      }

      if (!result) {
        // defensive — treat like a failed recovery step
        planFailed = true;
        break;
      }

      host.recordExecution(result.execution.tool, result);
      lastObservation = result.observation;
      if (result.execution.status === 'failed' || result.execution.status === 'timeout') {
        step.status = 'failed';
        planFailed = true;
        void emitEvent({
          taskId: host.taskId,
          type: 'planner.recovery_failed',
          source: 'planner',
          message: `Recovery attempt ${attempt}/${maxAttempts} failed: ${result.execution.tool} ${result.execution.status}.`,
          data: {
            attempt,
            maxAttempts,
            tool: result.execution.tool,
            error: result.execution.error?.message ?? result.execution.status,
            recoverable: true,
          },
          priority: 3,
        });
        await host.persistState();
        break;
      }
      step.status = 'completed';
      await host.persistState();
    }

    if (planFailed) {
      // §11 — attempt consumed; the next loop iteration builds a REVISED
      // recovery subgoal/pre-plan with the newest observations in context.
      host.state.activeSubgoal = prevActiveSubgoal;
      setRecoveryState(host, { status: 'recovering', attempt, maxAttempts, steps: recoverySteps });
      await host.persistState();
      continue;
    }

    // All recovery steps completed → VERIFY (§10 — the Observer is the
    // authority; HTTP-200/completed status alone is not sufficient).
    if (await host.verifyGoal()) {
      // The recovery also satisfied the main goal.
      void emitEvent({
        taskId: host.taskId,
        type: 'planner.recovery_succeeded',
        source: 'planner',
        message: `Recovery succeeded (attempt ${attempt}/${maxAttempts}) — main goal verified.`,
        data: { attempt, maxAttempts, failedStepId: failure.failedStepId, outcome: 'goal_reached' },
        priority: 3,
      });
      setRecoveryState(host, {
        status: 'resumed',
        attempt,
        maxAttempts,
        steps: recoverySteps,
        resumeNote: 'Main goal verified after recovery.',
      });
      return { kind: 'completed', summary: host.state.lastObservation ?? 'Goal verified after recovery.' };
    }

    const assessment = await assessRecovery(
      {
        stepTitle: failure.failedStepTitle,
        stepDetail: failure.failedStepDetail,
        failure: reason,
        recoverySteps: recoverySteps.map((s) => ({ title: s.title, status: s.status })),
        observations: host.state.observations.slice(-4).map((o) => o.message),
      },
      host.reasoningLevel,
      host.taskId,
      host.signal,
    );

    if (!assessment.recoverable) {
      void emitEvent({
        taskId: host.taskId,
        type: 'planner.recovery_failed',
        source: 'planner',
        message: `Recovery attempt ${attempt}/${maxAttempts} failed: ${assessment.reason}`,
        data: { attempt, maxAttempts, reason: assessment.reason, recoverable: false },
        priority: 3,
      });
      void emitEvent({
        taskId: host.taskId,
        type: 'planner.main_plan_aborted',
        source: 'planner',
        message: `Main plan aborted — the Observer determined the task cannot safely continue.`,
        data: { failedStepId: failure.failedStepId, attempt, maxAttempts, reason: assessment.reason },
        priority: 2,
      });
      setRecoveryState(host, { status: 'exhausted', attempt, maxAttempts, steps: recoverySteps });
      return {
        kind: 'aborted',
        statusDetail: `Recovery unrecoverable (attempt ${attempt}/${maxAttempts}): ${assessment.reason}`,
        errorCode: 'RECOVERY_UNRECOVERABLE',
      };
    }

    // §10 — success = failed condition resolved OR the main goal can safely
    // continue. §6/§7 — resume state-aware: mark the step satisfied when the
    // Observer resolved it, otherwise re-queue it for real re-execution
    // (completed steps are never repeated; later steps never jump ahead).
    if (assessment.resolved && failure.failedStepId) {
      markStepSatisfied(host, failure.failedStepId, attempt);
    } else if (failure.failedStepId) {
      requeueStep(host, failure.failedStepId);
    }
    host.state.activeSubgoal = prevActiveSubgoal;
    const resumeNote = assessment.resolved
      ? `Failed step ${assessment.resolved && failure.failedStepId ? 'satisfied' : 'resolved'} by recovery attempt ${attempt} — main plan resumed.`
      : `Failed step re-queued after recovery attempt ${attempt} — main plan resumed (re-execution verifies).`;
    void emitEvent({
      taskId: host.taskId,
      type: 'planner.recovery_succeeded',
      source: 'planner',
      message: `Recovery succeeded (attempt ${attempt}/${maxAttempts}) — ${assessment.reason}`,
      data: {
        attempt,
        maxAttempts,
        failedStepId: failure.failedStepId,
        outcome: assessment.resolved ? 'resolved' : 'main_goal_can_continue',
        engine: assessment.engine,
      },
      priority: 3,
    });
    void emitEvent({
      taskId: host.taskId,
      type: 'planner.main_plan_resumed',
      source: 'planner',
      message: resumeNote,
      data: { failedStepId: failure.failedStepId, attempt, maxAttempts, requeued: !assessment.resolved },
      priority: 4,
    });
    setRecoveryState(host, {
      status: 'resumed',
      attempt,
      maxAttempts,
      steps: recoverySteps,
      resumeNote,
    });
    await host.persistState();
    return { kind: 'resumed', resumeNote, satisfiedStep: assessment.resolved };
  }

  // §11 — attempts exhausted: observe the final failure, record the useful
  // final state, terminate the task honestly.
  const exhaustedNote = `Recovery failed — attempts: ${maxAttempts}/${maxAttempts}. The main task ended because the failed step ("${truncate(failure.failedStepTitle, 80)}") could not be recovered. Last failure: ${reason}`;
  void emitEvent({
    taskId: host.taskId,
    type: 'planner.recovery_exhausted',
    source: 'planner',
    message: `Recovery exhausted after ${maxAttempts} attempts — ending the task honestly.`,
    data: { failedStepId: failure.failedStepId, attempts: maxAttempts, maxAttempts, reason },
    priority: 2,
  });
  void emitEvent({
    taskId: host.taskId,
    type: 'planner.main_plan_aborted',
    source: 'planner',
    message: 'Main plan aborted — recovery attempts exhausted.',
    data: { failedStepId: failure.failedStepId, attempts: maxAttempts, maxAttempts },
    priority: 2,
  });
  setRecoveryState(host, { status: 'exhausted', attempt: maxAttempts, maxAttempts });
  return {
    kind: 'aborted',
    statusDetail: exhaustedNote,
    errorCode: 'RECOVERY_EXHAUSTED',
  };
}
