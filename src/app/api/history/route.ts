/**
 * GET /api/history?taskId=&limit= — execution history entries (max 200).
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit') ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 100, 1), 200);

  const rows = await db.historyEntry.findMany({
    where: taskId ? { taskId } : undefined,
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return ok(rows.map((r) => {
    let params: unknown = undefined;
    try { params = r.params ? JSON.parse(r.params) : undefined; } catch { params = r.params; }
    let result: unknown = undefined;
    try { result = r.result ? JSON.parse(r.result) : undefined; } catch { result = r.result; }
    return {
      id: r.id,
      taskId: r.taskId ?? undefined,
      action: r.action,
      params,
      result,
      status: r.status,
      timestamp: r.timestamp.toISOString(),
    };
  }));
}
