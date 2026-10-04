'use client';

/**
 * History (spec §41) — runtime history ledger: time, task, action, status,
 * expandable params/result rows. Filtered client-side.
 * v1.0.1: blue gradient glassmorphism — glass table container (md+) with
 * overflow-x-auto, stacked glass cards under md, sky accents. Rows stay
 * expandable in both layouts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConsoleStore } from '../console-store';
import { ApiClientError, listHistory } from '@/lib/nexool/client';
import type { HistoryEntryDTO } from '@/lib/nexool/api-contract';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, StatusChip, fmtClock } from '../ui-bits';
import { History as HistoryIcon } from 'lucide-react';

function ParamResultGrid({ entry }: { entry: HistoryEntryDTO }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="min-w-0">
        <p className="font-tech mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">params</p>
        <JsonBlock value={entry.params ?? null} maxHeight="max-h-44" />
      </div>
      <div className="min-w-0">
        <p className="font-tech mb-1 text-[9px] uppercase tracking-wider text-muted-foreground">result</p>
        <JsonBlock value={entry.result ?? null} maxHeight="max-h-44" />
      </div>
    </div>
  );
}

function TaskLink({ taskId }: { taskId: string }) {
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  return (
    <button
      type="button"
      className="font-mono text-[11px] text-sky-300 outline-ring/50 hover:underline focus-visible:ring-2"
      onClick={(e) => {
        e.stopPropagation();
        openTaskPreview(taskId);
      }}
      aria-label={`Open task ${taskId.slice(0, 8)}`}
    >
      #{taskId.slice(0, 8)}
    </button>
  );
}

/** Stacked glass card row (mobile <md). */
function HistoryCard({ entry }: { entry: HistoryEntryDTO }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.params !== undefined || entry.result !== undefined;

  return (
    <div className={cn('glass-card rounded-md', expandable && 'glass-card-hover cursor-pointer')}>
      {/* Pointer shortcut for expansion — keyboard users toggle via the chevron button. */}
      <div
        onClick={() => expandable && setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2.5 text-left outline-ring/50"
      >
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtClock(entry.timestamp)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs text-foreground/90">{entry.action}</span>
          <span className="mt-0.5 flex items-center gap-2">
            {entry.taskId ? <TaskLink taskId={entry.taskId} /> : <span className="font-mono text-[11px] text-muted-foreground/60">no task</span>}
            <StatusChip status={entry.status} />
          </span>
        </span>
        {expandable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="rounded p-1 outline-ring/50 focus-visible:ring-2"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} entry ${entry.action}`}
          >
            <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
          </button>
        ) : null}
      </div>
      {open ? <div className="px-3 pb-3"><ParamResultGrid entry={entry} /></div> : null}
    </div>
  );
}

/** Table row (md+). */
function HistoryRow({ entry }: { entry: HistoryEntryDTO }) {
  const [open, setOpen] = useState(false);
  const expandable = entry.params !== undefined || entry.result !== undefined;

  return (
    <>
      <TableRow className={cn('border-white/[0.06]', expandable && 'cursor-pointer')} onClick={() => expandable && setOpen((o) => !o)}>
        <TableCell className="whitespace-nowrap py-2 font-mono text-[11px] text-muted-foreground">{fmtClock(entry.timestamp)}</TableCell>
        <TableCell className="py-2">
          {entry.taskId ? <TaskLink taskId={entry.taskId} /> : <span className="text-muted-foreground/60">—</span>}
        </TableCell>
        <TableCell className="max-w-[280px] truncate py-2 font-mono text-xs text-foreground/90">{entry.action}</TableCell>
        <TableCell className="py-2"><StatusChip status={entry.status} /></TableCell>
        <TableCell className="w-8 py-2 text-right">
          {expandable ? <ChevronDown className={cn('ml-auto size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden /> : null}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="border-white/[0.06] hover:bg-transparent">
          <TableCell colSpan={5} className="bg-white/[0.03] px-4 py-3">
            <ParamResultGrid entry={entry} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export default function HistoryView() {
  const [entries, setEntries] = useState<HistoryEntryDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await listHistory({ limit: 100 });
      setEntries(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'History unavailable');
    }
  }, []);

  useEffect(() => {
    // defer first fetch to a timeout so state updates stay out of the effect body
    const initial = setTimeout(() => void load(), 0);
    return () => clearTimeout(initial);
  }, [load]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries ?? [];
    return (entries ?? []).filter(
      (e) => e.action.toLowerCase().includes(q) || (e.taskId ?? '').toLowerCase().includes(q) || e.status.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  return (
    <div className="space-y-4">
      <SectionTitle
        icon={<HistoryIcon className="size-4 text-sky-300" aria-hidden />}
        title="History"
        desc="Runtime action ledger (latest 100). Click a row to inspect params/result."
      />

      {/* Filter — full-width row so it never squeezes the title on small screens */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by action, task id, status…"
          className="h-11 w-full font-mono text-xs sm:w-72"
          aria-label="Filter history entries"
        />
      </div>

      {error && entries === null ? (
        <ErrorCard title="History unavailable" message={error} onRetry={load} />
      ) : entries === null ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="size-6" aria-hidden />}
          title={entries.length === 0 ? 'No history recorded yet' : 'No entries match the filter'}
          hint={entries.length === 0 ? 'History entries accumulate as the runtime executes actions.' : undefined}
        />
      ) : (
        <>
          {/* Stacked cards on mobile — no forced wide table */}
          <div className="nextool-scroll max-h-[62vh] space-y-2 overflow-y-auto pr-1 md:hidden" aria-label="History entries">
            {filtered.map((entry) => <HistoryCard key={entry.id} entry={entry} />)}
          </div>

          {/* Table on md+ — horizontal scroll stays inside the glass container */}
          <div className="glass-panel nextool-scroll hidden max-h-[62vh] overflow-auto rounded-lg md:block">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-[oklch(0.145_0.028_262/0.92)] backdrop-blur-sm">
                <TableRow className="border-white/[0.08] hover:bg-transparent">
                  <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">time</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">task</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">action</TableHead>
                  <TableHead className="text-[10px] uppercase tracking-wider text-muted-foreground">status</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {entries !== null && entries.length > 0 ? (
        <p className="text-right font-mono text-[10px] text-muted-foreground">
          showing {filtered.length} of {entries.length} (limit 100)
        </p>
      ) : null}
    </div>
  );
}
