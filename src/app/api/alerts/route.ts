/**
 * /api/alerts — interactive tool alert() dialogs (v1.0.14 §20).
 *
 * GET  ?taskId=… → pending alerts the console/editor should render.
 * POST { alertId } → dismiss (OK) a pending alert; the awaiting tool resumes.
 *
 * An alert pauses ONLY its tool until the operator dismisses it (or the
 * 120s window auto-dismisses) — the NexTool runtime keeps running.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingAlerts, resolvePendingAlert } from '@/lib/nexool/tools/sandbox-interactive';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    alertId: z.string().trim().min(1).max(120),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ alerts: listPendingAlerts(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { alertId } = parsed.data;
  const resolved = resolvePendingAlert(alertId);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Alert not found or already dismissed (or expired).' });
  }
  return ok({ resolved: true });
}
