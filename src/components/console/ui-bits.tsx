'use client';

/**
 * Shared small building blocks for the NexTool console views (v1.0.1).
 * Palette rule: blue gradient glassmorphism — sky/cyan/blue brand accents on a
 * deep navy base, with semantic status colors reserved for meaning:
 * emerald (ok) · amber (warn) · rose (error) · sky (info) · slate (muted).
 * Technical metadata uses the Michroma face via `font-tech`.
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
    case 'awaiting_approval': // v1.0.6 §15 — waiting on a user decision
    case 'degraded':
    case 'timeout':
    case 'restarting':
      return 'warn';
    case 'paused': // v1.0.6 §15 — suspended, resumable (NOT stopped)
    case 'live':
      return 'info';
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
    default:
      return 'muted';
  }
}

const toneClasses: Record<Tone, string> = {
  ok: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  warn: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
  err: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  info: 'border-sky-400/30 bg-sky-400/10 text-sky-300',
  muted: 'border-slate-400/25 bg-slate-400/10 text-slate-200',
};

export function StatusChip({ status, className }: { status: string | undefined | null; className?: string }) {
  if (!status) return null;
  return (
    <Badge variant="outline" className={cn('font-mono text-[11px]', toneClasses[statusTone(status)], className)}>
      {status}
    </Badge>
  );
}

/** Michroma technical metadata label — version numbers, system identifiers. */
export function TechLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-tech text-[10px] uppercase tracking-wider text-sky-300/80', className)}>{children}</span>;
}

export const SOURCE_COLORS: Record<EventSource, string> = {
  planner: 'bg-emerald-400',
  core: 'bg-cyan-300',
  tool: 'bg-amber-400',
  observer: 'bg-slate-300',
  runtime: 'bg-slate-400',
  user: 'bg-rose-400',
  environment: 'bg-orange-400',
  system: 'bg-slate-500',
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

import { JsonTree } from './json-tree';

/**
 * v1.0.2 — ONE consistent JSON viewer for the whole console. Objects/arrays
 * render as an interactive tree (expand/collapse, copy); primitives render as
 * text. (spec §74-77)
 */
export function JsonBlock({ value, className, maxHeight = 'max-h-80' }: { value: unknown; className?: string; maxHeight?: string }) {
  const px = maxHeight.includes('px') ? Number(maxHeight.replace(/[^0-9]/g, '')) || 320 : undefined;
  return (
    <div className={className}>
      <JsonTree value={value} maxHeight={px ?? 320} />
    </div>
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
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
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
    : tone === 'info' ? 'text-sky-300'
    : 'text-foreground';
  return (
    <div className={cn('glass-card rounded-lg p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <TechLabel>{label}</TechLabel>
        {icon ? <span className="text-sky-300/70">{icon}</span> : null}
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
  /** v1.0.7 — optional action slot (e.g. "Clear search" on the Tools page). */
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn('glass-card flex flex-col items-center justify-center gap-2 rounded-lg border-dashed p-8 text-center', className)}>
      <div className="text-sky-300/50">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="text-sm font-medium text-foreground/90">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
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
    <div className={cn('flex flex-col items-start gap-3 rounded-lg border border-rose-400/30 bg-rose-400/5 p-4', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-rose-300">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        {title}
      </div>
      <p className="font-mono text-xs text-rose-200/80">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="min-h-9 border-rose-400/30 text-rose-200 hover:bg-rose-400/10">
          <RefreshCw className="size-3.5" aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-white/[0.06]', className)} />;
}

export function PulsingDot({ tone = 'ok', className }: { tone?: Tone; className?: string }) {
  const color =
    tone === 'ok' ? 'bg-emerald-400'
    : tone === 'warn' ? 'bg-amber-400'
    : tone === 'err' ? 'bg-rose-400'
    : tone === 'info' ? 'bg-sky-300'
    : 'bg-slate-400';
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
    <div className="glass-card rounded-md px-3 py-2">
      <button
        type="button"
        onClick={hasData ? () => setOpen((o) => !o) : undefined}
        className={cn('flex w-full items-start gap-2 text-left', hasData && 'cursor-pointer')}
        aria-expanded={open}
      >
        <SourceDot source={event.source} className="mt-1.5" />
        <span className="shrink-0 font-mono text-[11px] text-sky-200/50">[{fmtClock(event.createdAt)}]</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <TypeChip type={event.type} />
            <span className="truncate text-xs text-foreground/90">{event.message}</span>
          </span>
        </span>
        {hasData ? <RotateCw className={cn('mt-0.5 size-3 shrink-0 text-sky-300/40 transition-transform', open && 'rotate-90')} aria-hidden /> : null}
      </button>
      {open && hasData ? <JsonBlock value={event.data} maxHeight="max-h-48" className="mt-2" /> : null}
    </div>
  );
}

// ---------- v1.0.2: runtime status / terminal / checklist derivation ----------

/** The single task-status vocabulary used by the console (spec §71 + v1.0.6 §15). */
export const TASK_STATUS_VOCABULARY = [
  'idle', 'queued', 'starting', 'planning', 'running', 'waiting',
  'awaiting_approval', 'paused', 'observing', 'completed', 'failed', 'cancelled', 'stopped',
] as const;
export type ConsoleTaskStatus = (typeof TASK_STATUS_VOCABULARY)[number];

export interface DerivedTaskRuntime {
  /** Human-readable console status — derived, never hardcoded. */
  status: ConsoleTaskStatus;
  /** Currently executing tool (e.g. "server.health") or null. */
  activeTool: string | null;
  /** True while something is actively executing (drives the terminal cursor). */
  active: boolean;
}

const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'waiting', 'awaiting_approval', 'paused']);

/**
 * Derive the real runtime state of a task from its status + event stream.
 * Used by Task Preview, Live Monitor, the terminal and the status bar — one
 * source of truth so pages cannot invent statuses (spec §72/§83).
 */
export function deriveTaskRuntime(
  taskStatus: string | undefined,
  events: NexToolEvent[],
): DerivedTaskRuntime {
  const last = events.length > 0 ? events[events.length - 1] : undefined;
  const activeTool = (() => {
    // walk backwards to the latest tool.started not followed by its completion
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      if (ev.source !== 'tool') continue;
      const tool = (ev.data as { tool?: string } | undefined)?.tool;
      if (ev.type === 'tool.started' && typeof tool === 'string') return tool;
      if (ev.type === 'tool.completed' || ev.type === 'tool.failed' || ev.type === 'tool.timeout' || ev.type === 'tool.cancelled') {
        const t = (ev.data as { tool?: string } | undefined)?.tool;
        if (typeof t === 'string') return null; // latest tool cycle ended
      }
    }
    return null;
  })();

  if (!taskStatus) {
    return { status: 'idle', activeTool: null, active: false };
  }
  // v1.0.6 §15 — explicit runtime states surface verbatim (never invented).
  if (taskStatus === 'paused') return { status: 'paused', activeTool: null, active: false };
  if (taskStatus === 'awaiting_approval') return { status: 'awaiting_approval', activeTool: activeTool, active: false };
  if (taskStatus === 'completed') return { status: 'completed', activeTool: null, active: false };
  if (taskStatus === 'failed') return { status: 'failed', activeTool: null, active: false };
  if (taskStatus === 'stopped' || taskStatus === 'cancelled') return { status: taskStatus, activeTool: null, active: false };
  if (!ACTIVE_TASK_STATUSES.has(taskStatus)) {
    return { status: 'idle', activeTool: null, active: false };
  }

  // Active task — refine from the latest event
  const type = last?.type ?? '';
  if (activeTool) return { status: 'running', activeTool, active: true };
  if (type.startsWith('task.created') || type.startsWith('task.started')) return { status: 'starting', activeTool: null, active: false };
  if (type.startsWith('planner') || type.startsWith('core')) return { status: 'planning', activeTool: null, active: false };
  if (type.startsWith('observer')) return { status: 'observing', activeTool: null, active: false };
  if (type.startsWith('task.waiting')) return { status: 'waiting', activeTool: null, active: false };
  if (type.startsWith('tool.completed')) return { status: 'observing', activeTool: null, active: false };
  return { status: taskStatus === 'queued' ? 'queued' : 'running', activeTool: null, active: taskStatus === 'running' };
}

/**
 * Terminal status line (spec §7-11). Format: `[status]: Tool called <tool> █`
 * while a tool runs; honest idle/completed/failed lines otherwise. Never a
 * hardcoded shell prompt.
 */
export function terminalStatusLine(rt: DerivedTaskRuntime): {
  label: string; text: string; blinking: boolean;
  tone: 'muted' | 'ok' | 'warn' | 'err' | 'info';
} {
  switch (rt.status) {
    case 'running':
      return rt.activeTool
        ? { label: '[running]', text: `Tool called ${rt.activeTool}`, blinking: true, tone: 'info' }
        : { label: '[running]', text: 'executing plan', blinking: true, tone: 'info' };
    case 'planning':
      return { label: '[planning]', text: 'core module selecting tool', blinking: false, tone: 'info' };
    case 'observing':
      return { label: '[observing]', text: 'observer evaluating result', blinking: false, tone: 'info' };
    case 'waiting':
      return { label: '[waiting]', text: 'waiting for next scheduled tick', blinking: false, tone: 'warn' };
    case 'awaiting_approval':
      return { label: '[awaiting_approval]', text: 'waiting for the user to approve tool execution (timeout 5 min)', blinking: false, tone: 'warn' };
    case 'paused':
      return { label: '[paused]', text: 'paused by user — state preserved, resume to continue', blinking: false, tone: 'info' };
    case 'starting':
      return { label: '[starting]', text: 'task accepted — initializing', blinking: false, tone: 'info' };
    case 'queued':
      return { label: '[queued]', text: 'task queued', blinking: false, tone: 'muted' };
    case 'completed':
      return { label: '[completed]', text: 'task completed', blinking: false, tone: 'ok' };
    case 'failed':
      return { label: '[failed]', text: 'task failed', blinking: false, tone: 'err' };
    case 'stopped':
      return { label: '[stopped]', text: 'task stopped by user', blinking: false, tone: 'muted' };
    case 'cancelled':
      return { label: '[cancelled]', text: 'task cancelled', blinking: false, tone: 'muted' };
    default:
      return { label: '[idle]', text: 'runtime standing by — submit a task to begin', blinking: false, tone: 'muted' };
  }
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string;
  /** [✓] completed · [-] running · [ ] pending · [!] failed · [~] waiting/skipped */
  state: 'completed' | 'running' | 'pending' | 'failed' | 'waiting';
  kind: string;
}

/**
 * Build the live checklist from the ACTUAL plan (spec §62-65). Falls back to
 * terminal events when no plan exists. Returns null percent when no plan is
 * present — the UI shows an indeterminate state instead of a fake number.
 */
export function deriveChecklist(
  plan: { id: string; title: string; detail?: string; status: string; kind: string }[] | undefined,
  events: NexToolEvent[],
): { items: ChecklistItem[]; percent: number | null } {
  const toState = (s: string): ChecklistItem['state'] =>
    s === 'completed' ? 'completed'
    : s === 'in_progress' ? 'running'
    : s === 'failed' ? 'failed'
    : s === 'skipped' ? 'waiting'
    : 'pending';

  if (plan && plan.length > 0) {
    const items: ChecklistItem[] = plan.map((s) => ({
      id: s.id,
      title: s.title,
      detail: s.detail,
      state: toState(s.status),
      kind: s.kind,
    }));
    const done = items.filter((i) => i.state === 'completed' || i.state === 'waiting' || i.state === 'failed').length;
    return { items, percent: Math.round((done / items.length) * 100) };
  }

  // No plan: derive from real task lifecycle events (honest, no invented steps).
  const items: ChecklistItem[] = [];
  const markTool = (tool: string, state: ChecklistItem['state']) => {
    const item = items.find((i) => i.title === `Tool called ${tool}` && i.state === 'running');
    if (item) item.state = state;
  };
  for (const ev of events) {
    if (ev.type === 'task.started' && !items.some((i) => i.id === 'evt-started')) {
      items.push({ id: 'evt-started', title: 'Task started', state: 'completed', kind: 'action' });
    }
    if (ev.type === 'tool.started') {
      const tool = (ev.data as { tool?: string } | undefined)?.tool;
      const id = `evt-tool-${ev.id}`;
      // A second call of the same tool closes the previous cycle.
      markTool(tool ?? '', 'completed');
      if (tool) items.push({ id, title: `Tool called ${tool}`, state: 'running', kind: 'action' });
    }
    if (ev.type === 'tool.completed') {
      const tool = (ev.data as { tool?: string } | undefined)?.tool;
      if (tool) markTool(tool, 'completed');
    }
    if (ev.type === 'tool.failed' || ev.type === 'tool.timeout') {
      const tool = (ev.data as { tool?: string } | undefined)?.tool;
      if (tool) markTool(tool, 'failed');
    }
    if (ev.type === 'task.completed' && !items.some((i) => i.id === 'evt-completed')) {
      items.filter((i) => i.state === 'running').forEach((i) => { i.state = 'completed'; });
      items.push({ id: 'evt-completed', title: 'Task completed', state: 'completed', kind: 'verification' });
    }
    if (ev.type === 'task.failed' && !items.some((i) => i.id === 'evt-failed')) {
      items.filter((i) => i.state === 'running').forEach((i) => { i.state = 'failed'; });
      items.push({ id: 'evt-failed', title: 'Task failed', state: 'failed', kind: 'verification' });
    }
  }
  if (items.length === 0) return { items: [], percent: null };
  const done = items.filter((i) => i.state === 'completed' || i.state === 'failed').length;
  return { items, percent: Math.round((done / items.length) * 100) };
}
