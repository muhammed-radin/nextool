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
 *
 * v1.0.16 §4 — INCREMENTAL 40-ITEM LOADING:
 *   ?page=1              → { items, nextCursor, hasMore, totalCount }
 *   ?page=1&before=<ts>  → the next-OLDER page (cursor = the oldest timestamp
 *                          of the previous page, exclusive; an id tiebreaker
 *                          keeps rows with identical timestamps stable).
 *   default              → legacy flat ascending list (kept for API
 *                          compatibility). The legacy list now returns the
 *                          NEWEST 200 rows (asc) — previously it returned the
 *                          OLDEST 200 and silently dropped the most recent
 *                          executions once a task passed 200 tool calls.
 * History rows are the authoritative terminal records and are paginated;
 * `tool.*` events are fetched for the RECENT window only (in-flight runs +
 * fresh completions) — completed history rows win the merge regardless.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { mergeExecutionRecords } from '@/lib/nexool/execution-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_DEFAULT = 40;
const PAGE_MAX = 200;
const RECENT_EVENT_WINDOW = 150;

type HistoryRow = {
  id: string; action: string; params: string | null; result: string | null;
  status: string | null; timestamp: Date; batchId: string | null; parallelGroup: number | null;
};

function toExecutions(rows: HistoryRow[], events: { type: string; data: string | null; createdAt: Date }[]) {
  return mergeExecutionRecords(
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
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const paginated = url.searchParams.get('page') === '1';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? PAGE_DEFAULT) || PAGE_DEFAULT, 1), PAGE_MAX);

    // recent tool.* window (in-flight records for the live merge)
    const recentEventsDesc = await db.taskEvent.findMany({
      where: { taskId: id, type: { startsWith: 'tool.' } },
      orderBy: { createdAt: 'desc' },
      take: RECENT_EVENT_WINDOW,
      select: { type: true, data: true, createdAt: true },
    });
    const recentEvents = [...recentEventsDesc].reverse();

    if (paginated) {
      const before = url.searchParams.get('before');
      const cursor = before ? new Date(before) : null;
      const validCursor = cursor !== null && !Number.isNaN(cursor.getTime()) ? cursor : null;

      const where = validCursor
        ? {
            taskId: id,
            action: { contains: '.' },
            OR: [
              { timestamp: { lt: validCursor } },
              { AND: [{ timestamp: { equals: validCursor } }, { id: { lt: (before as string).split('|')[1] ?? '' } }] },
            ],
          }
        : { taskId: id, action: { contains: '.' } };

      const [rowsDesc, totalCount] = await Promise.all([
        db.historyEntry.findMany({
          where,
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        }),
        db.historyEntry.count({ where: { taskId: id, action: { contains: '.' } } }),
      ]);
      const hasMore = rowsDesc.length > limit;
      const pageDesc = hasMore ? rowsDesc.slice(0, limit) : rowsDesc;
      const rows = [...pageDesc].reverse(); // chronological inside the page
      const oldest = rows[0];
      const items = toExecutions(rows, recentEvents);

      return ok({
        items,
        nextCursor: hasMore && oldest ? `${oldest.timestamp.toISOString()}|${oldest.id}` : null,
        hasMore,
        totalCount,
      });
    }

    // legacy flat list — NEWEST 200 rows, ascending (see header note)
    const rowsDesc = await db.historyEntry.findMany({
      where: { taskId: id, action: { contains: '.' } },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    const rows = [...rowsDesc].reverse();
    const executions = toExecutions(rows, recentEvents);
    return ok(executions);
  } catch (err) {
    console.error('[executions] load failed:', err);
    return fail('EXECUTIONS_LOAD_FAILED', err instanceof Error ? err.message : 'Failed to load executions', 500);
  }
}
