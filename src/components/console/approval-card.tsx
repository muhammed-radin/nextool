'use client';

/**
 * NexTool v1.0.15 §31-§35 — the THREE-CHOICE tool approval card.
 *
 * Whenever NexTool asks for approval to execute a tool, the operator sees:
 *
 *   [Skip]   [Reject]   [Accept]
 *
 * with enough information for a real decision (§35): tool name, tool
 * description, environment, parameters, the relevant target/path (the
 * `reason` — for destructive or real-FS commands the target command and
 * working directory are especially visible) and why it is being requested
 * (purpose + subgoal).
 *
 * Decisions (§32-§34):
 *   ACCEPT — execute the requested tool normally, then continue the plan.
 *   SKIP   — do not execute; the execution is marked `skipped` and the plan
 *            continues to the next logical step (the planner is told).
 *   REJECT — the user does not permit this execution; the planner must
 *            revise the plan or stop (it must never repeat the same
 *            rejected action indefinitely).
 */
import { useState } from 'react';
import { AlertTriangle, Check, Loader2, ShieldAlert, SkipForward, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PendingApprovalDTO } from '@/lib/nexool/client';

export interface ApprovalCardProps {
  approval: PendingApprovalDTO;
  busy: boolean;
  onResolve: (approvalId: string, decision: 'accept' | 'skip' | 'reject', feedback?: string) => void;
}

export function ApprovalCard({ approval: a, busy, onResolve }: ApprovalCardProps) {
  const [feedback, setFeedback] = useState('');

  return (
    <div className="rounded-md border border-amber-400/30 bg-amber-400/[0.06] p-3">
      <p className="flex items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-amber-300">
        <ShieldAlert className="size-3.5" aria-hidden /> approval required — {a.state ?? 'pending'} (timeout 5 min)
      </p>
      <p className="mt-1 break-words font-mono text-xs text-foreground">
        {a.tool}
        {a.environment ? (
          <span className="ml-2 rounded border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-tech text-[9px] uppercase tracking-wider text-slate-300">
            env: {a.environment}
          </span>
        ) : null}
      </p>
      {a.description ? <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{a.description}</p> : null}
      {a.purpose ? <p className="mt-0.5 break-words text-[11px] text-muted-foreground">why: {a.purpose}</p> : null}
      {a.subgoal ? <p className="mt-0.5 break-words text-[11px] text-muted-foreground">subgoal: {a.subgoal}</p> : null}
      {a.reason ? (
        <div className="glass-inset mt-1.5 rounded p-2">
          <p className="flex items-center gap-1 font-tech text-[9px] uppercase tracking-wider text-amber-300/90">
            <AlertTriangle className="size-3" aria-hidden /> execute
          </p>
          <pre className="mt-0.5 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-amber-100/90 nextool-scroll">{a.reason}</pre>
        </div>
      ) : null}
      <pre className="glass-inset nextool-scroll mt-1.5 max-h-24 overflow-auto rounded p-2 font-mono text-[10px] text-slate-300">{JSON.stringify(a.params, null, 2)}</pre>
      <Input
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional: why skip/reject? (feedback becomes a runtime event)"
        className="mt-2 min-h-9 border-white/[0.09] bg-white/[0.04] text-xs"
        aria-label={`Optional feedback for ${a.tool}`}
      />
      {/* §31 — [Skip] [Reject] [Accept] in the documented order. */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onResolve(a.approvalId, 'skip', feedback.trim() || undefined)}
          className="min-h-11 border-sky-400/40 text-sky-300 hover:bg-sky-400/10"
          aria-label={`Skip ${a.tool} — do not execute, continue the plan`}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <SkipForward className="size-3.5" aria-hidden />} Skip
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onResolve(a.approvalId, 'reject', feedback.trim() || undefined)}
          className="min-h-11 border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
          aria-label={`Reject ${a.tool} — block this execution`}
        >
          <X className="size-3.5" aria-hidden /> Reject
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onResolve(a.approvalId, 'accept')}
          className="min-h-11 border-emerald-400/40 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
          aria-label={`Accept — execute ${a.tool}`}
        >
          <Check className="size-3.5" aria-hidden /> Accept
        </Button>
      </div>
    </div>
  );
}
