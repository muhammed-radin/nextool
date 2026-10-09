/**
 * /api/limits/continuations — SAFETY-LIMIT CONTINUATION questions (v1.0.13).
 *
 * GET  ?taskId=… → pending continuation questions the console UI should
 *                  render (Live Monitor / Task Preview continuation cards
 *                  showing the tripped limit, the current numbers and the
 *                  budget that would be granted).
 * POST { continuationId, decision, feedback? } → resolve the question:
 *          'continue' → BOTH maxIterations and safetyLimit grow by the
 *                       reported extraBudget and the task proceeds.
 *          'deny'     → the task ends exactly as before (limit_reached /
 *                       failed, SAFETY_LIMIT) — the honest operator stop.
 *
 * v1.0.16: the response window is 60 SECONDS (backend-enforced timer). After
 * it expires an unanswered question resolves as a timeout and the task stops —
 * the runtime NEVER grows its own budget unattended. Resolution is
 * idempotent-safe (the registry entry is removed first), so duplicate clicks
 * or duplicate API requests cannot extend the same budget twice. Task stop
 * resolves the question as cancelled.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingLimitContinuations, resolveLimitContinuation } from '@/lib/nexool/limit-continuation';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    continuationId: z.string().trim().min(1).max(120),
    /** 'continue' = grant the budget, 'deny' = end the task as before. */
    decision: z.enum(['continue', 'deny']),
    /** Optional operator feedback (recorded as an observer event on denial). */
    feedback: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ continuations: listPendingLimitContinuations(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { continuationId, decision, feedback } = parsed.data;
  const resolved = await resolveLimitContinuation(continuationId, decision, feedback);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Continuation question not found or already resolved/expired.' });
  }
  return ok({ resolved: true });
}
