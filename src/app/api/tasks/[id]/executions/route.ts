/**
 * GET /api/tasks/[id]/executions — this task's tool executions (from HistoryEntry rows).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import type { ToolExecution, ExecutionStatus } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: ExecutionStatus[] = ['pending', 'running', 'completed', 'failed', 'timeout', 'cancelled'];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db.historyEntry.findMany({
    where: { taskId: id, action: { contains: '.' } },
    orderBy: { timestamp: 'asc' },
    take: 200,
  });

  const executions: ToolExecution[] = rows.map((r) => {
    let params: Record<string, unknown> = {};
    try { params = r.params ? (JSON.parse(r.params) as Record<string, unknown>) : {}; } catch { /* keep empty */ }
    let result: unknown = null;
    try { result = r.result ? JSON.parse(r.result) : null; } catch { /* keep null */ }
    const status = STATUSES.includes(r.status as ExecutionStatus) ? (r.status as ExecutionStatus) : 'failed';
    const ts = r.timestamp.toISOString();
    return {
      executionId: `hist_${r.id}`,
      tool: r.action,
      status,
      params,
      result,
      error: status === 'failed' || status === 'timeout' ? { code: status.toUpperCase(), message: 'See task events for details.' } : null,
      startedAt: ts,
      completedAt: ts,
      // v1.0.3: parallel provenance — Task Preview groups consecutive rows
      // sharing a batchId into one "parallel batch" group.
      ...(r.batchId ? { batchId: r.batchId, parallelGroup: r.parallelGroup ?? undefined } : {}),
    };
  });
  return ok(executions);
}
