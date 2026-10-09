/**
 * NexTool Main Loop — Goal Mode + Live Mode orchestration.
 * UNDERSTAND → PLAN → SELECT TOOL → GENERATE PARAMS → EXECUTE → OBSERVE → UPDATE STATE → REPLAN → COMPLETE
 */
import { db } from '@/lib/db';
import { emitEvent, emitEventLifecycle } from '../eventbus';
import { getSettings } from '../settings';
import { getEnabledToolDefs } from '../tools/registry';
import { executeTool, executeParallelBatch } from '../tools/executor';
import { clampNetworkTimeoutMs } from '../tools/network-timeout';
import { decide } from '../core/coremodule';
// v1.1.0 — shared provider-call layer for the subgoal proposal (planner deadline + abort).
import { callLlm } from '../core/llm-call';
import { buildPlan, DEFAULT_PRE_PLAN_MAX_STEPS } from './planner';
import {
  buildOneByOneContext, buildOneByOneFallbackStep, planOneByOneStep,
} from './planner-strategy';
import type { PlannerType } from '../types';
import { interpret, checkGoalComplete } from './observer';
import { runPrePlanRecovery } from './recovery';
import { listServers } from '../environment';
import { resolveAutoExecution, requestApproval, FORCE_APPROVAL_TOOLS } from '../approval';
import { requestLimitContinuation } from '../limit-continuation';
// v1.1.0 §2/§3 — prior-task context for Continue Task / fork-from-recent.
import { buildPriorContext } from './task-continuity';
// v1.0.16 §10 — Skills: progressive loading (metadata discovery → selection →
// full instructions on demand). Untrusted content stays a user-level block.
import { listSkills, listSkillSummaries, loadSkillInstructions, selectSkillsForTask, renderSkillsBlock } from '../skills/registry';
import { clampToLimit, getResolvedLimits } from '../config-limits';
// v1.0.12 Phase 7 — custom task instructions (sanitize when loading from DB).
import { sanitizeInstructionsSource, MAX_COMBINED_INSTRUCTIONS_CHARS } from '../instructions';
import { recordPatternObservation, recordTaskOutcomePatterns } from '../patterns/extractor';
import type {
  MainState, PlanStep, Subgoal, TaskConfig, ToolDefinition, ToolExecution, NexToolEvent, FinalResult, QueuedLiveEvent,
} from '../types';
import type { TaskMode } from '../types';

const RESTART_SETTLE_MS = 2700;

// ---------- run handle (passed in from nexool.ts) ----------

export interface WakePayload {
  reason: 'timeout' | 'event' | 'paused';
  event?: NexToolEvent;
}

export interface TaskRunHandle {
  stopFlag: { stopped: boolean };
  abortController: AbortController;
  wake: ((payload: WakePayload) => void) | null;
  /** v1.0.6 §11 — pause is separate from stop: state stays intact. */
  pauseFlag: { paused: boolean };
  /** Resolves the paused wait on resume (set by waitWhilePaused). */
  resumeSignal: (() => void) | null;
  /** v1.0.6 §10.2 — events injected while the loop is BUSY wait here so
   *  multi-event mode never loses them (single-event mode keeps the first). */
  inbox: NexToolEvent[];
  /** v1.0.14 §2.2 — set by runTask from the resolved config: when the task
   *  has "Read & Act All Events" DISABLED, injectEvent rejects additional
   *  events while one is already pending (no hidden backlog). */
  queueingDisabled?: boolean;
  /** v1.0.14 §2.2 — true while a Live action/cycle is executing (injectEvent
   *  consults it to reject events observably when queueing is disabled). */
  actionRunning?: boolean;
}

/** v1.0.14 §13/§14 — structured trigger context for a Live cycle. Interval
 *  triggers are message-less ("time to check again" — never a fabricated
 *  event); event triggers carry the FULL event (id, type, source, message,
 *  data, priority, createdAt) so the AI observes WHAT happened. */
export type LiveTrigger =
  | { type: 'initial' }
  | { type: 'interval' }
  | { type: 'event'; event: NexToolEvent };

/** §14 — event triggers expose their full body to the decision pipeline;
 *  interval/initial triggers stay message-less by design (§13). */
export function summarizeTrigger(trigger: LiveTrigger): Record<string, unknown> {
  if (trigger.type === 'event') {
    const e = trigger.event;
    return {
      type: 'event',
      event: {
        id: e.id,
        type: e.type,
        source: e.source,
        message: e.message,
        data: e.data,
        priority: e.priority,
        createdAt: e.createdAt,
      },
    };
  }
  return { type: trigger.type };
}

// ---------- helpers ----------

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function clampNum(v: number | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** v1.0.8 §9.2 — clamp a task-config value into the CENTRAL limits' [min, max]
 *  for its property, falling back to `def` (the settings default) when absent. */
function clampLimit(section: string, key: string, v: number | undefined, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  try {
    return clampToLimit(section, key, n);
  } catch {
    return def;
  }
}

export interface ResolvedTaskConfig extends TaskConfig {
  mode: TaskConfig['mode'];
  reasoningLevel: TaskConfig['reasoningLevel'];
  useMemory: boolean;
  learnFrom: { feedback: boolean; results: boolean };
  autoExecuteSubtools: boolean;
  maxSubtoolCalls: number;
  safetyLimit: number;
  maxIterations: number;
  taskTimeoutMs: number;
  toolTimeoutMs: number;
  /** v1.0.9 §14 — task-level Network Policy request timeout (undefined =
   *  inherit tool policy → global Settings → shipped default). */
  networkTimeoutMs?: number;
  liveIntervalMs: number;
  parallelToolCalls: boolean;
  maxParallelToolCalls: number;
  /** v1.0.6 §9.4 — resolved auto-execute policy (global → task). */
  autoExecuteTools: boolean;
  /** v1.0.6 §10 — resolved multi-event policy (global → task). */
  allowMultipleEvents: boolean;
  /** v1.0.10 §13 — resolved planner strategy (task override → global default
   *  → 'pre-plan'; persisted at task creation). */
  plannerType: PlannerType;
  /** v1.0.10 §16 — resolved pre-plan step limit (1..122, default 10).
   *  Relevant to pre-plan planning only. */
  prePlanMaxSteps: number;
  /** v1.0.11 — resolved recovery attempt cap per failed pre-plan step
   *  (2..4, default 4). Pre-plan planner only. */
  recoveryMaxAttempts: number;
  /** v1.0.11 §38 — the RAW per-task auto-execute preference (undefined =
   *  not set) — the resolver needs the un-coalesced value to report the
   *  effective SOURCE (global | tool | task | default). */
  autoExecuteToolsRaw?: boolean;
  /** v1.0.11 §38 — the global Settings auto-execute value at run start. */
  autoExecuteToolsGlobal: boolean;
  /** v1.0.13 — per-task SAFETY-LIMIT CONTINUATION cap (0..5, default 1;
   *  0 disables the continuation question for this task). */
  limitContinuations: number;
  /** v1.0.13 — global continuation policy (Settings.safetyLimitContinuation). */
  limitContinuationEnabled: boolean;
  /** v1.0.13 — budget granted to BOTH limits per granted continuation
   *  (clamped into the central task.limitContinuationExtra bounds, shipped 25). */
  limitContinuationExtra: number;
  /** v1.1.0 §2/§3 — continuity identity + context seeding options. */
  continuationOfTaskId?: string;
  forkedFromTaskId?: string;
  contextOptions?: TaskConfig['contextOptions'];
  /** v1.1.0 §8 — manual skill selection + mode. */
  skills?: string[];
  skillsMode?: 'auto' | 'manual' | 'auto+manual';
  /** v1.1.0 §10 — pre-plan execute-all flag. */
  executeAllPlannedSteps?: boolean;
}

function mergeConfig(stored: Partial<TaskConfig>, settings: Awaited<ReturnType<typeof getSettings>>): ResolvedTaskConfig {
  const safetyLimit = clampLimit('task', 'safetyLimit', stored.safetyLimit, settings.safetyLimit);
  const maxSubtoolCalls = Math.min(clampLimit('task', 'maxSubtoolCalls', stored.maxSubtoolCalls, settings.maxSubtoolCalls), safetyLimit);
  const level = clampNum(stored.reasoningLevel, settings.defaultReasoningLevel, 1, 6);
  return {
    name: stored.name,
    mode: stored.mode === 'live' ? 'live' : stored.mode === 'goal' ? 'goal' : settings.defaultMode,
    reasoningLevel: level as TaskConfig['reasoningLevel'],
    enabledTools: Array.isArray(stored.enabledTools) ? stored.enabledTools.map(String) : undefined,
    useMemory: stored.useMemory ?? settings.useMemory,
    learnFrom: { feedback: stored.learnFrom?.feedback ?? true, results: stored.learnFrom?.results ?? true },
    autoExecuteSubtools: stored.autoExecuteSubtools ?? true,
    maxSubtoolCalls,
    safetyLimit,
    // v1.0.8 §9.2 — task-config clamps are resolved from the CENTRAL limits
    // (task.* metadata), no hard-coded min/max remain.
    maxIterations: clampLimit('task', 'maxIterations', stored.maxIterations, settings.maxIterations),
    taskTimeoutMs: clampLimit('task', 'taskTimeoutMs', stored.taskTimeoutMs, settings.taskTimeoutMs),
    // v1.0.7 §1 — task-level tool timeout default, ceiling = execution.timeoutMs.max.
    toolTimeoutMs: clampLimit('task', 'toolTimeoutMs', stored.toolTimeoutMs, settings.toolTimeoutMs),
    // v1.0.9 §14 — task-level Network Policy request timeout (clamped into
    // the central network.timeoutMs bounds; undefined inherits the global).
    networkTimeoutMs: stored.networkTimeoutMs !== undefined
      ? clampNetworkTimeoutMs(stored.networkTimeoutMs)
      : undefined,
    liveIntervalMs: clampLimit('task', 'liveIntervalMs', stored.liveIntervalMs, settings.liveIntervalMs),
    parallelToolCalls: stored.parallelToolCalls ?? settings.parallelToolCalls,
    maxParallelToolCalls: clampLimit('task', 'maxParallelToolCalls', stored.maxParallelToolCalls, settings.maxParallelToolCalls),
    allowMultipleEvents: stored.allowMultipleEvents ?? settings.allowMultipleEvents,
    // v1.0.10 §13 — planner strategy: stored (persisted at creation) → global
    // default → 'pre-plan'. Old tasks without the field keep working.
    plannerType: stored.plannerType === 'one-by-one' || stored.plannerType === 'pre-plan'
      ? stored.plannerType
      : settings.defaultPlannerType === 'one-by-one' ? 'one-by-one' : 'pre-plan',
    // v1.0.10 §16 — pre-plan step limit: task value (clamped 1..122) → global
    // default (10).
    prePlanMaxSteps: clampLimit('task', 'prePlanMaxSteps', stored.prePlanMaxSteps, settings.prePlanMaxSteps),
    // v1.0.11 — recovery attempt cap: task value (clamped 2..4) → global default (4).
    recoveryMaxAttempts: clampLimit('task', 'recoveryMaxAttempts', stored.recoveryMaxAttempts, settings.recoveryMaxAttempts),
    // v1.0.11 §38 — auto-execution hierarchy inputs: the RAW task preference
    // (no fallback coalescing) + the global value, resolved per execution by
    // resolveAutoExecution (global → tool → task → default).
    autoExecuteToolsRaw: stored.autoExecuteTools,
    autoExecuteToolsGlobal: settings.autoExecuteTools,
    // Back-compat coalesced view (task → global) retained for callers that
    // only need a boolean — never used for the effective-source decision.
    autoExecuteTools: stored.autoExecuteTools ?? settings.autoExecuteTools,
    // v1.0.13 — safety-limit continuation inputs: the per-task cap (clamped
    // 0..5, default 1) + the global policy and per-continuation budget.
    limitContinuations: clampLimit('task', 'limitContinuations', stored.limitContinuations, 1),
    limitContinuationEnabled: settings.safetyLimitContinuation === true,
    limitContinuationExtra: clampLimit('task', 'limitContinuationExtra', settings.safetyLimitContinuationExtra, 25),
    sessionId: stored.sessionId,
    context: stored.context,
    // v1.1.0 — the continuity/skills/execute-all fields survive the merge
    // (they are persisted at creation and consumed by runTask).
    continuationOfTaskId: stored.continuationOfTaskId,
    forkedFromTaskId: stored.forkedFromTaskId,
    contextOptions: stored.contextOptions,
    skills: Array.isArray(stored.skills) ? stored.skills.map(String).slice(0, 12) : undefined,
    skillsMode: stored.skillsMode === 'manual' || stored.skillsMode === 'auto+manual' ? stored.skillsMode : stored.skillsMode === 'auto' ? 'auto' : undefined,
    executeAllPlannedSteps: stored.executeAllPlannedSteps === true,
  };
}

function subgoalId(i: number): string {
  return `sg_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`;
}

async function persistTask(taskId: string, data: Record<string, unknown>): Promise<void> {
  try {
    // v1.1.0 §9.2 — a terminal row is never overwritten by a late write: a
    // parallel-batch execution completing after a force-stop must not flip
    // the task back to completed/failed. Non-status fields still persist.
    if (typeof data.status === 'string') {
      const current = await db.task.findUnique({ where: { id: taskId }, select: { status: true } });
      const TERMINAL = new Set(['completed', 'failed', 'stopped', 'cancelled']);
      if (current && TERMINAL.has(current.status)) {
        delete data.status;
        delete data.statusDetail;
        delete data.completedAt;
        console.warn(`[loop] persist: task ${taskId} already terminal (${current.status}) — status fields dropped from a late write.`);
        if (Object.keys(data).length === 0) return;
      }
    }
    await db.task.update({ where: { id: taskId }, data });
  } catch (err) {
    console.error(`[loop] persist failed for task ${taskId}:`, err);
  }
}

interface RunContext {
  taskId: string;
  request: string;
  goal: string;
  /** v1.0.12 Phase 7 — combined custom task instructions (uploaded Markdown
   *  + textarea), loaded from the Task row at run start and threaded into
   *  planner / core / observer prompts as a delimited user block. */
  instructions?: string;
  config: ResolvedTaskConfig;
  toolDefs: ToolDefinition[];
  state: MainState;
  handle: TaskRunHandle;
  startedAtMs: number;
  artifacts: Record<string, unknown>[];
  /** v1.0.6 §9.7 — set when an approval timeout must stop the task. */
  blockedStop?: { reason: string } | null;
  /** v1.0.6 §10 — monotonic queue sequence. */
  eventSeq: number;
  /** v1.0.10 §10 — recent failure summaries (tool: message) feeding the
   *  one-by-one planner's knownFailures (in-memory, bounded). */
  failureLog: string[];
  /** v1.0.10 §7 — one-by-one step id → tracked subgoal id (status sync). */
  oneByOneSubgoalByStep: Map<string, string>;
  /** v1.0.10 §10 — endless-repetition guard: last failed step key + streak. */
  lastFailedStepKey?: string;
  identicalFailureStreak: number;
  /** v1.0.11 — completed recovery cycles per failed-step key (§9 attempt
   *  counting; bounded by task.recoveryMaxAttempts). */
  recoveryAttemptsByStep: Map<string, number>;
  /** v1.0.13 — safety-limit continuations GRANTED so far (bounded by
   *  config.limitContinuations; each grants +limitContinuationExtra budget). */
  limitContinuationsUsed: number;
  /** v1.0.16 §2 — EXTRA TIME granted through timeout continuations (ms).
   *  Added to the ALLOWED TOTAL ELAPSED RUNTIME: the deadline is
   *  startedAtMs + taskTimeoutMs + grantedExtraTimeMs. The elapsed clock is
   *  never reset; mirrors state.grantedExtraTimeMs (persisted). */
  grantedExtraTimeMs: number;
  /** v1.0.16 §6.3 — the last observation already fed to the goal verifier
   *  (result: not complete). Repeated verification with UNCHANGED state is
   *  skipped — the same input cannot produce a different verdict. */
  lastVerifiedObservation?: string;
  /** v1.1.0 §10 — goal already verified while executeAllPlannedSteps keeps
   *  the remaining plan steps running; further verification is skipped. */
  goalVerified?: boolean;
  /** v1.1.0 §10 — set when the execute-all continuation first fired (the
   *  final summary mentions it honestly). */
  executeAllContinued?: boolean;
}

// ---------- pause (v1.0.6 §11) ----------

/**
 * Suspend the task at a SAFE point: no new planner actions, no new tool
 * executions (§11.4). The current atomic tool execution always finishes
 * first — pause is only evaluated between steps (§11.6). Events arriving
 * while paused are RETAINED (§11.4): multi-event mode queues them,
 * single-event mode keeps the latest for processing right after resume.
 */
async function waitWhilePaused(ctx: RunContext): Promise<void> {
  if (!ctx.handle.pauseFlag.paused) return;
  await persistTask(ctx.taskId, { status: 'paused', statusDetail: 'Paused by user — resumable.' });
  await persistState(ctx);
  while (ctx.handle.pauseFlag.paused && !ctx.handle.stopFlag.stopped) {
    await new Promise<void>((resolve) => {
      ctx.handle.resumeSignal = resolve;
    });
    ctx.handle.resumeSignal = null;
  }
  ctx.handle.wake = null;
  if (!ctx.handle.stopFlag.stopped) {
    // §11.8 — resume continues from the preserved state; the live scheduler
    // restarts its interval from now (no burst of missed ticks, §11.5).
    // Events injected while paused sit in handle.inbox and are processed next.
    await persistTask(ctx.taskId, { status: ctx.config.mode === 'live' ? 'waiting' : 'running', statusDetail: null });
  }
}

// ---------- approval (v1.0.6 §9 / v1.0.15 §31-§36) ----------

function deniedExecution(tool: string, params: Record<string, unknown>, reason: string): ToolExecution {
  return {
    executionId: `exec_denied_${Date.now().toString(36)}`,
    tool,
    status: 'cancelled',
    params,
    error: { code: 'DENIED_BY_USER', message: reason },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

/**
 * v1.0.15 §33 — a SKIPPED tool: the user chose Skip (not Reject) — the tool
 * was NOT executed and the plan continues to the next logical step. The
 * execution record says `skipped` (distinct from a rejection's `cancelled`)
 * and the message tells the planner exactly what happened.
 */
function skippedExecution(tool: string, params: Record<string, unknown>): ToolExecution {
  return {
    executionId: `exec_skipped_${Date.now().toString(36)}`,
    tool,
    status: 'skipped',
    params,
    error: { code: 'SKIPPED_BY_USER', message: `Tool ${tool} was skipped by the user.` },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

/**
 * v1.0.15 §36 — the operator's decision is recorded in the EXECUTION HISTORY
 * (not only in task events), so Task Preview / History / the planner context
 * can audit every accept/skip/reject. Denied decisions keep the 'cancelled'
 * status with decision metadata; skips record 'skipped'.
 */
async function recordApprovalDecisionHistory(taskId: string | undefined, execution: ToolExecution, decision: 'accepted' | 'skipped' | 'rejected'): Promise<void> {
  try {
    await db.historyEntry.create({
      data: {
        taskId: taskId ?? null,
        action: execution.tool,
        params: JSON.stringify(execution.params ?? {}),
        result: JSON.stringify({ decision, executed: false, message: execution.error?.message ?? null }),
        status: decision === 'skipped' ? 'skipped' : 'cancelled',
      },
    });
  } catch (err) {
    console.error('[loop] approval decision history write failed:', err);
  }
}

/**
 * §9.5/§9.6 — approval gate in front of EVERY task-driven tool execution.
 * Returns the resolved outcome WITHOUT executing: 'auto' | 'allowed' mean the
 * caller may execute; 'skipped' means the user chose Skip — record and
 * continue; 'denied' means the user rejected — escalation ladder; 'timeout'
 * means the task must stop; 'cancelled' means the task was stopped while
 * waiting. Nothing silently executes — the caller executes ONLY on
 * 'auto'/'allowed'.
 */
async function requestApprovalIfNeeded(
  ctx: RunContext,
  tool: string,
  params: Record<string, unknown>,
  opts: { purpose?: string; reason?: string } = {},
): Promise<'auto' | 'allowed' | 'denied' | 'skipped' | 'timeout' | 'cancelled'> {
  const def = ctx.toolDefs.find((d) => d.name === tool);
  // v1.0.11 §34-§38 — the auto-execution hierarchy resolved through ONE
  // centralized resolver: GLOBAL (Settings) → TOOL config → TASK console →
  // default OFF. The effective source is observable via tool.auto_execution.
  const resolved = resolveAutoExecution(
    ctx.config.autoExecuteToolsGlobal,
    def?.autoExecute,
    ctx.config.autoExecuteToolsRaw,
  );
  // v1.0.13 §10 — FORCE_APPROVAL_TOOLS (fs.cmd) never take the auto-execution
  // shortcut: the explicit user confirmation is a product requirement, so the
  // gate below ALWAYS collects it for these tools.
  if (resolved.enabled && !FORCE_APPROVAL_TOOLS.has(tool)) {
    if (resolved.source !== 'global') {
      // §39/§41 — make the effective source observable when a lower layer
      // decided (the global-forced case is the documented default behavior).
      void emitEvent({
        taskId: ctx.taskId, type: 'tool.auto_execution', source: 'runtime',
        message: `${tool} auto-executed (effective source: ${resolved.source}).`,
        data: { tool, enabled: true, source: resolved.source }, priority: 6,
      });
    }
    return 'auto';
  }

  const subgoal = ctx.state.activeSubgoal?.title;
  // v1.0.15 §35 — the approval card shows the tool's environment + registry
  // description so the operator can judge what they are approving.
  ctx.state.pendingApproval = {
    approvalId: 'pending',
    tool,
    params,
    purpose: opts.purpose ?? def?.purpose,
    reason: opts.reason,
    environment: def?.environment,
    description: def?.description,
    state: 'pending',
    subgoal,
    requestedAt: new Date().toISOString(),
  };
  // §11.7 — pausing while awaiting approval keeps the approval unresolved and
  // well-defined; the paused state is preserved, never auto-allowed/denied.
  // Events arriving during the wait land in handle.inbox (no silent loss).
  const pausedWhileWaiting = ctx.handle.pauseFlag.paused;
  await persistTask(ctx.taskId, {
    status: pausedWhileWaiting ? 'paused' : 'awaiting_approval',
    statusDetail: pausedWhileWaiting
      ? `Paused — approval pending for ${tool} (approval stays unresolved during pause).`
      : `Waiting for approval to execute ${tool}.`,
  });
  await persistState(ctx);

  const { outcome, feedback } = await requestApproval({
    taskId: ctx.taskId,
    tool,
    params,
    purpose: opts.purpose ?? def?.purpose,
    reason: opts.reason,
    description: def?.description,
    environment: def?.environment,
    subgoal,
  });

  ctx.state.pendingApproval = null;
  await persistState(ctx);

  if (outcome === 'allowed') {
    await persistTask(ctx.taskId, {
      status: ctx.handle.pauseFlag.paused ? 'paused' : 'running',
      statusDetail: ctx.handle.pauseFlag.paused ? 'Paused by user — resumable.' : null,
    });
    return 'allowed';
  }
  if (outcome === 'skipped') {
    // v1.0.15 §33 — SKIP: NOT a denial. The tool is not executed, the
    // execution is recorded as `skipped`, and the plan continues to the next
    // logical step. The planner receives the exact fact so dependent steps
    // never assume success. The denial ladder is NOT burned.
    const message = `Tool ${tool} was skipped by the user — continue with the next logical step. Dependent steps must not assume this step succeeded.`;
    void emitEvent({
      taskId: ctx.taskId, type: 'observer.state_changed', source: 'observer',
      message, data: { tool, state: 'skipped', dependencyUnavailable: true }, priority: 3,
    });
    await persistTask(ctx.taskId, {
      status: ctx.handle.pauseFlag.paused ? 'paused' : 'running',
      statusDetail: ctx.handle.pauseFlag.paused ? 'Paused by user — resumable.' : null,
    });
    return 'skipped';
  }
  if (outcome === 'denied') {
    // v1.0.13 §13 — USER DENIAL / TOOL REJECTION ESCALATION. Every denial is
    // counted with its reason; the ladder decides what the runtime does next:
    //   #1 understand the reason → retry the same logical state
    //   #2 change the plan → retry with a modified approach
    //   #3 understand + final plan revision → retry once more
    //   #4 STOP the task (status 'stopped', detail 'user_denied: …').
    // The retry/plan-change directives travel to the planner through the
    // denied execution error message (knownFailures context) — no silent
    // abandonment on #1-#3, no infinite loop: #4 terminates.
    const count = (ctx.state.userDenialCount ?? 0) + 1;
    ctx.state.userDenialCount = count;
    ctx.state.lastDenialReason = feedback ?? undefined;
    const reasonText = feedback ? ` Reason: ${feedback.slice(0, 400)}` : '';
    void emitEvent({
      taskId: ctx.taskId, type: 'task.user_denial', source: 'user',
      message: `User denied ${tool} (denial #${count} of 4).${reasonText}`,
      data: { tool, denialCount: count, feedback: feedback ?? null }, priority: 2,
    });
    if (count >= 4) {
      // §13 — Denial #4: stop. Never loop forever.
      ctx.blockedStop = {
        reason: `user_denied: ${tool} was denied ${count} times by the user — task stopped.${reasonText}`,
      };
      void emitEvent({
        taskId: ctx.taskId, type: 'tool.execution.blocked', source: 'runtime',
        message: `Task stopped after ${count} user denials (user_denied).`,
        data: { tool, denialCount: count, cause: 'user_denied' }, priority: 2,
      });
      return 'denied';
    }
    // §9.10 — skip; continue according to the task plan (dependent steps get
    // an explicit observation so the planner never assumes success).
    const message = `${tool} was denied by the user — skipped. Dependent steps must not assume this step succeeded.`;
    void emitEvent({
      taskId: ctx.taskId, type: 'observer.state_changed', source: 'observer',
      message, data: { tool, dependencyUnavailable: true }, priority: 3,
    });
    return 'denied';
  }
  if (outcome === 'timeout') {
    // §9.7/§9.11 — approval timeout STOPS the task.
    ctx.blockedStop = { reason: `Approval for ${tool} timed out after 5 minutes — task stopped before execution.` };
    return 'timeout';
  }
  // cancelled (task stop while waiting)
  return 'cancelled';
}

async function executeWithApproval(
  ctx: RunContext,
  tool: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number; networkTimeoutMs?: number; batch?: { batchId: string; parallelGroup: number }; purpose?: string; reason?: string } = {},
): Promise<ToolExecution> {
  const outcome = await requestApprovalIfNeeded(ctx, tool, params, { purpose: opts.purpose, reason: opts.reason });
  if (outcome === 'auto' || outcome === 'allowed') {
    return executeTool(tool, params, { timeoutMs: opts.timeoutMs ?? ctx.config.toolTimeoutMs, networkTimeoutMs: ctx.config.networkTimeoutMs, taskId: ctx.taskId, signal: ctx.handle.abortController.signal, batch: opts.batch, // v1.0.13 §10 — an explicit ALLOW at this gate satisfies the
      // FORCE_APPROVAL_TOOLS handler gate too (no double confirmation).
      approved: outcome === 'allowed' });
  }
  if (outcome === 'skipped') {
    // v1.0.15 §33 — the skip is recorded as a real execution row so the
    // task history and the planner context both show it.
    const skipped = skippedExecution(tool, params);
    await recordApprovalDecisionHistory(ctx.taskId, skipped, 'skipped');
    return skipped;
  }
  const denied = deniedExecution(tool, params, outcome === 'denied'
    // v1.0.13 §13 — the denied execution carries the escalation directive so
    // the planner's knownFailures context understands what to do next:
    // #1 retry the same logical state, #2/#3 change the approach.
    ? denialEscalationMessage(ctx, tool)
    : outcome === 'timeout' ? 'Approval timeout — not executed.' : 'Task stopped while awaiting approval.');
  if (outcome === 'denied') {
    // v1.0.15 §36 — record the REJECT decision in the execution history.
    await recordApprovalDecisionHistory(ctx.taskId, denied, 'rejected');
  }
  return denied;
}

/**
 * v1.0.13 §13 — the escalation directive attached to a denied execution.
 * ctx.state.userDenialCount was already incremented by the approval gate, so
 * #1 = retry, #2/#3 = plan change (final on #3). Denial #4 never reaches this
 * message — the gate sets ctx.blockedStop and the loop stops the task.
 */
function denialEscalationMessage(ctx: RunContext, tool: string): string {
  const count = ctx.state.userDenialCount ?? 1;
  const reason = ctx.state.lastDenialReason ? ` User reason: "${ctx.state.lastDenialReason.slice(0, 300)}".` : '';
  if (count <= 1) {
    return `${tool} was denied by the user (denial #1) — understand the rejection reason and RETRY the same logical state. Do not abandon the task.${reason}`;
  }
  if (count === 2) {
    return `${tool} was denied again (denial #2) — CHANGE THE PLAN: retry with a modified approach.${reason}`;
  }
  return `${tool} was denied again (denial #3) — FINAL plan revision: change the approach a second time; another denial stops the task.${reason}`;
}


/** Read the blocked-stop reason through a helper — property narrowing inside
 *  the run loops would otherwise collapse the truthy branch to `never`. */
function blockedStopReason(ctx: RunContext): string | null {
  return ctx.blockedStop ? ctx.blockedStop.reason : null;
}

// ---------- context bundle ----------


async function buildContextBundle(
  ctx: RunContext,
  trigger?: LiveTrigger,
): Promise<{
  memory: Record<string, unknown>[];
  history: Record<string, unknown>[];
  stateSummary: string;
  lastObservation?: string;
  trigger?: Record<string, unknown>;
}> {
  let memory: Record<string, unknown>[] = [];
  if (ctx.config.useMemory) {
    try {
      const rows = await db.memoryEntry.findMany({ orderBy: { updatedAt: 'desc' }, take: 5 });
      memory = rows.map((r) => ({ key: r.key, value: parseJson<unknown>(r.value, r.value), updatedAt: r.updatedAt.toISOString() }));
    } catch (err) {
      console.error('[loop] memory load failed:', err);
    }
  }
  let history: Record<string, unknown>[] = [];
  try {
    const rows = await db.historyEntry.findMany({ where: { taskId: ctx.taskId }, orderBy: { timestamp: 'desc' }, take: 5 });
    history = rows.map((r) => ({ action: r.action, status: r.status, result: parseJson<unknown>(r.result, null) }));
  } catch {
    /* fresh task */
  }
  return {
    memory,
    history,
    stateSummary: JSON.stringify({
      mode: ctx.state.mode,
      iteration: ctx.state.iterationCount,
      toolCalls: ctx.state.toolCallCount,
      activeSubgoal: ctx.state.activeSubgoal?.title,
      planStatuses: ctx.state.plan.map((s) => `${s.id}:${s.status}`).join(','),
      servers: listServers().map((s) => `${s.id}=${s.health}`),
    }),
    lastObservation: ctx.state.lastObservation,
    // v1.0.14 §14 — the trigger travels with the cycle context: the Core sees
    // whether this run was event-driven (with the FULL event body) or a
    // message-less interval check. Events keep their id/type/source/message/
    // data/createdAt — never reduced to a generic "continue task" string.
    trigger: trigger ? summarizeTrigger(trigger) : undefined,
  };
}

// ---------- plan-step selection ----------

function firstPendingIndex(plan: PlanStep[]): number {
  return plan.findIndex((s) => s.status === 'pending' || s.status === 'in_progress');
}

/** Collect consecutive pending action steps sharing the first pending step's parallelGroup. */
function parallelGroupSteps(plan: PlanStep[]): PlanStep[] {
  const idx = firstPendingIndex(plan);
  if (idx === -1) return [];
  const step = plan[idx];
  if (!step.parallelGroup) return [step];
  const group: PlanStep[] = [step];
  for (let i = idx + 1; i < plan.length; i++) {
    const s = plan[i];
    if (s.status !== 'pending' || s.parallelGroup !== step.parallelGroup || s.kind !== 'action') break;
    group.push(s);
  }
  return group.length >= 2 ? group : [step];
}

// ---------- one CoreModule decision + execution ----------

interface ActionResult {
  execution: ToolExecution;
  observation: string;
}

async function decideAndExecute(
  ctx: RunContext,
  objective: string,
  contextBundleOverride?: Partial<Awaited<ReturnType<typeof buildContextBundle>>>,
  trigger?: LiveTrigger,
): Promise<{ decision: Awaited<ReturnType<typeof decide>>; result?: ActionResult }> {
  const bundle = { ...(await buildContextBundle(ctx, trigger)), ...contextBundleOverride };

  // v1.1.0 — the decision carries the task id (CoreModule Live Output) and
  // the task's AbortSignal so a force-stop unblocks an in-flight LLM call.
  const decision = await decide({
    objective,
    request: ctx.request,
    goal: ctx.goal,
    activeSubgoal: ctx.state.activeSubgoal
      ? { title: ctx.state.activeSubgoal.title, reason: ctx.state.activeSubgoal.reason }
      : undefined,
    toolDefs: ctx.toolDefs,
    contextBundle: bundle,
    reasoningLevel: ctx.config.reasoningLevel,
    allowedTools: ctx.config.enabledTools,
    instructions: ctx.instructions,
    taskId: ctx.taskId,
    signal: ctx.handle.abortController.signal,
  });

  // v1.1.0 §9.2 — prevent late execution: if the task was stopped while the
  // LLM call was in flight, the (valid) result must NOT trigger a tool run.
  if (ctx.handle.stopFlag.stopped || ctx.handle.abortController.signal.aborted) {
    return { decision };
  }

  void emitEvent({
    taskId: ctx.taskId,
    type: 'core.decision',
    source: 'core',
    message: `core → ${decision.status}${decision.tool ? ` ${decision.tool}` : ''} (conf ${decision.confidence.toFixed(2)}, ${decision.engine})`,
    data: { ...decision, objective } as unknown as Record<string, unknown>,
    priority: 4,
  });

  if (decision.status !== 'tool_call' || !decision.tool) {
    return { decision };
  }

  // v1.0.6 §9 — every task-driven tool execution passes the approval gate.
  const execution = await executeWithApproval(ctx, decision.tool, decision.params ?? {}, {
    timeoutMs: ctx.config.toolTimeoutMs,
    networkTimeoutMs: ctx.config.networkTimeoutMs,
    reason: decision.reason,
  });
  if (ctx.blockedStop) {
    return { decision, result: { execution, observation: interpret(decision.tool, execution, { goal: ctx.goal, lastObservation: ctx.state.lastObservation }) } };
  }
  const observation = interpret(decision.tool, execution, { goal: ctx.goal, lastObservation: ctx.state.lastObservation });
  return { decision, result: { execution, observation } };
}

function recordExecution(ctx: RunContext, tool: string, result: ActionResult): void {
  ctx.state.lastObservation = result.observation;
  ctx.state.observations.push({ at: new Date().toISOString(), message: result.observation });
  if (ctx.state.observations.length > 30) ctx.state.observations.splice(0, ctx.state.observations.length - 30);
  ctx.state.previousActions.push({ action: tool, status: result.execution.status, at: new Date().toISOString() });
  if (ctx.state.previousActions.length > 30) ctx.state.previousActions.splice(0, ctx.state.previousActions.length - 30);
  ctx.state.toolCallCount += 1;
  // v1.0.10 §10 — bounded in-memory failure log feeding the one-by-one
  // planner's knownFailures (never blindly repeat a failed action).
  // v1.0.15 §33/§52 — user decisions travel too: a SKIPPED or REJECTED tool
  // is exactly the fact the planner must see so it never re-issues the same
  // request and never assumes a skipped step succeeded.
  if (
    result.execution.status === 'failed' || result.execution.status === 'timeout' || result.execution.status === 'skipped'
    || (result.execution.status === 'cancelled' && result.execution.error?.code === 'DENIED_BY_USER')
  ) {
    const message = result.execution.error?.message ?? result.execution.status;
    ctx.failureLog.push(`${result.execution.tool}: ${message} (${result.execution.status})`);
    if (ctx.failureLog.length > 10) ctx.failureLog.shift();
  }
  const r = result.execution.result as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    if (typeof r.imagePath === 'string') ctx.artifacts.push({ type: 'image', path: r.imagePath });
    if (typeof r.id === 'string' && typeof r.level === 'string') ctx.artifacts.push({ type: 'notification', id: r.id, level: r.level });
  }
  // v1.0.10 §32/§35 — Observer → pattern pipeline: normalized observations
  // feed the structured pattern store (fire-and-forget, never blocks/fails
  // the loop; the Observer stays responsible for what actually happened).
  void recordPatternObservation({
    taskId: ctx.taskId,
    taskMode: ctx.config.mode,
    plannerType: ctx.config.plannerType,
    request: ctx.request,
    tool: result.execution.tool,
    execution: result.execution,
    observation: result.observation,
    previousAction: ctx.state.previousActions.length >= 2
      ? ctx.state.previousActions[ctx.state.previousActions.length - 2]
      : undefined,
  }).catch(() => { /* pattern extraction must never break the loop */ });
  void emitEvent({
    taskId: ctx.taskId,
    type: 'observer.observed',
    source: 'observer',
    message: result.observation,
    priority: 6,
  });
}

async function persistState(ctx: RunContext): Promise<void> {
  // v1.0.3 §2/§31: keep the plan COLUMN in sync with state.plan — previously
  // only the state JSON advanced, so Task.plan stayed stale at "pending" and
  // the UI checklist never reflected real step completion.
  await persistTask(ctx.taskId, {
    state: JSON.stringify(ctx.state),
    plan: JSON.stringify(ctx.state.plan),
    steps: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
  });
}

// ---------- LLM helper: next subgoal ----------

async function proposeNextSubgoal(
  ctx: RunContext,
): Promise<{ done: true } | { done: false; title: string; reason: string }> {
  // v1.1.0 §11.5 — the subgoal proposal shares the PLANNER deadline (it is a
  // planner inference), separate from the CoreModule timeout, and honors the
  // task's AbortSignal.
  let plannerTimeoutMs: number | null = 10_000;
  try {
    plannerTimeoutMs = getResolvedLimits().planner.llmTimeoutMs;
  } catch {
    /* limits file problem — keep the documented 10-second default */
  }
  try {
    const { content } = await callLlm({
      messages: [
        {
          role: 'assistant',
          content: [
            'You are the Planner of NexTool. Given the goal and recent observations, determine the next dynamic subgoal.',
            'Output STRICT JSON only, either {"done":true} when nothing further is needed, or {"title":"next subgoal","reason":"one sentence"}.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            goal: ctx.goal,
            observations: ctx.state.observations.slice(-4),
            planStatuses: ctx.state.plan.map((s) => `${s.title}:${s.status}`),
          }),
        },
      ],
      timeoutMs: plannerTimeoutMs,
      signal: ctx.handle.abortController.signal,
    });
    const cleaned = (content ?? '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { done?: unknown; title?: unknown; reason?: unknown };
      if (parsed.done === true) return { done: true };
      if (typeof parsed.title === 'string' && parsed.title.trim()) {
        return { done: false, title: parsed.title.trim().slice(0, 200), reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 300) : 'Dynamic subgoal from planner.' };
      }
    }
  } catch (err) {
    console.error('[loop] subgoal proposal failed, heuristic fallback:', err);
  }
  return { done: true };
}

// ---------- goal completion check ----------

/**
 * v1.1.0 §10 — the shared goal-verification gate for runGoalMode.
 *  - 'complete'  → normal early completion (executeAllPlannedSteps off, or
 *                  no pending plan steps left, or one-by-one planner).
 *  - 'continue'  → the goal IS verified but executeAllPlannedSteps is on and
 *                  pending pre-plan steps remain: the remaining steps still
 *                  execute (stop, approvals, safety limits and boundaries
 *                  stay enforced — this flag never bypasses them).
 * Guardrails (§10.3): decision-level terminal outcomes (clarification,
 * cannot_execute, no_tool, stop, approval timeout) are NOT affected.
 */
async function resolveGoalVerification(ctx: RunContext): Promise<'complete' | 'continue'> {
  if (ctx.goalVerified) {
    // already verified — execute-all is mid-flight, skip re-verification
    return 'continue';
  }
  if (await verifyGoal(ctx)) {
    ctx.goalVerified = true;
    const pendingLeft = firstPendingIndex(ctx.state.plan) !== -1;
    if (ctx.config.plannerType === 'pre-plan' && ctx.config.executeAllPlannedSteps === true && pendingLeft) {
      const pendingCount = ctx.state.plan.filter((s) => s.status === 'pending').length;
      if (!ctx.executeAllContinued) {
        ctx.executeAllContinued = true;
        void emitEvent({
          taskId: ctx.taskId, type: 'planner.execute_all_continue', source: 'planner',
          message: `Goal verified — executeAllPlannedSteps is enabled: the remaining ${pendingCount} planned step(s) still execute (stop, approvals and safety limits remain enforced).`,
          data: { plannerType: 'pre-plan', executeAllPlannedSteps: true, pendingSteps: pendingCount, goal: ctx.goal },
          priority: 4,
        });
      }
      return 'continue';
    }
    return 'complete';
  }
  return 'continue';
}

async function verifyGoal(ctx: RunContext): Promise<boolean> {
  const observation = ctx.state.lastObservation ?? 'No observation yet.';
  // v1.0.16 §6.3 — repeated verification when NO relevant state changed is
  // avoided: the verifier is deterministic per (goal, observation) pair, so
  // an unchanged observation since the last NOT-complete verdict cannot
  // suddenly verify. Removes a duplicate LLM call per planning cycle.
  if (ctx.lastVerifiedObservation === observation && observation !== 'No observation yet.') {
    return false;
  }
  const check = await checkGoalComplete(ctx.goal, observation, ctx.config.reasoningLevel, ctx.taskId, ctx.instructions, ctx.handle.abortController.signal);
  ctx.lastVerifiedObservation = observation;
  if (check.complete) {
    void emitEvent({
      taskId: ctx.taskId,
      type: 'observer.state_changed',
      source: 'observer',
      message: `State indicates goal achieved: ${check.reason}`,
      priority: 4,
    });
    void emitEvent({
      taskId: ctx.taskId,
      type: 'goal.completed',
      source: 'runtime',
      message: `Goal completed: ${ctx.goal}`,
      data: { reason: check.reason, engine: check.engine },
      priority: 3,
    });
  }
  return check.complete;
}

// ---------- v1.0.10 one-by-one planner helpers ----------

/** Build the known-failure / constraint inputs for the one-by-one planner. */
function oneByOnePlannerInputs(ctx: RunContext, note?: string) {
  const constraints: string[] = [];
  if (ctx.config.enabledTools?.length) {
    constraints.push(`Only these tools are enabled: ${ctx.config.enabledTools.join(', ')}`);
  }
  if (ctx.config.mode === 'live') {
    constraints.push('Live mode: keep the step small, observable and safe — the task continues across ticks.');
  }
  return buildOneByOneContext({
    request: ctx.request,
    goal: ctx.goal,
    taskMode: ctx.config.mode,
    reasoningLevel: ctx.config.reasoningLevel,
    state: ctx.state,
    knownFailures: [...ctx.failureLog],
    constraints,
    instructions: ctx.instructions,
    note,
  });
}

/**
 * §4/§5/§6/§10 — plan exactly ONE next step from the latest state, push it to
 * the task plan, record it as the current operational subgoal (§7) and emit
 * the planner.plan update so the Task Preview checklist refreshes.
 *
 * Includes the §10 endless-repetition guard: after the SAME step failed twice
 * in a row, a third identical proposal is replaced by the failure-aware
 * deterministic fallback step.
 */
async function planAndTrackOneByOneStep(ctx: RunContext, note?: string): Promise<PlanStep> {
  const plannerCtx = oneByOnePlannerInputs(ctx, note);
  let planned = await planOneByOneStep(plannerCtx, ctx.toolDefs, ctx.taskId, ctx.handle.abortController.signal);

  const key = planned.step.title.trim().toLowerCase();
  if (ctx.lastFailedStepKey && key === ctx.lastFailedStepKey && ctx.identicalFailureStreak >= 2) {
    const replacement = buildOneByOneFallbackStep(plannerCtx, ctx.state.plan.length);
    void emitEvent({
      taskId: ctx.taskId, type: 'planner.one_by_one_replanned', source: 'planner',
      message: `Identical failed step proposed again ("${planned.step.title}") — replaced by the failure-aware fallback step.`,
      data: { plannerType: 'one-by-one', stepId: replacement.id, stepTitle: replacement.title, reason: 'identical-failed-step-guard' },
      priority: 4,
    });
    planned = { step: replacement, source: 'deterministic-fallback', discarded: 0 };
  }

  ctx.state.plan.push(planned.step);
  const sg: Subgoal = {
    id: subgoalId(ctx.state.subgoals.length),
    title: planned.step.title,
    reason: planned.step.detail ?? 'One-by-one subgoal planned from the latest observation.',
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  ctx.state.subgoals.push(sg);
  ctx.oneByOneSubgoalByStep.set(planned.step.id, sg.id);

  void emitEvent({
    taskId: ctx.taskId, type: 'planner.plan', source: 'planner',
    message: `One-by-one plan updated: next step "${planned.step.title}".`,
    data: { plannerType: 'one-by-one', goal: ctx.goal, steps: [planned.step], plannerSource: planned.source },
    priority: 5,
  });
  return planned.step;
}

/**
 * §7/§21 — after a one-by-one step executed: sync the tracked subgoal status,
 * maintain the §10 repetition guard and emit step_completed events.
 */
function observeOneByOneStepOutcome(ctx: RunContext, step: PlanStep | undefined, execution: ToolExecution): void {
  if (!step) return;
  const success = execution.status === 'completed';
  if (success) {
    void emitEvent({
      taskId: ctx.taskId, type: 'planner.one_by_one_step_completed', source: 'planner',
      message: `One-by-one step completed: ${step.title} (tool ${execution.tool}).`,
      data: { plannerType: 'one-by-one', stepId: step.id, stepTitle: step.title, tool: execution.tool, durationMs: execution.durationMs },
      priority: 6,
    });
    ctx.lastFailedStepKey = undefined;
    ctx.identicalFailureStreak = 0;
  } else {
    ctx.lastFailedStepKey = step.title.trim().toLowerCase();
    ctx.identicalFailureStreak += 1;
  }
  const sgId = ctx.oneByOneSubgoalByStep.get(step.id);
  if (sgId) {
    const sg = ctx.state.subgoals.find((s) => s.id === sgId);
    if (sg) {
      sg.status = success ? 'completed' : execution.status === 'cancelled' ? 'cancelled' : 'failed';
      if (sg.id === ctx.state.activeSubgoal?.id && success) ctx.state.activeSubgoal = undefined;
    }
  }
}

// ---------- termination ----------

interface Termination {
  finalStatus: FinalResult['status'];
  taskStatus: 'completed' | 'failed' | 'stopped';
  statusDetail?: string;
  summary: string;
  errorState?: MainState['errorState'];
}

function markStepByExecution(plan: PlanStep[], stepId: string, status: ToolExecution['status']): void {
  const step = plan.find((s) => s.id === stepId);
  if (!step) return;
  // v1.0.15 §33 — a SKIPPED execution marks the step 'skipped' explicitly.
  step.status = status === 'completed' ? 'completed' : status === 'cancelled' || status === 'skipped' ? 'skipped' : 'failed';
}

// ---------- GOAL MODE ----------

/**
 * v1.0.13 — SAFETY-LIMIT CONTINUATION: when the goal loop trips
 * maxIterations/safetyLimit, ASK the operator instead of failing silently.
 * While the question pends the task parks in `awaiting_approval` (§11 —
 * pausing during the wait keeps the question unresolved, never silently
 * granted). 'granted' → BOTH limits already grew by limitContinuationExtra
 * and the caller may `continue` the loop; 'stopped' → the task was stopped
 * while waiting; 'refused' → no continuations left / disabled / denied /
 * timeout — the caller applies the documented terminal SAFETY_LIMIT exit.
 */
async function requestLimitContinuationIfNeeded(ctx: RunContext): Promise<'granted' | 'refused' | 'stopped'> {
  const { config } = ctx;
  if (!config.limitContinuationEnabled || config.limitContinuationExtra <= 0) return 'refused';
  if (ctx.limitContinuationsUsed >= config.limitContinuations) return 'refused';

  const iterationsExhausted = ctx.state.iterationCount >= config.maxIterations;
  const callsExhausted = ctx.state.toolCallCount >= config.safetyLimit;
  const limitKind: 'maxIterations' | 'safetyLimit' | 'both' = iterationsExhausted && callsExhausted ? 'both' : iterationsExhausted ? 'maxIterations' : 'safetyLimit';

  const pausedWhileWaiting = ctx.handle.pauseFlag.paused;
  await persistTask(ctx.taskId, {
    status: pausedWhileWaiting ? 'paused' : 'awaiting_approval',
    statusDetail: pausedWhileWaiting
      ? `Paused — safety-limit continuation question pending (${limitKind}).`
      : `Safety limit reached (${limitKind}) — waiting for the operator's continuation decision.`,
  });

  const outcome = await requestLimitContinuation({
    taskId: ctx.taskId,
    limitKind,
    iterations: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    maxIterations: config.maxIterations,
    safetyLimit: config.safetyLimit,
    extraBudget: config.limitContinuationExtra,
  });

  if (outcome === 'continued') {
    ctx.limitContinuationsUsed += 1;
    config.maxIterations += config.limitContinuationExtra;
    config.safetyLimit += config.limitContinuationExtra;
    await persistTask(ctx.taskId, {
      status: ctx.handle.pauseFlag.paused ? 'paused' : 'running',
      statusDetail: null,
    });
    return 'granted';
  }
  // cancelled: the task was stopped (or paused→stopped) while waiting — the
  // caller reports the honest stop instead of a limit_reached failure.
  if (outcome === 'cancelled') return 'stopped';
  // denied | timeout → the documented terminal exit.
  return 'refused';
}

/**
 * v1.0.16 §2 — TIMEOUT CONTINUATION: when the task's TOTAL time budget is
 * exhausted, ASK the operator instead of failing silently. The proposal is a
 * DOUBLING policy: additional = ORIGINAL time budget (120 s → 240 s total).
 * The grant extends the ALLOWED TOTAL ELAPSED RUNTIME
 * (startedAtMs + taskTimeoutMs + grantedExtraTimeMs) — the elapsed clock is
 * NEVER reset and the expired deadline is never left unchanged. The granted
 * extra time is mirrored into the persisted state
 * (state.grantedExtraTimeMs) so polling/reloads can never reset it. While the
 * question pends the task parks in `awaiting_approval` and no tools run.
 */
async function requestTimeoutContinuationIfNeeded(ctx: RunContext): Promise<'granted' | 'refused' | 'stopped'> {
  const { config } = ctx;
  if (!config.limitContinuationEnabled || config.taskTimeoutMs <= 0) return 'refused';
  if (ctx.limitContinuationsUsed >= config.limitContinuations) return 'refused';

  const pausedWhileWaiting = ctx.handle.pauseFlag.paused;
  await persistTask(ctx.taskId, {
    status: pausedWhileWaiting ? 'paused' : 'awaiting_approval',
    statusDetail: pausedWhileWaiting
      ? 'Paused — task-timeout continuation question pending.'
      : 'Task timeout reached — waiting for the operator\u2019s continuation decision.',
  });

  const elapsedMs = Date.now() - ctx.startedAtMs;
  const outcome = await requestLimitContinuation({
    taskId: ctx.taskId,
    limitKind: 'taskTimeout',
    iterations: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    maxIterations: config.maxIterations,
    safetyLimit: config.safetyLimit,
    extraBudget: config.limitContinuationExtra,
    originalTimeBudgetMs: config.taskTimeoutMs,
    elapsedMs,
    additionalMs: config.taskTimeoutMs,
  });

  if (outcome === 'continued') {
    ctx.limitContinuationsUsed += 1;
    ctx.grantedExtraTimeMs += config.taskTimeoutMs;
    ctx.state.grantedExtraTimeMs = ctx.grantedExtraTimeMs;
    await persistState(ctx);
    await persistTask(ctx.taskId, {
      status: ctx.handle.pauseFlag.paused ? 'paused' : 'running',
      statusDetail: null,
    });
    return 'granted';
  }
  if (outcome === 'cancelled') return 'stopped';
  // denied | timeout → the documented terminal exit (TIMEOUT).
  return 'refused';
}

/**
 * v1.0.15 §44-§49 — GOAL MODE processes injected events too. Live tasks wake
 * immediately on admission; goal mode has no wait to interrupt, so the inbox
 * is drained at every safe iteration boundary: user messages/corrections
 * become first-class observations that shape the NEXT decision cycle. An
 * admitted event is never silently dropped in goal mode.
 */
async function drainGoalInbox(ctx: RunContext): Promise<void> {
  const inbox = ctx.handle.inbox;
  let drained = 0;
  while (inbox.length > 0) {
    const event = inbox.shift();
    if (!event) break;
    drained += 1;
    const data = event.data as Record<string, unknown> | undefined;
    const message = typeof data?.message === 'string' ? data.message : event.message;
    const isUser = event.source === 'user' || event.type === 'user.message' || event.type === 'user.feedback';
    const note = isUser
      ? `User message received during the task: "${message.slice(0, 400)}" — take it into account before the next step.`
      : `Runtime event ${event.type}: ${message.slice(0, 400)}`;
    ctx.state.observations.push({ at: new Date().toISOString(), message: note });
    if (ctx.state.observations.length > 30) ctx.state.observations.splice(0, ctx.state.observations.length - 30);
    ctx.state.lastObservation = note;
    void emitEvent({
      taskId: ctx.taskId, type: 'observer.state_changed', source: 'observer',
      message: note, data: { eventId: event.id, eventType: event.type, source: event.source }, priority: 3,
    });
  }
  if (drained > 0) await persistState(ctx);
}

async function runGoalMode(ctx: RunContext): Promise<Termination> {
  const { config } = ctx;
  const startedAt = Date.now();

  while (true) {
    if (ctx.handle.stopFlag.stopped) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Stopped by user.', summary: ctx.state.lastObservation ?? 'Task stopped.' };
    }
    // v1.0.15 §44-§49 — drain admitted events at the safe boundary BEFORE
    // planning the next step, so a user message/correction steers the goal.
    await drainGoalInbox(ctx);
    // v1.0.6 §11 — pause at the safe point between iterations.
    await waitWhilePaused(ctx);
    if (ctx.handle.stopFlag.stopped) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Stopped by user.', summary: ctx.state.lastObservation ?? 'Task stopped.' };
    }
    const blockedTop = blockedStopReason(ctx);
    if (blockedTop) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: blockedTop, summary: ctx.state.lastObservation ?? blockedTop };
    }
    // v1.0.16 §2 — the deadline is the ORIGINAL budget + every operator-granted
    // time extension; the elapsed clock (ctx.startedAtMs) is never reset.
    if (Date.now() - ctx.startedAtMs > config.taskTimeoutMs + ctx.grantedExtraTimeMs) {
      const timeoutContinuation = await requestTimeoutContinuationIfNeeded(ctx);
      if (timeoutContinuation === 'granted') continue;
      if (timeoutContinuation === 'stopped') {
        return {
          finalStatus: 'stopped', taskStatus: 'stopped',
          statusDetail: 'Stopped while awaiting the task-timeout continuation decision.',
          summary: ctx.state.lastObservation ?? 'Task stopped.',
        };
      }
      return {
        finalStatus: 'limit_reached', taskStatus: 'failed', statusDetail: 'Task timeout reached.',
        summary: 'Task exceeded the configured timeout.',
        errorState: { code: 'TIMEOUT', message: `Task timeout (${config.taskTimeoutMs}ms budget + ${ctx.grantedExtraTimeMs}ms granted) reached.`, stage: 'goal_loop' },
      };
    }
    if (ctx.state.iterationCount >= config.maxIterations || ctx.state.toolCallCount >= config.safetyLimit) {
      // v1.0.13 — SAFETY-LIMIT CONTINUATION: ask the operator first. Granted →
      // both limits grew and the loop proceeds; stopped → honest stop; refused
      // (disabled / exhausted / denied / timeout) → the documented terminal.
      const continuation = await requestLimitContinuationIfNeeded(ctx);
      if (continuation === 'granted') continue;
      if (continuation === 'stopped') {
        return {
          finalStatus: 'stopped', taskStatus: 'stopped',
          statusDetail: 'Stopped while awaiting the safety-limit continuation decision.',
          summary: ctx.state.lastObservation ?? 'Task stopped.',
        };
      }
      return {
        finalStatus: 'limit_reached', taskStatus: 'failed', statusDetail: 'Iteration/safety limit reached.',
        summary: 'Safety limit reached before goal completion.',
        errorState: { code: 'SAFETY_LIMIT', message: 'Iteration or tool-call safety limit reached.', stage: 'goal_loop' },
      };
    }

    // pick objective
    const planExhausted = firstPendingIndex(ctx.state.plan) === -1;

    if (planExhausted && !ctx.state.activeSubgoal) {
      if (config.plannerType === 'one-by-one') {
        // v1.0.10 §4/§5 — REPLAN: plan exactly ONE next step from the LATEST
        // state (the previous observation is already in ctx.state — the goal
        // verifier ran before this planning call, §9). The proposed step
        // becomes the current operational subgoal (§7).
        await planAndTrackOneByOneStep(ctx);
        await persistState(ctx);
      } else {
      // plan exhausted → dynamic subgoal (pre-plan behavior, unchanged)
      const proposal = await proposeNextSubgoal(ctx);
      if (proposal.done) {
        return { finalStatus: 'completed', taskStatus: 'completed', summary: ctx.state.lastObservation ?? 'Plan exhausted; no further subgoals identified.' };
      }
      const sg: Subgoal = { id: subgoalId(ctx.state.subgoals.length), title: proposal.title, reason: proposal.reason, status: 'active', createdAt: new Date().toISOString() };
      ctx.state.subgoals.push(sg);
      ctx.state.activeSubgoal = sg;
      void emitEvent({
        taskId: ctx.taskId, type: 'subgoal.created', source: 'planner',
        message: `Dynamic subgoal created: ${sg.title}`, data: { subgoal: sg }, priority: 5,
      });
      await persistState(ctx);
      }
    }

    // v1.0.10 — re-evaluate pending steps AFTER a possible one-by-one replan
    // (the freshly planned step is now the only pending one).
    const group = parallelGroupSteps(ctx.state.plan);

    const objective = ctx.state.activeSubgoal
      ? ctx.state.activeSubgoal.title
      : group[0].title;

    // mark plan step in_progress (when using plan steps)
    let activeStepIds: string[] = [];
    if (!ctx.state.activeSubgoal) {
      activeStepIds = group.map((s) => s.id);
      for (const s of group) s.status = 'in_progress';
      ctx.state.currentStepId = group[0].id;
    }
    ctx.state.iterationCount += 1;

    // PARALLEL EXECUTION (v1.0.3 §18-23): the explicit `parallelToolCalls` config
    // enables concurrent execution of ≥2 independent consecutive action steps
    // (same parallelGroup). Concurrency is capped at maxParallelToolCalls; the
    // dependency graph is preserved because only CONSECUTIVE same-group steps
    // batch together — anything after a group boundary is a later, dependent wave.
    if (!ctx.state.activeSubgoal && ctx.config.parallelToolCalls && group.length >= 2 && ctx.config.autoExecuteSubtools) {
      const cap = Math.min(group.length, ctx.config.maxParallelToolCalls);
      const slice = group.slice(0, cap);
      const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const parallelGroup = group[0].parallelGroup ?? 0;
      void emitEvent({
        taskId: ctx.taskId, type: 'planner.parallel_batch', source: 'planner',
        message: `${slice.length} independent tool call(s) detected — executing concurrently (cap ${ctx.config.maxParallelToolCalls}).`,
        data: { batchId, parallelGroup, tools: slice.map((s) => s.title), maxParallelToolCalls: ctx.config.maxParallelToolCalls },
        priority: 5,
      });
      const decisions = await Promise.all(
        slice.map(async (step) => ({ step, decision: await decideForStep(ctx, step) })),
      );
      if (decisions.every((d) => d.decision.status === 'tool_call' && d.decision.tool)) {
        // v1.0.6 §9.13 — parallel approvals: every blocked tool waits for ITS
        // OWN decision; approving one never auto-approves its batch siblings.
        const approved: { tool: string; params: Record<string, unknown>; stepId: string }[] = [];
        const denied: { stepId: string; tool: string }[] = [];
        const skippedBatch: { stepId: string; tool: string }[] = [];
        for (const d of decisions) {
          const tool = d.decision.tool as string;
          const outcome = await requestApprovalIfNeeded(ctx, tool, d.decision.params ?? {}, { reason: d.decision.reason });
          const blockedBatch = blockedStopReason(ctx);
          if (blockedBatch) {
            return {
              finalStatus: 'stopped', taskStatus: 'stopped',
              statusDetail: blockedBatch,
              summary: ctx.state.lastObservation ?? blockedBatch,
            };
          }
          if (outcome === 'auto' || outcome === 'allowed') {
            approved.push({ tool, params: d.decision.params ?? {}, stepId: d.step.id });
          } else if (outcome === 'skipped') {
            // v1.0.15 §33 — batch SKIP: recorded, step marked skipped, plan continues.
            skippedBatch.push({ stepId: d.step.id, tool });
            const skippedExec = skippedExecution(tool, d.decision.params ?? {});
            await recordApprovalDecisionHistory(ctx.taskId, skippedExec, 'skipped');
            recordExecution(ctx, tool, {
              execution: skippedExec,
              observation: `Tool ${tool} was skipped by the user — continue with the next logical step.`,
            });
            markStepByExecution(ctx.state.plan, d.step.id, 'skipped');
          } else {
            denied.push({ stepId: d.step.id, tool });
            const deniedExec = deniedExecution(tool, d.decision.params ?? {}, outcome === 'denied'
              // v1.0.13 §13 — escalation directive in the denied execution.
              ? denialEscalationMessage(ctx, tool)
              : 'Task stopped while awaiting approval.');
            if (outcome === 'denied') {
              await recordApprovalDecisionHistory(ctx.taskId, deniedExec, 'rejected');
            }
            recordExecution(ctx, tool, {
              execution: deniedExec,
              observation: interpret(tool, deniedExec, { goal: ctx.goal }),
            });
            markStepByExecution(ctx.state.plan, d.step.id, 'cancelled');
          }
        }
        if (approved.length > 0) {
          const executions = await executeParallelBatch(
            batchId,
            approved.map((a) => ({
              tool: a.tool,
              params: a.params,
              parallelGroup,
            })),
            {
              timeoutMs: ctx.config.toolTimeoutMs,
              networkTimeoutMs: ctx.config.networkTimeoutMs,
              taskId: ctx.taskId,
              signal: ctx.handle.abortController.signal,
              maxParallel: ctx.config.maxParallelToolCalls,
              // v1.0.13 §10 — every parallel member collected its own explicit
              // ALLOW above; the FORCE_APPROVAL_TOOLS handler gate is satisfied.
              approved: true,
            },
          );
          let failed = 0;
          executions.forEach((execution, i) => {
            const observation = interpret(execution.tool, execution, { goal: ctx.goal });
            recordExecution(ctx, execution.tool, { execution, observation });
            markStepByExecution(ctx.state.plan, approved[i].stepId, execution.status);
            if (execution.status === 'failed' || execution.status === 'timeout') failed += 1;
          });
          if (failed > 0 && failed < executions.length) {
            void emitEvent({
              taskId: ctx.taskId, type: 'planner.partial_failure', source: 'planner',
              message: `${failed} of ${executions.length} parallel call(s) failed — independent calls continued.`,
              data: { batchId }, priority: 4,
            });
          }
        }
        if (denied.length > 0) {
          void emitEvent({
            taskId: ctx.taskId, type: 'planner.partial_failure', source: 'planner',
            message: `${denied.length} parallel call(s) denied by user — skipped (batch siblings unaffected).`,
            data: { batchId, denied: denied.map((d) => d.tool) }, priority: 4,
          });
        }
        if (skippedBatch.length > 0) {
          void emitEvent({
            taskId: ctx.taskId, type: 'planner.partial_failure', source: 'planner',
            message: `${skippedBatch.length} parallel call(s) skipped by the user — the plan continues (batch siblings unaffected).`,
            data: { batchId, skipped: skippedBatch.map((d) => d.tool) }, priority: 4,
          });
        }
        await persistState(ctx);
        const verdict = await resolveGoalVerification(ctx);
        if (verdict === 'complete') {
          return { finalStatus: 'completed', taskStatus: 'completed', summary: ctx.state.lastObservation ?? 'Goal verified.' };
        }
        continue;
      }
      // not uniformly parallelizable → fall through to sequential handling below
      for (const s of slice) s.status = 'pending';
      ctx.state.currentStepId = undefined;
      ctx.state.iterationCount -= 1;
    }

    // SEQUENTIAL EXECUTION
    const { decision, result } = await decideAndExecute(ctx, objective);

    const blockedSeq = blockedStopReason(ctx);
    if (blockedSeq) {
      // v1.0.6 §9.7 — approval timeout: stop rather than silently continue.
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: blockedSeq, summary: ctx.state.lastObservation ?? blockedSeq };
    }

    if (decision.status === 'clarification_required') {
      const missing = decision.missing ?? [];
      void emitEvent({
        taskId: ctx.taskId, type: 'core.clarification', source: 'core',
        message: `Clarification required: missing ${missing.join(', ') || 'parameters'}`,
        data: { missing, reason: decision.reason }, priority: 3,
      });
      return {
        finalStatus: 'failed', taskStatus: 'failed',
        statusDetail: `Clarification required: ${missing.join(', ') || 'missing parameters'}`,
        summary: decision.reason,
        errorState: { code: 'CLARIFICATION_REQUIRED', message: `Missing parameters: ${missing.join(', ')}`, stage: 'core_decision' },
      };
    }

    if (decision.status === 'cannot_execute') {
      return {
        finalStatus: 'failed', taskStatus: 'failed', statusDetail: decision.reason,
        summary: decision.reason,
        errorState: { code: 'NO_CAPABLE_TOOL', message: decision.reason, stage: 'core_decision' },
      };
    }

    if (decision.status === 'stop') {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Stop requested.', summary: decision.reason };
    }

    if (decision.status === 'no_tool') {
      const informational = /no .*(registered|suitable|matching) tool|not require|informational|no tool provides/i.test(decision.reason) || decision.confidence >= 0.6;
      if (informational) {
        return { finalStatus: 'completed', taskStatus: 'completed', summary: decision.reason };
      }
      return {
        finalStatus: 'failed', taskStatus: 'failed', statusDetail: 'No capable tool available.',
        summary: decision.reason,
        errorState: { code: 'NO_TOOL', message: decision.reason, stage: 'core_decision' },
      };
    }

    // tool_call — execute
    if (!result) {
      // defensive: tool_call without execution
      continue;
    }
    let finalResult = result;
    if (result.execution.status === 'failed' || result.execution.status === 'timeout') {
      if (config.plannerType === 'one-by-one') {
        // v1.0.10 §10 — one-by-one failure handling: NO blind retry of the
        // identical action. Record the failure, observe it, verify the goal,
        // then REPLAN one step with the failure context (the planner input
        // carries knownFailures). Bounded by maxIterations/safetyLimit/timeout.
        // v1.0.11 §15 — one-by-one semantics are NOT changed by recovery.
        recordExecution(ctx, result.execution.tool, result);
        for (const id of activeStepIds) markStepByExecution(ctx.state.plan, id, 'failed');
        observeOneByOneStepOutcome(ctx, ctx.state.plan.find((s) => s.id === activeStepIds[0]), result.execution);
        void emitEvent({
          taskId: ctx.taskId, type: 'planner.one_by_one_replanned', source: 'planner',
          message: `Step failed (${result.execution.status}) — replanning one step with the failure context.`,
          data: {
            plannerType: 'one-by-one',
            stepId: activeStepIds[0],
            failedTool: result.execution.tool,
            error: result.execution.error?.message ?? result.execution.status,
          },
          priority: 4,
        });
        await persistState(ctx);
        if (await verifyGoal(ctx)) {
          void emitEvent({
            taskId: ctx.taskId, type: 'planner.one_by_one_goal_reached', source: 'planner',
            message: `One-by-one goal reached: ${ctx.goal}`,
            data: { plannerType: 'one-by-one', goal: ctx.goal },
            priority: 4,
          });
          return { finalStatus: 'completed', taskStatus: 'completed', summary: ctx.state.lastObservation ?? 'Goal verified.' };
        }
        continue;
      }

      // v1.0.11 §1–§15 — PRE-PLAN FAILURE RECOVERY (replaces the v1.0.3
      // single blind retry + hard stop). The main plan is FROZEN while the
      // recovery subgoal runs its own pre-plan; a successful recovery
      // resumes the main plan state-aware (§6/§7).
      recordExecution(ctx, result.execution.tool, result);
      for (const id of activeStepIds) markStepByExecution(ctx.state.plan, id, 'failed');
      await persistState(ctx);
      const failedStep = ctx.state.plan.find((s) => s.id === activeStepIds[0]);
      const recoveryHost = {
        taskId: ctx.taskId,
        request: ctx.request,
        goal: ctx.goal,
        toolDefs: ctx.toolDefs,
        reasoningLevel: config.reasoningLevel,
        recoveryMaxAttempts: config.recoveryMaxAttempts,
        state: ctx.state,
        recoveryAttempts: ctx.recoveryAttemptsByStep,
        // v1.1.0 — recovery assessments inherit the task's AbortSignal.
        signal: ctx.handle.abortController.signal,
        decideAndExecute: (objective: string, overrides?: { lastObservation?: string }) =>
          decideAndExecute(ctx, objective, overrides),
        recordExecution: (tool: string, r: { execution: ToolExecution; observation: string }) =>
          recordExecution(ctx, tool, r),
        persistState: () => persistState(ctx),
        verifyGoal: () => verifyGoal(ctx),
        blockedStopReason: () => blockedStopReason(ctx),
      };
      const recovery = await runPrePlanRecovery(recoveryHost, {
        failedStepId: activeStepIds[0] || undefined,
        failedStepTitle: failedStep?.title ?? ctx.state.activeSubgoal?.title ?? objective,
        failedStepDetail: failedStep?.detail,
        failedTool: result.execution.tool,
        failureStatus: result.execution.status,
        failureMessage: result.execution.error?.message ?? result.execution.status,
      });
      if (recovery.kind === 'completed') {
        return { finalStatus: 'completed', taskStatus: 'completed', summary: recovery.summary };
      }
      if (recovery.kind === 'aborted') {
        // §11/§12 — exhausted or unrecoverable: end the task honestly.
        // §9.7 — a stop/approval-timeout during recovery still ends 'stopped'.
        if (ctx.handle.stopFlag.stopped || recovery.errorCode === 'RECOVERY_BLOCKED') {
          return {
            finalStatus: 'stopped', taskStatus: 'stopped',
            statusDetail: recovery.statusDetail,
            summary: ctx.state.lastObservation ?? recovery.statusDetail,
          };
        }
        return {
          finalStatus: 'failed', taskStatus: 'failed',
          statusDetail: recovery.statusDetail,
          summary: ctx.state.lastObservation ?? 'Recovery failed — task ended.',
          errorState: { code: recovery.errorCode, message: recovery.statusDetail, stage: 'recovery' },
        };
      }
      // kind === 'resumed' — the main plan continues (failed step satisfied
      // or re-queued); the loop re-evaluates from the current state.
      await persistState(ctx);
      continue;
    }

    recordExecution(ctx, finalResult.execution.tool, finalResult);
    for (const id of activeStepIds) markStepByExecution(ctx.state.plan, id, finalResult.execution.status);
    // v1.0.10 §7/§21 — one-by-one step outcome bookkeeping (events + subgoal
    // status sync + repetition-guard state).
    if (config.plannerType === 'one-by-one') {
      observeOneByOneStepOutcome(ctx, ctx.state.plan.find((s) => s.id === activeStepIds[0]), finalResult.execution);
    }

    // action fulfilled the active subgoal → mark completed
    if (ctx.state.activeSubgoal && finalResult.execution.status === 'completed') {
      ctx.state.activeSubgoal.status = 'completed';
      ctx.state.activeSubgoal = undefined;
    }
    await persistState(ctx);

    const verdict = await resolveGoalVerification(ctx);
    if (verdict === 'complete') {
      // v1.0.10 §9 — the goal verifier ran BEFORE requesting another plan;
      // one-by-one emits its dedicated goal event and completes without
      // generating any further step.
      if (config.plannerType === 'one-by-one') {
        void emitEvent({
          taskId: ctx.taskId, type: 'planner.one_by_one_goal_reached', source: 'planner',
          message: `One-by-one goal reached: ${ctx.goal}`,
          data: { plannerType: 'one-by-one', goal: ctx.goal },
          priority: 4,
        });
      }
      return {
        finalStatus: 'completed', taskStatus: 'completed',
        statusDetail: ctx.executeAllContinued ? 'Goal verified — all planned steps executed (executeAllPlannedSteps).' : undefined,
        summary: ctx.state.lastObservation ?? 'Goal verified.',
      };
    }
  }
}

async function decideForStep(ctx: RunContext, step: PlanStep): Promise<Awaited<ReturnType<typeof decide>>> {
  return decide({
    objective: step.title,
    request: ctx.request,
    goal: ctx.goal,
    toolDefs: ctx.toolDefs,
    contextBundle: await buildContextBundle(ctx),
    reasoningLevel: ctx.config.reasoningLevel,
    allowedTools: ctx.config.enabledTools,
    instructions: ctx.instructions,
    taskId: ctx.taskId,
    signal: ctx.handle.abortController.signal,
  });
}

// ---------- LIVE MODE ----------

function waitWithEvents(intervalMs: number, handle: TaskRunHandle): Promise<WakePayload> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      handle.wake = null;
      resolve({ reason: 'timeout' });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    handle.wake = (payload: WakePayload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handle.wake = null;
      resolve(payload);
    };
  });
}

async function runRepairPasses(ctx: RunContext, serverId: string): Promise<boolean> {
  const sg: Subgoal = {
    id: subgoalId(ctx.state.subgoals.length),
    title: `Recover server ${serverId}`,
    reason: `Server ${serverId} reported unhealthy — recovery subgoal created.`,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  ctx.state.subgoals.push(sg);
  ctx.state.activeSubgoal = sg;
  void emitEvent({
    taskId: ctx.taskId, type: 'subgoal.created', source: 'planner',
    message: `Recovery subgoal created: ${sg.title}`, data: { subgoal: sg }, priority: 3,
  });

  let calls = 0;
  // 1) observe health
  let health = await executeTool('server.health', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, networkTimeoutMs: ctx.config.networkTimeoutMs, taskId: ctx.taskId });
  calls += 1;
  recordExecution(ctx, 'server.health', { execution: health, observation: interpret('server.health', health) });

  if (health.status === 'completed') {
    const r = health.result as { health?: string } | undefined;
    if (r?.health === 'healthy') {
      sg.status = 'completed';
      ctx.state.activeSubgoal = undefined;
      await persistState(ctx);
      return true;
    }
  }

  // 2) restart
  if (calls < 3) {
    const restart = await executeTool('server.restart', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, networkTimeoutMs: ctx.config.networkTimeoutMs, taskId: ctx.taskId });
    calls += 1;
    recordExecution(ctx, 'server.restart', { execution: restart, observation: interpret('server.restart', restart) });
    await new Promise((res) => setTimeout(res, RESTART_SETTLE_MS));
  }

  // 3) verify
  if (calls < 4) {
    const verify = await executeTool('server.health', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, networkTimeoutMs: ctx.config.networkTimeoutMs, taskId: ctx.taskId });
    calls += 1;
    recordExecution(ctx, 'server.health', { execution: verify, observation: interpret('server.health', verify) });
    const r = verify.result as { health?: string } | undefined;
    if (r?.health === 'healthy') {
      sg.status = 'completed';
      ctx.state.activeSubgoal = undefined;
      ctx.state.lastObservation = `Server ${serverId} recovered and verified healthy.`;
      await persistState(ctx);
      void emitEvent({
        taskId: ctx.taskId, type: 'observer.state_changed', source: 'observer',
        message: `Server ${serverId} recovered and verified healthy.`, priority: 3,
      });
      return true;
    }
  }

  sg.status = 'failed';
  ctx.state.activeSubgoal = undefined;
  await persistState(ctx);
  return false;
}

async function liveObserveCycle(ctx: RunContext, objective: string, trigger?: LiveTrigger): Promise<void> {
  // v1.0.10 §8 — Live Mode one-by-one planning: each tick/event first plans
  // exactly ONE next action/subgoal from the CURRENT world state, then that
  // single step is executed and observed. No giant pre-plan is generated;
  // the live task keeps running across future ticks/events.
  let effectiveObjective = objective;
  let oneByOneStep: PlanStep | undefined;
  if (ctx.config.plannerType === 'one-by-one') {
    oneByOneStep = await planAndTrackOneByOneStep(ctx, objective);
    effectiveObjective = oneByOneStep.title;
  }
  const { decision, result } = await decideAndExecute(ctx, effectiveObjective, undefined, trigger);
  if (result) {
    recordExecution(ctx, decision.tool as string, result);
    if (oneByOneStep) {
      for (const s of ctx.state.plan) if (s.id === oneByOneStep.id) s.status = result.execution.status === 'completed' ? 'completed' : result.execution.status === 'cancelled' ? 'skipped' : 'failed';
      observeOneByOneStepOutcome(ctx, oneByOneStep, result.execution);
    }
    await persistState(ctx);
  }
  if (ctx.blockedStop) return;

  // v1.0.10 §9 — the goal verifier runs after every executed one-by-one step.
  // Live tasks are long-running: goal evidence is RECORDED (event + state)
  // but the live architecture is not broken — the task continues across
  // future ticks/events instead of being torn down on first goal evidence.
  if (ctx.config.plannerType === 'one-by-one' && result) {
    if (await verifyGoal(ctx)) {
      void emitEvent({
        taskId: ctx.taskId, type: 'planner.one_by_one_goal_reached', source: 'planner',
        message: `One-by-one goal evidence recorded — live task continues across ticks: ${ctx.goal}`,
        data: { plannerType: 'one-by-one', goal: ctx.goal, live: true },
        priority: 5,
      });
    }
  }

  // environment-driven recovery (spec §71) — unchanged for both planner types
  const goalMentionsMonitoring = /monitor|recover|production|prod|api|server|health|web|db/i.test(ctx.goal);
  const unhealthy = listServers().filter((s) => s.health === 'unhealthy' || s.health === 'degraded');
  if (goalMentionsMonitoring && unhealthy.length > 0) {
    for (const server of unhealthy) {
      if (ctx.handle.stopFlag.stopped || ctx.blockedStop) return;
      await runRepairPasses(ctx, server.id);
    }
  }
}

// ---------- live event queue (v1.0.6 §10) ----------

/** §10.9 — configurable, deterministic queue limits. v1.0.8 §9.2 — the queue
 *  cap is resolved from the CENTRAL configuration (task.eventQueueCap).
 *  v1.1.0 §7 — the per-event payload cap is ALSO central now
 *  (events.maxDataBytes, previously the hard-coded 16 KiB). */
function maxEventDataBytes(): number {
  try {
    return getResolvedLimits().events.maxDataBytes;
  } catch {
    return 16 * 1024; // shipped default; the loader fails clearly on invalid files
  }
}

function maxQueuedEvents(): number {
  try {
    return getResolvedLimits().task.eventQueueCap;
  } catch {
    return 50; // shipped default; the loader fails clearly on invalid files
  }
}

function stateQueue(ctx: RunContext): QueuedLiveEvent[] {
  if (!Array.isArray(ctx.state.eventQueue)) ctx.state.eventQueue = [];
  return ctx.state.eventQueue;
}

/** §10.2 / v1.0.14 §12 — accept an event into the queue with the documented
 *  drop policy. Lifecycle: event.queued on admission; event.rejected with an
 *  observable reason when the queue is full (never silent). */
function enqueueLiveEvent(ctx: RunContext, event: NexToolEvent): QueuedLiveEvent | null {
  const queue = stateQueue(ctx);
  // payload guard
  let data = event.data;
  if (data && JSON.stringify(data).length > maxEventDataBytes()) {
    data = { truncated: true, note: 'Event payload exceeded the 16 KiB queue limit and was reduced to metadata.' };
  }
  const queued: QueuedLiveEvent = {
    seq: ++ctx.eventSeq,
    eventId: event.id,
    type: event.type,
    message: event.message,
    priority: event.priority,
    queuedAt: new Date().toISOString(),
    // v1.0.14 §33 — keep the original source so the reconstructed event
    // stays faithful to what actually happened.
    source: event.source,
    status: 'queued',
    data,
  };
  if (queue.length >= maxQueuedEvents()) {
    const cap = maxQueuedEvents();
    // §10.9 policy: when full, the LOWEST-priority item is dropped —
    // emergency events displace stale low-priority ones, never silently.
    let lowestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].priority > queue[lowestIdx].priority) lowestIdx = i;
    }
    if (queue[lowestIdx].priority <= event.priority) {
      const dropped = queue.splice(lowestIdx, 1)[0];
      dropped.status = 'dropped';
      dropped.statusReason = `Event queue full (${cap}) — displaced by higher-priority "${event.type}".`;
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: dropped.eventId, eventType: dropped.type,
        state: 'rejected', reason: dropped.statusReason,
        extra: { droppedSeq: dropped.seq, incoming: event.type }, priority: 6,
      });
    } else {
      const reason = `Event queue full (${cap}) — incoming event lost to a higher-priority queue.`;
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: event.id, eventType: event.type,
        state: 'rejected', reason, extra: { incoming: event.type, priority: event.priority },
        priority: 6,
      });
      return null;
    }
  }
  queue.push(queued);
  emitEventLifecycle({
    taskId: ctx.taskId, eventId: event.id, eventType: event.type, state: 'queued',
    extra: { seq: queued.seq, queueLength: queue.length },
  });
  return queued;
}

/**
 * §10.3 / v1.0.14 §2.1 — drain the queue ONE-BY-ONE, in deterministic order
 * (§10.4: priority 1 = emergency first, then arrival sequence). No two
 * event-driven action plans ever run concurrently. After each event the loop
 * CONTINUES immediately — queued events never wait for the next interval
 * (§2.1: the queue must be drained continuously until empty). A failing
 * event cycle never deadlocks the queue (§32): the failure is recorded and
 * the next queued event proceeds.
 */
async function drainEventQueue(ctx: RunContext): Promise<void> {
  const queue = stateQueue(ctx);
  while (true) {
    if (ctx.handle.stopFlag.stopped || ctx.blockedStop) return;
    if (ctx.handle.pauseFlag.paused) return; // remaining events stay queued (§11.4)
    const pending = queue.filter((q) => q.status === 'queued');
    if (pending.length === 0) break;
    pending.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
    const current = pending[0];
    current.status = 'processing';
    ctx.state.currentEventSeq = current.seq;
    await persistState(ctx);
    emitEventLifecycle({
      taskId: ctx.taskId, eventId: current.eventId, eventType: current.type,
      state: 'processing', extra: { seq: current.seq },
    });

    const synthetic: NexToolEvent = {
      id: current.eventId,
      taskId: ctx.taskId,
      type: current.type,
      // v1.0.14 §33 — preserve the original source (falls back to
      // 'environment' only for pre-v1.0.14 queue entries without one).
      source: (current.source as NexToolEvent['source']) ?? 'environment',
      message: current.message,
      data: current.data,
      priority: current.priority,
      createdAt: current.queuedAt,
    };
    // v1.0.14 §32 — a failed event cycle must not deadlock the queue: record
    // the failure observably, then move on to the next queued event.
    try {
      await processLiveEvent(ctx, synthetic);
      current.status = 'processed';
    } catch (err) {
      console.error('[loop] queued event cycle failed:', err);
      current.status = 'failed';
      current.statusReason = err instanceof Error ? err.message : String(err);
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: current.eventId, eventType: current.type,
        state: 'failed', reason: current.statusReason, extra: { seq: current.seq },
        priority: 5,
      });
    }
    ctx.state.currentEventSeq = undefined;
    if (current.status === 'processed') {
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: current.eventId, eventType: current.type,
        state: 'completed', extra: { seq: current.seq }, priority: 7,
      });
    }
    // §10.7 — trim processed history so the queue stays a QUEUE in state.
    const settled = queue.filter((q) => q.status === 'processed' || q.status === 'failed');
    if (settled.length > 10) {
      for (const q of settled.slice(0, settled.length - 10)) {
        const idx = queue.indexOf(q);
        if (idx !== -1) queue.splice(idx, 1);
      }
    }
    await persistState(ctx);
  }
}

/**
 * One event's observe → decide → act cycle (§10.6 / v1.0.14 §14). Extracted
 * from the v1.0.0-v1.0.5 wake handler so single-event mode and queue
 * processing share EXACTLY the same behavior. The event's FULL context
 * (id/type/source/message/data/createdAt) is passed to the observation and
 * decision pipeline — never reduced to a generic "continue task" string.
 */
async function processLiveEvent(ctx: RunContext, event: NexToolEvent): Promise<void> {
  const cycleDeadline = Date.now() + ctx.config.taskTimeoutMs;
  const trigger: LiveTrigger = { type: 'event', event };
  void emitEvent({
    taskId: ctx.taskId, type: 'observer.event_wake', source: 'observer',
    message: `Woken by event: ${event.type} (priority ${event.priority}, source ${event.source}).`,
    data: { eventId: event.id, type: event.type, source: event.source },
    priority: 5,
  });

  if (event.type === 'user.message') {
    // v1.0.14 §8 — a user message event is the live conversation channel.
    // The message (and any body) reaches the observe/decide pipeline verbatim
    // so the AI can answer questions, take corrections and act on feedback.
    const message = typeof event.data?.message === 'string' && event.data.message.trim()
      ? event.data.message.trim()
      : event.message;
    try {
      await liveObserveCycle(
        ctx,
        `User message received. Respond to the user and act if needed. Message: "${message.slice(0, 2000)}" Keep making progress on: ${ctx.goal}`,
        trigger,
      );
    } catch (err) {
      console.error('[loop] user.message cycle failed:', err);
    }
  } else if (event.type === 'user.feedback') {
    const message = String(event.data?.message ?? '');
    const correctAction = event.data?.correctAction ? String(event.data.correctAction) : undefined;
    void emitEvent({
      taskId: ctx.taskId, type: 'observer.feedback_applied', source: 'observer',
      message: `User feedback processed: ${message.slice(0, 200)}`,
      priority: 3,
    });
    if (ctx.config.learnFrom?.feedback) {
      try {
        await db.memoryEntry.upsert({
          where: { key: `feedback_${ctx.taskId}` },
          update: { value: JSON.stringify({ message, correctAction, at: new Date().toISOString() }), tags: JSON.stringify(['feedback', 'live']) },
          create: { key: `feedback_${ctx.taskId}`, value: JSON.stringify({ message, correctAction, at: new Date().toISOString() }), tags: JSON.stringify(['feedback', 'live']), source: 'runtime' },
        });
      } catch (err) {
        console.error('[loop] feedback memory failed:', err);
      }
    }
    // revise active subgoal via LLM (fallback: correctAction or generic title)
    let title = correctAction ?? `Adjust approach per user feedback: ${message.slice(0, 80)}`;
    try {
      const { default: ZAI } = await import('z-ai-web-dev-sdk');
      const zai = await ZAI.create();
      const res = await Promise.race([
        zai.chat.completions.create({
          messages: [
            { role: 'assistant' as const, content: 'You are the Planner of NexTool. The user corrected the runtime. Revise the active subgoal accordingly. Output STRICT JSON only: {"title":"revised subgoal","reason":"one sentence"}' },
            { role: 'user' as const, content: JSON.stringify({ goal: ctx.goal, feedback: message, correctAction, activeSubgoal: ctx.state.activeSubgoal?.title, lastObservation: ctx.state.lastObservation }) },
          ],
          thinking: { type: 'disabled' },
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
      ]);
      const content = res?.choices?.[0]?.message?.content ?? '';
      const m = content.replace(/```json\s*/gi, '').match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]) as { title?: unknown };
        if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim().slice(0, 200);
      }
    } catch (err) {
      console.error('[loop] feedback subgoal revision fallback:', err);
    }
    const sg: Subgoal = { id: subgoalId(ctx.state.subgoals.length), title, reason: `Revised after user feedback: ${message.slice(0, 150)}`, status: 'active', createdAt: new Date().toISOString() };
    ctx.state.subgoals.push(sg);
    ctx.state.activeSubgoal = sg;
    void emitEvent({
      taskId: ctx.taskId, type: 'subgoal.created', source: 'planner',
      message: `Subgoal revised after feedback: ${title}`, data: { subgoal: sg }, priority: 3,
    });
    await persistState(ctx);
    // v1.0.14 §8/§10 — a user correction is acted upon IMMEDIATELY: the
    // revised subgoal feeds an instant observe/act cycle (no interval wait).
    try {
      await liveObserveCycle(
        ctx,
        `User correction received: "${message.slice(0, 1000)}". Re-observe the current state and recover/correct the previous decision. Keep making progress on: ${ctx.goal}`,
        trigger,
      );
    } catch (err) {
      console.error('[loop] feedback correction cycle failed:', err);
    }
  } else if (event.type.startsWith('environment.')) {
    // environment event → immediate recovery
    const serverId = event.data?.serverId ? String(event.data.serverId) : undefined;
    const crashed = serverId ?? listServers().find((s) => s.health !== 'healthy')?.id;
    if (crashed) {
      try {
        await runRepairPasses(ctx, crashed);
      } catch (err) {
        console.error('[loop] env recovery failed:', err);
      }
    }
  } else {
    // generic event: one observe cycle bounded by cycle deadline. The FULL
    // event body (message + data) travels into the cycle via the trigger —
    // the AI observes the actual event content, not just the wake-up.
    if (Date.now() < cycleDeadline) {
      try {
        await liveObserveCycle(
          ctx,
          `Event-driven observation (${event.type}, source ${event.source}): keep making progress on: ${ctx.goal}. Event message: ${event.message}`,
          trigger,
        );
      } catch (err) {
        console.error('[loop] event cycle failed:', err);
      }
    }
  }
}

// ---------- live event inbox (v1.0.6 §10.2) ----------

/**
 * Drain events that arrived while the loop was busy/paused/waiting.
 * Multi-event mode (Read & Act All Events): EVERY event is queued and
 * processed one-by-one, immediately, with no interval waits in between.
 * Single-event mode (default / queueing disabled): the FIRST event is
 * processed now; later simultaneous events are REJECTED with an observable
 * reason (v1.0.14 §2.2 — no queue, no hidden backlog, never silent).
 */
async function drainInbox(ctx: RunContext): Promise<void> {
  const inbox = ctx.handle.inbox;
  if (inbox.length === 0) return;
  if (ctx.config.allowMultipleEvents) {
    while (inbox.length > 0) {
      const event = inbox.shift() as NexToolEvent;
      enqueueLiveEvent(ctx, event);
    }
    await drainEventQueue(ctx);
  } else {
    const event = inbox.shift() as NexToolEvent;
    const skipped = inbox.splice(0, inbox.length);
    for (const s of skipped) {
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: s.id, eventType: s.type, state: 'rejected',
        reason: 'Live action already running and Read & Act All Events is disabled.',
        priority: 6,
      });
    }
    // v1.0.14 §12 — the single-event path reports the same lifecycle as the
    // queue path (processing → completed/failed), never silently.
    emitEventLifecycle({ taskId: ctx.taskId, eventId: event.id, eventType: event.type, state: 'processing' });
    try {
      await processLiveEvent(ctx, event);
      emitEventLifecycle({ taskId: ctx.taskId, eventId: event.id, eventType: event.type, state: 'completed', priority: 7 });
    } catch (err) {
      console.error('[loop] single-event cycle failed:', err);
      emitEventLifecycle({
        taskId: ctx.taskId, eventId: event.id, eventType: event.type, state: 'failed',
        reason: err instanceof Error ? err.message : String(err), priority: 5,
      });
    }
  }
}

async function runLiveMode(ctx: RunContext): Promise<Termination> {
  const { config } = ctx;

  // v1.0.14 §6 — INITIAL EXECUTION: every Live task runs its first full
  // observation/action cycle IMMEDIATELY on startup (never "wait for the
  // first interval"). The trigger is 'initial' — message-less by design.
  ctx.handle.actionRunning = true;
  try {
    await liveObserveCycle(ctx, `Initial observation: ${ctx.goal}. Environment state: ${JSON.stringify(listServers())}`, { type: 'initial' });
  } catch (err) {
    console.error('[loop] live initial pass failed:', err);
  }
  ctx.handle.actionRunning = false;
  if (ctx.handle.stopFlag.stopped) {
    return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Live task stopped by user.', summary: ctx.state.lastObservation ?? 'Live task stopped.' };
  }
  const blockedInitial = blockedStopReason(ctx);
  if (blockedInitial) {
    return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: blockedInitial, summary: ctx.state.lastObservation ?? blockedInitial };
  }

  // live tasks park in 'waiting' while between cycles
  await persistTask(ctx.taskId, { status: 'waiting' });
  void emitEvent({
    taskId: ctx.taskId, type: 'task.waiting', source: 'runtime',
    message: `Live task waiting — reacts to events IMMEDIATELY plus a scheduled check every ${config.liveIntervalMs}ms${config.allowMultipleEvents ? ' (Read & Act All Events: incoming events are queued and processed one-by-one)' : ''}.`,
    priority: 7,
  });
  await persistState(ctx);

  while (true) {
    if (ctx.handle.stopFlag.stopped) break;

    // v1.0.6 §11 — pause at the safe point between cycles. Events arriving
    // while paused accumulate in handle.inbox and are processed after resume.
    await waitWhilePaused(ctx);
    if (ctx.handle.stopFlag.stopped) break;

    // v1.0.14 §2.1 — the queue/inbox drain happens BEFORE every wait: events
    // that arrived while the previous action was running are processed
    // IMMEDIATELY, never after another interval wait.
    if (ctx.handle.inbox.length > 0) {
      ctx.handle.actionRunning = true;
      await drainInbox(ctx);
      ctx.handle.actionRunning = false;
      if (ctx.handle.stopFlag.stopped || ctx.blockedStop) break;
      continue;
    }
    // §10.5 — queued events persisted in state survive refresh/reconnect/pause.
    if (config.allowMultipleEvents && stateQueue(ctx).some((q) => q.status === 'queued')) {
      ctx.handle.actionRunning = true;
      await drainEventQueue(ctx);
      ctx.handle.actionRunning = false;
      if (ctx.handle.stopFlag.stopped || ctx.blockedStop) break;
      continue;
    }

    // v1.0.14 §2.2 — entering the WAITING state: injectEvent may admit
    // immediately from here on.
    ctx.handle.actionRunning = false;
    const wake = await waitWithEvents(config.liveIntervalMs, ctx.handle);
    if (ctx.handle.stopFlag.stopped) break;
    // pause wake-up: loop back to the paused hold (§11 — no new actions).
    if (ctx.handle.pauseFlag.paused) continue;

    // v1.0.14 §2.2 — a cycle is running from here until the next wait.
    ctx.handle.actionRunning = true;

    if (wake.reason === 'timeout') {
      void emitEvent({
        taskId: ctx.taskId, type: 'observer.scheduled_tick', source: 'runtime',
        message: 'Scheduled observation tick.',
        data: { at: new Date().toISOString() },
        priority: 9,
      });
      const servers = listServers();
      try {
        // v1.0.14 §13 — the interval is a message-less trigger: the AI
        // performs its normal scheduled observation (no fabricated event).
        await liveObserveCycle(
          ctx,
          `Scheduled observation: keep making progress on: ${ctx.goal}. Environment state: ${JSON.stringify(servers)}`,
          { type: 'interval' },
        );
      } catch (err) {
        console.error('[loop] scheduled cycle failed:', err);
      }
    } else if (wake.event) {
      const event = wake.event;
      if (event.type === 'task.stop') break;
      // v1.0.6 — direct wake payloads (e.g. task.stop sent with an event) are
      // processed here; user/env events always funnel through the inbox.
      if (config.allowMultipleEvents) {
        enqueueLiveEvent(ctx, event);
        await drainEventQueue(ctx);
      } else {
        // v1.0.0-v1.0.5 single-event behavior preserved by default (§10.1).
        await processLiveEvent(ctx, event);
      }
    } else if (wake.reason === 'event') {
      // Woken without a payload — drain whatever accumulated in the inbox.
      await drainInbox(ctx);
    }
    if (ctx.blockedStop) break;
  }

  // v1.0.14 §31 — stopping a Live task ends event processing cleanly: any
  // still-queued events are marked CANCELLED (observable, never silently
  // forgotten) and nothing keeps running after the stop.
  const remaining = stateQueue(ctx).filter((q) => q.status === 'queued' || q.status === 'processing');
  for (const q of remaining) {
    q.status = 'cancelled';
    q.statusReason = 'Task stopped by user — queued event cancelled.';
    emitEventLifecycle({
      taskId: ctx.taskId, eventId: q.eventId, eventType: q.type, state: 'cancelled',
      reason: q.statusReason, extra: { seq: q.seq }, priority: 6,
    });
  }
  if (remaining.length > 0) await persistState(ctx);
  ctx.handle.inbox.length = 0;

  const blockedEnd = blockedStopReason(ctx);
  if (blockedEnd) {
    return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: blockedEnd, summary: ctx.state.lastObservation ?? blockedEnd };
  }
  return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Live task stopped by user.', summary: ctx.state.lastObservation ?? 'Live task stopped.' };
}

// ---------- ENTRY POINT ----------

export async function runTask(taskId: string, handle: TaskRunHandle): Promise<void> {
  const row = await db.task.findUnique({ where: { id: taskId } });
  if (!row) throw new Error(`Task not found: ${taskId}`);

  const settings = await getSettings();
  const storedConfig = parseJson<Partial<TaskConfig>>(row.config, {});
  const config = mergeConfig(storedConfig, settings);
  const request = row.request;
  const startedAtMs = Date.now();

  const state: MainState = {
    request,
    goal: row.goal ?? request,
    mode: config.mode,
    plan: [],
    subgoals: [],
    previousActions: [],
    observations: [],
    iterationCount: 0,
    toolCallCount: 0,
    terminationStatus: null,
    errorState: null,
    pendingApproval: null,
    eventQueue: [],
    paused: false,
  };

  const ctx: RunContext = {
    taskId, request, goal: state.goal, config, toolDefs: [], state, handle, startedAtMs, artifacts: [], eventSeq: 0, blockedStop: null,
    // v1.0.12 Phase 7 — custom task instructions loaded from the Task row
    // (combined at creation; survive task restart/reopen).
    instructions: sanitizeInstructionsSource(row.instructions, MAX_COMBINED_INSTRUCTIONS_CHARS) || undefined,
    failureLog: [], oneByOneSubgoalByStep: new Map(), identicalFailureStreak: 0, recoveryAttemptsByStep: new Map(),
    limitContinuationsUsed: 0,
    grantedExtraTimeMs: 0,
  };
  // v1.0.14 §2.2 — publish the resolved queueing policy onto the handle so
  // injectEvent can reject (observably) extra events while one is pending.
  handle.queueingDisabled = !config.allowMultipleEvents;

  // v1.0.6 §11.9 — resume support: a task re-created as paused waits at the
  // first safe point; paused flag is mirrored into the persisted state.
  if (handle.pauseFlag.paused) state.paused = true;

  // v1.1.0 §2/§3 — PRIOR-TASK CONTEXT (Continue Task / fork-from-recent):
  // a bounded, relevance-selected block from the source task travels as a
  // delimited instructions section (never the unbounded raw history, never
  // replayed tool calls).
  const sourceTaskId = config.continuationOfTaskId ?? config.forkedFromTaskId;
  if (sourceTaskId) {
    const prior = await buildPriorContext(sourceTaskId, config.contextOptions ?? {});
    if (prior) {
      const relation = config.continuationOfTaskId ? 'continuation of' : 'forked from';
      ctx.instructions = [prior.block, ctx.instructions].filter(Boolean).join('\n\n');
      void emitEvent({
        taskId, type: 'task.context_seeded', source: 'runtime',
        message: `Prior task context attached (${relation} ${prior.sourceTaskId}, status ${prior.sourceStatus})${prior.truncated ? ' — truncated to the configured limit' : ''}.`,
        data: {
          relation,
          sourceTaskId: prior.sourceTaskId,
          sourceStatus: prior.sourceStatus,
          truncated: prior.truncated,
          inheritedSkills: config.contextOptions?.skills === false ? [] : prior.selectedSkills,
        },
        priority: 6,
      });
      // §12.3 — inherit the source skill selection by default when the new
      // task did not specify its own skills.
      if (!config.skills && prior.selectedSkills.length > 0) {
        config.skills = prior.selectedSkills;
        config.skillsMode = 'manual';
      }
    } else {
      void emitEvent({
        taskId, type: 'task.context_seeded', source: 'runtime',
        message: `Prior task ${sourceTaskId} could not be read — no context was attached.`,
        data: { sourceTaskId },
        priority: 7,
      });
    }
  }

  // v1.0.16 §10.3 / v1.1.0 §8 — SKILLS, progressive loading with the new
  // SELECTION MODES: manual (operator picks from the Task Console), auto
  // (deterministic selection — v1.0.16 behavior), auto+manual (both, capped).
  // Disabled/invalid skills are excluded WITH an explanation; the selection is
  // recorded in the persisted skills.selected event so Task Preview can show
  // which skills influenced the task and continuations can inherit it.
  const skillSummaries = listSkillSummaries();
  const skillMetas = listSkills(); // full metadata (enabled + valid) for the manual path
  if (skillSummaries.length > 0) {
    const mode = config.skillsMode ?? 'auto';
    const manual = (config.skills ?? []).filter(Boolean);
    const validManual = manual
      .map((name) => skillMetas.find((s) => s.name === name))
      .filter((s): s is NonNullable<typeof s> => Boolean(s && s.enabled && s.valid));
    const excluded = manual.filter((name) => !validManual.some((s) => s.name === name));
    let names: string[] = [];
    if (mode === 'manual') {
      names = validManual.map((s) => s.name);
    } else if (mode === 'auto+manual') {
      const autoSelected = selectSkillsForTask(request, skillSummaries);
      names = [...new Set([...validManual.map((s) => s.name), ...autoSelected])];
    } else {
      names = selectSkillsForTask(request, skillSummaries);
    }
    const loaded = loadSkillInstructions(names);
    if (loaded.length > 0) {
      ctx.instructions = [ctx.instructions, renderSkillsBlock(loaded)].filter(Boolean).join('\n\n');
      void emitEvent({
        taskId, type: 'skills.selected', source: 'runtime',
        message: `Skills selected for this task (${mode}): ${loaded.map((s) => s.name).join(', ')}.${excluded.length > 0 ? ` Excluded (disabled/invalid/unknown): ${excluded.join(', ')}.` : ''}`,
        data: {
          selected: loaded.map((s) => s.name),
          installed: skillSummaries.map((s) => s.name),
          mode,
          manual: validManual.map((s) => s.name),
          ...(excluded.length > 0 ? { excluded } : {}),
        },
        priority: 6,
      });
    } else if (excluded.length > 0) {
      void emitEvent({
        taskId, type: 'skills.selected', source: 'runtime',
        message: `No skills loaded — requested selection could not be applied (excluded: ${excluded.join(', ')}).`,
        data: { selected: [], installed: skillSummaries.map((s) => s.name), mode, excluded },
        priority: 6,
      });
    }
  }

  await persistTask(taskId, { status: 'running', startedAt: new Date(), config: JSON.stringify(config) });
  void emitEvent({
    taskId, type: 'task.started', source: 'runtime',
    message: `Task started in ${config.mode} mode (reasoning level ${config.reasoningLevel}).`,
    priority: 5,
  });

  try {
    // tool registry + plan
    ctx.toolDefs = await getEnabledToolDefs(config.enabledTools);

    // v1.0.10 §2/§12/§13 — planner strategy selection. The strategy was
    // resolved and persisted at task creation (task override → global default
    // → 'pre-plan'); emit the selection event for the event stream/UI.
    const taskOverride = storedConfig.plannerType === 'pre-plan' || storedConfig.plannerType === 'one-by-one';
    void emitEvent({
      taskId, type: 'planner.mode_selected', source: 'planner',
      message: `Planner mode selected: ${config.plannerType}${taskOverride ? ` (task override; global default: ${settings.defaultPlannerType})` : ` (global default)`}.`,
      data: { plannerType: config.plannerType, taskOverride, globalDefault: settings.defaultPlannerType, prePlanMaxSteps: config.prePlanMaxSteps },
      priority: 6,
    });

    if (config.plannerType === 'one-by-one') {
      // v1.0.10 §4 — ONE-BY-ONE: plan exactly ONE first step. No future list
      // is generated; each subsequent step is planned after the latest
      // observation (runGoalMode/runLiveMode replan hooks).
      await planAndTrackOneByOneStep(ctx, 'Initial step of the task');
      state.plan = ctx.state.plan;
      await persistTask(taskId, { plan: JSON.stringify(state.plan), state: JSON.stringify(state) });
    } else {
      // v1.0.10 §16 — pre-plan with the configurable step limit (default 10,
      // hard max 122; task value resolved against the global setting).
      const plan = await buildPlan(request, state.goal, ctx.toolDefs, config.reasoningLevel, taskId, config.prePlanMaxSteps, ctx.instructions, handle.abortController.signal);
      state.plan = plan.steps;
      state.goal = plan.goal;
      ctx.goal = plan.goal;
      await persistTask(taskId, { goal: plan.goal, plan: JSON.stringify(plan.steps), state: JSON.stringify(state) });
      void emitEvent({
        taskId, type: 'planner.plan', source: 'planner',
        message: `Plan created: ${plan.steps.length} step(s) for goal "${plan.goal}".`,
        data: { goal: plan.goal, steps: plan.steps, plannerType: 'pre-plan' },
        priority: 5,
      });
    }

    const term = config.mode === 'live' ? await runLiveMode(ctx) : await runGoalMode(ctx);

    state.terminationStatus = term.finalStatus === 'completed' ? 'completed' : term.finalStatus;
    state.errorState = term.errorState ?? null;
    await finalize(ctx, term);
  } catch (err) {
    console.error(`[loop] fatal error in task ${taskId}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    await finalize(ctx, {
      finalStatus: 'failed',
      taskStatus: 'failed',
      statusDetail: 'Runtime error.',
      summary: `Runtime error: ${message}`,
      errorState: { code: 'RUNTIME_ERROR', message, stage: 'main' },
    });
  }
}

async function finalize(ctx: RunContext, term: Termination): Promise<void> {
  const durationMs = Date.now() - ctx.startedAtMs;
  // v1.0.10 §32/§33 — task outcome feeds the pattern pipeline (e.g. the
  // early-completion pattern: the first observation proved the goal and the
  // remaining pre-planned steps were discarded). Fire-and-forget.
  void recordTaskOutcomePatterns({
    taskId: ctx.taskId,
    taskMode: ctx.config.mode,
    plannerType: ctx.config.plannerType,
    outcome: term.finalStatus,
    steps: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    planStepsPlanned: ctx.state.plan.length,
    previousActions: ctx.state.previousActions,
    lastObservation: ctx.state.lastObservation,
    request: ctx.request,
  }).catch(() => { /* pattern extraction must never break finalization */ });
  const finalResult: FinalResult = {
    status: term.finalStatus,
    goal: ctx.goal,
    result: {
      summary: term.summary,
      lastObservation: ctx.state.lastObservation,
      artifacts: ctx.artifacts.length > 0 ? ctx.artifacts : undefined,
    },
    steps: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    durationMs,
  };

  ctx.state.terminationStatus = term.finalStatus;
  ctx.state.errorState = term.errorState ?? null;

  const completedAt = new Date();
  await persistTask(ctx.taskId, {
    status: term.taskStatus,
    statusDetail: term.statusDetail ?? null,
    state: JSON.stringify(ctx.state),
    finalResult: JSON.stringify(finalResult),
    error: term.errorState ? JSON.stringify(term.errorState) : null,
    steps: ctx.state.iterationCount,
    toolCalls: ctx.state.toolCallCount,
    durationMs,
    completedAt,
  });

  // v1.1.0 §9.4 — the run handle is released once the task is terminal: no
  // stale entry lingers in the registry (a later stop finalizes through the
  // no-handle path instead of signaling a dead runner). Same globalThis
  // registry nexool.ts owns — accessed directly to avoid an import cycle.
  try {
    const g = globalThis as unknown as { __nextoolRuntime?: { handles?: Map<string, unknown> } };
    g.__nextoolRuntime?.handles?.delete(ctx.taskId);
  } catch {
    /* registry missing — nothing to release */
  }

  void emitEvent({
    taskId: ctx.taskId,
    type: term.taskStatus === 'completed' ? 'task.completed' : term.taskStatus === 'stopped' ? 'task.cancelled' : 'task.failed',
    source: 'runtime',
    message: `Task ${term.taskStatus}${term.statusDetail ? `: ${term.statusDetail}` : ''} — ${term.summary.slice(0, 200)}`,
    data: finalResult as unknown as Record<string, unknown>,
    priority: 3,
  });
}
