/**
 * GET /api/stream — SSE real-time event stream.
 * Query: taskId (filter), since (ISO or epoch ms to replay).
 */
import { buildEventStream } from '@/lib/nexool/stream/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get('taskId') ?? undefined;
  const sinceRaw = url.searchParams.get('since') ?? undefined;

  let since: string | undefined;
  if (sinceRaw) {
    const asNum = Number(sinceRaw);
    since = Number.isFinite(asNum) && sinceRaw.trim() !== '' && !sinceRaw.includes('-')
      ? new Date(asNum).toISOString()
      : sinceRaw;
  }

  return buildEventStream(req, taskId || undefined, since);
}
