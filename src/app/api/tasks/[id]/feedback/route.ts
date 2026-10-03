/**
 * POST /api/tasks/[id]/feedback — user correction event.
 * Body validated with taskFeedbackSchema (zod) — v1.0.1 §54.
 * Persists a TaskEvent and injects a 'user.feedback' runtime event (priority 2 → wakes live mode).
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { injectEvent } from '@/lib/nexool/main/nexool';
import { getTaskDetail } from '@/lib/nexool/main/nexool';
import { taskFeedbackSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, taskFeedbackSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const task = await getTaskDetail(id);
  if (!task) return fail('NOT_FOUND', `Task not found: ${id}`, 404);

  const event = await injectEvent(
    id,
    'user.feedback',
    {
      message: body.message,
      correctAction: body.correctAction || undefined,
    },
    2,
    'user',
  );
  return ok(event, 201);
}
