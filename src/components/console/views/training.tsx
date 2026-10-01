'use client';

/**
 * Training (v1.0.2 §32-37) — REAL training workflow against the shared
 * TF.js engine (same service the CLI uses):
 *   dataset selection → configuration → start → live progress → logs →
 *   job history → model package produced (visible in Models).
 *
 * Metrics are only rendered when the engine actually produced them; jobs in
 * flight show real epoch counts from TrainingJobRecord.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';
import {
  ApiClientError, cancelTrainingJob, createTrainingJob, getTrainingJob,
  listDatasets, listTrainingJobs, listTools,
} from '@/lib/nexool/client';
import type { DatasetInfo } from '@/lib/nexool/types';
import type { TrainingJobDetail, TrainingJobSummary } from '@/lib/nexool/types';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, StatusChip, TechLabel, TimeAgo, fmtMs } from '../ui-bits';
import { GraduationCap, Loader2, Play, RefreshCw, Square } from 'lucide-react';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'starting', 'running']);

function JobProgress({ job }: { job: TrainingJobDetail }) {
  const pct = job.epochs > 0 ? Math.min(100, Math.round((job.epochsDone / job.epochs) * 100)) : 0;
  const latest = job.metrics[job.metrics.length - 1];
  const elapsed = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : undefined;
  const perEpoch = job.epochsDone > 0 && elapsed ? elapsed / job.epochsDone : undefined;
  const remaining = perEpoch && job.status === 'running' ? perEpoch * (job.epochs - job.epochsDone) : undefined;

  return (
    <div className="space-y-3" data-testid="training-progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-foreground">
          Epoch <span className="text-sky-300">{job.epochsDone}</span> / {job.epochs}
          {latest ? ` · loss ${latest.loss}` : ''}
          {latest?.valLoss !== null && latest?.valLoss !== undefined ? ` · val_loss ${latest.valLoss}` : ''}
          {latest ? ` · accuracy ${latest.accuracy}` : ''}
          {latest?.valAccuracy !== null && latest?.valAccuracy !== undefined ? ` · val_accuracy ${latest.valAccuracy}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <StatusChip status={job.status} />
          {elapsed !== undefined ? <span className="font-mono text-[11px] text-muted-foreground">elapsed {fmtMs(elapsed)}</span> : null}
          {remaining !== undefined ? <span className="font-mono text-[11px] text-muted-foreground">~{fmtMs(remaining)} left</span> : null}
        </div>
      </div>
      <Progress value={pct} className="h-2" aria-label={`Training progress ${pct}%`} />
    </div>
  );
}

function MetricsChart({ metrics }: { metrics: TrainingJobDetail['metrics'] }) {
  // Small inline SVG sparkline of loss/accuracy — real data, no chart lib needed.
  if (metrics.length < 2) return null;
  const w = 280;
  const h = 64;
  const losses = metrics.map((m) => m.loss);
  const accs = metrics.map((m) => m.accuracy);
  const maxLoss = Math.max(...losses, 0.0001);
  const path = (vals: number[], max: number) =>
    vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (vals.length - 1)) * w},${h - (v / max) * h}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full max-w-[280px]" role="img" aria-label="Loss curve">
      <path d={path(losses, maxLoss)} fill="none" stroke="oklch(0.72 0.14 225)" strokeWidth="1.5" />
      <path d={path(accs, 1)} fill="none" stroke="oklch(0.78 0.16 162)" strokeWidth="1.5" strokeDasharray="3 2" />
    </svg>
  );
}

export default function TrainingView() {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [datasetId, setDatasetId] = useState<string>('');
  const [jobs, setJobs] = useState<TrainingJobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [config, setConfig] = useState({ epochs: 20, batchSize: 8, learningRate: 0.01, validationSplit: 0.2, shuffle: true, earlyStoppingPatience: 0 });
  const [starting, setStarting] = useState(false);

  const [selectedJob, setSelectedJob] = useState<TrainingJobDetail | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const activeJobId = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [ds, js] = await Promise.allSettled([listDatasets(), listTrainingJobs()]);
    if (ds.status === 'fulfilled') {
      setDatasets(ds.value);
      setError(null);
    } else {
      setError(ds.reason instanceof ApiClientError ? ds.reason.message : 'Datasets unavailable');
    }
    if (js.status === 'fulfilled') setJobs(js.value);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the selected (or newest active) job while it runs — real progress.
  useEffect(() => {
    const active = jobs?.find((j) => ACTIVE_JOB_STATUSES.has(j.status));
    if (active && !activeJobId.current) activeJobId.current = active.id;
    if (!activeJobId.current) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await getTrainingJob(activeJobId.current as string);
        if (alive) setSelectedJob(d);
        const stillActive = ACTIVE_JOB_STATUSES.has(d.status);
        if (!stillActive) {
          activeJobId.current = null;
          void load();
        }
      } catch {
        /* job endpoint hiccup — retry next tick */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [jobs, load]);

  const selectJob = async (id: string) => {
    setJobLoading(true);
    activeJobId.current = ACTIVE_JOB_STATUSES.has(jobs?.find((j) => j.id === id)?.status ?? '') ? id : activeJobId.current;
    try {
      const d = await getTrainingJob(id);
      setSelectedJob(d);
      activeJobId.current = ACTIVE_JOB_STATUSES.has(d.status) ? id : null;
    } catch (e) {
      toast.error('Job load failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setJobLoading(false);
    }
  };

  const dataset = useMemo(() => datasets?.find((d) => d.id === datasetId) ?? null, [datasets, datasetId]);

  const start = async () => {
    if (!datasetId) {
      toast.error('Select a dataset first');
      return;
    }
    setStarting(true);
    try {
      const job = await createTrainingJob({
        datasetId,
        config: {
          epochs: Number(config.epochs),
          batchSize: Number(config.batchSize),
          learningRate: Number(config.learningRate),
          validationSplit: Number(config.validationSplit),
          shuffle: config.shuffle,
          ...(config.earlyStoppingPatience > 0 ? { earlyStoppingPatience: Number(config.earlyStoppingPatience) } : {}),
        },
      });
      toast.success('Training queued', { description: `Job #${job.id.slice(0, 8)} on ${job.datasetName} v${job.datasetVersion}.` });
      activeJobId.current = job.id;
      void load();
      void selectJob(job.id);
    } catch (e) {
      toast.error('Cannot start training', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await cancelTrainingJob(id);
      toast.success('Cancel signal sent', { description: 'Stops between epochs.' });
      void selectJob(id);
    } catch (e) {
      toast.error('Cancel failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  };

  const inputCls = 'min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<GraduationCap className="size-4 text-sky-300" aria-hidden />}
        title="Training"
        desc="Real TensorFlow.js tool-selection training — the same engine the CLI uses (nextool train)."
      />

      {error ? <ErrorCard title="Registry unavailable" message={error} onRetry={load} /> : null}

      {/* Configuration */}
      <section aria-label="Training configuration" className="glass-panel space-y-4 rounded-lg p-4 md:p-6">
        <SectionTitle title="New training run" desc="Dataset examples need a request + expectedTool to be trainable." />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="train-dataset">Dataset</Label>
            {datasets === null ? (
              <Skeleton className="h-11 w-full" />
            ) : datasets.length === 0 ? (
              <p className="text-xs text-muted-foreground">No datasets imported yet — add one in Datasets.</p>
            ) : (
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger id="train-dataset" className={inputCls} aria-label="Training dataset"><SelectValue placeholder="Select dataset" /></SelectTrigger>
                <SelectContent className="glass-strong">
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} v{d.version} ({d.format}) — {d.trainSize + d.valSize + d.testSize} examples
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {dataset ? (
              <p className="font-mono text-[10px] text-muted-foreground">
                train {dataset.trainSize} · val {dataset.valSize} · test {dataset.testSize}
              </p>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="train-epochs" className="text-xs text-muted-foreground">Epochs</Label>
              <Input id="train-epochs" type="number" min={1} max={100} value={config.epochs} onChange={(e) => setConfig((c) => ({ ...c, epochs: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))} className={inputCls} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="train-batch" className="text-xs text-muted-foreground">Batch size</Label>
              <Input id="train-batch" type="number" min={1} max={128} value={config.batchSize} onChange={(e) => setConfig((c) => ({ ...c, batchSize: Math.max(1, Math.min(128, Number(e.target.value) || 1)) }))} className={inputCls} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="train-lr" className="text-xs text-muted-foreground">Learning rate</Label>
              <Input id="train-lr" type="number" step="0.001" min={0.0001} max={1} value={config.learningRate} onChange={(e) => setConfig((c) => ({ ...c, learningRate: Number(e.target.value) || 0.01 }))} className={inputCls} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="train-split" className="text-xs text-muted-foreground">Validation split</Label>
              <Input id="train-split" type="number" step="0.05" min={0} max={0.5} value={config.validationSplit} onChange={(e) => setConfig((c) => ({ ...c, validationSplit: Math.max(0, Math.min(0.5, Number(e.target.value) || 0)) }))} className={inputCls} />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch id="train-shuffle" checked={config.shuffle} onCheckedChange={(v) => setConfig((c) => ({ ...c, shuffle: v }))} aria-label="Shuffle" />
              <Label htmlFor="train-shuffle" className="text-xs text-muted-foreground">Shuffle</Label>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="train-earlystop" className="whitespace-nowrap text-xs text-muted-foreground">Early stop patience</Label>
              <Input id="train-earlystop" type="number" min={0} max={50} value={config.earlyStoppingPatience} onChange={(e) => setConfig((c) => ({ ...c, earlyStoppingPatience: Math.max(0, Math.min(50, Number(e.target.value) || 0)) }))} className="h-9 w-20 border-white/[0.09] bg-white/[0.04] font-mono text-sm" />
              <span className="text-[10px] text-muted-foreground">0 = off</span>
            </div>
          </div>
          <Button className="min-h-11 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={starting || !datasetId} onClick={() => void start()}>
            {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />} Start training
          </Button>
        </div>
      </section>

      {/* Active/selected job */}
      {selectedJob ? (
        <section aria-label="Training job" className="glass-panel space-y-4 rounded-lg p-4 md:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionTitle title={`Job ${selectedJob.id.slice(0, 8)}`} desc={`${selectedJob.datasetName} v${selectedJob.datasetVersion}`} />
            <div className="flex items-center gap-2">
              {ACTIVE_JOB_STATUSES.has(selectedJob.status) ? (
                <Button variant="outline" size="sm" className="min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10" onClick={() => void cancel(selectedJob.id)}>
                  <Square className="size-3.5" aria-hidden /> Cancel
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" className="min-h-9 text-muted-foreground" onClick={() => void selectJob(selectedJob.id)}>
                <RefreshCw className="size-3.5" aria-hidden /> Refresh
              </Button>
            </div>
          </div>

          <JobProgress job={selectedJob} />
          {selectedJob.metrics.length > 1 ? <MetricsChart metrics={selectedJob.metrics} /> : null}

          {selectedJob.finalMetrics ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="training-final-metrics">
              {([
                ['loss', selectedJob.finalMetrics.loss],
                ['val loss', selectedJob.finalMetrics.valLoss ?? '—'],
                ['accuracy', selectedJob.finalMetrics.accuracy],
                ['train time', fmtMs(selectedJob.finalMetrics.trainMs)],
              ] as const).map(([label, v]) => (
                <div key={label} className="glass-card rounded-md px-3 py-2">
                  <TechLabel>{label}</TechLabel>
                  <p className="mt-1 font-mono text-sm tabular-nums text-foreground">{v}</p>
                </div>
              ))}
            </div>
          ) : null}

          {selectedJob.modelRecordId ? (
            <p className="flex items-center gap-2 text-xs text-emerald-300">
              ✓ Model package produced — see it under Models (registered, exportable).
            </p>
          ) : null}
          {selectedJob.error && selectedJob.status === 'failed' ? (
            <p role="alert" className="break-words rounded-md border border-rose-400/30 bg-rose-400/5 px-3 py-2 font-mono text-xs text-rose-300">{selectedJob.error}</p>
          ) : null}

          {/* Real training logs */}
          <div>
            <TechLabel>training logs</TechLabel>
            <div className="glass-inset nextool-terminal nextool-scroll mt-1.5 max-h-48 overflow-y-auto rounded-md p-3">
              {selectedJob.logs.length === 0 ? (
                <p className="font-mono text-xs text-slate-400">— no log lines yet</p>
              ) : (
                selectedJob.logs.map((l, i) => (
                  <p key={i} className={cn('break-words font-mono text-[11px] leading-relaxed', l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-300' : 'text-sky-100/75')}>
                    <span className="text-slate-500">[{new Date(l.at).toLocaleTimeString('en-GB', { hour12: false })}]</span> {l.message}
                  </p>
                ))
              )}
            </div>
          </div>

          <details className="mt-1">
            <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">epoch metrics series</summary>
            <JsonBlock value={selectedJob.metrics} maxHeight="max-h-48" className="mt-1" />
          </details>
        </section>
      ) : null}

      {/* History */}
      <section aria-label="Training history" className="glass-panel rounded-lg p-4">
        <SectionTitle title="Training history" desc="Persisted jobs — open one to inspect metrics and logs." />
        <div className="mt-3">
          {jobs === null ? (
            <Skeleton className="h-20 w-full" />
          ) : jobs.length === 0 ? (
            <EmptyState icon={<GraduationCap className="size-6" aria-hidden />} title="No training jobs yet" hint="Configure a dataset above and start the first run." />
          ) : (
            <div className="nextool-scroll max-h-72 space-y-2 overflow-y-auto pr-1">
              {jobs.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => void selectJob(j.id)}
                  className={cn(
                    'glass-card flex w-full flex-wrap items-center gap-2 rounded-md px-3 py-2.5 text-left hover:bg-white/[0.06]',
                    selectedJob?.id === j.id && 'ring-1 ring-sky-400/30',
                  )}
                >
                  <StatusChip status={j.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {j.datasetName} <span className="text-muted-foreground">v{j.datasetVersion}</span>
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{j.epochsDone}/{j.epochs} epochs</span>
                  {j.modelRecordId ? <Badge variant="outline" className="border-emerald-400/30 font-mono text-[9px] text-emerald-300">model</Badge> : null}
                  <TimeAgo iso={j.createdAt} className="shrink-0 font-mono text-[10px] text-slate-500" />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {jobLoading ? <div className="flex justify-center"><Loader2 className="size-4 animate-spin text-sky-300" aria-hidden /></div> : null}
    </div>
  );
}
