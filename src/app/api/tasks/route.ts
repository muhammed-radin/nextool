/**
 * /api/tasks — GET list (filters status/mode/limit), POST create+start.
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { createTask, listTasks } from '@/lib/nexool/main/nexool';
import type { TaskConfig } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const mode = url.searchParams.get('mode') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const tasks = await listTasks({
    status: status || undefined,
    mode: mode || undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return ok(tasks);
}

interface CreateBody {
  request?: string;
  config?: Partial<TaskConfig>;
  mode?: string;
  reasoningLevel?: number;
}

export async function POST(req: Request) {
  const body = await readJson<CreateBody>(req);
  if (!body || typeof body.request !== 'string' || !body.request.trim()) {
    return fail('INVALID_REQUEST', 'request (non-empty string) is required');
  }
  const config: Partial<TaskConfig> = { ...(body.config ?? {}) };
  if (body.mode === 'goal' || body.mode === 'live') config.mode = body.mode;
  if (typeof body.reasoningLevel === 'number') {
    config.reasoningLevel = Math.min(6, Math.max(1, Math.round(body.reasoningLevel))) as TaskConfig['reasoningLevel'];
  }

  try {
    const detail = await createTask(body.request, config);
    return ok(detail, 201);
  } catch (err) {
    return fail('TASK_CREATE_FAILED', err instanceof Error ? err.message : 'Failed to create task', 400);
  }
}
