/**
 * GET /api/tasks/[id]/executions — this task's authoritative execution records.
 *
 * v1.0.9 §15 — each tool-call card's status comes from its ACTUAL execution
 * record, never from the parent task's status. Two persisted sources merge:
 *   - HistoryEntry rows (terminal, written when an execution finalizes) —
 *     they carry params/result and the finalized status;
 *   - TaskEvent `tool.*` payloads (live execution records emitted by the tool
 *     executor: tool.started / tool.completed / tool.failed / tool.timeout /
 *     tool.cancelled) — they carry the executor's own record, including
 *     in-flight runs, durationMs, timeoutMs and parallel provenance.
 * Reconciliation (execution-merge.ts): a terminal record ALWAYS beats a
 * running/pending one regardless of arrival order — a replayed stale
 * `tool.started` can never regress a finished execution (§15.9), and
 * parallel-batch members keep their individual statuses (§15.7/§15.8).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { mergeExecutionRecords } from '@/lib/nexool/execution-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [rows, events] = await Promise.all([
      db.historyEntry.findMany({
        where: { taskId: id, action: { contains: '.' } },
        orderBy: { timestamp: 'asc' },
        take: 200,
      }),
      db.taskEvent.findMany({
        where: { taskId: id, type: { startsWith: 'tool.' } },
        orderBy: { createdAt: 'asc' },
        take: 400,
        select: { type: true, data: true, createdAt: true },
      }),
    ]);

    const executions = mergeExecutionRecords(
      rows.map((r) => ({
        id: r.id,
        action: r.action,
        params: r.params,
        result: r.result,
        status: r.status,
        timestamp: r.timestamp,
        batchId: r.batchId,
        parallelGroup: r.parallelGroup,
      })),
      events.map((ev) => ({ type: ev.type, data: ev.data, createdAt: ev.createdAt })),
    );

    return ok(executions);
  } catch (err) {
    console.error('[executions] load failed:', err);
    return fail('EXECUTIONS_LOAD_FAILED', err instanceof Error ? err.message : 'Failed to load executions', 500);
  }
}
