'use client';

/**
 * Live State — full GlobalLiveState view: runtime banner, server fleet with
 * 3s auto-refresh and per-server environment injections, active counters.
 * v1.0.1: blue gradient glassmorphism — glass banner/cards, sky accents,
 * 1→2→3 column responsive fleet grid.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError, getLiveState, injectEnvEvent } from '@/lib/nexool/client';
import type { GlobalLiveState } from '@/lib/nexool/types';
import { ServerCard } from '../server-card';
import { PulsingDot, SectionTitle, TimeAgo, fmtUptime, statusTone } from '../ui-bits';
import { Activity, ListChecks, Radio, Server } from 'lucide-react';

export default function LiveStateView() {
  const [state, setState] = useState<GlobalLiveState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [injecting, setInjecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getLiveState();
      setState(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Live state unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

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

  const tone = state ? statusTone(state.runtimeStatus) : 'muted';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Activity className="size-4 text-sky-300" aria-hidden />}
        title="Live State"
        desc="Global ephemeral runtime state — auto-refreshed every 3s."
      />

      {error && state === null ? (
        <div className="rounded-lg border border-rose-400/30 bg-rose-400/5 p-4">
          <p className="text-sm font-medium text-rose-300">Runtime unavailable</p>
          <p className="mt-1 font-mono text-xs text-rose-200/80">{error}</p>
          <Button variant="outline" size="sm" className="mt-3 min-h-11 border-rose-400/30 text-rose-200 hover:bg-rose-400/10" onClick={load}>
            Retry
          </Button>
        </div>
      ) : null}

      {state === null && !error ? (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}
          </div>
        </div>
      ) : null}

      {state ? (
        <>
          {/* Runtime banner */}
          <div className="glass-panel flex flex-wrap items-center justify-between gap-3 rounded-lg p-4">
            <div className="flex min-w-0 items-center gap-3">
              <PulsingDot tone={tone === 'muted' ? 'warn' : (tone as 'ok' | 'warn' | 'err')} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">
                  Runtime status: <span className="font-mono">{state.runtimeStatus}</span>
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  started {new Date(state.startedAt).toLocaleString()} · up {fmtUptime(Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000))}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 border-white/[0.09] bg-white/[0.03] font-mono text-[11px] text-foreground/90">
                <ListChecks className="size-3 text-sky-300/80" aria-hidden /> active goal tasks {state.activeGoalTasks}
              </Badge>
              <Badge variant="outline" className="gap-1.5 border-sky-400/30 bg-sky-400/10 font-mono text-[11px] text-sky-300">
                <Radio className="size-3" aria-hidden /> active live tasks {state.activeLiveTasks}
              </Badge>
            </div>
          </div>

          {/* Server fleet */}
          <section aria-label="Server fleet" className="space-y-3">
            <SectionTitle
              icon={<Server className="size-4 text-sky-300" aria-hidden />}
              title="Virtual server fleet"
              desc="Inject real environment events — the runtime observes and reacts on the next tick."
              right={<TimeAgo iso={state.servers[0]?.lastCheckAt} className="font-mono text-[10px] text-muted-foreground" />}
            />
            {state.servers.length === 0 ? (
              <p className="glass-card rounded-lg border-dashed p-6 text-center text-xs text-muted-foreground">No servers registered in the environment.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {state.servers.map((server) => (
                  <ServerCard key={server.id} server={server} onInject={(type, id) => void inject(type, id)} injecting={injecting} />
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
