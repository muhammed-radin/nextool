'use client';

/**
 * NexTool v1.1.0 §2 — CONTINUE TASK (Task Preview action).
 *
 * For a TERMINAL task (completed / stopped / failed) the operator can start
 * a follow-up in the same logical session: a NEW linked task is created
 * (config.continuationOfTaskId) seeded server-side with the original
 * request, final result, last observations, plan state, recent tool
 * executions and selected skills. The original task is NEVER mutated and
 * its status/results/history remain unchanged.
 */

import { useEffect, useState } from 'react';
import { createTask } from '@/lib/nexool/client';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import { useConsoleStore } from './console-store';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { CornerDownRight, Loader2 } from 'lucide-react';

const STATUS_BADGE: Record<string, string> = {
  completed: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  stopped: 'border-slate-400/40 bg-slate-400/10 text-slate-300',
  failed: 'border-rose-400/40 bg-rose-400/10 text-rose-300',
};

export function ContinueTaskDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskDetail;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [nextRequest, setNextRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);

  // fresh dialog state each open
  useEffect(() => {
    if (open) setNextRequest('');
  }, [open]);

  const summary =
    task.finalResult?.result?.summary ??
    (typeof task.finalResult === 'object' && task.finalResult !== null
      ? (task.finalResult as { result?: { summary?: string } }).result?.summary
      : undefined) ??
    task.statusDetail ??
    task.request.slice(0, 160);

  const doContinue = async () => {
    const request = nextRequest.trim();
    if (!request) {
      toast.info('Enter what NexTool should do next');
      return;
    }
    setBusy(true);
    try {
      const cfg = task.config ?? ({} as TaskDetail['config']);
      const created = await createTask({
        request,
        config: {
          // sensible defaults carried over from the original task (§2.3) —
          // the operator can adjust everything in the Task Console afterwards
          name: `Continue: ${(cfg.name ?? task.name ?? task.request).slice(0, 60)}`,
          mode: 'goal',
          reasoningLevel: cfg.reasoningLevel ?? 3,
          enabledTools: cfg.enabledTools,
          useMemory: cfg.useMemory ?? true,
          plannerType: cfg.plannerType ?? 'pre-plan',
          ...(cfg.plannerType === 'pre-plan' && cfg.prePlanMaxSteps ? { prePlanMaxSteps: cfg.prePlanMaxSteps } : {}),
          limitContinuations: cfg.limitContinuations ?? 1,
          // §2.2/§2.3 — the identity + full context seeding happens server-side
          continuationOfTaskId: task.id,
          contextOptions: { result: true, plan: true, executions: true, memory: true, skills: true },
        },
      });
      toast.success('Continuation task created', {
        description: `New task ${created.id.slice(0, 12)}… linked to ${task.id.slice(0, 12)}… — the original task is unchanged.`,
      });
      onOpenChange(false);
      openTaskPreview(created.id);
    } catch (e) {
      toast.error('Continue failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-strong sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CornerDownRight className="size-4 text-sky-300" aria-hidden /> Continue this task
          </DialogTitle>
          <DialogDescription>
            Creates a NEW linked task with the relevant context of the original (result, observations, plan, executions, skills). The original task stays exactly as it is.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-white/[0.07] bg-white/[0.03] p-3 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] text-muted-foreground">previous task</span>
              <Badge variant="outline" className={cn('font-mono text-[9px] uppercase', STATUS_BADGE[task.status] ?? '')}>{task.status}</Badge>
            </div>
            <p className="text-xs font-medium leading-snug">{task.name || task.request.slice(0, 120)}</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="text-slate-400">Previous result:</span> {String(summary).slice(0, 220) || '—'}
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="continue-request" className="text-xs font-medium">What should NexTool do next?</label>
            <Textarea
              id="continue-request"
              value={nextRequest}
              onChange={(e) => setNextRequest(e.target.value)}
              rows={3}
              className="border-white/[0.09] bg-white/[0.04] text-sm"
              placeholder="e.g. Now test the other API endpoints. / Fix the remaining errors. / Explain why the previous task failed."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void doContinue();
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="min-h-11 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={busy || !nextRequest.trim()} onClick={() => void doContinue()}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CornerDownRight className="size-4" aria-hidden />} Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
