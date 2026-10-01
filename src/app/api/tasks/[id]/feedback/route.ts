/**
 * POST /api/tasks/[id]/feedback — user correction event.
 * Body: { message: string, correctAction?: string }
 * Persists a TaskEvent and injects a 'user.feedback' runtime event (priority 2 → wakes live mode).
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { injectEvent } from '@/lib/nexool/main/nexool';
import { getTaskDetail } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  message?: string;
  correctAction?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<Body>(req);
  if (!body?.message || typeof body.message !== 'string' || !body.message.trim()) {
    return fail('INVALID_PARAMS', 'message (string) is required');
  }
  const task = await getTaskDetail(id);
  if (!task) return fail('NOT_FOUND', `Task not found: ${id}`, 404);

  const event = await injectEvent(
    id,
    'user.feedback',
    {
      message: body.message.trim(),
      correctAction: body.correctAction?.trim() || undefined,
    },
    2,
    'user',
  );
  return ok(event, 201);
}
