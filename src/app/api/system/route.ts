/**
 * GET /api/system — SystemStats for the Dashboard (real runtime + DB data).
 */
import { db } from '@/lib/db';
import { getMetrics } from '@/lib/nexool/eventbus';
import { ok } from '@/lib/nexool/api-helpers';
import os from 'node:os';
import type { SystemStats } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const metrics = getMetrics();
  const memory = process.memoryUsage();

  const [tasksTotal, tasksActive, tasksLive, tasksCompleted, tasksFailed, eventCount, memoryEntries] =
    await Promise.all([
      db.task.count(),
      db.task.count({ where: { status: { in: ['running', 'waiting', 'queued'] } } }),
      db.task.count({ where: { status: 'waiting', mode: 'live' } }),
      db.task.count({ where: { status: 'completed' } }),
      db.task.count({ where: { status: 'failed' } }),
      db.taskEvent.count(),
      db.memoryEntry.count(),
    ]);

  const toolAgg = await db.toolRecord.aggregate({
    _sum: { callCount: true, successCount: true, failureCount: true, totalMs: true },
  });

  const finished = tasksCompleted + tasksFailed;
  const stats: SystemStats = {
    runtimeStatus: 'online',
    runtimeUptimeSec: Math.round((Date.now() - Date.parse(metrics.startedAt)) / 1000),
    engine: {
      active: 'llm-core',
      fallback: 'heuristic-fallback',
      version: '1.0.0',
      coreCalls: metrics.coreCalls,
      avgCoreLatencyMs: metrics.coreCalls > 0 ? Math.round(metrics.totalCoreLatencyMs / metrics.coreCalls) : 0,
      lastDecisionAt: metrics.lastDecisionAt,
    },
    tasks: {
      total: tasksTotal,
      active: tasksActive,
      live: tasksLive,
      completed: tasksCompleted,
      failed: tasksFailed,
      successRate: finished > 0 ? Math.round((tasksCompleted / finished) * 100) / 100 : 0,
    },
    toolCalls: {
      total: toolAgg._sum.callCount ?? 0,
      success: toolAgg._sum.successCount ?? 0,
      failed: (toolAgg._sum.failureCount ?? 0),
      avgMs: (toolAgg._sum.callCount ?? 0) > 0 ? Math.round((toolAgg._sum.totalMs ?? 0) / (toolAgg._sum.callCount ?? 1)) : 0,
    },
    eventCount,
    memoryEntries,
    process: {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
      nodeVersion: process.version,
      platform: os.platform(),
    },
    latencySeries: metrics.coreDecisionSeries,
  };

  return ok(stats);
}
