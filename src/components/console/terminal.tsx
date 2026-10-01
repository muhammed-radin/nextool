'use client';

/**
 * Runtime terminal (spec §53) — `.nextool-terminal` scanline surface rendering
 * live task events as `[HH:MM:SS] source → message` lines with auto-scroll.
 */

import { useEffect, useRef } from 'react';
import type { NexToolEvent, EventSource } from '@/lib/nexool/types';
import { cn } from '@/lib/utils';
import { fmtClock } from './ui-bits';

const SOURCE_TEXT: Record<EventSource, string> = {
  planner: 'text-emerald-400',
  core: 'text-teal-300',
  tool: 'text-amber-400',
  observer: 'text-zinc-300',
  runtime: 'text-zinc-400',
  user: 'text-rose-400',
  environment: 'text-orange-400',
  system: 'text-zinc-500',
};

export function RuntimeTerminal({ taskId, events, className }: { taskId: string; events: NexToolEvent[]; className?: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new lines arrive.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-zinc-800', className)}>
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
        <span className="size-2.5 rounded-full bg-rose-500/80" aria-hidden />
        <span className="size-2.5 rounded-full bg-amber-400/80" aria-hidden />
        <span className="size-2.5 rounded-full bg-emerald-400/80" aria-hidden />
        <span className="ml-2 truncate font-mono text-xs text-zinc-400">runtime://{taskId}</span>
      </div>
      <div
        ref={bodyRef}
        role="log"
        aria-label={`Runtime output for task ${taskId}`}
        className="nextool-terminal nextool-scroll h-64 overflow-y-auto p-3 md:h-80"
      >
        {events.length === 0 ? (
          <p className="font-mono text-xs text-zinc-500">
            <span className="text-zinc-600">nexchange@runtime</span>:<span className="text-zinc-500">~$</span> waiting for runtime events…
          </p>
        ) : (
          events.map((ev) => {
            const isError = ev.type.includes('error') || ev.type.includes('failed') || ev.priority <= 2;
            return (
              <div key={ev.id} className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                <span className="text-zinc-600">[{fmtClock(ev.createdAt)}]</span>{' '}
                <span className={cn('font-semibold', SOURCE_TEXT[ev.source as EventSource] ?? 'text-zinc-400')}>
                  {ev.source}
                </span>{' '}
                <span className="text-zinc-600">→</span>{' '}
                <span className={cn(isError ? 'font-bold text-rose-400' : 'text-zinc-200')}>{ev.message}</span>
              </div>
            );
          })
        )}
        <div className="mt-1 font-mono text-xs leading-relaxed">
          <span className="text-zinc-600">nexchange@runtime</span>:<span className="text-zinc-500">~$</span>{' '}
          <span className="inline-block h-3.5 w-2 animate-pulse bg-emerald-400/80 align-middle" aria-hidden />
        </div>
      </div>
    </div>
  );
}
