'use client';

/**
 * Benchmark (v1.0.2 §38-42) — REAL benchmark runs against the shared engine
 * (same one the CLI uses: nextool benchmark). Selects model × dataset,
 * executes the actual decision unit per example and reports ONLY metrics the
 * engine actually computed. Includes run history with per-case inspection.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  ApiClientError, getBenchmarkRun, getModels, listBenchmarkRuns, listDatasets,
  runBenchmarkJob, type ModelsInfo,
} from '@/lib/nexool/client';
import type { BenchmarkRunDetail, BenchmarkRunSummary, DatasetInfo } from '@/lib/nexool/types';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, StatusChip, TechLabel, TimeAgo, fmtMs } from '../ui-bits';
import { FlaskConical, Loader2, Play } from 'lucide-react';

interface TrainedModelOption {
  id: string;
  label: string;
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass-card rounded-md px-3 py-2.5">
      <TechLabel>{label}</TechLabel>
      <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">{value}</p>
      {hint ? <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function RunDetail({ run, onClose }: { run: BenchmarkRunDetail; onClose: () => void }) {
  const m = run.metrics;
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  return (
    <section aria-label="Benchmark result" className="glass-panel space-y-4 rounded-lg p-4 md:p-6" data-testid="benchmark-result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle title={`Run ${run.id.slice(0, 8)}`} desc={`${run.modelKey} × ${run.datasetName} v${run.datasetVersion} · ${fmtMs(run.durationMs)}`} />
        <Button variant="ghost" size="sm" className="min-h-9 text-muted-foreground" onClick={onClose}>Close</Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <MetricCard label="tool selection" value={pct(m.toolSelectionAccuracy)} hint={`${m.cases} cases`} />
        <MetricCard label="schema validity" value={pct(m.schemaValidity)} hint="of tool_call decisions" />
        <MetricCard label="param accuracy" value={pct(m.paramAccuracy)} hint={m.paramAccuracy === null ? 'no expectedParams in dataset' : 'strict match'} />
        <MetricCard label="no-tool rate" value={pct(m.noToolRate)} hint="no_tool / cannot_execute / stop" />
        <MetricCard label="avg decision" value={fmtMs(m.avgDecisionLatencyMs)} />
        <MetricCard label="p95 decision" value={fmtMs(m.p95DecisionLatencyMs)} />
        <MetricCard label="avg confidence" value={m.avgConfidence.toFixed(3)} />
        <MetricCard label="core calls / case" value={String(m.avgCoreCallsPerCase)} hint="one decision per case" />
      </div>

      {/* Per-case table — responsive horizontal scroll on small screens */}
      <div>
        <TechLabel>per-case results</TechLabel>
        <div className="nextool-scroll mt-1.5 max-h-80 overflow-auto rounded-md border border-white/[0.07]">
          <table className="w-full min-w-[560px] text-left text-[11px]">
            <thead className="sticky top-0 bg-[oklch(0.16_0.03_262)]">
              <tr className="text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">request</th>
                <th className="px-2 py-1.5 font-medium">expected</th>
                <th className="px-2 py-1.5 font-medium">decided</th>
                <th className="px-2 py-1.5 font-medium">status</th>
                <th className="px-2 py-1.5 font-medium">conf</th>
                <th className="px-2 py-1.5 font-medium">latency</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {run.cases.map((c, i) => (
                <tr key={i} className="border-t border-white/[0.06] align-top">
                  <td className="max-w-[260px] px-2 py-1.5 text-foreground/85" title={c.request}>{c.request}</td>
                  <td className="px-2 py-1.5 text-slate-300">{c.expectedTool ?? '—'}</td>
                  <td className={cn('px-2 py-1.5', c.correct ? 'text-emerald-300' : 'text-rose-300')}>{c.decidedTool ?? '—'}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{c.status}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-400">{c.confidence.toFixed(2)}</td>
                  <td className="px-2 py-1.5 tabular-nums text-slate-400">{c.latencyMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {run.error ? (
        <p role="alert" className="break-words rounded-md border border-rose-400/30 bg-rose-400/5 px-3 py-2 font-mono text-xs text-rose-300">{run.error}</p>
      ) : null}
      <details>
        <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">configuration</summary>
        <JsonBlock value={run.config} maxHeight="max-h-32" className="mt-1" />
      </details>
    </section>
  );
}

export default function BenchmarkView() {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [models, setModels] = useState<ModelsInfo | null>(null);
  const [runs, setRuns] = useState<BenchmarkRunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [modelKey, setModelKey] = useState('heuristic-fallback');
  const [datasetId, setDatasetId] = useState('');
  const [limit, setLimit] = useState('50');
  const [label, setLabel] = useState('');
  const [running, setRunning] = useState(false);

  const [detail, setDetail] = useState<BenchmarkRunDetail | null>(null);

  const trainedOptions = useMemo<TrainedModelOption[]>(() => {
    const seen = new Set<string>();
    const out: TrainedModelOption[] = [];
    for (const pkg of models?.packages ?? []) {
      if (pkg.format === 'tfjs-trained-classifier' && !seen.has(pkg.id)) {
        seen.add(pkg.id);
        out.push({ id: pkg.id, label: `${pkg.name} v${pkg.version}` });
      }
    }
    return out;
  }, [models]);

  const load = useCallback(async () => {
    const [ds, md, rs] = await Promise.allSettled([listDatasets(), getModels(), listBenchmarkRuns()]);
    if (ds.status === 'fulfilled') {
      setDatasets(ds.value);
      setError(null);
    } else {
      setError(ds.reason instanceof ApiClientError ? ds.reason.message : 'Datasets unavailable');
    }
    if (md.status === 'fulfilled') setModels(md.value);
    if (rs.status === 'fulfilled') setRuns(rs.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async () => {
    if (!datasetId) {
      toast.error('Select a dataset first');
      return;
    }
    setRunning(true);
    try {
      const run = await runBenchmarkJob({
        modelKey,
        datasetId,
        suite: 'tool-selection',
        limit: limit ? Math.max(1, Math.min(500, Number(limit) || 50)) : undefined,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      toast.success('Benchmark completed', { description: `${Math.round(run.metrics.toolSelectionAccuracy * 100)}% tool selection over ${run.metrics.cases} cases.` });
      const d = await getBenchmarkRun(run.id);
      setDetail(d);
      void load();
    } catch (e) {
      toast.error('Benchmark failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setRunning(false);
    }
  };

  const openRun = async (id: string) => {
    try {
      const d = await getBenchmarkRun(id);
      setDetail(d);
    } catch (e) {
      toast.error('Run load failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  };

  const inputCls = 'min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<FlaskConical className="size-4 text-sky-300" aria-hidden />}
        title="Benchmark"
        desc="Run the actual decision unit against a dataset — the same engine the CLI uses (nextool benchmark)."
      />

      {error ? <ErrorCard title="Registry unavailable" message={error} onRetry={load} /> : null}

      {/* Run configuration */}
      <section aria-label="Benchmark configuration" className="glass-panel space-y-4 rounded-lg p-4 md:p-6">
        <SectionTitle title="New benchmark run" desc="Suite: tool-selection (the implemented suite). Only computed metrics are shown." />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bm-model">Model / decision unit</Label>
            <Select value={modelKey} onValueChange={setModelKey}>
              <SelectTrigger id="bm-model" className={inputCls} aria-label="Benchmark model"><SelectValue /></SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="heuristic-fallback">heuristic-fallback (deterministic matcher)</SelectItem>
                <SelectItem value="llm-core">llm-core (live CoreModule — real LLM calls)</SelectItem>
                {trainedOptions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.label} (trained classifier)</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {modelKey === 'llm-core' ? (
              <p className="text-[10px] text-amber-300/80">Runs real LLM decisions — keep the case limit modest.</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bm-dataset">Dataset</Label>
            {datasets === null ? (
              <Skeleton className="h-11 w-full" />
            ) : datasets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No datasets imported yet — add one in Datasets.</p>
            ) : (
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger id="bm-dataset" className={inputCls} aria-label="Benchmark dataset"><SelectValue placeholder="Select dataset" /></SelectTrigger>
                <SelectContent className="glass-strong">
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.name} v{d.version} — {d.testSize} test</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:col-span-2">
            <div className="space-y-1">
              <Label htmlFor="bm-limit" className="text-xs text-muted-foreground">Case limit</Label>
              <Input id="bm-limit" type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(e.target.value)} className={inputCls} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bm-label" className="text-xs text-muted-foreground">Label (optional)</Label>
              <Input id="bm-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. after-epoch-20" className={inputCls} />
            </div>
          </div>
        </div>
        <div className="flex justify-end border-t border-white/[0.08] pt-4">
          <Button className="min-h-11 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={running || !datasetId} onClick={() => void start()}>
            {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />} Run benchmark
          </Button>
        </div>
      </section>

      {detail ? <RunDetail run={detail} onClose={() => setDetail(null)} /> : null}

      {/* History */}
      <section aria-label="Benchmark history" className="glass-panel rounded-lg p-4">
        <SectionTitle title="Benchmark history" desc="Stored runs — open one to see metrics and per-case results." />
        <div className="mt-3">
          {runs === null ? (
            <Skeleton className="h-20 w-full" />
          ) : runs.length === 0 ? (
            <EmptyState icon={<FlaskConical className="size-6" aria-hidden />} title="No benchmark runs yet" hint="Configure a model and dataset above, then run the first benchmark." />
          ) : (
            <div className="nextool-scroll max-h-72 space-y-2 overflow-y-auto pr-1">
              {runs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => void openRun(r.id)}
                  className={cn(
                    'glass-card flex w-full flex-wrap items-center gap-2 rounded-md px-3 py-2.5 text-left hover:bg-white/[0.06]',
                    detail?.id === r.id && 'ring-1 ring-sky-400/30',
                  )}
                >
                  <StatusChip status={r.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {r.modelKey} <span className="text-muted-foreground">× {r.datasetName} v{r.datasetVersion}</span>
                    {r.label ? <span className="ml-1 text-sky-300">“{r.label}”</span> : null}
                  </span>
                  <span className="font-mono text-[10px] tabular-nums text-slate-300">
                    {r.status === 'completed' ? `${Math.round(r.metrics.toolSelectionAccuracy * 100)}% · ${r.metrics.cases} cases` : ''}
                  </span>
                  <TimeAgo iso={r.createdAt} className="shrink-0 font-mono text-[10px] text-slate-500" />
                  {r.error ? <Badge variant="outline" className="border-rose-400/30 font-mono text-[9px] text-rose-300">error</Badge> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
