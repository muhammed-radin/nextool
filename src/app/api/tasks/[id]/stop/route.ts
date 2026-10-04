/**
 * POST /api/tasks/[id]/stop — cancel a goal/live task + active execution.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { stopTask } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await stopTask(id);
  if (!detail) return fail('NOT_FOUND', `Task not found: ${id}`, 404);
  return ok(detail);
}
