'use client';

/**
 * Live Monitor (spec §54-55) — live-mode task cards, environment server grid
 * with crash/degrade/recover injection, and the filtered live event stream.
 * v1.0.1: glass surfaces, sky "live" accents, mobile-first card order (LIVE →
 * task → status → subgoal → observation → next tick → events → stop action)
 * and a full-width min-h-11 stop button with confirm dialog on every card.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useConsoleStore } from '../console-store';
import { useGlobalStream } from '../providers';
import { ApiClientError, getLiveState, getTaskDetail, injectEnvEvent, listTasks, stopTask } from '@/lib/nexool/client';
import type { GlobalLiveState, NexToolEvent, TaskSummary } from '@/lib/nexool/types';
import type { TaskDetail } from '@/lib/nexool/api-contract';
import { ServerCard } from '../server-card';
import { TaskChecklist } from '../task-checklist';
import { RuntimeTerminal } from '../terminal';
import { EmptyState, ErrorCard, PulsingDot, SectionTitle, StatusChip, TimeAgo, fmtMs } from '../ui-bits';
import { Ban, ChevronDown, Loader2, RadioTower, Square, Timer } from 'lucide-react';

const STREAM_SOURCES = new Set(['environment', 'planner', 'core', 'tool']);

/** Shared per-session preview preference — checklist is the default (spec §67/§69). */
function readTerminalPreference(): boolean {
  try {
    return window.localStorage.getItem('nextool.previewAsTerminal') === '1';
  } catch {
    return false;
  }
}

interface LiveTaskCardData {
  summary: TaskSummary;
  detail: TaskDetail | null;
  eventCount: number;
  lastTickAt: string | null;
}

function LiveTaskCard({ data, taskEvents, onStop, stopping, onOpen }: {
  data: LiveTaskCardData;
  taskEvents: NexToolEvent[];
  onStop: (id: string) => void;
  stopping: boolean;
  onOpen: (id: string) => void;
}) {
  const { summary, detail, eventCount, lastTickAt } = data;
  const interval = detail?.config?.liveIntervalMs;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [asTerminal, setAsTerminal] = useState<boolean | null>(null);
  const nextTickEstimate = useMemo(() => {
    if (!lastTickAt || !interval) return null;
    const elapsed = Date.now() - new Date(lastTickAt).getTime();
    const remaining = Math.max(0, interval - elapsed);
    return `~${Math.ceil(remaining / 1000)}s`;
  }, [lastTickAt, interval]);

  // Default Live Mode visualization is the CHECKLIST (spec §62) — restore the
  // per-session "Preview as Terminal" preference on mount.
  useEffect(() => {
    setAsTerminal(readTerminalPreference());
  }, []);

  return (
    <div className="glass-card rounded-lg p-4">
      {/* Priority row: LIVE badge · status · task · stop (desktop) */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1.5 border-sky-400/30 bg-sky-400/10 font-tech text-[9px] uppercase tracking-wider text-sky-300">
          <PulsingDot tone="info" /> live
        </Badge>
        <StatusChip status={summary.status} />
        <button
          type="button"
          onClick={() => onOpen(summary.id)}
          className="min-w-0 flex-1 truncate rounded text-left font-mono text-xs text-foreground/90 outline-ring/50 hover:text-sky-300 hover:underline focus-visible:ring-2"
          aria-label={`Open preview for live task ${summary.id.slice(0, 8)}`}
        >
          {summary.name || summary.request}
        </button>
        <Button
          variant="outline"
          size="sm"
          disabled={stopping}
          onClick={() => onStop(summary.id)}
          className="hidden min-h-11 border-rose-500/40 text-rose-300 hover:bg-rose-500/10 sm:inline-flex"
          aria-label={`Stop live task ${summary.id.slice(0, 8)}`}
        >
          <Square className="size-3.5" aria-hidden /> Stop
        </Button>
      </div>

      {/* Priority info: subgoal → last observation → next tick → events */}
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="min-w-0 text-foreground/90">
          <span className="text-muted-foreground">subgoal: </span>
          {detail?.state?.activeSubgoal?.title ?? '—'}
        </p>
        <p className="min-w-0 text-foreground/90 sm:truncate">
          <span className="text-muted-foreground">last observation: </span>
          {detail?.state?.lastObservation ?? '—'}
        </p>
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Timer className="size-3 shrink-0" aria-hidden />
          tick {interval ? fmtMs(interval) : '—'}
          {nextTickEstimate ? ` · next ${nextTickEstimate}` : ''}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground">events {eventCount} · steps {summary.steps} · tools {summary.toolCalls}</p>
      </div>

      {/* Stop action — full-width, easy to reach on mobile */}
      <Button
        variant="outline"
        disabled={stopping}
        onClick={() => onStop(summary.id)}
        className="mt-3 min-h-11 w-full justify-center border-rose-500/40 text-rose-300 hover:bg-rose-500/10 sm:hidden"
        aria-label={`Stop live task ${summary.id.slice(0, 8)}`}
      >
        <Square className="size-4" aria-hidden /> Stop live task
      </Button>

      {/* v1.0.2 §62-68: live checklist/timeline (default) with terminal toggle.
          Both views consume the SAME runtime event stream. */}
      <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
        <CollapsibleTrigger className="mt-3 flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
          <span className="flex items-center gap-2">
            {asTerminal ? <span className="font-mono">terminal preview</span> : <span>live checklist</span>}
            <span className="font-mono text-[10px] text-muted-foreground">{eventCount} events</span>
          </span>
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const next = !(asTerminal ?? false);
                setAsTerminal(next);
                try {
                  window.localStorage.setItem('nextool.previewAsTerminal', next ? '1' : '0');
                } catch { /* session-only */ }
              }}
              className="rounded border border-sky-400/25 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-sky-300 outline-ring/50 hover:bg-sky-400/10 focus-visible:ring-2"
            >
              Preview as Terminal: {asTerminal ? 'ON' : 'OFF'}
            </button>
            <ChevronDown className={cn('size-4 text-sky-300/70 transition-transform', previewOpen && 'rotate-180')} aria-hidden />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">
          {asTerminal === true ? (
            <RuntimeTerminal taskId={summary.id} events={taskEvents} taskStatus={summary.status} />
          ) : (
            // v1.0.3 §2: prefer the fresher state.plan (written on every state persist).
            <TaskChecklist plan={detail?.state?.plan?.length ? detail.state.plan : detail?.plan} events={taskEvents} taskStatus={summary.status} />
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export default function LiveMonitorView() {
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  const { events } = useGlobalStream();

  const [liveState, setLiveState] = useState<GlobalLiveState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [liveTasks, setLiveTasks] = useState<TaskSummary[] | null>(null);
  const [details, setDetails] = useState<Record<string, TaskDetail>>({});
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);
  const [stopCandidate, setStopCandidate] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [stateRes, tasksRes] = await Promise.allSettled([getLiveState(), listTasks({ mode: 'live', limit: 50 })]);
    if (stateRes.status === 'fulfilled') {
      setLiveState(stateRes.value);
      setStateError(null);
    } else {
      setStateError(stateRes.reason instanceof ApiClientError ? stateRes.reason.message : 'Live state unavailable');
    }
    if (tasksRes.status === 'fulfilled') setLiveTasks(tasksRes.value);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  // Pull details for live tasks (subgoal, interval, observation).
  useEffect(() => {
    const ids = (liveTasks ?? []).filter((t) => t.status === 'running' || t.status === 'waiting' || t.status === 'queued').map((t) => t.id);
    if (ids.length === 0) return;
    let alive = true;
    void Promise.allSettled(ids.map((id) => getTaskDetail(id))).then((results) => {
      if (!alive) return;
      setDetails((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') next[ids[i]] = r.value;
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [liveTasks]);

  const stopTaskById = async (id: string) => {
    setStoppingId(id);
    try {
      await stopTask(id);
      toast.success('Stop signal sent', { description: `Live task #${id.slice(0, 8)} cancellation requested.` });
      void load();
    } catch (e) {
      toast.error('Stop failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStoppingId(null);
      setStopCandidate(null);
    }
  };

  const inject = async (type: 'server.crash' | 'server.degrade' | 'server.recover', serverId: string) => {
    setInjecting(true);
    try {
      await injectEnvEvent({ type, serverId });
      toast.success('Environment event injected', { description: `${type} → ${serverId}` });
      void load();
    } catch (e) {
      toast.error('Injection failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setInjecting(false);
    }
  };

  const liveTaskEvents = (taskId: string) => events.filter((ev) => ev.taskId === taskId).length;
  const lastTick = (taskId: string) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.taskId === taskId && (ev.type.includes('tick') || ev.type.includes('scheduled'))) return ev.createdAt;
    }
    return null;
  };

  const monitorEvents = useMemo(
    () => events.filter((ev) => STREAM_SOURCES.has(ev.source)).slice(-60).reverse(),
    [events],
  );

  const activeLive = (liveTasks ?? []).filter((t) => t.status === 'running' || t.status === 'waiting' || t.status === 'queued');

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<RadioTower className="size-4 text-sky-300" aria-hidden />}
        title="Live Monitor"
        desc="Continuous (live-mode) tasks and the virtual environment — refreshed every 3s."
      />

      {stateError ? <ErrorCard title="Runtime unavailable" message={stateError} onRetry={load} /> : null}

      {/* Live tasks */}
      <section aria-label="Live tasks" className="space-y-3">
        <SectionTitle title="Live tasks" desc={`${activeLive.length} active · click stop to cancel; tasks are interruptible.`} />
        {liveTasks === null && !stateError ? (
          <Skeleton className="h-28 w-full" />
        ) : activeLive.length === 0 ? (
          <EmptyState
            title="No live tasks running"
            hint="Create one in the Task Console — choose Live mode and confirm the opt-in."
          />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {activeLive.map((t) => (
              <LiveTaskCard
                key={t.id}
                data={{ summary: t, detail: details[t.id] ?? null, eventCount: liveTaskEvents(t.id), lastTickAt: lastTick(t.id) }}
                taskEvents={events.filter((ev) => ev.taskId === t.id).slice(-120)}
                onStop={(id) => setStopCandidate(id)}
                stopping={stoppingId === t.id}
                onOpen={openTaskPreview}
              />
            ))}
          </div>
        )}
      </section>

      {/* Environment */}
      <section aria-label="Virtual environment" className="space-y-3">
        <SectionTitle title="Environment" desc="Virtual servers (api-01 · web-01 · db-01). Injections emit real environment events into the runtime." />
        {liveState === null ? (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        ) : liveState.servers.length === 0 ? (
          <EmptyState title="No servers in the virtual environment" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {liveState.servers.map((server) => (
              <ServerCard key={server.id} server={server} onInject={(type, id) => void inject(type, id)} injecting={injecting} />
            ))}
          </div>
        )}
      </section>

      {/* Live event stream */}
      <section aria-label="Live event stream" className="glass-panel rounded-lg p-4">
        <SectionTitle
          title="Live event stream"
          desc="environment · planner · core · tool sources — newest first."
          right={<PulsingDot tone={monitorEvents.length > 0 ? 'ok' : 'muted'} />}
        />
        <div className="mt-3">
          {monitorEvents.length === 0 ? (
            <EmptyState title="No runtime events yet" hint="Start a task or inject an environment event." />
          ) : (
            <div className="glass-inset nextool-terminal nextool-scroll max-h-96 space-y-1 overflow-y-auto rounded-md p-3">
              {monitorEvents.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  disabled={!ev.taskId}
                  onClick={() => ev.taskId && openTaskPreview(ev.taskId)}
                  className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-white/[0.05] disabled:hover:bg-transparent"
                >
                  <span className="shrink-0 text-slate-500">[{new Date(ev.createdAt).toLocaleTimeString('en-GB', { hour12: false })}]</span>
                  <span className={ev.source === 'planner' ? 'shrink-0 font-semibold text-emerald-300' : ev.source === 'core' ? 'shrink-0 font-semibold text-cyan-300' : ev.source === 'tool' ? 'shrink-0 font-semibold text-amber-300' : 'shrink-0 font-semibold text-orange-300'}>{ev.source}</span>
                  <span className="shrink-0 text-slate-600">→</span>
                  <span className={ev.type.includes('error') ? 'min-w-0 flex-1 font-bold text-rose-300' : 'min-w-0 flex-1 text-foreground/90'}>{ev.message}</span>
                  <TimeAgo iso={ev.createdAt} className="shrink-0 text-[10px] text-slate-600" />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Stop confirm dialog — required confirmation before cancelling a live task */}
      <Dialog
        open={stopCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setStopCandidate(null);
        }}
      >
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><Ban className="size-4" aria-hidden /> Stop live task?</DialogTitle>
            <DialogDescription>
              Cancellation is sent to the runtime: scheduled ticks stop, active executions abort and the task terminates with status <code className="font-mono">stopped</code>. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setStopCandidate(null)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={stoppingId !== null} onClick={() => stopCandidate && void stopTaskById(stopCandidate)}>
              {stoppingId !== null ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Square className="size-4" aria-hidden />} Stop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
