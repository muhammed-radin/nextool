'use client';

/**
 * Task Preview (spec §52) — dedicated per-task screen: live detail polling,
 * control surface (stop / send event / send feedback), plan, executions,
 * state, context, event timeline and the runtime terminal (§53).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useNexoolStream } from '@/hooks/use-nexool-stream';
import { useConsoleStore } from '../console-store';
import { ApiClientError, getTaskContext, getTaskDetail, getTaskEvents, getTaskExecutions, sendTaskEvent, sendTaskFeedback, stopTask } from '@/lib/nexool/client';
import type { ContextComposition, NexToolEvent, PlanStep, TaskDetail, ToolExecution } from '@/lib/nexool/types';
import { RuntimeTerminal } from '../terminal';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, StatusChip, TimeAgo, SOURCE_COLORS, fmtClock, fmtMs } from '../ui-bits';
import {
  Ban, CheckCircle2, Circle, CornerDownRight, Flag, Loader2, MessageSquareWarning, Play, Send, Square, XCircle,
} from 'lucide-react';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting']);

function PlanIcon({ step }: { step: PlanStep }) {
  if (step.status === 'in_progress') return <Loader2 className="size-3.5 animate-spin text-emerald-400" aria-hidden />;
  if (step.status === 'completed') return <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden />;
  if (step.status === 'failed') return <XCircle className="size-3.5 text-rose-400" aria-hidden />;
  return <Circle className="size-3.5 text-zinc-600" aria-hidden />;
}

function ExecutionsPanel({ executions }: { executions: ToolExecution[] | null }) {
  if (executions === null) {
    return <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }
  if (executions.length === 0) return <EmptyState title="No tool calls yet" hint="Executions appear as the CoreModule dispatches tools." />;
  return (
    <div className="space-y-2">
      {executions.map((ex) => (
        <div key={ex.executionId} className="rounded-md border border-zinc-800/80 bg-card/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={ex.status} />
            <span className="font-mono text-xs font-semibold text-zinc-100">{ex.tool}</span>
            <span className="ml-auto font-mono text-[10px] text-zinc-500">
              {ex.durationMs !== undefined ? fmtMs(ex.durationMs) : 'running…'} · {fmtClock(ex.startedAt)}
            </span>
          </div>
          {ex.error ? <p className="mt-1 font-mono text-[11px] text-rose-300">{ex.error.code}: {ex.error.message}</p> : null}
          <Accordion type="single" collapsible className="mt-1">
            <AccordionItem value="io" className="border-none">
              <AccordionTrigger className="py-1 text-[11px] text-zinc-500 hover:no-underline">params / result</AccordionTrigger>
              <AccordionContent className="space-y-2 pb-1">
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase text-zinc-600">params</p>
                  <JsonBlock value={ex.params ?? {}} maxHeight="max-h-40" />
                </div>
                <div>
                  <p className="mb-1 font-mono text-[10px] uppercase text-zinc-600">result</p>
                  <JsonBlock value={ex.result ?? null} maxHeight="max-h-40" />
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      ))}
    </div>
  );
}

function ContextPanel({ title, value, count }: { title: string; value: unknown; count?: number }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-card/60 p-3">
      <p className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        {title}
        {count !== undefined ? <Badge variant="outline" className="border-zinc-700 px-1.5 py-0 font-mono text-[10px] text-zinc-400">{count}</Badge> : null}
      </p>
      {value === null || value === undefined ? (
        <p className="text-[11px] text-zinc-600">empty</p>
      ) : (
        <JsonBlock value={value} maxHeight="max-h-44" className="border-0 bg-zinc-950/60 p-2" />
      )}
    </div>
  );
}

export default function TaskPreviewView({ taskId }: { taskId: string }) {
  const setActiveView = useConsoleStore((s) => s.setActiveView);

  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<ToolExecution[] | null>(null);
  const [context, setContext] = useState<ContextComposition | null>(null);
  const [backfill, setBackfill] = useState<NexToolEvent[]>([]);

  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [eventType, setEventType] = useState('user.message');
  const [eventPayload, setEventPayload] = useState('{}');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState('Incorrect decision.');
  const [feedbackAction, setFeedbackAction] = useState('');
  const [busy, setBusy] = useState(false);

  const { events: streamEvents } = useNexoolStream({ taskId, max: 300 });

  // Backfill historical events from REST, then merge with live SSE (dedupe by id).
  useEffect(() => {
    let alive = true;
    getTaskEvents(taskId, { limit: 200 })
      .then((d) => {
        if (alive) setBackfill(d);
      })
      .catch(() => {
        /* honest: timeline will simply show live events only */
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  const taskEvents = useMemo(() => {
    const byId = new Map<string, NexToolEvent>();
    for (const ev of [...backfill, ...streamEvents]) byId.set(ev.id, ev);
    return [...byId.values()].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [backfill, streamEvents]);

  const isActive = detail ? ACTIVE_STATUSES.has(detail.status) : true;

  const loadDetail = useCallback(async () => {
    try {
      const d = await getTaskDetail(taskId);
      setDetail(d);
      setDetailError(null);
    } catch (e) {
      setDetailError(e instanceof ApiClientError ? e.message : 'Task unavailable');
    }
  }, [taskId]);

  const loadSide = useCallback(async () => {
    const [ex, ctx] = await Promise.allSettled([getTaskExecutions(taskId), getTaskContext(taskId)]);
    if (ex.status === 'fulfilled') setExecutions(ex.value);
    if (ctx.status === 'fulfilled') setContext(ctx.value);
  }, [taskId]);

  useEffect(() => {
    void loadDetail();
    void loadSide();
  }, [loadDetail, loadSide]);

  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => {
      void loadDetail();
      void loadSide();
    }, 2500);
    return () => clearInterval(t);
  }, [isActive, loadDetail, loadSide]);

  const doStop = async () => {
    setStopping(true);
    try {
      await stopTask(taskId);
      toast.success('Stop signal sent', { description: `Task #${taskId.slice(0, 8)} cancellation requested.` });
      setStopOpen(false);
      void loadDetail();
    } catch (e) {
      toast.error('Stop failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStopping(false);
    }
  };

  const doSendEvent = async () => {
    let payload: unknown;
    try {
      payload = eventPayload.trim() ? JSON.parse(eventPayload) : {};
    } catch {
      toast.error('Invalid JSON payload');
      return;
    }
    setBusy(true);
    try {
      await sendTaskEvent(taskId, { type: eventType, payload: payload as Record<string, unknown> });
      toast.success('Event injected', { description: `${eventType} → task #${taskId.slice(0, 8)}` });
      setEventOpen(false);
    } catch (e) {
      toast.error('Event injection failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const doSendFeedback = async () => {
    if (!feedbackMsg.trim()) {
      toast.error('Feedback message required');
      return;
    }
    setBusy(true);
    try {
      await sendTaskFeedback(taskId, {
        message: feedbackMsg.trim(),
        ...(feedbackAction.trim() ? { correctAction: feedbackAction.trim() } : {}),
      });
      toast.success('Feedback delivered', { description: 'The runtime emitted a user.feedback event.' });
      setFeedbackOpen(false);
    } catch (e) {
      toast.error('Feedback failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  if (detailError && detail === null) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" className="min-h-9 text-zinc-400" onClick={() => setActiveView('dashboard')}>
          ← Back to dashboard
        </Button>
        <ErrorCard title="Task unavailable" message={detailError} onRetry={loadDetail} />
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  const state = detail.state;
  const duration = detail.durationMs ?? (detail.startedAt ? Date.now() - new Date(detail.startedAt).getTime() : undefined);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="min-h-9 text-zinc-400" onClick={() => setActiveView('dashboard')}>
        ← Back to dashboard
      </Button>

      {/* Header card */}
      <section aria-label="Task overview" className="rounded-lg border bg-card p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs break-all text-zinc-300">{detail.request}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusChip status={detail.status} />
              <Badge variant="outline" className={cn('font-mono text-[10px]', detail.mode === 'live' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-600 text-zinc-400')}>
                {detail.mode}
              </Badge>
              <Badge variant="outline" className="border-zinc-600 font-mono text-[10px] text-zinc-400">L{detail.reasoningLevel}</Badge>
              {detail.sessionId ? <span className="font-mono text-[10px] text-zinc-500">session {detail.sessionId.slice(0, 12)}</span> : null}
              <span className="font-mono text-[10px] text-zinc-500">#{detail.id.slice(0, 8)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-zinc-500">
              {detail.steps} steps · {detail.toolCalls} tools{duration !== undefined ? ` · ${fmtMs(duration)}` : ''}
            </span>
            <Button variant="outline" size="sm" className="min-h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800" onClick={() => setEventOpen(true)}>
              <Send className="size-3.5" aria-hidden /> Send event
            </Button>
            <Button variant="outline" size="sm" className="min-h-9 border-zinc-700 text-zinc-300 hover:bg-zinc-800" onClick={() => setFeedbackOpen(true)}>
              <MessageSquareWarning className="size-3.5" aria-hidden /> Feedback
            </Button>
            {ACTIVE_STATUSES.has(detail.status) ? (
              <Button variant="outline" size="sm" className="min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10" onClick={() => setStopOpen(true)}>
                <Square className="size-3.5" aria-hidden /> Stop task
              </Button>
            ) : null}
          </div>
        </div>
        {detail.statusDetail ? <p className="mt-2 text-xs text-muted-foreground">{detail.statusDetail}</p> : null}
        {detail.error ? <p className="mt-2 font-mono text-xs text-rose-300">{detail.error.code} [{detail.error.stage}]: {detail.error.message}</p> : null}
      </section>

      {/* Goal + subgoal */}
      <div className="grid gap-4 md:grid-cols-2">
        <section aria-label="Current goal" className="rounded-lg border bg-card p-4">
          <SectionTitle icon={<Flag className="size-4 text-emerald-400" aria-hidden />} title="Current goal" />
          <p className="mt-2 text-sm text-zinc-200">{state?.goal || '—'}</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-500">
            iteration {state?.iterationCount ?? 0} · tool calls {state?.toolCallCount ?? 0}
          </p>
        </section>
        <section aria-label="Active subgoal" className="rounded-lg border bg-card p-4">
          <SectionTitle icon={<CornerDownRight className="size-4 text-emerald-400" aria-hidden />} title="Active subgoal" />
          {state?.activeSubgoal ? (
            <>
              <p className="mt-2 text-sm font-medium text-zinc-100">{state.activeSubgoal.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{state.activeSubgoal.reason}</p>
            </>
          ) : (
            <p className="mt-2 text-xs text-zinc-600">No active subgoal — {state?.subgoals?.length ?? 0} subgoal(s) so far.</p>
          )}
        </section>
      </div>

      {/* Plan */}
      <section aria-label="Plan" className="rounded-lg border bg-card p-4">
        <SectionTitle icon={<Play className="size-4 text-emerald-400" aria-hidden />} title="Plan" desc="Steps produced by the planner." />
        <div className="mt-3">
          {(detail.plan ?? state?.plan ?? []).length === 0 ? (
            <EmptyState title="No plan yet" hint="The planner publishes steps once the task starts executing." />
          ) : (
            <ol className="nextool-scroll max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {(detail.plan ?? state?.plan ?? []).map((step) => (
                <li key={step.id} className="flex items-start gap-2 rounded-md border border-zinc-800/70 px-3 py-2">
                  <span className="mt-0.5"><PlanIcon step={step} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-zinc-200">{step.title}</span>
                    {step.detail ? <span className="block text-[11px] text-zinc-500">{step.detail}</span> : null}
                  </span>
                  <Badge variant="outline" className="border-zinc-700 font-mono text-[9px] uppercase text-zinc-500">{step.kind}</Badge>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      {/* Tool calls + State */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section aria-label="Tool calls" className="rounded-lg border bg-card p-4">
          <SectionTitle icon={<Loader2 className="size-4 text-emerald-400" aria-hidden />} title="Tool calls" desc="Executions with params and results." />
          <div className="mt-3"><ExecutionsPanel executions={executions} /></div>
        </section>
        <section aria-label="Task state" className="rounded-lg border bg-card p-4">
          <SectionTitle icon={<Circle className="size-4 text-emerald-400" aria-hidden />} title="State" desc="MainState snapshot (live JSON)." />
          <div className="mt-3">
            <JsonBlock value={state ?? {}} maxHeight="max-h-80" />
          </div>
        </section>
      </div>

      {/* Context composition */}
      <section aria-label="Context composition" className="rounded-lg border bg-card p-4">
        <SectionTitle icon={<CornerDownRight className="size-4 text-emerald-400" aria-hidden />} title="Context" desc="Previous + delta + observation + memory + history (assembled by the runtime)." />
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <ContextPanel title="previous context" value={context?.previousContext ?? null} />
          <ContextPanel title="delta" value={context?.delta ?? null} />
          <ContextPanel title="new observation" value={context?.observation ?? null} />
          <ContextPanel title="memory refs" value={context?.memory ?? null} count={context?.memory?.length} />
          <ContextPanel title="history refs" value={context?.history ?? null} count={context?.history?.length} />
          <div className="rounded-md border border-zinc-800/80 bg-card/60 p-3">
            <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">assembled at</p>
            <p className="font-mono text-xs text-zinc-300">{context ? <TimeAgo iso={context.assembledAt} /> : '—'}</p>
          </div>
        </div>
      </section>

      {/* Events timeline */}
      <section aria-label="Event timeline" className="rounded-lg border bg-card p-4">
        <SectionTitle icon={<Flag className="size-4 text-emerald-400" aria-hidden />} title="Events timeline" desc="This task's events — REST backfill + live stream (newest last)." />
        <div className="mt-3">
          {taskEvents.length === 0 ? (
            <EmptyState title="No events for this task yet" hint="Runtime events appear here as the task executes." />
          ) : (
            <ol className="nextool-scroll relative max-h-96 space-y-2 overflow-y-auto border-l border-zinc-800 pl-4 pr-1">
              {taskEvents.map((ev) => (
                <li key={ev.id} className="relative">
                  <span
                    aria-hidden
                    className={cn('absolute -left-[21px] top-1.5 size-2 rounded-full ring-2 ring-card', SOURCE_COLORS[ev.source] ?? 'bg-zinc-600')}
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-500">[{fmtClock(ev.createdAt)}]</span>
                    <span className="rounded border border-zinc-700 px-1 font-mono text-[9px] uppercase text-zinc-400">{ev.source}</span>
                    <span className="rounded border border-zinc-700 px-1 font-mono text-[9px] text-emerald-400/80">{ev.type}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{ev.message}</span>
                  </div>
                  {ev.data ? <JsonBlock value={ev.data} maxHeight="max-h-32" className="mt-1" /> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      {/* Terminal */}
      <RuntimeTerminal taskId={taskId} events={taskEvents} />

      {/* Stop confirm dialog */}
      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent className="border-zinc-800 bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><Ban className="size-4" aria-hidden /> Stop task?</DialogTitle>
            <DialogDescription>
              Cancellation is sent to the runtime: active executions are aborted and the task terminates with status <code className="font-mono">stopped</code>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setStopOpen(false)}>Cancel</Button>
            <Button variant="destructive" className="min-h-10" disabled={stopping} onClick={() => void doStop()}>
              {stopping ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />} Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send event dialog */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="border-zinc-800 bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send event to task</DialogTitle>
            <DialogDescription>Injects a runtime event. <code className="font-mono">scheduled.force</code> wakes live-mode ticks immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-type">Event type</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="ev-type" className="min-h-10 w-full font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user.message">user.message</SelectItem>
                  <SelectItem value="environment.custom">environment.custom</SelectItem>
                  <SelectItem value="scheduled.force">scheduled.force</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-payload">Payload (JSON)</Label>
              <Textarea id="ev-payload" value={eventPayload} onChange={(e) => setEventPayload(e.target.value)} rows={4} className="font-mono text-xs" placeholder="{}" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setEventOpen(false)}>Cancel</Button>
            <Button className="min-h-10 bg-emerald-500/90 text-zinc-950 hover:bg-emerald-400" disabled={busy} onClick={() => void doSendEvent()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feedback dialog (spec §60) */}
      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent className="border-zinc-800 bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300"><MessageSquareWarning className="size-4" aria-hidden /> Send feedback</DialogTitle>
            <DialogDescription>Tell the runtime a decision was wrong. It records a user.feedback event and adapts context.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fb-msg">What was incorrect?</Label>
              <Textarea id="fb-msg" value={feedbackMsg} onChange={(e) => setFeedbackMsg(e.target.value)} rows={3} className="text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-action">Correct action <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="fb-action" value={feedbackAction} onChange={(e) => setFeedbackAction(e.target.value)} className="text-sm" placeholder="e.g. restart api-01 before health check" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-10" onClick={() => setFeedbackOpen(false)}>Cancel</Button>
            <Button className="min-h-10 bg-amber-500/90 text-zinc-950 hover:bg-amber-400" disabled={busy} onClick={() => void doSendFeedback()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageSquareWarning className="size-4" aria-hidden />} Send feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
