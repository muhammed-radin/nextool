/**
 * /api/notifications — GET list (?limit=), POST /read-all marks all read.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
  const rows = await db.notificationRecord.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return ok(rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    source: r.source,
    taskId: r.taskId ?? undefined,
    level: r.level as 'info' | 'warning' | 'critical',
    read: r.read,
    createdAt: r.createdAt.toISOString(),
  })));
}

export async function POST() {
  await db.notificationRecord.updateMany({ data: { read: true } });
  return ok({ ok: true });
}
