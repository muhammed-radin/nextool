/**
 * /api/approvals — pending tool-execution approvals (v1.0.6 §9 / v1.0.15 §31-§36).
 *
 * GET  ?taskId=…  → PendingApproval[] currently blocking tool executions
 *                   (each with its explicit state, default 'pending').
 * POST { approvalId, decision: "accept" | "skip" | "reject", feedback? }
 *                 → resolve one.
 *
 * v1.0.15 §31-§34 — THREE operator choices (wire names in parentheses):
 *   ACCEPT (allow) — execute the requested tool normally, continue the plan.
 *   SKIP   (skip)  — do not execute; execution recorded `skipped`; the plan
 *                    continues to the next logical step (never burns the
 *                    denial ladder).
 *   REJECT (deny)  — do not execute; execution blocked; the planner must
 *                    revise the plan or stop (v1.0.13 denial ladder).
 * Feedback (optional) becomes a runtime feedback event (§9.9).
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { listPendingApprovals, resolveApproval } from '@/lib/nexool/approval';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const resolveSchema = z
  .object({
    approvalId: z.string().trim().min(1).max(120),
    // v1.0.15 — operator-facing verbs; 'allow'/'deny' stay accepted for
    // backwards compatibility with older console clients.
    decision: z.enum(['accept', 'skip', 'reject', 'allow', 'deny']),
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
  // Normalize operator verbs → wire decisions (§31-§34).
  const wire = decision === 'accept' ? 'allow' : decision === 'reject' ? 'deny' : decision === 'skip' ? 'skip' : decision;
  const state = decision === 'accept' || decision === 'allow' ? 'accepted' : decision === 'skip' ? 'skipped' : 'rejected';
  const resolved = await resolveApproval(approvalId, wire as 'allow' | 'deny' | 'skip', feedback);
  if (!resolved) {
    return ok({ resolved: false, reason: 'Approval not found or already resolved (or expired).' });
  }
  return ok({ resolved: true, decision, state });
}
