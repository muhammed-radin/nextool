'use client';

/**
 * Shared small building blocks for the NexTool console views.
 * Palette rule: zinc neutrals + emerald (ok) + amber (warn) + rose (error)
 * + teal/orange reserved for 'core' / 'environment' source tags.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { NexToolEvent, EventSource } from '@/lib/nexool/types';
import { ApiClientError } from '@/lib/nexool/client';
import {
  AlertTriangle,
  Inbox,
  RefreshCw,
  RotateCw,
} from 'lucide-react';

// ---------- formatting helpers ----------

export function fmtClock(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function fmtMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtUptime(sec: number | undefined | null): string {
  if (sec === undefined || sec === null || Number.isNaN(sec)) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(sec)}s`;
}

/** Relative time, re-rendered every 15s. Client-only text (safe: views hydrate with skeletons). */
export function TimeAgo({ iso, className }: { iso: string | undefined; className?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return <span className={className}>—</span>;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return <span className={className}>—</span>;
  const diff = Date.now() - then;
  let text: string;
  if (diff < 0) text = 'now';
  else if (diff < 5_000) text = 'just now';
  else if (diff < 60_000) text = `${Math.floor(diff / 1000)}s ago`;
  else if (diff < 3_600_000) text = `${Math.floor(diff / 60_000)}m ago`;
  else if (diff < 86_400_000) text = `${Math.floor(diff / 3_600_000)}h ago`;
  else text = `${Math.floor(diff / 86_400_000)}d ago`;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>
      {text}
    </time>
  );
}

// ---------- status / source coloring ----------

type Tone = 'ok' | 'warn' | 'err' | 'muted' | 'info';

export function statusTone(status: string | undefined | null): Tone {
  switch (status) {
    case 'running':
    case 'in_progress':
    case 'completed':
    case 'healthy':
    case 'online':
    case 'active':
    case 'registered':
      return 'ok';
    case 'waiting':
    case 'degraded':
    case 'timeout':
    case 'restarting':
      return 'warn';
    case 'failed':
    case 'unhealthy':
    case 'offline':
    case 'rejected':
      return 'err';
    case 'queued':
    case 'pending':
    case 'stopped':
    case 'cancelled':
    case 'skipped':
    case 'goal':
      return 'muted';
    case 'live':
      return 'info';
    default:
      return 'muted';
  }
}

const toneClasses: Record<Tone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  err: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  info: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  muted: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-300',
};

export function StatusChip({ status, className }: { status: string | undefined | null; className?: string }) {
  if (!status) return null;
  return (
    <Badge variant="outline" className={cn('font-mono text-[11px]', toneClasses[statusTone(status)], className)}>
      {status}
    </Badge>
  );
}

export const SOURCE_COLORS: Record<EventSource, string> = {
  planner: 'bg-emerald-400',
  core: 'bg-teal-300',
  tool: 'bg-amber-400',
  observer: 'bg-zinc-300',
  runtime: 'bg-zinc-400',
  user: 'bg-rose-400',
  environment: 'bg-orange-400',
  system: 'bg-zinc-500',
};

export function SourceDot({ source, className }: { source: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        SOURCE_COLORS[source as EventSource] ?? 'bg-zinc-500',
        className,
      )}
    />
  );
}

/** Human labels for runtime event types (spec §55 taxonomy). Falls back to raw type. */
const TYPE_LABELS: Record<string, string> = {
  'scheduled.tick': 'scheduled tick',
  'environment.event': 'environment event',
  'user.feedback': 'user feedback',
  'user.message': 'user message',
  'planner.decision': 'planner decision',
  'core.decision': 'core decision',
  'tool.execution': 'tool execution',
  'tool.result': 'tool result',
  'observation': 'observation',
  'state.update': 'state update',
  'subgoal.created': 'subgoal creation',
  'goal.completed': 'goal completion',
  'goal.failed': 'goal failed',
  'task.created': 'task created',
  'task.started': 'task started',
  'task.completed': 'task completed',
  'task.failed': 'task failed',
  'task.stopped': 'task stopped',
  'error': 'error',
};

export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type.replace(/[._]/g, ' ');
}

export function TypeChip({ type, className }: { type: string; className?: string }) {
  const tone = type.includes('error') || type.includes('failed') ? 'err' : 'muted';
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px] uppercase tracking-wide', toneClasses[tone], className)}>
      {typeLabel(type)}
    </Badge>
  );
}

// ---------- JSON ----------

export function JsonBlock({ value, className, maxHeight = 'max-h-80' }: { value: unknown; className?: string; maxHeight?: string }) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className={cn('nextool-scroll overflow-auto rounded-md border border-zinc-800 bg-zinc-950/80 p-3 font-mono text-xs leading-relaxed text-zinc-300', maxHeight, className)}>
      {text}
    </pre>
  );
}

// ---------- layout bits ----------

export function SectionTitle({
  icon,
  title,
  desc,
  right,
  className,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100">
          {icon}
          {title}
        </h2>
        {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  sub,
  icon,
  tone = 'muted',
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const valueColor =
    tone === 'ok' ? 'text-emerald-300'
    : tone === 'warn' ? 'text-amber-300'
    : tone === 'err' ? 'text-rose-300'
    : tone === 'info' ? 'text-teal-300'
    : 'text-zinc-100';
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <div className={cn('mt-2 font-mono text-xl font-semibold tabular-nums', valueColor)}>{value}</div>
      {sub ? <div className="mt-1 truncate text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-800 p-8 text-center', className)}>
      <div className="text-zinc-600">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ErrorCard({
  title = 'Request failed',
  message,
  onRetry,
  className,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-rose-300">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {title}
      </div>
      <p className="font-mono text-xs text-rose-200/80">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="min-h-9 border-rose-500/30 text-rose-200 hover:bg-rose-500/10">
          <RefreshCw className="size-3.5" aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-zinc-800/60', className)} />;
}

export function PulsingDot({ tone = 'ok', className }: { tone?: Tone; className?: string }) {
  const color =
    tone === 'ok' ? 'bg-emerald-400'
    : tone === 'warn' ? 'bg-amber-400'
    : tone === 'err' ? 'bg-rose-400'
    : tone === 'info' ? 'bg-teal-300'
    : 'bg-zinc-400';
  return (
    <span className={cn('relative inline-flex size-2.5', className)} aria-hidden>
      <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', color)} />
      <span className={cn('relative inline-flex size-2.5 rounded-full', color)} />
    </span>
  );
}

// ---------- events ----------

export function EventRow({ event, defaultOpen = false }: { event: NexToolEvent; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasData = event.data !== undefined && event.data !== null;
  return (
    <div className="rounded-md border border-zinc-800/80 bg-card/60 px-3 py-2">
      <button
        type="button"
        onClick={hasData ? () => setOpen((o) => !o) : undefined}
        className={cn('flex w-full items-start gap-2 text-left', hasData && 'cursor-pointer')}
        aria-expanded={open}
      >
        <SourceDot source={event.source} className="mt-1.5" />
        <span className="shrink-0 font-mono text-[11px] text-zinc-500">[{fmtClock(event.createdAt)}]</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <TypeChip type={event.type} />
            <span className="truncate text-xs text-zinc-200">{event.message}</span>
          </span>
        </span>
        {hasData ? <RotateCw className={cn('mt-0.5 size-3 shrink-0 text-zinc-600 transition-transform', open && 'rotate-90')} aria-hidden /> : null}
      </button>
      {open && hasData ? <JsonBlock value={event.data} maxHeight="max-h-48" className="mt-2" /> : null}
    </div>
  );
}
