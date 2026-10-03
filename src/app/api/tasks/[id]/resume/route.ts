/**
 * POST /api/tasks/[id]/resume — continue a paused task from its preserved
 * state (v1.0.6 §11.8). Never restarts the task from the beginning.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { resumeTask } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await resumeTask(id);
  if (!detail) return fail('NOT_FOUND', `Task not found: ${id}`, 404);
  return ok(detail);
}
