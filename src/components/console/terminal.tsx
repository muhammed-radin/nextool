'use client';

/**
 * Runtime terminal (spec §53) — `.nextool-terminal` scanline surface rendering
 * live task events as `[HH:MM:SS] source → message` lines with auto-scroll.
 * v1.0.1: blue glass surface, Readex/Michroma chrome, efficient rendering
 * (plain divs, capped scroll container, no per-line React state).
 */

import { useEffect, useRef } from 'react';
import type { NexToolEvent, EventSource } from '@/lib/nexool/types';
import { cn } from '@/lib/utils';
import { fmtClock } from './ui-bits';

const SOURCE_TEXT: Record<EventSource, string> = {
  planner: 'text-emerald-300',
  core: 'text-cyan-300',
  tool: 'text-amber-300',
  observer: 'text-slate-200',
  runtime: 'text-slate-300',
  user: 'text-rose-300',
  environment: 'text-orange-300',
  system: 'text-slate-400',
};

export function RuntimeTerminal({ taskId, events, className }: { taskId: string; events: NexToolEvent[]; className?: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new lines arrive.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div className={cn('glass-panel overflow-hidden rounded-lg', className)}>
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <span className="size-2.5 rounded-full bg-rose-400/80" aria-hidden />
        <span className="size-2.5 rounded-full bg-amber-300/80" aria-hidden />
        <span className="size-2.5 rounded-full bg-sky-400/80" aria-hidden />
        <span className="ml-2 truncate font-mono text-xs text-sky-200/70">runtime://{taskId}</span>
        <span className="font-tech ml-auto hidden shrink-0 text-[9px] uppercase tracking-widest text-sky-300/50 sm:inline">
          runtime output
        </span>
      </div>
      <div
        ref={bodyRef}
        role="log"
        aria-label={`Runtime output for task ${taskId}`}
        className="nextool-terminal nextool-scroll h-64 overflow-y-auto p-3 md:h-80"
      >
        {events.length === 0 ? (
          <p className="font-mono text-xs text-slate-400">
            <span className="text-sky-300/60">nextool@runtime</span>:<span className="text-sky-200/70">~$</span> waiting for runtime events…
          </p>
        ) : (
          events.map((ev) => {
            const isError = ev.type.includes('error') || ev.type.includes('failed') || ev.priority <= 2;
            return (
              <div key={ev.id} className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                <span className="text-slate-500">[{fmtClock(ev.createdAt)}]</span>{' '}
                <span className={cn('font-semibold', SOURCE_TEXT[ev.source as EventSource] ?? 'text-slate-300')}>
                  {ev.source}
                </span>{' '}
                <span className="text-sky-300/50">→</span>{' '}
                <span className={cn(isError ? 'font-bold text-rose-300' : 'text-sky-50/90')}>{ev.message}</span>
              </div>
            );
          })
        )}
        <div className="mt-1 font-mono text-xs leading-relaxed">
          <span className="text-sky-300/60">nextool@runtime</span>:<span className="text-sky-200/70">~$</span>{' '}
          <span className="inline-block h-3.5 w-2 animate-pulse bg-sky-400/80 align-middle" aria-hidden />
        </div>
      </div>
    </div>
  );
}
