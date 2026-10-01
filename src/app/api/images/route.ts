/**
 * GET /api/images?limit= — generated image records.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);
  const rows = await db.generatedImage.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  return ok(rows.map((r) => ({
    id: r.id,
    path: r.path,
    prompt: r.prompt,
    size: r.size ?? undefined,
    taskId: r.taskId ?? undefined,
    createdAt: r.createdAt.toISOString(),
  })));
}
