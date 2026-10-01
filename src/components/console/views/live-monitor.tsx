'use client';

/**
 * Live Monitor (spec §54-55) — live-mode task cards, environment server grid
 * with crash/degrade/recover injection, and the filtered live event stream.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useConsoleStore } from '../console-store';
import { useGlobalStream } from '../providers';
import { ApiClientError, getLiveState, getTaskDetail, injectEnvEvent, listTasks, stopTask } from '@/lib/nexool/client';
import type { GlobalLiveState, TaskDetail, TaskSummary } from '@/lib/nexool/types';
import { ServerCard } from '../server-card';
import { EmptyState, ErrorCard, PulsingDot, SectionTitle, StatusChip, TimeAgo, fmtMs } from '../ui-bits';
import { RadioTower, Square, Timer } from 'lucide-react';

const STREAM_SOURCES = new Set(['environment', 'planner', 'core', 'tool']);

interface LiveTaskCardData {
  summary: TaskSummary;
  detail: TaskDetail | null;
  eventCount: number;
  lastTickAt: string | null;
}

function LiveTaskCard({ data, onStop, stopping, onOpen }: { data: LiveTaskCardData; onStop: (id: string) => void; stopping: boolean; onOpen: (id: string) => void }) {
  const { summary, detail, eventCount, lastTickAt } = data;
  const interval = detail?.config?.liveIntervalMs;
  const nextTickEstimate = useMemo(() => {
    if (!lastTickAt || !interval) return null;
    const elapsed = Date.now() - new Date(lastTickAt).getTime();
    const remaining = Math.max(0, interval - elapsed);
    return `~${Math.ceil(remaining / 1000)}s`;
  }, [lastTickAt, interval]);

  return (
    <div className="rounded-lg border border-amber-500/20 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={summary.status} />
        <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 font-mono text-[10px] text-amber-300">live</Badge>
        <button
          type="button"
          onClick={() => onOpen(summary.id)}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-200 hover:text-emerald-300 hover:underline"
          aria-label={`Open preview for live task ${summary.id.slice(0, 8)}`}
        >
          {summary.name || summary.request}
        </button>
        <Button
          variant="outline"
          size="sm"
          disabled={stopping}
          onClick={() => onStop(summary.id)}
          className="min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
          aria-label={`Stop live task ${summary.id.slice(0, 8)}`}
        >
          <Square className="size-3.5" aria-hidden /> Stop
        </Button>
      </div>

      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <p className="text-zinc-300">
          <span className="text-muted-foreground">subgoal: </span>
          {detail?.state?.activeSubgoal?.title ?? '—'}
        </p>
        <p className="truncate text-zinc-300">
          <span className="text-muted-foreground">last observation: </span>
          {detail?.state?.lastObservation ?? '—'}
        </p>
        <p className="font-mono text-[11px] text-zinc-500">events {eventCount} · steps {summary.steps} · tools {summary.toolCalls}</p>
        <p className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
          <Timer className="size-3" aria-hidden />
          tick {interval ? fmtMs(interval) : '—'}
          {nextTickEstimate ? ` · next ${nextTickEstimate}` : ''}
        </p>
      </div>
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
        icon={<RadioTower className="size-4 text-amber-400" aria-hidden />}
        title="Live Monitor"
        desc="Continuous (live-mode) tasks and the virtual environment — refreshed every 3s."
      />

      {stateError ? <ErrorCard title="Runtime unavailable" message={stateError} onRetry={load} /> : null}

      {/* Live tasks */}
      <section aria-label="Live tasks" className="space-y-3">
        <SectionTitle title="Live tasks" desc={`${activeLive.length} active · click stop to cancel; tasks are interruptible.`} />
        {liveTasks === null && !stateError ? (
          <Skeleton className="h-24 w-full" />
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
                onStop={(id) => void stopTaskById(id)}
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
          <div className="grid gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
          </div>
        ) : liveState.servers.length === 0 ? (
          <EmptyState title="No servers in the virtual environment" />
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {liveState.servers.map((server) => (
              <ServerCard key={server.id} server={server} onInject={(type, id) => void inject(type, id)} injecting={injecting} />
            ))}
          </div>
        )}
      </section>

      {/* Live event stream */}
      <section aria-label="Live event stream" className="rounded-lg border bg-card p-4">
        <SectionTitle
          title="Live event stream"
          desc="environment · planner · core · tool sources — newest first."
          right={<PulsingDot tone={monitorEvents.length > 0 ? 'ok' : 'muted'} />}
        />
        <div className="mt-3">
          {monitorEvents.length === 0 ? (
            <EmptyState title="No runtime events yet" hint="Start a task or inject an environment event." />
          ) : (
            <div className="nextool-terminal nextool-scroll max-h-96 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-3">
              {monitorEvents.map((ev) => (
                <button key={ev.id} type="button" disabled={!ev.taskId} onClick={() => ev.taskId && openTaskPreview(ev.taskId)} className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left font-mono text-xs hover:bg-zinc-800/40 disabled:hover:bg-transparent">
                  <span className="shrink-0 text-zinc-600">[{new Date(ev.createdAt).toLocaleTimeString('en-GB', { hour12: false })}]</span>
                  <span className={ev.source === 'planner' ? 'shrink-0 font-semibold text-emerald-400' : ev.source === 'core' ? 'shrink-0 font-semibold text-teal-300' : ev.source === 'tool' ? 'shrink-0 font-semibold text-amber-400' : 'shrink-0 font-semibold text-orange-400'}>{ev.source}</span>
                  <span className="shrink-0 text-zinc-600">→</span>
                  <span className={ev.type.includes('error') ? 'min-w-0 flex-1 font-bold text-rose-400' : 'min-w-0 flex-1 text-zinc-200'}>{ev.message}</span>
                  <TimeAgo iso={ev.createdAt} className="shrink-0 text-[10px] text-zinc-600" />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
