/**
 * GET /api/tasks/[id]/events — task event list.
 *
 * TWO modes (v1.0.16 §4.2):
 *  - ?page=1      → PAGINATED page payload { items, nextCursor, hasMore,
 *                    totalCount }: the MOST RECENT `limit` (default 40)
 *                    events, ascending inside the page; `before=<eventId>`
 *                    fetches the next-older 40-item page. Stable id cursor
 *                    (evt_<time36> ids are chronologically ordered).
 *  - default      → legacy flat ascending list (`since` + `limit`) kept for
 *                    API compatibility (older clients, backfills).
 */
import { ok } from '@/lib/nexool/api-helpers';
import { queryEvents, queryEventsPage } from '@/lib/nexool/eventbus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);

  if (url.searchParams.get('page') === '1') {
    const before = url.searchParams.get('before') ?? undefined;
    const limit = Number(url.searchParams.get('limit') ?? 40);
    const page = await queryEventsPage({
      taskId: id,
      before: before || undefined,
      limit: Number.isFinite(limit) ? limit : 40,
    });
    return ok(page);
  }

  const since = url.searchParams.get('since') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 200);
  const events = await queryEvents({
    taskId: id,
    since,
    limit: Number.isFinite(limit) ? limit : 200,
  });
  return ok(events);
}
