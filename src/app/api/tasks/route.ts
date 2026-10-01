/**
 * /api/tasks — GET list (filters status/mode/limit), POST create+start.
 * POST body is validated with createTaskSchema (zod) — v1.0.1 §54.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { createTask, listTasks } from '@/lib/nexool/main/nexool';
import { createTaskSchema } from '@/lib/nexool/schemas';
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

export async function POST(req: Request) {
  const parsed = await parseBody(req, createTaskSchema, 'INVALID_REQUEST');
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const config = { ...(body.config ?? {}) } as Partial<TaskConfig>;
  if (body.mode) config.mode = body.mode;
  if (typeof body.reasoningLevel === 'number') {
    // zod already guarantees int 1..6 — narrow the union here.
    config.reasoningLevel = body.reasoningLevel as TaskConfig['reasoningLevel'];
  }

  try {
    const detail = await createTask(body.request, config);
    return ok(detail, 201);
  } catch (err) {
    return fail('TASK_CREATE_FAILED', err instanceof Error ? err.message : 'Failed to create task', 400);
  }
}
