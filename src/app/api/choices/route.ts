/**
 * /api/choices — askForUserAsChoice() interactions (NexTool v1.0.13).
 *
 * GET  ?taskId=… → pending choice questions the console UI should render
 *                  (Live Monitor / Task Preview choice cards with one button
 *                  per offered option).
 * POST { choiceId, value? , cancel? } → answer/cancel a pending choice.
 *        `value` MUST exactly match one of the offered option values — the
 *        runtime rejects any fabricated answer with resolved:false.
 *
 * A waiting choice pauses ONLY its tool (the promise pends with a 120s
 * window; expiry resolves null) — the NexTool runtime keeps processing
 * everything else.
 *
 * Events: tool.user_choice.requested on request, tool.user_choice.responded
 * on the answer — each carries taskId/executionId/toolName + the request/
 * response payload so the UI can associate the answer with
 * task/execution/tool.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingChoices, resolvePendingChoice } from '@/lib/nexool/tools/sandbox-interactive';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    choiceId: z.string().trim().min(1).max(120),
    /** Must EXACTLY match one of the offered option values (when not cancelling). */
    value: z.string().trim().min(1).max(120).optional(),
    cancel: z.boolean().optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ choices: listPendingChoices(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { choiceId, value, cancel } = parsed.data;
  const resolved = resolvePendingChoice(choiceId, cancel ? null : (value ?? null));
  if (!resolved) {
    return ok({ resolved: false, reason: 'Choice not found, already resolved/expired, or the value does not match any offered option.' });
  }
  return ok({ resolved: true });
}
