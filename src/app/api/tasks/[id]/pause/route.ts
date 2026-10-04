/**
 * POST /api/tasks/[id]/pause — suspend a running task (v1.0.6 §11).
 * Pause preserves task/plan/subgoal/context/Live State/event queue/history;
 * only NEW autonomous actions stop. Distinct from stop (termination).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { pauseTask } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await pauseTask(id);
  if (!detail) return fail('NOT_FOUND', `Task not found: ${id}`, 404);
  return ok(detail);
}
