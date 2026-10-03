/**
 * GET /api/tasks/[id]/context — ContextComposition (previous + delta + observation + memory + history).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { getTaskDetail } from '@/lib/nexool/main/nexool';
import { db } from '@/lib/db';
import type { ContextComposition } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTaskDetail(id);
  if (!task) return fail('NOT_FOUND', `Task not found: ${id}`, 404);

  const state = task.state;
  const observations = state.observations ?? [];

  // previous context: the state as of before the latest observation (derived from real state history)
  const previousContext: Record<string, unknown> = {
    goal: state.goal,
    mode: state.mode,
    iteration: Math.max(0, state.iterationCount - 1),
    toolCalls: Math.max(0, state.toolCallCount - 1),
    previousObservation: observations.length >= 2 ? observations[observations.length - 2].message : null,
    previousAction: (state.previousActions ?? []).length >= 2
      ? state.previousActions[state.previousActions.length - 2]
      : null,
  };

  // delta: what actually changed with the latest step
  const delta: Record<string, unknown> = {
    newObservation: observations.length > 0 ? observations[observations.length - 1].message : null,
    lastAction: (state.previousActions ?? []).length > 0 ? state.previousActions[state.previousActions.length - 1] : null,
    iterationDelta: 1,
    activeSubgoal: state.activeSubgoal?.title ?? null,
  };

  const observation: Record<string, unknown> | null = state.lastObservation
    ? { message: state.lastObservation, at: observations.length > 0 ? observations[observations.length - 1].at : null }
    : null;

  let memory: Record<string, unknown>[] = [];
  if (task.config.useMemory !== false) {
    const rows = await db.memoryEntry.findMany({ orderBy: { updatedAt: 'desc' }, take: 5 });
    memory = rows.map((r) => {
      let value: unknown = r.value;
      try { value = JSON.parse(r.value); } catch { /* keep raw */ }
      return { key: r.key, value, tags: r.tags, updatedAt: r.updatedAt.toISOString() } as Record<string, unknown>;
    });
  }

  const historyRows = await db.historyEntry.findMany({
    where: { taskId: id },
    orderBy: { timestamp: 'desc' },
    take: 5,
  });
  const history: Record<string, unknown>[] = historyRows.map((r) => {
    let result: unknown = null;
    try { result = r.result ? JSON.parse(r.result) : null; } catch { /* keep raw */ }
    return { action: r.action, status: r.status, result, timestamp: r.timestamp.toISOString() };
  });

  const composition: ContextComposition = {
    previousContext,
    delta,
    observation,
    memory,
    history,
    assembledAt: new Date().toISOString(),
  };
  return ok(composition);
}
