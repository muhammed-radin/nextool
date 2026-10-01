'use client';

/**
 * NexTool v1.0.2/v1.0.3 — Live Task Checklist / Timeline (spec §62-69, v1.0.3 §2-4).
 *
 * Aceternity-style animated timeline: the running step carries a moving
 * gradient highlight, completion stamps animate in, and the whole list
 * transitions as runtime state changes. Animation communicates progress and
 * STATE TRANSITIONS only — never decoration:
 *   pending → running    : moving highlight + ring switch
 *   running → completed  : ✓ pulse + emerald ring
 *   running → failed     : ! + rose ring
 *
 * States come from the ACTUAL plan / event stream via deriveChecklist:
 *   [✓] completed   [-] running   [ ] pending   [!] failed   [~] waiting
 * Progress % only renders when a meaningful percentage exists; otherwise the
 * bar is indeterminate (no invented numbers, spec §65).
 *
 * v1.0.3: `ChecklistItems` is exported so the Task Preview Plan section
 * renders the SAME animated, runtime-driven checklist states (one state
 * source — v1.0.3 §2/§3/§31).
 */

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { deriveChecklist, type ChecklistItem } from './ui-bits';
import type { NexToolEvent } from '@/lib/nexool/types';

const STATE_GLYPH: Record<string, string> = {
  completed: '✓',
  running: '-',
  pending: ' ',
  failed: '!',
  waiting: '~',
};

const STATE_STYLE: Record<string, { ring: string; text: string; glyph: string; bg: string }> = {
  completed: { ring: 'border-emerald-400/50 bg-emerald-400/10', text: 'text-emerald-300', glyph: 'text-emerald-300', bg: 'bg-emerald-400' },
  running: { ring: 'border-sky-400/60 bg-primary-gradient-soft', text: 'text-sky-200', glyph: 'text-sky-300', bg: 'bg-sky-400' },
  pending: { ring: 'border-white/[0.12] bg-white/[0.03]', text: 'text-slate-400', glyph: 'text-slate-500', bg: 'bg-slate-500' },
  failed: { ring: 'border-rose-400/50 bg-rose-400/10', text: 'text-rose-300', glyph: 'text-rose-300', bg: 'bg-rose-400' },
  waiting: { ring: 'border-amber-400/40 bg-amber-400/[0.07]', text: 'text-amber-300/90', glyph: 'text-amber-300', bg: 'bg-amber-400' },
};

/**
 * The animated checklist rows themselves — shared by the Live checklist and
 * the always-visible Plan section. Every state change (re-render with a new
 * state) animates: the running highlight mounts on `running`, the completion
 * pulse fires on `completed`, rings/colors transition smoothly.
 */
export function ChecklistItems({ items, finished }: { items: ChecklistItem[]; finished: boolean }) {
  return (
    <ol className="relative space-y-1.5" aria-label="Task checklist">
      <span aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-white/[0.08]" />
      {items.map((item, idx) => {
        const style = STATE_STYLE[item.state] ?? STATE_STYLE.pending;
        const isRunning = item.state === 'running';
        return (
          <motion.li
            key={item.id}
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(idx * 0.04, 0.4), duration: 0.22 }}
            className={cn(
              'relative flex items-start gap-3 rounded-lg border px-3 py-2 transition-colors duration-300',
              style.ring,
              isRunning && 'overflow-hidden',
            )}
          >
            {/* Aceternity-style moving highlight on the active step */}
            {isRunning ? (
              <motion.span
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{ background: 'linear-gradient(90deg, transparent, oklch(0.72 0.14 225), transparent)' }}
                animate={{ left: ['-30%', '100%'] }}
                transition={{ repeat: Infinity, duration: 2.2, ease: 'linear' }}
              />
            ) : null}
            <motion.span
              aria-hidden
              key={`glyph-${item.state}`}
              initial={{ scale: item.state === 'completed' ? 1.4 : 1, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 22 }}
              className={cn(
                'z-10 flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold',
                style.ring,
                style.glyph,
              )}
            >
              {STATE_GLYPH[item.state]}
            </motion.span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-sm leading-5', isRunning ? 'font-medium text-foreground' : style.text)}>
                {item.title}
              </span>
              {item.detail ? <span className="mt-0.5 block text-xs text-muted-foreground">{item.detail}</span> : null}
            </span>
            <span className="shrink-0">
              <span
                className={cn(
                  'rounded border border-white/[0.09] px-1 font-mono text-[9px] uppercase',
                  isRunning ? 'text-sky-300' : 'text-muted-foreground',
                )}
              >
                {item.kind}
              </span>
            </span>
            {/* Completion pulse for just-finished steps (animation = state transition) */}
            {!finished && item.state === 'completed' ? (
              <motion.span
                aria-hidden
                className={cn('absolute right-2 top-1/2 size-1 rounded-full', style.bg)}
                initial={{ opacity: 1, scale: 2.4 }}
                animate={{ opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.9 }}
              />
            ) : null}
          </motion.li>
        );
      })}
    </ol>
  );
}

export function TaskChecklist({
  plan,
  events,
  taskStatus,
  className,
}: {
  plan: { id: string; title: string; detail?: string; status: string; kind: string }[] | undefined;
  events: NexToolEvent[];
  taskStatus?: string;
  className?: string;
}) {
  const { items, percent } = deriveChecklist(plan, events);

  if (items.length === 0) {
    return (
      <div className={cn('glass-card rounded-lg border-dashed p-6 text-center', className)}>
        <p className="text-sm text-foreground/80">No plan yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The planner publishes the checklist as soon as the task starts executing.
        </p>
      </div>
    );
  }

  const finished = taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'stopped' || taskStatus === 'cancelled';

  return (
    <div className={cn('space-y-3', className)}>
      {/* Progress header */}
      <div className="flex items-center justify-between gap-3">
        <span className="font-tech text-[10px] uppercase tracking-widest text-sky-300/70">Progress</span>
        <span className="font-mono text-xs tabular-nums text-foreground">
          {percent !== null ? `${percent}%` : <span className="text-muted-foreground">indeterminate</span>}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {percent !== null ? (
          <motion.div
            className="bg-primary-gradient h-full rounded-full"
            initial={{ width: 0 }}
            animate={{ width: `${percent}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            data-testid="checklist-progress-bar"
          />
        ) : (
          <motion.div
            className="bg-primary-gradient h-full w-1/3 rounded-full"
            animate={{ x: ['0%', '300%'] }}
            transition={{ repeat: Infinity, duration: 1.4, ease: 'linear' }}
            aria-label="Task in progress"
          />
        )}
      </div>

      <ChecklistItems items={items} finished={finished} />
    </div>
  );
}
