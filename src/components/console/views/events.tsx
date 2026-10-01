'use client';

/**
 * Events (spec §59) — global runtime event stream with source / type /
 * priority filters. Backed by the shared SSE connection (replay last 15 min
 * + live follow).
 * v1.0.1: blue gradient glassmorphism — glass filter panel, sky active chips,
 * wrapping filter row (no horizontal overflow at 320px).
 */

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { useGlobalStream } from '../providers';
import { EventRow, PulsingDot, SectionTitle, typeLabel } from '../ui-bits';
import { ListFilter } from 'lucide-react';

const SOURCES = ['all', 'planner', 'observer', 'core', 'tool', 'runtime', 'environment', 'user', 'system'] as const;

export default function EventsView() {
  const { events, connected } = useGlobalStream();

  const [source, setSource] = useState<string>('all');
  const [typeQuery, setTypeQuery] = useState('');
  const [minPriority, setMinPriority] = useState(9);

  const filtered = useMemo(() => {
    const q = typeQuery.trim().toLowerCase();
    return events
      .filter((ev) => (source === 'all' ? true : ev.source === source))
      .filter((ev) => (q ? ev.type.toLowerCase().includes(q) || typeLabel(ev.type).includes(q) : true))
      .filter((ev) => ev.priority <= minPriority)
      .slice()
      .reverse(); // newest first
  }, [events, source, typeQuery, minPriority]);

  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of events) counts.set(ev.source, (counts.get(ev.source) ?? 0) + 1);
    return counts;
  }, [events]);

  return (
    <div className="space-y-4">
      <SectionTitle
        icon={<ListFilter className="size-4 text-sky-300" aria-hidden />}
        title="Events"
        desc="Global runtime event stream — server replay covers the last 15 minutes, then live."
        right={
          <span className="flex items-center gap-2 font-mono text-[11px]">
            <PulsingDot tone={connected ? 'ok' : 'err'} />
            <span className={connected ? 'text-emerald-300' : 'text-rose-300'}>{connected ? 'live' : 'reconnecting'}</span>
            <span aria-hidden className="text-muted-foreground/60">·</span>
            <span className="text-muted-foreground">{filtered.length} / {events.length}</span>
          </span>
        }
      />

      {/* Filters — wrap to a single column under md */}
      <div className="glass-panel grid grid-cols-1 gap-3 rounded-lg p-4 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="ev-filter-source">Source</Label>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger id="ev-filter-source" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {SOURCES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-filter-type">Type search</Label>
          <Input id="ev-filter-type" value={typeQuery} onChange={(e) => setTypeQuery(e.target.value)} placeholder="e.g. tick, decision, error" className="min-h-11 border-white/[0.09] bg-white/[0.04] font-mono text-sm" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ev-filter-priority">Priority ≥ {minPriority} <span className="text-muted-foreground">(1 emergency … 9 scheduled)</span></Label>
          <Slider
            id="ev-filter-priority"
            value={[minPriority]}
            min={1}
            max={9}
            step={1}
            onValueChange={([v]) => setMinPriority(v)}
            aria-label="Minimum priority filter"
            className="mt-3"
          />
        </div>
      </div>

      {/* Source counts — 44px hit area per chip */}
      <div className="flex flex-wrap gap-1.5" aria-label="Event counts per source">
        {[...sourceCounts.entries()].map(([src, count]) => (
          <button
            key={src}
            type="button"
            onClick={() => setSource(src)}
            className="inline-flex min-h-11 items-center rounded-md outline-ring/50 focus-visible:ring-2"
            aria-label={`Filter by source ${src}`}
          >
            <Badge
              variant="outline"
              className={
                source === src
                  ? 'bg-primary-gradient-soft border-sky-400/30 font-mono text-[10px] text-sky-100 ring-1 ring-sky-400/25'
                  : 'border-white/[0.09] font-mono text-[10px] text-muted-foreground hover:border-white/[0.15] hover:text-foreground/80'
              }
            >
              {src} · {count}
            </Badge>
          </button>
        ))}
        {sourceCounts.size === 0 ? <span className="text-[11px] text-muted-foreground">No events received yet.</span> : null}
      </div>

      {/* Stream */}
      {filtered.length === 0 ? (
        <div className="glass-card rounded-lg border-dashed p-8 text-center">
          <p className="text-sm font-medium text-foreground/90">{events.length === 0 ? 'No events on the stream yet' : 'No events match the current filters'}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {events.length === 0 ? 'Run a task or inject an environment event — the runtime emits everything here in real time.' : 'Loosen the source, type or priority filters.'}
          </p>
        </div>
      ) : (
        <div className="nextool-scroll max-h-[62vh] space-y-1.5 overflow-y-auto pr-1" aria-label="Filtered event stream">
          {filtered.map((ev) => <EventRow key={ev.id} event={ev} />)}
        </div>
      )}
    </div>
  );
}
