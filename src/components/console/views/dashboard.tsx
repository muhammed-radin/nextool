'use client';

/**
 * Dashboard — runtime overview. Polls /api/system (via SystemStatsProvider, 5s),
 * renders metric cards, core-latency area chart, recent tasks + live event feed.
 */

import { useCallback, useEffect, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useConsoleStore } from '../console-store';
import { useGlobalStream, useSystemStats } from '../providers';
import { ApiClientError, listTasks } from '@/lib/nexool/client';
import type { TaskSummary } from '@/lib/nexool/types';
import {
  EmptyState, ErrorCard, EventRow, MetricCard, PulsingDot, SectionTitle, StatusChip, TimeAgo, fmtMs, fmtUptime, statusTone,
} from '../ui-bits';
import {
  Activity, BrainCircuit, Clock, Cpu, Database, Gauge, ListChecks, Radio, TerminalSquare, Wrench,
} from 'lucide-react';

function LatencyChart({ data }: { data: { at: string; ms: number }[] }) {
  const points = data.slice(-60).map((p) => ({ t: new Date(p.at).toLocaleTimeString('en-GB', { hour12: false }), ms: p.ms }));
  if (points.length === 0) {
    return <EmptyState icon={<Activity className="size-6" aria-hidden />} title="No core decisions recorded yet" hint="The latency series fills as the engine makes decisions." />;
  }
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: '#27272a' }} minTickGap={32} />
          <YAxis tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }} tickLine={false} axisLine={false} width={54} unit="ms" />
          <RTooltip
            contentStyle={{ background: '#111113', border: '1px solid #27272a', borderRadius: 8, fontFamily: 'monospace', fontSize: 12 }}
            labelStyle={{ color: '#a1a1aa' }}
            itemStyle={{ color: '#6ee7b7' }}
          />
          <Area type="monotone" dataKey="ms" stroke="#34d399" strokeWidth={1.5} fill="url(#latencyFill)" isAnimationActive={false} name="core latency" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecentTasks() {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);

  const load = useCallback(async () => {
    try {
      const data = await listTasks({ limit: 8 });
      setTasks(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to load tasks');
    }
  }, []);

  useEffect(() => {
    // defer first fetch to a timeout so state updates stay out of the effect body
    const initial = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(t);
    };
  }, [load]);

  if (error && tasks === null) return <ErrorCard title="Could not load tasks" message={error} onRetry={load} />;
  if (tasks === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }
  if (tasks.length === 0) {
    return <EmptyState icon={<TerminalSquare className="size-6" aria-hidden />} title="No tasks yet — create one in the Task Console" />;
  }
  return (
    <ul className="nextool-scroll max-h-[360px] space-y-1.5 overflow-y-auto pr-1" aria-label="Recent tasks">
      {tasks.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            onClick={() => openTaskPreview(t.id)}
            className="flex w-full min-h-11 items-center gap-2 rounded-md border border-zinc-800/80 bg-card/50 px-3 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-800/40"
          >
            <StatusChip status={t.status} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-zinc-200">{t.name || t.request}</span>
              <span className="block truncate font-mono text-[10px] text-zinc-500">
                #{t.id.slice(0, 8)} · {t.mode} · L{t.reasoningLevel} · {t.steps} steps · {t.toolCalls} tools
              </span>
            </span>
            <TimeAgo iso={t.createdAt} className="shrink-0 font-mono text-[10px] text-zinc-500" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function RecentEvents() {
  const { events } = useGlobalStream();
  const recent = events.slice(-30).reverse();
  if (recent.length === 0) {
    return <EmptyState icon={<Radio className="size-6" aria-hidden />} title="No events on stream yet" hint="Runtime events appear here in real time once tasks run." />;
  }
  return (
    <div className="nextool-scroll max-h-[360px] space-y-1.5 overflow-y-auto pr-1" aria-label="Recent runtime events">
      {recent.map((ev) => <EventRow key={ev.id} event={ev} />)}
    </div>
  );
}

export default function DashboardView() {
  const { stats, error, loading, refresh } = useSystemStats();

  const runtimeOffline = !stats || error !== null || stats.runtimeStatus === 'offline';
  const runtimeTone = stats ? statusTone(stats.runtimeStatus) : 'warn';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Gauge className="size-4 text-emerald-400" aria-hidden />}
        title="Dashboard"
        desc="Runtime health, engine metrics and live activity — refreshed every 5s."
      />

      {runtimeOffline ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <PulsingDot tone="warn" className="mt-1" />
            <div>
              <p className="text-sm font-medium text-amber-200">Runtime offline — retrying</p>
              <p className="font-mono text-xs text-amber-200/70">{error ?? 'Waiting for /api/system…'}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="min-h-9 border-amber-500/30 text-amber-200 hover:bg-amber-500/10" onClick={refresh}>
            Retry now
          </Button>
        </div>
      ) : null}

      {loading && !stats ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <MetricCard
              label="Runtime"
              value={stats.runtimeStatus}
              sub={`up ${fmtUptime(stats.runtimeUptimeSec)}`}
              icon={<PulsingDot tone={runtimeTone === 'muted' ? 'warn' : runtimeTone} />}
              tone={runtimeTone === 'muted' ? 'warn' : runtimeTone}
            />
            <MetricCard
              label="Engine"
              value={stats.engine.active}
              sub={`avg core ${fmtMs(stats.engine.avgCoreLatencyMs)} · v${stats.engine.version}`}
              icon={<BrainCircuit className="size-4" aria-hidden />}
            />
            <MetricCard label="Active Tasks" value={stats.tasks.active} sub={`${stats.tasks.total} total`} icon={<ListChecks className="size-4" aria-hidden />} tone="ok" />
            <MetricCard label="Live Tasks" value={stats.tasks.live} sub="scheduled + event-driven" icon={<Radio className="size-4" aria-hidden />} tone={stats.tasks.live > 0 ? 'warn' : 'muted'} />
            <MetricCard label="Tool Calls" value={stats.toolCalls.total} sub={`${stats.toolCalls.success} ok · ${stats.toolCalls.failed} failed`} icon={<Wrench className="size-4" aria-hidden />} />
            <MetricCard label="Success Rate" value={`${Math.round(stats.tasks.successRate * 100)}%`} sub={`${stats.tasks.completed} completed · ${stats.tasks.failed} failed`} icon={<Gauge className="size-4" aria-hidden />} tone={stats.tasks.successRate >= 0.9 ? 'ok' : stats.tasks.successRate >= 0.5 ? 'warn' : 'err'} />
            <MetricCard label="Avg Tool Latency" value={fmtMs(stats.toolCalls.avgMs)} sub="tool execution round-trip" icon={<Clock className="size-4" aria-hidden />} />
            <MetricCard label="Memory Entries" value={stats.memoryEntries} sub="persistent memory store" icon={<Database className="size-4" aria-hidden />} />
            <MetricCard label="Heap" value={`${Math.round(stats.process.heapUsedMb)} MB`} sub={`rss ${Math.round(stats.process.rssMb)} MB · node ${stats.process.nodeVersion}`} icon={<Cpu className="size-4" aria-hidden />} />
            <MetricCard label="Events" value={stats.eventCount} sub="emitted by runtime" icon={<Activity className="size-4" aria-hidden />} />
          </div>

          <section aria-label="Core decision latency" className="rounded-lg border bg-card p-4">
            <SectionTitle
              icon={<Activity className="size-4 text-emerald-400" aria-hidden />}
              title="Core decision latency"
              desc="Recent CoreModule decision times (ms) — live runtime metrics."
              right={<Badge variant="outline" className="border-zinc-700 font-mono text-[10px] text-zinc-400">last {Math.min(stats.latencySeries.length, 60)} decisions</Badge>}
            />
            <div className="mt-3">
              <LatencyChart data={stats.latencySeries} />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-label="Recent tasks" className="rounded-lg border bg-card p-4">
              <SectionTitle
                icon={<TerminalSquare className="size-4 text-emerald-400" aria-hidden />}
                title="Recent tasks"
                desc="Click a task to open the dedicated preview."
              />
              <div className="mt-3">
                <RecentTasks />
              </div>
            </section>

            <section aria-label="Recent events" className="rounded-lg border bg-card p-4">
              <SectionTitle
                icon={<Radio className="size-4 text-emerald-400" aria-hidden />}
                title="Recent events"
                desc="Live SSE feed — newest first (last 30)."
              />
              <div className="mt-3">
                <RecentEvents />
              </div>
            </section>
          </div>
        </>
      ) : (
        <ErrorCard title="Runtime unavailable" message={error ?? 'The runtime did not respond.'} onRetry={refresh} />
      )}
    </div>
  );
}
