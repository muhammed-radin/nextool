'use client';

/**
 * NexTool v1.0.2 — dynamic runtime terminal (spec §7-12).
 *
 * The v1.0.0/1.0.1 hardcoded `nextool@runtime:~$` prompt is GONE. The terminal
 * now mirrors the ACTUAL runtime activity:
 *   [idle]      → runtime standing by (no cursor)
 *   [running]   → `Tool called server.health █` — cursor blinks ONLY while a
 *                 tool is actively executing
 *   [planning]/[observing]/[waiting] → real intermediate states, no cursor
 *   [completed]/[failed]/[stopped]   → terminal lifecycle states, no cursor
 *
 * Status is derived by `deriveTaskRuntime` from the SAME event stream that
 * feeds Task Preview / Live Monitor — there is no separate fake terminal
 * state (spec §12). Event lines below the status line are the real runtime
 * events (`[HH:MM:SS] source → message`).
 */

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { NexToolEvent, EventSource } from '@/lib/nexool/types';
import { cn } from '@/lib/utils';
import { deriveTaskRuntime, terminalStatusLine, type DerivedTaskRuntime } from './ui-bits';
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

const TONE_LABEL: Record<string, string> = {
  muted: 'text-slate-400',
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  err: 'text-rose-300',
  info: 'text-sky-300',
};

export function RuntimeTerminal({
  taskId,
  events,
  taskStatus,
  className,
}: {
  taskId: string;
  events: NexToolEvent[];
  /** The task's real status field (TaskDetail.status). */
  taskStatus?: string;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const runtime: DerivedTaskRuntime = deriveTaskRuntime(taskStatus, events);
  const statusLine = terminalStatusLine(runtime);

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
        {/* Status line — derived from the live event stream, never hardcoded */}
        <div className="mb-2 font-mono text-xs leading-relaxed" aria-live="polite">
          <span className={cn('font-bold', TONE_LABEL[statusLine.tone])}>{statusLine.label}</span>{' '}
          <span className="text-sky-300/50">:</span>{' '}
          <span className={cn(statusLine.tone === 'err' ? 'font-bold text-rose-300' : 'text-sky-50/90')}>
            {statusLine.text}
          </span>
          {statusLine.blinking ? (
            <span
              className="ml-1 inline-block h-3.5 w-2 animate-pulse bg-sky-400/90 align-middle"
              aria-hidden
              data-testid="terminal-cursor-active"
            />
          ) : null}
        </div>

        {/* Real runtime event lines */}
        {events.length === 0 ? (
          <p className="font-mono text-xs leading-relaxed text-slate-400">
            <span className="text-slate-500">—</span> no runtime events for this task yet
          </p>
        ) : (
          <AnimatePresence initial={false}>
            {events.map((ev) => {
              const isError = ev.type.includes('error') || ev.type.includes('failed') || ev.priority <= 2;
              return (
                <motion.div
                  key={ev.id}
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18 }}
                  className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
                >
                  <span className="text-slate-500">[{fmtClock(ev.createdAt)}]</span>{' '}
                  <span className={cn('font-semibold', SOURCE_TEXT[ev.source as EventSource] ?? 'text-slate-300')}>
                    {ev.source}
                  </span>{' '}
                  <span className="text-sky-300/50">→</span>{' '}
                  <span className={cn(isError ? 'font-bold text-rose-300' : 'text-sky-50/90')}>{ev.message}</span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
