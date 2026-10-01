'use client';

/**
 * Reusable virtual-server card (used by Live Monitor, Live State, Memory view).
 * Health: healthy=emerald · degraded=amber · unhealthy=rose · restarting=animated amber.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { VirtualServer } from '@/lib/nexool/types';
import { fmtUptime, TimeAgo, statusTone } from './ui-bits';
import { Activity, Bomb, HeartPulse, RotateCw, TrendingDown, Zap } from 'lucide-react';

const HEALTH_LABEL: Record<VirtualServer['health'], string> = {
  healthy: 'healthy',
  degraded: 'degraded',
  unhealthy: 'unhealthy',
  restarting: 'restarting',
};

export function ServerCard({
  server,
  onInject,
  injecting,
  compact = false,
}: {
  server: VirtualServer;
  /** Provide to enable environment injection buttons */
  onInject?: (type: 'server.crash' | 'server.degrade' | 'server.recover', serverId: string) => void;
  injecting?: boolean;
  compact?: boolean;
}) {
  const tone = statusTone(server.health);
  const badgeClass =
    tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : tone === 'warn' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
    : 'border-rose-500/30 bg-rose-500/10 text-rose-300';

  return (
    <div className={cn('rounded-lg border bg-card p-4', server.health === 'restarting' && 'animate-pulse')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-mono text-sm font-semibold text-zinc-100">{server.id}</span>
        </div>
        <Badge variant="outline" className={cn('font-mono text-[11px]', badgeClass, server.health === 'restarting' && 'animate-pulse')}>
          {HEALTH_LABEL[server.health]}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>CPU</span>
            <span className="font-mono tabular-nums text-zinc-300">{Math.round(server.cpu)}%</span>
          </div>
          <Progress value={server.cpu} className="h-1.5" aria-label={`${server.id} CPU usage`} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>MEM</span>
            <span className="font-mono tabular-nums text-zinc-300">{Math.round(server.memory)}%</span>
          </div>
          <Progress value={server.memory} className="h-1.5" aria-label={`${server.id} memory usage`} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">up {fmtUptime(server.uptimeSec)}</span>
        {server.lastCheckAt ? (
          <span>
            checked <TimeAgo iso={server.lastCheckAt} />
          </span>
        ) : null}
      </div>

      {onInject && !compact ? (
        <TooltipProvider delayDuration={200}>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-800/80 pt-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={injecting}
                  onClick={() => onInject('server.crash', server.id)}
                  aria-label={`Inject crash into ${server.id}`}
                  className="h-8 min-h-8 border-rose-500/30 px-2.5 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                >
                  <Bomb className="size-3.5" aria-hidden /> Crash
                </Button>
              </TooltipTrigger>
              <TooltipContent>Inject server.crash environment event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={injecting}
                  onClick={() => onInject('server.degrade', server.id)}
                  aria-label={`Degrade ${server.id}`}
                  className="h-8 min-h-8 border-amber-500/30 px-2.5 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                >
                  <TrendingDown className="size-3.5" aria-hidden /> Degrade
                </Button>
              </TooltipTrigger>
              <TooltipContent>Inject server.degrade environment event</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={injecting}
                  onClick={() => onInject('server.recover', server.id)}
                  aria-label={`Recover ${server.id}`}
                  className="h-8 min-h-8 border-emerald-500/30 px-2.5 text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                >
                  <HeartPulse className="size-3.5" aria-hidden /> Recover
                </Button>
              </TooltipTrigger>
              <TooltipContent>Inject server.recover environment event</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

/** Compact inline inject controls (Live State view uses full per-server buttons too). */
export function InjectLegend() {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Zap className="size-3" aria-hidden />
      Injections post real <code className="font-mono">/api/env/event</code> calls — the runtime reacts on stream.
      <RotateCw className="size-3" aria-hidden />
    </p>
  );
}
