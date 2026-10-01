/**
 * NexTool Main Loop — Goal Mode + Live Mode orchestration.
 * UNDERSTAND → PLAN → SELECT TOOL → GENERATE PARAMS → EXECUTE → OBSERVE → UPDATE STATE → REPLAN → COMPLETE
 */
import { db } from '@/lib/db';
import { emitEvent } from '../eventbus';
import { getSettings } from '../settings';
import { getEnabledToolDefs } from '../tools/registry';
import { executeTool } from '../tools/executor';
import { decide } from '../core/coremodule';
import { buildPlan } from './planner';
import { interpret, checkGoalComplete } from './observer';
import { listServers } from '../environment';
import type {
  MainState, PlanStep, Subgoal, TaskConfig, ToolDefinition, ToolExecution, NexToolEvent, FinalResult,
} from '../types';
import type { TaskMode } from '../types';

const RESTART_SETTLE_MS = 2700;

// ---------- run handle (passed in from nexool.ts) ----------

export interface WakePayload {
  reason: 'timeout' | 'event';
  event?: NexToolEvent;
}

export interface TaskRunHandle {
  stopFlag: { stopped: boolean };
  abortController: AbortController;
  wake: ((payload: WakePayload) => void) | null;
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
}

function mergeConfig(stored: Partial<TaskConfig>, settings: Awaited<ReturnType<typeof getSettings>>): ResolvedTaskConfig {
  const safetyLimit = clampNum(stored.safetyLimit, settings.safetyLimit, 1, 500);
  const maxSubtoolCalls = Math.min(clampNum(stored.maxSubtoolCalls, settings.maxSubtoolCalls, 1, 200), safetyLimit);
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
    maxIterations: clampNum(stored.maxIterations, settings.maxIterations, 1, 200),
    taskTimeoutMs: clampNum(stored.taskTimeoutMs, settings.taskTimeoutMs, 5_000, 3_600_000),
    toolTimeoutMs: clampNum(stored.toolTimeoutMs, settings.toolTimeoutMs, 1_000, 300_000),
    liveIntervalMs: clampNum(stored.liveIntervalMs, settings.liveIntervalMs, 1_000, 3_600_000),
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

  const execution = await executeTool(decision.tool, decision.params, {
    timeoutMs: ctx.config.toolTimeoutMs,
    taskId: ctx.taskId,
    signal: ctx.handle.abortController.signal,
  });
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
  await persistTask(ctx.taskId, {
    state: JSON.stringify(ctx.state),
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

    // PARALLEL EXECUTION (spec §10): ≥2 consecutive pending action steps sharing parallelGroup
    if (!ctx.state.activeSubgoal && group.length >= 2 && ctx.config.autoExecuteSubtools) {
      const cap = Math.min(group.length, ctx.config.maxSubtoolCalls);
      const slice = group.slice(0, cap);
      const decisions = await Promise.all(
        slice.map(async (step) => ({ step, decision: await decideForStep(ctx, step) })),
      );
      if (decisions.every((d) => d.decision.status === 'tool_call' && d.decision.tool)) {
        const executions = await Promise.all(
          decisions.map((d) =>
            executeTool(d.decision.tool as string, d.decision.params, {
              timeoutMs: ctx.config.toolTimeoutMs, taskId: ctx.taskId, signal: ctx.handle.abortController.signal,
            }),
          ),
        );
        executions.forEach((execution, i) => {
          const observation = interpret(execution.tool, execution, { goal: ctx.goal });
          recordExecution(ctx, execution.tool, { execution, observation });
          markStepByExecution(ctx.state.plan, decisions[i].step.id, execution.status);
        });
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

  // environment-driven recovery (spec §71)
  const goalMentionsMonitoring = /monitor|recover|production|prod|api|server|health|web|db/i.test(ctx.goal);
  const unhealthy = listServers().filter((s) => s.health === 'unhealthy' || s.health === 'degraded');
  if (goalMentionsMonitoring && unhealthy.length > 0) {
    for (const server of unhealthy) {
      if (ctx.handle.stopFlag.stopped) return;
      await runRepairPasses(ctx, server.id);
    }
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

  // live tasks park in 'waiting' while between cycles
  await persistTask(ctx.taskId, { status: 'waiting' });
  void emitEvent({
    taskId: ctx.taskId, type: 'task.waiting', source: 'runtime',
    message: `Live task waiting — scheduled tick every ${config.liveIntervalMs}ms plus event-driven wake-ups.`,
    priority: 7,
  });
  await persistState(ctx);

  while (true) {
    if (ctx.handle.stopFlag.stopped) break;

    const wake = await waitWithEvents(config.liveIntervalMs, ctx.handle);
    if (ctx.handle.stopFlag.stopped) break;

    const cycleDeadline = Date.now() + config.taskTimeoutMs;

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
      void emitEvent({
        taskId: ctx.taskId, type: 'observer.event_wake', source: 'observer',
        message: `Woken by event: ${event.type} (priority ${event.priority}).`,
        data: { eventId: event.id, type: event.type },
        priority: 5,
      });

      if (event.type === 'task.stop') break;

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
  };

  const ctx: RunContext = {
    taskId, request, goal: state.goal, config, toolDefs: [], state, handle, startedAtMs, artifacts: [],
  };

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
