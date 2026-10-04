/**
 * /api/confirmations — async confirm() interactions (v1.0.8 §1).
 *
 * GET  ?taskId=… → pending confirmations the console UI should render
 *                   (Task Preview / Live Monitor confirmation cards).
 * POST { confirmId, accepted } → resolve a pending confirmation with the
 *                   user's boolean decision. The waiting tool ALWAYS receives
 *                   a boolean; cancellation/timeout resolve false (§1.4).
 *
 * A waiting confirmation pauses ONLY its tool (the promise pends with a 120s
 * window) — the NexTool runtime keeps processing everything else.
 *
 * Events: tool.confirm.requested on request, tool.confirm.responded on the
 * answer — each carries taskId/executionId/toolName + the request/response
 * payload so the UI can associate the response with task/execution/tool.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingConfirmations, resolvePendingConfirmation } from '@/lib/nexool/tools/sandbox-interactive';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    confirmId: z.string().trim().min(1).max(120),
    /** true = Confirm, false = Cancel/Deny. Required — never implicit. */
    accepted: z.boolean(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ confirmations: listPendingConfirmations(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { confirmId, accepted } = parsed.data;
  const resolved = resolvePendingConfirmation(confirmId, accepted);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Confirmation not found or already resolved (or expired).' });
  }
  return ok({ resolved: true });
}
