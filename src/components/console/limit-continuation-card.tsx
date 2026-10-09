'use client';

/**
 * v1.0.16 §2 — shared task-limit continuation dialog (Task Preview + Live
 * Monitor). Renders the REAL numbers from the backend payload (current limit,
 * usage, additional budget, new total) and a 60-second countdown derived from
 * the server's requestedAt. The deadline itself is enforced by the backend
 * timer (LIMIT_CONTINUATION_TIMEOUT_MS = 60 s); a stale browser can never
 * approve an already-expired request because resolution requires the live
 * backend record.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, Gauge, X } from 'lucide-react';
import type { PendingLimitContinuationDTO } from '@/lib/nexool/client';

export function LimitContinuationCard({
  continuation,
  busy,
  onResolve,
}: {
  continuation: PendingLimitContinuationDTO;
  busy: boolean;
  onResolve: (continuationId: string, decision: 'continue' | 'deny') => void;
}) {
  const WINDOW_MS = 60_000;
  // Re-render once per second; the remaining time is always derived from the
  // server's requestedAt at render time (no setState inside the effect body).
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(t);
  }, []);
  const deadlineMs = Date.parse(continuation.requestedAt) + WINDOW_MS;
  const secondsLeft = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
  const expired = secondsLeft <= 0;
  const isTimeout = continuation.limitKind === 'taskTimeout';
  const fmtSec = (ms?: number) => (ms === undefined ? '—' : `${Math.round(ms / 1000)} seconds`);
  const disabled = busy || expired;

  return (
    <div role="alertdialog" aria-label="Task limit reached — continue or stop" className="rounded-md border border-amber-400/30 bg-amber-400/[0.05] p-3">
      <p className="flex flex-wrap items-center gap-1.5 font-tech text-[10px] uppercase tracking-wider text-amber-300">
        <Gauge className="size-3.5" aria-hidden /> task limit reached · {isTimeout ? 'task timeout' : continuation.limitKind}
        <span className={cn('ml-auto font-mono normal-case', expired ? 'text-rose-300' : 'text-amber-200')} aria-live="polite">
          {expired ? 'window expired' : `${secondsLeft}s left`}
        </span>
      </p>

      {isTimeout ? (
        <div className="mt-1.5 space-y-0.5 font-mono text-[11px] text-foreground">
          <p>Reason: task timeout</p>
          <p>Original time budget: {fmtSec(continuation.originalTimeBudgetMs)}</p>
          <p>Elapsed time: {fmtSec(continuation.elapsedMs)}</p>
          <p className="pt-1 text-amber-200">Continue with additional time?</p>
          <p>Additional time: +{fmtSec(continuation.additionalMs)}</p>
          <p>New total budget: {fmtSec(continuation.newTotalBudgetMs)}</p>
        </div>
      ) : (
        <div className="mt-1.5 space-y-0.5 font-mono text-[11px] text-foreground">
          <p>Reason: {continuation.limitKind} exhausted</p>
          <p>Iterations: {continuation.iterations}/{continuation.maxIterations} → {continuation.newMaxIterations ?? continuation.maxIterations + continuation.extraBudget}</p>
          <p>Tool calls: {continuation.toolCalls}/{continuation.safetyLimit} → {continuation.newSafetyLimit ?? continuation.safetyLimit + continuation.extraBudget}</p>
          <p className="pt-1 text-amber-200">Continue with additional budget?</p>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={disabled} onClick={() => onResolve(continuation.continuationId, 'continue')} className="min-h-9 border-emerald-400/40 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20">
          <Check className="size-3.5" aria-hidden /> Continue task
        </Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onResolve(continuation.continuationId, 'deny')} className="min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10">
          <X className="size-3.5" aria-hidden /> Stop task
        </Button>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">
        continuing extends this task&rsquo;s budget only (global settings unchanged) · no response within 60 seconds stops the task
      </p>
    </div>
  );
}
