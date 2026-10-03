/**
 * NexTool Main Loop — Goal Mode + Live Mode orchestration.
 * UNDERSTAND → PLAN → SELECT TOOL → GENERATE PARAMS → EXECUTE → OBSERVE → UPDATE STATE → REPLAN → COMPLETE
 */
import { db } from '@/lib/db';
import { emitEvent } from '../eventbus';
import { getSettings } from '../settings';
import { getEnabledToolDefs } from '../tools/registry';
import { executeTool, executeParallelBatch } from '../tools/executor';
import { decide } from '../core/coremodule';
import { buildPlan } from './planner';
import { interpret, checkGoalComplete } from './observer';
import { listServers } from '../environment';
import { resolveAutoExecute, requestApproval } from '../approval';
import { clampToLimit, getResolvedLimits } from '../config-limits';
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
  liveIntervalMs: number;
  parallelToolCalls: boolean;
  maxParallelToolCalls: number;
  /** v1.0.6 §9.4 — resolved auto-execute policy (global → task). */
  autoExecuteTools: boolean;
  /** v1.0.6 §10 — resolved multi-event policy (global → task). */
  allowMultipleEvents: boolean;
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
    liveIntervalMs: clampLimit('task', 'liveIntervalMs', stored.liveIntervalMs, settings.liveIntervalMs),
    parallelToolCalls: stored.parallelToolCalls ?? settings.parallelToolCalls,
    maxParallelToolCalls: clampLimit('task', 'maxParallelToolCalls', stored.maxParallelToolCalls, settings.maxParallelToolCalls),
    // §9.4 precedence: global setting → per-task config → per-tool (per-tool is
    // resolved at execution time against the concrete tool definition).
    autoExecuteTools: stored.autoExecuteTools ?? settings.autoExecuteTools,
    allowMultipleEvents: stored.allowMultipleEvents ?? settings.allowMultipleEvents,
    sessionId: stored.sessionId,
    context: stored.context,
  };
}

function subgoalId(i: number): string {
  return `sg_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`;
}

async function persistTask(taskId: string, data: Record<string, unknown>): Promise<void> {
  try {
    await db.task.update({ where: { id: taskId }, data });
  } catch (err) {
    console.error(`[loop] persist failed for task ${taskId}:`, err);
  }
}

interface RunContext {
  taskId: string;
  request: string;
  goal: string;
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

// ---------- approval (v1.0.6 §9) ----------

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
 * §9.5/§9.6 — approval gate in front of EVERY task-driven tool execution.
 * Returns the resolved outcome WITHOUT executing: 'auto' | 'allowed' mean the
 * caller may execute; 'denied' means skip; 'timeout' means the task must
 * stop; 'cancelled' means the task was stopped while waiting. Nothing
 * silently executes — the caller executes ONLY on 'auto'/'allowed'.
 */
async function requestApprovalIfNeeded(
  ctx: RunContext,
  tool: string,
  params: Record<string, unknown>,
  opts: { purpose?: string; reason?: string } = {},
): Promise<'auto' | 'allowed' | 'denied' | 'timeout' | 'cancelled'> {
  const def = ctx.toolDefs.find((d) => d.name === tool);
  // §9.4 — global/task override already folded into config.autoExecuteTools;
  // otherwise consult the concrete tool definition (documented default false).
  const auto = ctx.config.autoExecuteTools === true || resolveAutoExecute(
    def ?? { autoExecute: undefined },
    { autoExecuteTools: undefined },
    { autoExecuteTools: false },
  );
  if (auto) return 'auto';

  const subgoal = ctx.state.activeSubgoal?.title;
  ctx.state.pendingApproval = {
    approvalId: 'pending',
    tool,
    params,
    purpose: opts.purpose ?? def?.purpose,
    reason: opts.reason,
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

  const outcome = await requestApproval({
    taskId: ctx.taskId,
    tool,
    params,
    purpose: opts.purpose ?? def?.purpose,
    reason: opts.reason,
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
  if (outcome === 'denied') {
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
  opts: { timeoutMs?: number; batch?: { batchId: string; parallelGroup: number }; purpose?: string; reason?: string } = {},
): Promise<ToolExecution> {
  const outcome = await requestApprovalIfNeeded(ctx, tool, params, { purpose: opts.purpose, reason: opts.reason });
  if (outcome === 'auto' || outcome === 'allowed') {
    return executeTool(tool, params, { timeoutMs: opts.timeoutMs ?? ctx.config.toolTimeoutMs, taskId: ctx.taskId, signal: ctx.handle.abortController.signal, batch: opts.batch });
  }
  return deniedExecution(tool, params, outcome === 'denied'
    ? `${tool} was denied by the user — skipped. Dependent steps must not assume this step succeeded.`
    : outcome === 'timeout' ? 'Approval timeout — not executed.' : 'Task stopped while awaiting approval.');
}


/** Read the blocked-stop reason through a helper — property narrowing inside
 *  the run loops would otherwise collapse the truthy branch to `never`. */
function blockedStopReason(ctx: RunContext): string | null {
  return ctx.blockedStop ? ctx.blockedStop.reason : null;
}

// ---------- context bundle ----------


async function buildContextBundle(ctx: RunContext): Promise<{
  memory: Record<string, unknown>[];
  history: Record<string, unknown>[];
  stateSummary: string;
  lastObservation?: string;
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
): Promise<{ decision: Awaited<ReturnType<typeof decide>>; result?: ActionResult }> {
  const bundle = { ...(await buildContextBundle(ctx)), ...contextBundleOverride };

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
  });

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
  const r = result.execution.result as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    if (typeof r.imagePath === 'string') ctx.artifacts.push({ type: 'image', path: r.imagePath });
    if (typeof r.id === 'string' && typeof r.level === 'string') ctx.artifacts.push({ type: 'notification', id: r.id, level: r.level });
  }
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
  try {
    const { default: ZAI } = await import('z-ai-web-dev-sdk');
    const zai = await ZAI.create();
    const res = await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: 'assistant' as const,
            content: [
              'You are the Planner of NexTool. Given the goal and recent observations, determine the next dynamic subgoal.',
              'Output STRICT JSON only, either {"done":true} when nothing further is needed, or {"title":"next subgoal","reason":"one sentence"}.',
            ].join('\n'),
          },
          {
            role: 'user' as const,
            content: JSON.stringify({
              goal: ctx.goal,
              observations: ctx.state.observations.slice(-4),
              planStatuses: ctx.state.plan.map((s) => `${s.title}:${s.status}`),
            }),
          },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10_000)),
    ]);
    const content = res?.choices?.[0]?.message?.content ?? '';
    const cleaned = content.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
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

async function verifyGoal(ctx: RunContext): Promise<boolean> {
  const check = await checkGoalComplete(ctx.goal, ctx.state.lastObservation ?? 'No observation yet.', ctx.config.reasoningLevel, ctx.taskId);
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
  step.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'skipped' : 'failed';
}

// ---------- GOAL MODE ----------

async function runGoalMode(ctx: RunContext): Promise<Termination> {
  const { config } = ctx;
  const startedAt = Date.now();

  while (true) {
    if (ctx.handle.stopFlag.stopped) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Stopped by user.', summary: ctx.state.lastObservation ?? 'Task stopped.' };
    }
    // v1.0.6 §11 — pause at the safe point between iterations.
    await waitWhilePaused(ctx);
    if (ctx.handle.stopFlag.stopped) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: 'Stopped by user.', summary: ctx.state.lastObservation ?? 'Task stopped.' };
    }
    const blockedTop = blockedStopReason(ctx);
    if (blockedTop) {
      return { finalStatus: 'stopped', taskStatus: 'stopped', statusDetail: blockedTop, summary: ctx.state.lastObservation ?? blockedTop };
    }
    if (Date.now() - startedAt > config.taskTimeoutMs) {
      return {
        finalStatus: 'limit_reached', taskStatus: 'failed', statusDetail: 'Task timeout reached.',
        summary: 'Task exceeded the configured timeout.',
        errorState: { code: 'TIMEOUT', message: `Task timeout (${config.taskTimeoutMs}ms) reached.`, stage: 'goal_loop' },
      };
    }
    if (ctx.state.iterationCount >= config.maxIterations || ctx.state.toolCallCount >= config.safetyLimit) {
      return {
        finalStatus: 'limit_reached', taskStatus: 'failed', statusDetail: 'Iteration/safety limit reached.',
        summary: 'Safety limit reached before goal completion.',
        errorState: { code: 'SAFETY_LIMIT', message: 'Iteration or tool-call safety limit reached.', stage: 'goal_loop' },
      };
    }

    // pick objective
    const group = parallelGroupSteps(ctx.state.plan);
    const planExhausted = firstPendingIndex(ctx.state.plan) === -1;

    if (planExhausted && !ctx.state.activeSubgoal) {
      // plan exhausted → dynamic subgoal
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
          } else {
            denied.push({ stepId: d.step.id, tool });
            const deniedExec = deniedExecution(tool, d.decision.params ?? {}, outcome === 'denied'
              ? `${tool} was denied by the user — skipped. Dependent steps must not assume this step succeeded.`
              : 'Task stopped while awaiting approval.');
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
              taskId: ctx.taskId,
              signal: ctx.handle.abortController.signal,
              maxParallel: ctx.config.maxParallelToolCalls,
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
        await persistState(ctx);
        if (await verifyGoal(ctx)) {
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

    // tool_call — execute with ONE retry on failure
    if (!result) {
      // defensive: tool_call without execution
      continue;
    }
    let finalResult = result;
    if (result.execution.status === 'failed' || result.execution.status === 'timeout') {
      void emitEvent({
        taskId: ctx.taskId, type: 'planner.retry', source: 'planner',
        message: `Execution failed (${result.execution.status}); retrying once with error as observation.`,
        data: { tool: result.execution.tool, error: result.execution.error }, priority: 4,
      });
      const retry = await decideAndExecute(ctx, objective, {
        lastObservation: `Previous attempt ${result.execution.status}: ${result.execution.error?.message ?? 'unknown'}`,
      });
      if (retry.result && retry.result.execution.status !== 'failed' && retry.result.execution.status !== 'timeout') {
        finalResult = retry.result;
      } else {
        recordExecution(ctx, result.execution.tool, result);
        if (retry.result) recordExecution(ctx, retry.result.execution.tool, retry.result);
        for (const id of activeStepIds) markStepByExecution(ctx.state.plan, id, 'failed');
        await persistState(ctx);
        const errMsg = retry.result?.execution.error?.message ?? result.execution.error?.message ?? 'unknown error';
        return {
          finalStatus: 'failed', taskStatus: 'failed', statusDetail: `Tool failure after retry: ${errMsg}`,
          summary: ctx.state.lastObservation ?? 'Tool execution failed.',
          errorState: { code: 'TOOL_FAILURE', message: errMsg, stage: 'tool_execution' },
        };
      }
    }

    recordExecution(ctx, finalResult.execution.tool, finalResult);
    for (const id of activeStepIds) markStepByExecution(ctx.state.plan, id, finalResult.execution.status);

    // action fulfilled the active subgoal → mark completed
    if (ctx.state.activeSubgoal && finalResult.execution.status === 'completed') {
      ctx.state.activeSubgoal.status = 'completed';
      ctx.state.activeSubgoal = undefined;
    }
    await persistState(ctx);

    if (await verifyGoal(ctx)) {
      return { finalStatus: 'completed', taskStatus: 'completed', summary: ctx.state.lastObservation ?? 'Goal verified.' };
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
  let health = await executeTool('server.health', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, taskId: ctx.taskId });
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
    const restart = await executeTool('server.restart', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, taskId: ctx.taskId });
    calls += 1;
    recordExecution(ctx, 'server.restart', { execution: restart, observation: interpret('server.restart', restart) });
    await new Promise((res) => setTimeout(res, RESTART_SETTLE_MS));
  }

  // 3) verify
  if (calls < 4) {
    const verify = await executeTool('server.health', { serverId }, { timeoutMs: ctx.config.toolTimeoutMs, taskId: ctx.taskId });
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

async function liveObserveCycle(ctx: RunContext, objective: string): Promise<void> {
  const { decision, result } = await decideAndExecute(ctx, objective);
  if (result) {
    recordExecution(ctx, decision.tool as string, result);
    await persistState(ctx);
  }
  if (ctx.blockedStop) return;

  // environment-driven recovery (spec §71)
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
 *  cap is resolved from the CENTRAL configuration (task.eventQueueCap);
 *  the 16 KiB payload guard is a fixed data-shape policy, not a tunable limit. */
const MAX_EVENT_DATA_BYTES = 16 * 1024;

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

/** §10.2 — accept an event into the queue with the documented drop policy. */
function enqueueLiveEvent(ctx: RunContext, event: NexToolEvent): QueuedLiveEvent | null {
  const queue = stateQueue(ctx);
  // payload guard
  let data = event.data;
  if (data && JSON.stringify(data).length > MAX_EVENT_DATA_BYTES) {
    data = { truncated: true, note: 'Event payload exceeded the 16 KiB queue limit and was reduced to metadata.' };
  }
  const queued: QueuedLiveEvent = {
    seq: ++ctx.eventSeq,
    eventId: event.id,
    type: event.type,
    message: event.message,
    priority: event.priority,
    queuedAt: new Date().toISOString(),
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
      void emitEvent({
        taskId: ctx.taskId, type: 'live.event.dropped', source: 'runtime',
        message: `Event queue full (${cap}) — dropped "${dropped.type}" (priority ${dropped.priority}) for "${event.type}".`,
        data: { dropped: dropped.type, droppedSeq: dropped.seq, incoming: event.type },
        priority: 6,
      });
    } else {
      void emitEvent({
        taskId: ctx.taskId, type: 'live.event.dropped', source: 'runtime',
        message: `Event queue full (${cap}) — incoming "${event.type}" (priority ${event.priority}) was dropped.`,
        data: { incoming: event.type, priority: event.priority },
        priority: 6,
      });
      return null;
    }
  }
  queue.push(queued);
  void emitEvent({
    taskId: ctx.taskId, type: 'live.event.queued', source: 'runtime',
    message: `Event queued: ${event.type} (priority ${event.priority}, seq ${queued.seq}).`,
    data: { seq: queued.seq, eventId: event.id, type: event.type, queueLength: queue.length },
    priority: 6,
  });
  return queued;
}

/**
 * §10.3 — drain the queue ONE-BY-ONE, in deterministic order (§10.4:
 * priority 1 = emergency first, then arrival sequence). No two event-driven
 * action plans ever run concurrently.
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
    void emitEvent({
      taskId: ctx.taskId, type: 'live.event.processing', source: 'runtime',
      message: `Processing queued event: ${current.type} (seq ${current.seq}).`,
      data: { seq: current.seq, type: current.type },
      priority: 6,
    });

    const synthetic: NexToolEvent = {
      id: current.eventId,
      taskId: ctx.taskId,
      type: current.type,
      source: 'environment',
      message: current.message,
      data: current.data,
      priority: current.priority,
      createdAt: current.queuedAt,
    };
    await processLiveEvent(ctx, synthetic);

    current.status = 'processed';
    ctx.state.currentEventSeq = undefined;
    void emitEvent({
      taskId: ctx.taskId, type: 'live.event.processed', source: 'runtime',
      message: `Processed queued event: ${current.type} (seq ${current.seq}).`,
      data: { seq: current.seq, type: current.type },
      priority: 7,
    });
    // §10.7 — trim processed history so the queue stays a QUEUE in state.
    const processed = queue.filter((q) => q.status === 'processed');
    if (processed.length > 10) {
      for (const q of processed.slice(0, processed.length - 10)) {
        const idx = queue.indexOf(q);
        if (idx !== -1) queue.splice(idx, 1);
      }
    }
    await persistState(ctx);
  }
}

/**
 * One event's observe → decide → act cycle (§10.6). Extracted from the
 * v1.0.0-v1.0.5 wake handler so single-event mode and queue processing
 * share EXACTLY the same behavior.
 */
async function processLiveEvent(ctx: RunContext, event: NexToolEvent): Promise<void> {
  const cycleDeadline = Date.now() + ctx.config.taskTimeoutMs;
  void emitEvent({
    taskId: ctx.taskId, type: 'observer.event_wake', source: 'observer',
    message: `Woken by event: ${event.type} (priority ${event.priority}).`,
    data: { eventId: event.id, type: event.type },
    priority: 5,
  });

  if (event.type === 'user.feedback') {
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
    // generic event: one observe cycle bounded by cycle deadline
    if (Date.now() < cycleDeadline) {
      try {
        await liveObserveCycle(ctx, `Event-driven observation (${event.type}): keep making progress on: ${ctx.goal}. Event: ${event.message}`);
      } catch (err) {
        console.error('[loop] event cycle failed:', err);
      }
    }
  }
}

// ---------- live event inbox (v1.0.6 §10.2) ----------

/**
 * Drain events that arrived while the loop was busy/paused/waiting.
 * Multi-event mode: EVERY event is queued and processed one-by-one.
 * Single-event mode (default): the FIRST event is processed now; later
 * simultaneous events are skipped per the documented single-event behavior.
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
    const skipped = inbox.length;
    inbox.length = 0;
    if (skipped > 0) {
      void emitEvent({
        taskId: ctx.taskId, type: 'live.event.dropped', source: 'runtime',
        message: `Single-event mode: ${skipped} simultaneous event(s) skipped while processing ${event.type}.`,
        priority: 7,
      });
    }
    await processLiveEvent(ctx, event);
  }
}

async function runLiveMode(ctx: RunContext): Promise<Termination> {
  const { config } = ctx;

  // initial pass: one full observation cycle before entering the wait loop
  try {
    await liveObserveCycle(ctx, `Initial observation: ${ctx.goal}. Environment state: ${JSON.stringify(listServers())}`);
  } catch (err) {
    console.error('[loop] live initial pass failed:', err);
  }
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
    message: `Live task waiting — scheduled tick every ${config.liveIntervalMs}ms plus event-driven wake-ups${config.allowMultipleEvents ? ' (multi-event mode: incoming events are queued)' : ''}.`,
    priority: 7,
  });
  await persistState(ctx);

  while (true) {
    if (ctx.handle.stopFlag.stopped) break;

    // v1.0.6 §11 — pause at the safe point between cycles. Events arriving
    // while paused accumulate in handle.inbox and are processed after resume.
    await waitWhilePaused(ctx);
    if (ctx.handle.stopFlag.stopped) break;

    // §10.2 — events injected while busy/paused wait in the inbox.
    if (ctx.handle.inbox.length > 0) {
      await drainInbox(ctx);
      if (ctx.handle.stopFlag.stopped || ctx.blockedStop) break;
      continue;
    }
    // §10.5 — queued events persisted in state survive refresh/reconnect/pause.
    if (config.allowMultipleEvents && stateQueue(ctx).some((q) => q.status === 'queued')) {
      await drainEventQueue(ctx);
      if (ctx.handle.stopFlag.stopped || ctx.blockedStop) break;
      continue;
    }

    const wake = await waitWithEvents(config.liveIntervalMs, ctx.handle);
    if (ctx.handle.stopFlag.stopped) break;
    // pause wake-up: loop back to the paused hold (§11 — no new actions).
    if (ctx.handle.pauseFlag.paused) continue;

    if (wake.reason === 'timeout') {
      void emitEvent({
        taskId: ctx.taskId, type: 'observer.scheduled_tick', source: 'runtime',
        message: 'Scheduled observation tick.',
        data: { at: new Date().toISOString() },
        priority: 9,
      });
      const servers = listServers();
      try {
        await liveObserveCycle(
          ctx,
          `Scheduled observation: keep making progress on: ${ctx.goal}. Environment state: ${JSON.stringify(servers)}`,
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

  const ctx: RunContext = { taskId, request, goal: state.goal, config, toolDefs: [], state, handle, startedAtMs, artifacts: [], eventSeq: 0, blockedStop: null };

  // v1.0.6 §11.9 — resume support: a task re-created as paused waits at the
  // first safe point; paused flag is mirrored into the persisted state.
  if (handle.pauseFlag.paused) state.paused = true;

  await persistTask(taskId, { status: 'running', startedAt: new Date(), config: JSON.stringify(config) });
  void emitEvent({
    taskId, type: 'task.started', source: 'runtime',
    message: `Task started in ${config.mode} mode (reasoning level ${config.reasoningLevel}).`,
    priority: 5,
  });

  try {
    // tool registry + plan
    ctx.toolDefs = await getEnabledToolDefs(config.enabledTools);
    const plan = await buildPlan(request, state.goal, ctx.toolDefs, config.reasoningLevel, taskId);
    state.plan = plan.steps;
    state.goal = plan.goal;
    ctx.goal = plan.goal;
    await persistTask(taskId, { goal: plan.goal, plan: JSON.stringify(plan.steps), state: JSON.stringify(state) });
    void emitEvent({
      taskId, type: 'planner.plan', source: 'planner',
      message: `Plan created: ${plan.steps.length} step(s) for goal "${plan.goal}".`,
      data: { goal: plan.goal, steps: plan.steps },
      priority: 5,
    });

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

  void emitEvent({
    taskId: ctx.taskId,
    type: term.taskStatus === 'completed' ? 'task.completed' : term.taskStatus === 'stopped' ? 'task.cancelled' : 'task.failed',
    source: 'runtime',
    message: `Task ${term.taskStatus}${term.statusDetail ? `: ${term.statusDetail}` : ''} — ${term.summary.slice(0, 200)}`,
    data: finalResult as unknown as Record<string, unknown>,
    priority: 3,
  });
}
