/**
 * NexToolRuntime — singleton task manager (globalThis-backed).
 */
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { emitEvent, getMetrics } from '../eventbus';
import { getSettings } from '../settings';
import { getGlobalLiveState } from '../environment';
import { runTask, type TaskRunHandle, type WakePayload } from './loop';
import { cancelPendingApprovalsForTask, listPendingApprovals } from '../approval';
import { cancelPendingPromptsForTask, cancelPendingConfirmationsForTask } from '../tools/sandbox-interactive';
import type {
  TaskConfig, TaskSummary, MainState, PlanStep, FinalResult, NexToolEvent, EventSource,
} from '../types';
import type { TaskDetail } from '../api-contract';

const g = globalThis as unknown as { __nextoolRuntime?: { handles: Map<string, TaskRunHandle> } };

function runtimeState(): { handles: Map<string, TaskRunHandle> } {
  if (!g.__nextoolRuntime) {
    g.__nextoolRuntime = { handles: new Map() };
  }
  return g.__nextoolRuntime;
}

function newTaskId(): string {
  return `task_${crypto.randomBytes(4).toString('hex')}`;
}

function clamp(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

/** Create + start a task. Returns the TaskDetail of the queued task. */
export async function createTask(
  request: string,
  configPartial: Partial<TaskConfig> = {},
): Promise<TaskDetail> {
  const trimmed = String(request ?? '').trim();
  if (!trimmed) throw new Error('Request must be a non-empty string.');
  if (trimmed.length > 4000) throw new Error('Request too long (max 4000 chars).');

  const settings = await getSettings();

  // config validation — mode is NEVER auto-switched; it is used exactly as provided (default goal)
  const cfg: Partial<TaskConfig> = { ...configPartial };
  if (cfg.mode !== 'goal' && cfg.mode !== 'live') delete cfg.mode;
  if (cfg.reasoningLevel !== undefined) cfg.reasoningLevel = clamp(cfg.reasoningLevel, settings.defaultReasoningLevel, 1, 6) as TaskConfig['reasoningLevel'];
  if (cfg.maxSubtoolCalls !== undefined) cfg.maxSubtoolCalls = clamp(cfg.maxSubtoolCalls, settings.maxSubtoolCalls, 1, 200);
  if (cfg.safetyLimit !== undefined) cfg.safetyLimit = clamp(cfg.safetyLimit, settings.safetyLimit, 1, 500);
  if (cfg.maxSubtoolCalls !== undefined && cfg.safetyLimit !== undefined && cfg.maxSubtoolCalls > cfg.safetyLimit) {
    cfg.maxSubtoolCalls = cfg.safetyLimit;
  }
  if (cfg.maxIterations !== undefined) cfg.maxIterations = clamp(cfg.maxIterations, settings.maxIterations, 1, 200);
  if (cfg.taskTimeoutMs !== undefined) cfg.taskTimeoutMs = clamp(cfg.taskTimeoutMs, settings.taskTimeoutMs, 5_000, 3_600_000);
  if (cfg.toolTimeoutMs !== undefined) cfg.toolTimeoutMs = clamp(cfg.toolTimeoutMs, settings.toolTimeoutMs, 1_000, 3_600_000);
  if (cfg.liveIntervalMs !== undefined) cfg.liveIntervalMs = clamp(cfg.liveIntervalMs, settings.liveIntervalMs, 1_000, 3_600_000);

  const id = newTaskId();
  const mode = cfg.mode ?? settings.defaultMode;
  const level = cfg.reasoningLevel ?? settings.defaultReasoningLevel;

  await db.task.create({
    data: {
      id,
      name: cfg.name ?? null,
      request: trimmed,
      goal: null,
      mode,
      reasoningLevel: level,
      status: 'queued',
      config: JSON.stringify(cfg),
      state: JSON.stringify({}),
    },
  });

  void emitEvent({
    taskId: id,
    type: 'task.created',
    source: 'runtime',
    message: `Task created: "${trimmed.slice(0, 120)}" (${mode} mode).`,
    data: { taskId: id, mode, reasoningLevel: level },
    priority: 6,
  });

  const handle: TaskRunHandle = { stopFlag: { stopped: false }, abortController: new AbortController(), wake: null, pauseFlag: { paused: false }, resumeSignal: null, inbox: [] };
  runtimeState().handles.set(id, handle);

  // fire-and-forget execution
  void runTask(id, handle).catch(async (err) => {
    console.error(`[nexool] task ${id} crashed:`, err);
    try {
      await db.task.update({
        where: { id },
        data: {
          status: 'failed',
          statusDetail: 'Runtime crash.',
          error: JSON.stringify({ code: 'RUNTIME_CRASH', message: err instanceof Error ? err.message : String(err), stage: 'main' }),
          completedAt: new Date(),
        },
      });
      void emitEvent({ taskId: id, type: 'task.failed', source: 'runtime', message: 'Task crashed unexpectedly.', priority: 2 });
    } catch {
      /* ignore */
    }
  });

  const detail = await getTaskDetail(id);
  if (!detail) throw new Error('Task disappeared immediately after creation.');
  return detail;
}

/** Stop a task (goal or live). Wakes live waiting, aborts active tool execution,
 *  and flushes pending approvals/prompts so nothing stays blocked. */
export async function stopTask(taskId: string): Promise<TaskDetail | null> {
  const handle = runtimeState().handles.get(taskId);
  if (handle) {
    handle.stopFlag.stopped = true;
    handle.abortController.abort();
    const event: WakePayload = {
      reason: 'event',
      event: {
        id: `evt_stop_${Date.now().toString(36)}`,
        taskId,
        type: 'task.stop',
        source: 'user',
        message: 'Stop requested by user.',
        priority: 1,
        createdAt: new Date().toISOString(),
      },
    };
    handle.wake?.(event);
  }
  // v1.0.6 — a stopping task never keeps interactive resources pending.
  // v1.0.8 §1.4 — pending confirmations resolve FALSE (never true).
  cancelPendingApprovalsForTask(taskId);
  cancelPendingPromptsForTask(taskId);
  cancelPendingConfirmationsForTask(taskId);
  await emitEvent({
    taskId,
    type: 'task.stop_requested',
    source: 'user',
    message: 'Stop requested by user.',
    priority: 1,
  });
  return getTaskDetail(taskId);
}

/**
 * v1.0.6 §11 — Pause/suspend a running Live (or Goal) task.
 * Preserves task/plan/subgoal/context/Live State/event queue/history and only
 * stops NEW autonomous actions: the current atomic tool execution finishes
 * first (§11.6), the scheduler stops firing (§11.5), and events queue (§11.4).
 * Pause is NOT Stop — nothing is terminated.
 */
export async function pauseTask(taskId: string): Promise<TaskDetail | null> {
  const handle = runtimeState().handles.get(taskId);
  const row = await db.task.findUnique({ where: { id: taskId }, select: { status: true, mode: true } });
  if (!row) return null;
  const active = ['running', 'waiting', 'queued', 'awaiting_approval'].includes(row.status);
  if (!active) return getTaskDetail(taskId);
  if (handle) {
    handle.pauseFlag = { paused: true };
    // Wake the loop so it can enter the paused wait at the next safe point.
    handle.wake?.({ reason: 'paused' });
  }
  await db.task.update({ where: { id: taskId }, data: { status: 'paused', statusDetail: 'Paused by user — resumable.' } });
  const stateRow = await db.task.findUnique({ where: { id: taskId }, select: { state: true } });
  if (stateRow) {
    try {
      const state = JSON.parse(stateRow.state) as MainState;
      state.paused = true;
      await db.task.update({ where: { id: taskId }, data: { state: JSON.stringify(state) } });
    } catch { /* state untouched when unparsable */ }
  }
  await emitEvent({
    taskId,
    type: 'task.paused',
    source: 'user',
    message: 'Task paused — no new planner actions or tool executions until resumed. Queued events are retained.',
    priority: 2,
  });
  return getTaskDetail(taskId);
}

/** v1.0.6 §11.8 — Resume a paused task from its preserved state (never restart). */
export async function resumeTask(taskId: string): Promise<TaskDetail | null> {
  const handle = runtimeState().handles.get(taskId);
  const row = await db.task.findUnique({ where: { id: taskId }, select: { status: true, mode: true } });
  if (!row) return null;
  // A task paused while awaiting approval shows 'awaiting_approval' — the
  // approval REMAINS unresolved on resume (§11.7); only the pause is lifted.
  const approvalPending = listPendingApprovals(taskId).length > 0;
  const paused = row.status === 'paused' || handle?.pauseFlag.paused === true;
  if (!paused || !handle) {
    return getTaskDetail(taskId);
  }
  handle.pauseFlag = { paused: false };
  handle.resumeSignal?.();
  const stateRow = await db.task.findUnique({ where: { id: taskId }, select: { state: true } });
  const nextStatus = approvalPending ? 'awaiting_approval' : row.mode === 'live' ? 'waiting' : 'running';
  await db.task.update({
    where: { id: taskId },
    data: {
      status: nextStatus,
      statusDetail: approvalPending ? 'Waiting for approval to execute the pending tool.' : null,
    },
  });
  if (stateRow) {
    try {
      const state = JSON.parse(stateRow.state) as MainState;
      state.paused = false;
      await db.task.update({ where: { id: taskId }, data: { state: JSON.stringify(state) } });
    } catch { /* ignore */ }
  }
  await emitEvent({
    taskId,
    type: 'task.resumed',
    source: 'user',
    message: 'Task resumed — continuing from the preserved state (queued events are processed next).',
    priority: 3,
  });
  return getTaskDetail(taskId);
}

/** Inject a runtime event into a task. Wakes live mode when priority <= 5. */
export async function injectEvent(
  taskId: string,
  type: string,
  payload?: Record<string, unknown>,
  priority = 5,
  source: EventSource = 'user',
): Promise<NexToolEvent> {
  const event = await emitEvent({
    taskId,
    type,
    source,
    message: typeof payload?.message === 'string' ? payload.message : `Injected event: ${type}`,
    data: payload,
    priority: Math.min(Math.max(Math.round(priority), 1), 9),
  });
  const handle = runtimeState().handles.get(taskId);
  if (handle && event.priority <= 5 && !handle.stopFlag.stopped) {
    // v1.0.6 §10.2 — the event ALWAYS lands in the handle inbox (nothing is
    // lost while the loop is busy/paused/waiting); the wake just interrupts
    // the wait so the loop drains the inbox at the next safe point.
    handle.inbox.push(event);
    handle.wake?.({ reason: 'event' });
  }
  return event;
}

// ---------- queries ----------

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

interface TaskRowLike {
  id: string; name: string | null; request: string; goal: string | null; mode: string;
  reasoningLevel: number; status: string; statusDetail: string | null;
  config: string; state: string; plan: string | null; finalResult: string | null; error: string | null;
  steps: number; toolCalls: number; durationMs: number | null; sessionId: string | null;
  createdAt: Date; startedAt: Date | null; completedAt: Date | null;
}

function toSummary(row: TaskRowLike): TaskSummary {
  const state = parseJson<Partial<MainState>>(row.state, {});
  return {
    id: row.id,
    name: row.name ?? undefined,
    request: row.request,
    goal: row.goal ?? undefined,
    mode: row.mode as TaskSummary['mode'],
    reasoningLevel: row.reasoningLevel,
    status: row.status as TaskSummary['status'],
    statusDetail: row.statusDetail ?? undefined,
    steps: state.iterationCount ?? row.steps,
    toolCalls: state.toolCallCount ?? row.toolCalls,
    durationMs: row.durationMs ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

export function toTaskDetail(row: TaskRowLike): TaskDetail {
  return {
    ...toSummary(row),
    config: parseJson<TaskConfig>(row.config, { mode: 'goal', reasoningLevel: 4 }),
    state: parseJson<MainState>(row.state, {} as MainState),
    plan: parseJson<PlanStep[]>(row.plan, []),
    finalResult: row.finalResult ? (parseJson<unknown>(row.finalResult, null) as FinalResult) : undefined,
    error: row.error ? (parseJson<unknown>(row.error, null) as TaskDetail['error']) : null,
    sessionId: row.sessionId ?? undefined,
  };
}

export async function getTaskDetail(taskId: string): Promise<TaskDetail | null> {
  const row = await db.task.findUnique({ where: { id: taskId } });
  return row ? toTaskDetail(row) : null;
}

export async function listTasks(filters: { status?: string; mode?: string; limit?: number } = {}): Promise<TaskSummary[]> {
  const where: Record<string, unknown> = {};
  if (filters.status) where.status = filters.status;
  if (filters.mode) where.mode = filters.mode;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db.task.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  return rows.map(toSummary);
}

export async function countActiveTasks(): Promise<{ goal: number; live: number }> {
  const running = await db.task.count({ where: { status: 'running' } });
  const waiting = await db.task.count({ where: { status: 'waiting' } });
  const queued = await db.task.count({ where: { status: 'queued' } });
  // v1.0.6 — paused/awaiting_approval tasks are still active (resumable) work.
  const paused = await db.task.count({ where: { status: 'paused' } });
  const rows = await db.task.findMany({
    where: { status: { in: ['running', 'waiting', 'queued', 'paused', 'awaiting_approval'] } },
    select: { mode: true },
  });
  const goal = rows.filter((r) => r.mode === 'goal').length || running + queued;
  const live = rows.filter((r) => r.mode === 'live').length || waiting + paused;
  return { goal: Math.min(goal, running + queued + waiting + paused), live };
}

export async function getGlobalState() {
  const { goal, live } = await countActiveTasks();
  return getGlobalLiveState(goal, live);
}

export function runtimeUptimeSec(): number {
  return Math.round((Date.now() - Date.parse(getMetrics().startedAt)) / 1000);
}
