'use client';

/**
 * History (spec §41) — runtime history ledger: time, task, action, status,
 * expandable params/result rows. Filtered client-side.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
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

function HistoryRow({ entry }: { entry: HistoryEntryDTO }) {
  const [open, setOpen] = useState(false);
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);
  const expandable = entry.params !== undefined || entry.result !== undefined;

  return (
    <>
      <TableRow className={cn('border-zinc-800/60', expandable && 'cursor-pointer')} onClick={() => expandable && setOpen((o) => !o)}>
        <TableCell className="whitespace-nowrap py-2 font-mono text-[11px] text-zinc-500">{fmtClock(entry.timestamp)}</TableCell>
        <TableCell className="py-2">
          {entry.taskId ? (
            <button
              type="button"
              className="font-mono text-[11px] text-emerald-400 hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                openTaskPreview(entry.taskId as string);
              }}
              aria-label={`Open task ${entry.taskId.slice(0, 8)}`}
            >
              #{entry.taskId.slice(0, 8)}
            </button>
          ) : (
            <span className="text-zinc-600">—</span>
          )}
        </TableCell>
        <TableCell className="max-w-[280px] truncate py-2 font-mono text-xs text-zinc-200">{entry.action}</TableCell>
        <TableCell className="py-2"><StatusChip status={entry.status} /></TableCell>
        <TableCell className="w-8 py-2 text-right">
          {expandable ? <ChevronDown className={cn('ml-auto size-3.5 text-zinc-600 transition-transform', open && 'rotate-180')} aria-hidden /> : null}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="border-zinc-800/60 hover:bg-transparent">
          <TableCell colSpan={5} className="bg-zinc-950/60 px-4 py-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase text-zinc-600">params</p>
                <JsonBlock value={entry.params ?? null} maxHeight="max-h-44" />
              </div>
              <div>
                <p className="mb-1 font-mono text-[10px] uppercase text-zinc-600">result</p>
                <JsonBlock value={entry.result ?? null} maxHeight="max-h-44" />
              </div>
            </div>
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
        icon={<HistoryIcon className="size-4 text-emerald-400" aria-hidden />}
        title="History"
        desc="Runtime action ledger (latest 100). Click a row to inspect params/result."
        right={
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by action, task id, status…"
            className="h-9 w-56 font-mono text-xs sm:w-72"
            aria-label="Filter history entries"
          />
        }
      />

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
        <div className="nextool-scroll max-h-[62vh] overflow-y-auto rounded-lg border bg-card">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">time</TableHead>
                <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">task</TableHead>
                <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">action</TableHead>
                <TableHead className="text-[10px] uppercase tracking-wider text-zinc-500">status</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}
            </TableBody>
          </Table>
        </div>
      )}

      {entries !== null && entries.length > 0 ? (
        <p className="text-right font-mono text-[10px] text-zinc-600">
          showing {filtered.length} of {entries.length} (limit 100)
        </p>
      ) : null}
    </div>
  );
}
