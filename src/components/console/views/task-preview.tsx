'use client';

/**
 * Task Preview (spec §52) — dedicated per-task screen: live detail polling,
 * control surface (stop / send event / send feedback), plan, executions,
 * state, context, event timeline and the runtime terminal (§53).
 * v1.0.1: blue glass surfaces; <lg renders a scrollable tab row (Overview ·
 * Timeline · Tools · Internals) so 320–430px screens never force wide tables,
 * lg+ keeps the rich multi-column layout.
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
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useNexoolStream } from '@/hooks/use-nexool-stream';
import { useConsoleStore } from '../console-store';
import { ApiClientError, getTaskContext, getTaskDetail, getTaskEvents, getTaskExecutions, sendTaskEvent, sendTaskFeedback, stopTask } from '@/lib/nexool/client';
import type { ContextComposition, NexToolEvent, PlanStep, ToolExecution } from '@/lib/nexool/types';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import { RuntimeTerminal } from '../terminal';
import { ChecklistItems, TaskChecklist } from '../task-checklist';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, StatusChip, TechLabel, TimeAgo, SOURCE_COLORS, deriveTaskRuntime, deriveChecklist, fmtClock, fmtMs } from '../ui-bits';
import {
  Ban, Braces, CheckCircle2, Circle, CornerDownRight, Flag, Layers, ListChecks, Loader2, MessageSquareWarning, Play, Radio, Send, Square, TerminalSquare, Wrench, Zap,
} from 'lucide-react';

const PREVIEW_AS_TERMINAL_KEY = 'nextool.previewAsTerminal';

/** Persisted per user/session (spec §69) — defaults to OFF (checklist view). */
function readTerminalPreference(): boolean {
  try {
    return window.localStorage.getItem(PREVIEW_AS_TERMINAL_KEY) === '1';
  } catch {
    return false;
  }
}

const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting']);
/** v1.0.3 §1: terminal states — Live Checklist/Terminal are removed once reached. */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);
/** Events that should refresh task detail/plan/executions immediately (v1.0.3 §2). */
const REFRESH_EVENT_RE = /^(tool\.(completed|failed|timeout|cancelled)|task\.(completed|failed|cancelled|started)|planner\.(plan|parallel_batch|partial_failure)|subgoal\.created)/;

function ExecutionCard({ ex }: { ex: ToolExecution }) {
  return (
    <div className="glass-card rounded-md px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={ex.status} />
        <span className="font-mono text-xs font-semibold text-foreground">{ex.tool}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {ex.durationMs !== undefined ? fmtMs(ex.durationMs) : 'running…'} · {fmtClock(ex.startedAt)}
        </span>
      </div>
      {ex.error ? <p className="mt-1 font-mono text-[11px] text-rose-300">{ex.error.code}: {ex.error.message}</p> : null}
      <Accordion type="single" collapsible className="mt-1">
        <AccordionItem value="io" className="border-none">
          <AccordionTrigger className="py-1 text-[11px] text-muted-foreground hover:text-sky-300 hover:no-underline">params / result</AccordionTrigger>
          <AccordionContent className="space-y-2 pb-1">
            <div>
              <p className="mb-1"><TechLabel className="text-[9px]">params</TechLabel></p>
              <JsonBlock value={ex.params ?? {}} maxHeight="max-h-40" />
            </div>
            <div>
              <p className="mb-1"><TechLabel className="text-[9px]">result</TechLabel></p>
              <JsonBlock value={ex.result ?? null} maxHeight="max-h-40" />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function ExecutionsPanel({ executions }: { executions: ToolExecution[] | null }) {
  if (executions === null) {
    return <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  }
  if (executions.length === 0) return <EmptyState title="No tool calls yet" hint="Executions appear as the CoreModule dispatches tools." />;

  // v1.0.3 §23 — parallel visibility: executions sharing a batchId ran
  // CONCURRENTLY and render inside one labeled parallel-batch group instead of
  // a fake sequential chain. Sequential calls render as before.
  const groups: { key: string; batchId: string | null; items: ToolExecution[] }[] = [];
  for (const ex of executions) {
    const last = groups[groups.length - 1];
    if (ex.batchId && last && last.batchId === ex.batchId) {
      last.items.push(ex);
    } else if (ex.batchId) {
      groups.push({ key: `batch-${ex.batchId}`, batchId: ex.batchId, items: [ex] });
    } else {
      groups.push({ key: ex.executionId, batchId: null, items: [ex] });
    }
  }

  return (
    <div className="space-y-2">
      {groups.map((g) =>
        g.batchId ? (
          <div key={g.key} className="rounded-md border border-sky-400/25 bg-sky-400/[0.04] p-2" data-testid="parallel-batch">
            <p className="mb-1.5 flex items-center gap-1.5 px-1">
              <Zap className="size-3 text-sky-300" aria-hidden />
              <span className="font-tech text-[9px] uppercase tracking-widest text-sky-300/90">parallel batch · {g.items.length} concurrent</span>
            </p>
            <div className="space-y-2">
              {g.items.map((ex) => <ExecutionCard key={ex.executionId} ex={ex} />)}
            </div>
          </div>
        ) : (
          g.items.map((ex) => <ExecutionCard key={ex.executionId} ex={ex} />)
        ),
      )}
    </div>
  );
}

function ContextPanel({ title, value, count }: { title: string; value: unknown; count?: number }) {
  return (
    <div className="glass-card rounded-md p-3">
      <p className="mb-1.5 flex items-center justify-between gap-2">
        <TechLabel className="text-[9px]">{title}</TechLabel>
        {count !== undefined ? <Badge variant="outline" className="border-white/[0.09] px-1.5 py-0 font-mono text-[10px] text-muted-foreground">{count}</Badge> : null}
      </p>
      {value === null || value === undefined ? (
        <p className="text-[11px] text-muted-foreground/60">empty</p>
      ) : (
        <JsonBlock value={value} maxHeight="max-h-44" className="p-2" />
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
  const [previewAsTerminal, setPreviewAsTerminal] = useState<boolean | null>(null); // null = not yet hydrated

  const { events: streamEvents } = useNexoolStream({ taskId, max: 300 });

  // Restore the persisted view preference after mount (avoids SSR mismatch).
  useEffect(() => {
    setPreviewAsTerminal(readTerminalPreference());
  }, []);

  const togglePreviewMode = (on: boolean) => {
    setPreviewAsTerminal(on);
    try {
      window.localStorage.setItem(PREVIEW_AS_TERMINAL_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable — session-only preference */
    }
  };

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
  const isTerminal = detail ? TERMINAL_STATUSES.has(detail.status) : false;

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

  // v1.0.3 §2: plan/checklist state must update IMMEDIATELY when the runtime
  // reports a step/task transition — the live stream triggers an instant
  // detail refresh instead of waiting for the 2.5s poll.
  const lastStreamEvent = streamEvents.length > 0 ? streamEvents[streamEvents.length - 1] : null;
  const lastStreamEventId = lastStreamEvent?.id ?? '';
  const lastStreamEventType = lastStreamEvent?.type ?? '';
  useEffect(() => {
    if (!lastStreamEventId || !REFRESH_EVENT_RE.test(lastStreamEventType)) return;
    void loadDetail();
    void loadSide();
  }, [lastStreamEventId, lastStreamEventType, loadDetail, loadSide]);

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
        <Button variant="ghost" size="sm" className="min-h-11 text-muted-foreground hover:text-foreground" onClick={() => setActiveView('dashboard')}>
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
  // v1.0.3 §2: state.plan is written on every runtime state persist, so it is
  // the fresher source for live step statuses (detail.plan can lag on tasks
  // executed before the plan-column sync fix); fall back to detail.plan.
  const planSteps = state?.plan?.length ? state.plan : detail.plan ?? [];

  // ---- shared section fragments (rendered in mobile tabs AND desktop columns) ----

  const goalCard = (
    <section aria-label="Current goal" className="glass-card rounded-lg p-4">
      <SectionTitle icon={<Flag className="size-4 text-sky-300" aria-hidden />} title="Current goal" />
      <p className="mt-2 text-sm text-foreground/90">{state?.goal || '—'}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        iteration {state?.iterationCount ?? 0} · tool calls {state?.toolCallCount ?? 0}
      </p>
    </section>
  );

  const subgoalCard = (
    <section aria-label="Active subgoal" className="glass-card rounded-lg p-4">
      <SectionTitle icon={<CornerDownRight className="size-4 text-sky-300" aria-hidden />} title="Active subgoal" />
      {state?.activeSubgoal ? (
        <>
          <p className="mt-2 text-sm font-medium text-foreground">{state.activeSubgoal.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{state.activeSubgoal.reason}</p>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground/70">No active subgoal — {state?.subgoals?.length ?? 0} subgoal(s) so far.</p>
      )}
    </section>
  );

  // v1.0.3 §2/§3/§4 — the Plan section IS a live checklist: states come from
  // the actual runtime plan + event stream (deriveChecklist) and transitions
  // animate (✓ pulse on completion, moving highlight while running, [!] on
  // failure). Never a hardcoded checked state.
  const planChecklist = deriveChecklist(planSteps, taskEvents);

  const planSection = (
    <section aria-label="Plan" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Play className="size-4 text-sky-300" aria-hidden />} title="Plan" desc="Runtime-driven checklist — steps update as the task executes." />
      <div className="mt-3">
        {planSteps.length === 0 ? (
          <EmptyState title="No plan yet" hint="The planner publishes steps once the task starts executing." />
        ) : (
          <div className="nextool-scroll max-h-72 overflow-y-auto pr-1">
            <ChecklistItems items={planChecklist.items} finished={isTerminal} />
          </div>
        )}
      </div>
    </section>
  );

  const toolsSection = (
    <section aria-label="Tool calls" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Wrench className="size-4 text-sky-300" aria-hidden />} title="Tool calls" desc="Executions with params and results." />
      <div className="mt-3"><ExecutionsPanel executions={executions} /></div>
    </section>
  );

  const stateSection = (
    <section aria-label="Task state" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Braces className="size-4 text-sky-300" aria-hidden />} title="State" desc="MainState snapshot (live JSON)." />
      <div className="mt-3">
        <JsonBlock value={state ?? {}} maxHeight="max-h-80" />
      </div>
    </section>
  );

  const contextSection = (
    <section aria-label="Context composition" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Layers className="size-4 text-sky-300" aria-hidden />} title="Context" desc="Previous + delta + observation + memory + history (assembled by the runtime)." />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <ContextPanel title="previous context" value={context?.previousContext ?? null} />
        <ContextPanel title="delta" value={context?.delta ?? null} />
        <ContextPanel title="new observation" value={context?.observation ?? null} />
        <ContextPanel title="memory refs" value={context?.memory ?? null} count={context?.memory?.length} />
        <ContextPanel title="history refs" value={context?.history ?? null} count={context?.history?.length} />
        <div className="glass-card rounded-md p-3">
          <p className="mb-1.5"><TechLabel className="text-[9px]">assembled at</TechLabel></p>
          <p className="font-mono text-xs text-foreground/90">{context ? <TimeAgo iso={context.assembledAt} /> : '—'}</p>
        </div>
      </div>
    </section>
  );

  const timelineSection = (
    <section aria-label="Event timeline" className="glass-panel rounded-lg p-4">
      <SectionTitle icon={<Radio className="size-4 text-sky-300" aria-hidden />} title="Events timeline" desc="This task's events — REST backfill + live stream (newest last)." />
      <div className="mt-3">
        {taskEvents.length === 0 ? (
          <EmptyState title="No events for this task yet" hint="Runtime events appear here as the task executes." />
        ) : (
          <ol className="nextool-scroll relative max-h-96 space-y-2 overflow-y-auto border-l border-white/[0.08] pl-4 pr-1">
            {taskEvents.map((ev) => (
              <li key={ev.id} className="relative">
                <span
                  aria-hidden
                  className={cn('absolute -left-[21px] top-1.5 size-2 rounded-full ring-2 ring-card', SOURCE_COLORS[ev.source] ?? 'bg-slate-600')}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10px] text-muted-foreground">[{fmtClock(ev.createdAt)}]</span>
                  <span className="rounded border border-white/[0.09] px-1 font-mono text-[9px] uppercase text-slate-300">{ev.source}</span>
                  <span className="rounded border border-white/[0.09] px-1 font-mono text-[9px] text-cyan-300/90">{ev.type}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85">{ev.message}</span>
                </div>
                {ev.data ? <JsonBlock value={ev.data} maxHeight="max-h-32" className="mt-1" /> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );

  const terminal = <RuntimeTerminal taskId={taskId} events={taskEvents} taskStatus={detail.status} />;

  // ---- v1.0.2 §67-68: Preview as Terminal toggle — checklist is the DEFAULT.
  // Both views consume the SAME runtime state (spec §68).
  // v1.0.3 §1/§30: the whole Live Checklist/Terminal area exists ONLY while
  // the task is actively executing. On a terminal state (completed/failed/
  // cancelled/stopped) it disappears entirely — no empty container, no blank
  // gap — and the Final Task Output section takes over (historical info like
  // plan/executions/state/context/timeline remains below).
  const livePreview = (
    <section aria-label="Live task preview" className="glass-panel rounded-lg p-4" data-testid="live-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle
          icon={<ListChecks className="size-4 text-sky-300" aria-hidden />}
          title="Live checklist"
          desc="Real-time task timeline driven by the runtime plan."
        />
        <label className="flex min-h-11 items-center gap-2 rounded-md border border-white/[0.09] bg-white/[0.03] px-3 text-xs text-slate-300">
          <TerminalSquare className="size-3.5 text-sky-300/70" aria-hidden />
          Preview as Terminal
          <Switch
            checked={previewAsTerminal === true}
            onCheckedChange={togglePreviewMode}
            aria-label="Preview as Terminal"
            data-testid="terminal-toggle"
          />
        </label>
      </div>
      <div className="mt-3">
        {previewAsTerminal === false ? (
          <TaskChecklist plan={planSteps} events={taskEvents} taskStatus={detail.status} />
        ) : previewAsTerminal === true ? (
          terminal
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </div>
    </section>
  );

  // v1.0.3 §1/§30 — Final Task Output: replaces the live area once the task
  // reaches a terminal state. Shows the runtime-recorded FinalResult (summary,
  // steps, tool calls, duration, artifacts) — real data only, '—' if absent.
  const finalResult = detail.finalResult ?? null;
  const finalResultSummary = (() => {
    if (finalResult?.result && typeof finalResult.result === 'object' && !Array.isArray(finalResult.result)) {
      const s = (finalResult.result as Record<string, unknown>).summary;
      if (typeof s === 'string' && s.trim()) return s;
    }
    if (detail.statusDetail) return detail.statusDetail;
    if (detail.error) return `${detail.error.code} [${detail.error.stage}]: ${detail.error.message}`;
    return null;
  })();
  const finalArtifacts = (() => {
    if (finalResult?.result && typeof finalResult.result === 'object' && !Array.isArray(finalResult.result)) {
      const a = (finalResult.result as Record<string, unknown>).artifacts;
      if (Array.isArray(a) && a.length > 0) return a as Record<string, unknown>[];
    }
    return null;
  })();
  const finalOutputSection = isTerminal ? (
    <section aria-label="Final task output" className="glass-panel rounded-lg p-4" data-testid="final-task-output">
      <SectionTitle
        icon={<CheckCircle2 className="size-4 text-emerald-300" aria-hidden />}
        title="Final task output"
        desc="Recorded by the runtime when the task reached its terminal state."
      />
      {finalResultSummary ? (
        <p className="mt-3 break-words rounded-md border border-white/[0.08] bg-white/[0.04] px-3 py-2.5 text-sm text-foreground/90">
          {finalResultSummary}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">No summary was recorded for this task.</p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">result status</TechLabel>
          <p className="mt-1 font-mono text-sm text-foreground">{finalResult?.status ?? detail.status}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">steps</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.steps ?? detail.steps}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">tool calls</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.toolCalls ?? detail.toolCalls}</p>
        </div>
        <div className="glass-card rounded-md px-3 py-2">
          <TechLabel className="text-[9px]">duration</TechLabel>
          <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{finalResult?.durationMs !== undefined ? fmtMs(finalResult.durationMs) : duration !== undefined ? fmtMs(duration) : '—'}</p>
        </div>
      </div>
      {finalArtifacts ? (
        <div className="mt-3">
          <TechLabel className="text-[9px]">artifacts ({finalArtifacts.length})</TechLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {finalArtifacts.map((a, i) => (
              <Badge key={i} variant="outline" className="border-white/[0.09] font-mono text-[10px] text-slate-300">
                {String(a.type ?? 'artifact')}{typeof a.path === 'string' ? ` · ${a.path}` : ''}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3">
        <TechLabel className="text-[9px]">final result (live JSON)</TechLabel>
        <div className="mt-1">
          <JsonBlock value={finalResult ?? { status: detail.status, statusDetail: detail.statusDetail ?? null, error: detail.error ?? null }} maxHeight="max-h-72" />
        </div>
      </div>
    </section>
  ) : null;

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="min-h-11 text-muted-foreground hover:text-foreground" onClick={() => setActiveView('dashboard')}>
        ← Back to dashboard
      </Button>

      {/* Header card — task, status, controls (always visible) */}
      <section aria-label="Task overview" className="glass-panel rounded-lg p-4 md:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <p className="break-all font-mono text-xs text-foreground/90">{detail.request}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusChip status={detail.status} />
              {(() => {
                // v1.0.2 §71: dynamic derived status from the SAME event stream
                // the terminal/checklist use — never a hardcoded state string.
                const rt = deriveTaskRuntime(detail.status, taskEvents);
                if (rt.status === detail.status) return null;
                return (
                  <Badge variant="outline" className="border-sky-400/25 bg-sky-400/[0.06] font-mono text-[10px] text-sky-300">
                    {rt.status}
                    {rt.activeTool ? <span className="ml-1 text-cyan-300/90">· {rt.activeTool}</span> : null}
                  </Badge>
                );
              })()}
              <Badge variant="outline" className={cn('font-mono text-[10px]', detail.mode === 'live' ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : 'border-white/[0.09] text-muted-foreground')}>
                {detail.mode}
              </Badge>
              <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">L{detail.reasoningLevel}</Badge>
              {detail.sessionId ? <span className="font-mono text-[10px] text-muted-foreground">session {detail.sessionId.slice(0, 12)}</span> : null}
              <span className="font-mono text-[10px] text-muted-foreground">#{detail.id.slice(0, 8)}</span>
            </div>
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
              {detail.steps} steps · {detail.toolCalls} tools{duration !== undefined ? ` · ${fmtMs(duration)}` : ''}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 justify-center border-white/[0.09] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
              onClick={() => setEventOpen(true)}
            >
              <Send className="size-3.5" aria-hidden /> Send event
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 justify-center border-white/[0.09] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
              onClick={() => setFeedbackOpen(true)}
            >
              <MessageSquareWarning className="size-3.5" aria-hidden /> Feedback
            </Button>
            {ACTIVE_STATUSES.has(detail.status) ? (
              <Button
                variant="outline"
                size="sm"
                className="col-span-2 min-h-11 justify-center border-rose-500/40 text-rose-300 hover:bg-rose-500/10 sm:col-span-1"
                onClick={() => setStopOpen(true)}
              >
                <Square className="size-3.5" aria-hidden /> Stop task
              </Button>
            ) : null}
          </div>
        </div>
        {detail.statusDetail ? <p className="mt-2 text-xs text-muted-foreground">{detail.statusDetail}</p> : null}
        {detail.error ? <p className="mt-2 font-mono text-xs text-rose-300">{detail.error.code} [{detail.error.stage}]: {detail.error.message}</p> : null}
      </section>

      {/* Mobile: segmented tabs — Overview · Timeline · Tools · Internals */}
      <div className="lg:hidden">
        <Tabs defaultValue="overview" className="gap-3">
          <TabsList className="glass-card h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1 nextool-scroll" aria-label="Task sections">
            <TabsTrigger
              value="overview"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="timeline"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Timeline
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Tools
            </TabsTrigger>
            <TabsTrigger
              value="internals"
              className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100"
            >
              Internals
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-3 space-y-4 outline-none">
            {goalCard}
            {subgoalCard}
            {isTerminal ? finalOutputSection : livePreview}
            {planSection}
          </TabsContent>
          <TabsContent value="timeline" className="mt-3 space-y-4 outline-none">
            {timelineSection}
            {/* v1.0.3 §1: the live terminal disappears once the task finishes. */}
            {!isTerminal ? terminal : null}
          </TabsContent>
          <TabsContent value="tools" className="mt-3 space-y-4 outline-none">
            {toolsSection}
          </TabsContent>
          <TabsContent value="internals" className="mt-3 space-y-4 outline-none">
            {stateSection}
            {contextSection}
          </TabsContent>
        </Tabs>
      </div>

      {/* Desktop (lg+): rich multi-column layout */}
      <div className="hidden space-y-4 lg:block">
        <div className="grid gap-4 md:grid-cols-2">
          {goalCard}
          {subgoalCard}
        </div>

        {planSection}

        {isTerminal ? finalOutputSection : livePreview}

        <div className="grid gap-4 lg:grid-cols-2">
          {toolsSection}
          {stateSection}
        </div>

        {contextSection}

        {timelineSection}
      </div>

      {/* Stop confirm dialog */}
      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><Ban className="size-4" aria-hidden /> Stop task?</DialogTitle>
            <DialogDescription>
              Cancellation is sent to the runtime: active executions are aborted and the task terminates with status <code className="font-mono">stopped</code>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setStopOpen(false)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={stopping} onClick={() => void doStop()}>
              {stopping ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />} Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Send event dialog */}
      <Dialog open={eventOpen} onOpenChange={setEventOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send event to task</DialogTitle>
            <DialogDescription>Injects a runtime event. <code className="font-mono">scheduled.force</code> wakes live-mode ticks immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ev-type">Event type</Label>
              <Select value={eventType} onValueChange={setEventType}>
                <SelectTrigger id="ev-type" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent className="glass-strong">
                  <SelectItem value="user.message">user.message</SelectItem>
                  <SelectItem value="environment.custom">environment.custom</SelectItem>
                  <SelectItem value="scheduled.force">scheduled.force</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ev-payload">Payload (JSON)</Label>
              <Textarea id="ev-payload" value={eventPayload} onChange={(e) => setEventPayload(e.target.value)} rows={4} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" placeholder="{}" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setEventOpen(false)}>Cancel</Button>
            <Button className="min-h-11 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={busy} onClick={() => void doSendEvent()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />} Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feedback dialog (spec §60) */}
      <Dialog open={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300"><MessageSquareWarning className="size-4" aria-hidden /> Send feedback</DialogTitle>
            <DialogDescription>Tell the runtime a decision was wrong. It records a user.feedback event and adapts context.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="fb-msg">What was incorrect?</Label>
              <Textarea id="fb-msg" value={feedbackMsg} onChange={(e) => setFeedbackMsg(e.target.value)} rows={3} className="border-white/[0.09] bg-white/[0.04] text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-action">Correct action <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="fb-action" value={feedbackAction} onChange={(e) => setFeedbackAction(e.target.value)} className="min-h-11 border-white/[0.09] bg-white/[0.04] text-sm" placeholder="e.g. restart api-01 before health check" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setFeedbackOpen(false)}>Cancel</Button>
            <Button className="min-h-11 bg-amber-500/90 text-slate-950 hover:bg-amber-400" disabled={busy} onClick={() => void doSendFeedback()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MessageSquareWarning className="size-4" aria-hidden />} Send feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
