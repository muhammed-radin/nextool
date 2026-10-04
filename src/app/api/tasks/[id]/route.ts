/**
 * GET /api/tasks/[id] — TaskDetail (parsed config/state/plan/finalResult).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { getTaskDetail } from '@/lib/nexool/main/nexool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getTaskDetail(id);
  if (!detail) return fail('NOT_FOUND', `Task not found: ${id}`, 404);
  return ok(detail);
}
