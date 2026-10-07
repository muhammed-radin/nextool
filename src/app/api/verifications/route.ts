/**
 * /api/verifications — the VERIFICATION LATCH (NexTool v1.0.13).
 *
 * GET  ?taskId=… → pending result verifications the console UI should render
 *                  (Live Monitor / Task Preview verification cards).
 * POST { verificationId, accepted, feedback? } → resolve a pending
 *        verification with the operator's decision:
 *          accepted=true  → the held execution completes normally.
 *          accepted=false → the execution is recorded as FAILED with the
 *                           structured error VERIFICATION_REJECTED; the
 *                           optional feedback becomes an observer event.
 *
 * The latch is a REVIEW gate, not a security gate: after the 5-minute
 * window an unanswered verification AUTO-VERIFIES with a warning event —
 * an absent operator never destroys automation (documented difference from
 * approval §9.7, where a timeout STOPS the task).
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingVerifications, resolveVerification } from '@/lib/nexool/verification';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    verificationId: z.string().trim().min(1).max(120),
    /** true = Verify the result, false = Reject it. Required — never implicit. */
    accepted: z.boolean(),
    /** Optional operator feedback (recorded as an observer event; on
     *  rejection it explains WHAT was wrong with the result). */
    feedback: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ verifications: listPendingVerifications(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { verificationId, accepted, feedback } = parsed.data;
  const resolved = await resolveVerification(verificationId, accepted, feedback);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Verification not found or already resolved/expired.' });
  }
  return ok({ resolved: true });
}
