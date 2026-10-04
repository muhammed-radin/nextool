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

  // v1.0.4 §23/§24 — BACKEND tool-selection validation (defense in depth):
  // every task must carry at least one selected tool. The zod schema already
  // rejects an explicit empty array; this check rejects a MISSING list too,
  // so raw API calls cannot bypass the console's requirement.
  if (!Array.isArray(config.enabledTools) || config.enabledTools.length < 1) {
    return fail('TOOLS_REQUIRED', 'Select at least one tool before running the task.', 400);
  }

  try {
    // v1.0.12 Phase 7 — the two instruction sources (uploaded .md content +
    // textarea) travel to the service, which combines them deterministically
    // and persists the result on the Task row.
    const detail = await createTask(body.request, config, body.instructions);
    return ok(detail, 201);
  } catch (err) {
    return fail('TASK_CREATE_FAILED', err instanceof Error ? err.message : 'Failed to create task', 400);
  }
}
