'use client';

/**
 * RuntimeConnectionStatus (v1.0.1) — reusable, accessible indicator of the
 * ACTUAL frontend ↔ NexTool runtime connection (not merely "frontend loaded").
 *
 * States: connecting · connected · disconnected · reconnecting · error.
 * State comes from the centralized RuntimeConnection store (SSE transport).
 * A popover exposes connection details: runtime health, transport, last
 * connected, last event, reconnect attempts, and a manual reconnect action.
 * Accessible: state is always conveyed by text (never color alone).
 */

import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useRuntimeConnection, type ConnectionState } from '@/lib/nexool/connection';
import { useSystemStats } from './providers';
import { fmtUptime } from './ui-bits';
import { Cable, RefreshCw, ServerCog } from 'lucide-react';

const STATE_META: Record<ConnectionState, { label: string; dot: string; text: string; pulse: boolean }> = {
  connected: { label: 'Connected', dot: 'bg-emerald-400', text: 'text-emerald-300', pulse: true },
  connecting: { label: 'Connecting', dot: 'bg-sky-400', text: 'text-sky-300', pulse: true },
  reconnecting: { label: 'Reconnecting', dot: 'bg-amber-400', text: 'text-amber-300', pulse: true },
  disconnected: { label: 'Disconnected', dot: 'bg-zinc-400', text: 'text-zinc-300', pulse: false },
  error: { label: 'Error', dot: 'bg-rose-400', text: 'text-rose-300', pulse: false },
};

function DetailRow({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-xs text-foreground', mono && 'font-mono')}>{value}</span>
    </div>
  );
}

function useNextRetryLabel() {
  const nextRetryAt = useRuntimeConnection((s) => s.nextRetryAt);
  const status = useRuntimeConnection((s) => s.status);
  const [, force] = useState(0);
  // Re-render every second while a retry is pending so the countdown stays live.
  useEffect(() => {
    if (status !== 'reconnecting') return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);
  if (status !== 'reconnecting' || !nextRetryAt) return null;
  const secs = Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000));
  return `in ${secs}s`;
}

export function RuntimeConnectionStatus({ compact = false }: { compact?: boolean }) {
  const { status, transport, endpoint, runtimeName, lastConnectedAt, lastEventAt, reconnectAttempts, nextRetryAt, frontendLoadedAt, requestReconnect } =
    useRuntimeConnection();
  const { stats } = useSystemStats();
  const [open, setOpen] = useState(false);
  const nextRetryLabel = useNextRetryLabel();

  const meta = STATE_META[status];
  const runtimeAvailable = stats?.runtimeStatus === 'online';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="status"
          aria-label={`Runtime connection: ${meta.label}. ${runtimeAvailable ? 'Runtime is online.' : 'Runtime availability unknown or offline.'} Open connection details.`}
          className={cn(
            'inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs transition-colors outline-ring/50 focus-visible:ring-2',
            meta.pulse ? 'glass-card' : 'glass-card',
            status === 'connected' && 'border-emerald-400/25 text-emerald-300',
            status === 'connecting' && 'border-sky-400/25 text-sky-300',
            status === 'reconnecting' && 'border-amber-400/25 text-amber-300',
            status === 'disconnected' && 'border-zinc-500/25 text-zinc-300',
            status === 'error' && 'border-rose-400/25 text-rose-300',
          )}
        >
          <span className="relative inline-flex size-2" aria-hidden>
            {meta.pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-60', meta.dot)} />}
            <span className={cn('relative inline-flex size-2 rounded-full', meta.dot)} />
          </span>
          <span className={cn(compact ? 'hidden sm:inline' : '', meta.text)}>
            {meta.label}
          </span>
          <span className="sr-only">{`Runtime connection state: ${meta.label}`}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="glass-strong w-80 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Cable className="size-4 text-sky-300" aria-hidden />
            Connection details
          </span>
          <span className={cn('font-mono text-[11px]', meta.text)}>● {status}</span>
        </div>
        <Separator className="mb-2" />
        <DetailRow label="Runtime" value={runtimeAvailable ? 'online' : stats ? stats.runtimeStatus : 'unknown'} />
        <DetailRow label="Engine" value={stats ? `${stats.engine.active} v${stats.engine.version}` : '—'} />
        <DetailRow label="Uptime" value={stats ? fmtUptime(stats.runtimeUptimeSec) : '—'} />
        <DetailRow label="Transport" value={`SSE · ${endpoint}`} />
        <DetailRow label="Connection" value={status} />
        <DetailRow
          label="Last connected"
          value={lastConnectedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastConnectedAt)) / 1000))}s ago` : 'never'}
        />
        <DetailRow
          label="Last event"
          value={lastEventAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(lastEventAt)) / 1000))}s ago` : '—'}
        />
        <DetailRow
          label="Reconnect attempts"
          value={nextRetryLabel ? `${reconnectAttempts} (retry ${nextRetryLabel})` : String(reconnectAttempts)}
        />
        <DetailRow label="Frontend loaded" value={`${Math.max(0, Math.round((Date.now() - Date.parse(frontendLoadedAt)) / 1000))}s ago`} />
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          “Connected” means an active SSE stream to the {runtimeName} — not just a loaded frontend.
        </p>
        {status !== 'connected' ? (
          <Button size="sm" className="mt-3 h-8 w-full bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => requestReconnect()}>
            <RefreshCw className="size-3.5" aria-hidden /> Reconnect now
          </Button>
        ) : (
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-emerald-300/80">
            <ServerCog className="size-3.5" aria-hidden /> Real-time event stream active
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
