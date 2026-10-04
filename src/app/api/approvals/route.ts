/**
 * /api/approvals — pending tool-execution approvals (v1.0.6 §9).
 *
 * GET  ?taskId=…  → PendingApproval[] currently blocking tool executions.
 * POST { approvalId, decision: "allow" | "deny", feedback? } → resolve one.
 *
 * Denial feedback (optional) becomes a runtime feedback event (§9.9).
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingApprovals, resolveApproval } from '@/lib/nexool/approval';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(120),
    decision: z.enum(['allow', 'deny']),
    feedback: z.string().trim().max(2000).optional(),
  })
  .strict();

export async function GET(req: Request) {
  const taskId = new URL(req.url).searchParams.get('taskId') ?? undefined;
  return ok({ approvals: listPendingApprovals(taskId ?? undefined) });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, resolveSchema);
  if (parsed.error) return parsed.error;
  const { approvalId, decision, feedback } = parsed.data;
  const resolved = await resolveApproval(approvalId, decision, feedback);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Approval not found or already resolved (or expired).' });
  }
  return ok({ resolved: true, decision });
}
