/**
 * POST /api/tasks/[id]/event — inject a runtime event (wakes live mode when priority <= 5).
 * Body validated with taskEventSchema (zod) — v1.0.1 §54.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { injectEvent } from '@/lib/nexool/main/nexool';
import { taskEventSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, taskEventSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const event = await injectEvent(
    id,
    body.type,
    body.payload ?? {},
    body.priority ?? 5,
    body.source ?? 'user',
  );
  return ok(event, 201);
}
