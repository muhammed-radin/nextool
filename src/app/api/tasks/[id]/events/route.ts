/**
 * GET /api/tasks/[id]/events?since=&limit= — task event list (ascending).
 */
import { ok } from '@/lib/nexool/api-helpers';
import { queryEvents } from '@/lib/nexool/eventbus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 200);
  const events = await queryEvents({
    taskId: id,
    since,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  return ok(events);
}
