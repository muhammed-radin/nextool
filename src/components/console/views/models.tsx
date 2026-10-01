'use client';

/**
 * Models (spec §61) — active engine card, honest adapter status panel,
 * registered .nextool packages, package loading dialog and live benchmarks.
 * v1.0.1: blue gradient glassmorphism — text-gradient engine hero on glass,
 * honest adapter states kept, glass-strong dialog, min-h-11 controls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, getModels, loadModel } from '@/lib/nexool/client';
import type { ModelsInfo } from '@/lib/nexool/client';
import { useSystemStats } from '../providers';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, TimeAgo, fmtMs, statusTone } from '../ui-bits';
import { Box, CheckCircle2, Cpu, FileUp, Loader2, MinusCircle, Upload } from 'lucide-react';

function AdapterRow({ label, available, note }: { label: string; available: boolean; note: string }) {
  return (
    <div className="glass-card flex items-start justify-between gap-3 rounded-md px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground/90">{label}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>
      </div>
      {available ? (
        <Badge variant="outline" className="shrink-0 border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">available</Badge>
      ) : (
        <Badge variant="outline" className="shrink-0 border-white/[0.09] font-mono text-[10px] text-muted-foreground">not installed</Badge>
      )}
    </div>
  );
}

export default function ModelsView() {
  const { stats } = useSystemStats();
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadOpen, setLoadOpen] = useState(false);
  const [manifestText, setManifestText] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await getModels();
      setInfo(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Model registry unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setManifestText(text);
  };

  const submitLoad = async () => {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      toast.error('Manifest is not valid JSON');
      return;
    }
    setBusy(true);
    try {
      const pkg = await loadModel({ manifest: manifest as Record<string, unknown> });
      toast.success('Package registered', { description: `${pkg.name} v${pkg.version} (${pkg.status})` });
      setLoadOpen(false);
      setManifestText('');
      void load();
    } catch (e) {
      toast.error('Package rejected', {
        description: e instanceof ApiClientError ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}` : 'Unknown error',
      });
    } finally {
      setBusy(false);
    }
  };

  const engineStatus = info?.engine.status ?? 'active';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Box className="size-4 text-sky-300" aria-hidden />}
        title="Models"
        desc="Active decision engine, adapter availability and registered .nextool packages."
        right={
          <Button size="sm" className="bg-primary-gradient min-h-9 gap-1.5 text-primary-foreground hover:opacity-90" onClick={() => setLoadOpen(true)}>
            <Upload className="size-3.5" aria-hidden /> Load .nextool package
          </Button>
        }
      />

      {error && info === null ? (
        <ErrorCard title="Model registry unavailable" message={error} onRetry={load} />
      ) : info === null ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          {/* Active engine */}
          <section aria-label="Active engine" className="glass-panel rounded-lg p-4 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-4">
                <span className="bg-primary-gradient-soft glow-blue flex size-12 shrink-0 items-center justify-center rounded-lg ring-1 ring-sky-400/25">
                  <Cpu className="size-6 text-sky-300" aria-hidden />
                </span>
                <div className="min-w-0">
                  {/* Engine identity + version come from the live registry — never hardcoded. */}
                  <h3 className="truncate text-lg font-semibold">
                    <span className="text-gradient font-tech tracking-wide">{info.engine.name}</span>{' '}
                    <span className="font-mono text-sm text-muted-foreground">v{info.engine.version}</span>
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{info.engine.architecture}</p>
                  <p className="text-[11px] text-muted-foreground">backend: {info.engine.backend}</p>
                </div>
              </div>
              <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[11px] text-emerald-300">
                <CheckCircle2 className="size-3" aria-hidden /> {engineStatus}
              </Badge>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.07] pt-3 sm:grid-cols-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">core calls</p>
                <p className="font-mono text-sm tabular-nums text-foreground">{info.engine.coreCalls}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">avg latency</p>
                <p className="font-mono text-sm tabular-nums text-sky-300">{fmtMs(info.engine.avgLatencyMs)}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">last decision</p>
                <p className="font-mono text-sm text-foreground">{info.engine.lastDecisionAt ? <TimeAgo iso={info.engine.lastDecisionAt} /> : '—'}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">fallback</p>
                <p className="font-mono text-sm text-foreground">{stats?.engine.fallback ?? 'heuristic-fallback'}</p>
              </div>
            </div>
            {info.engine.notes ? <p className="mt-3 text-xs italic text-muted-foreground">{info.engine.notes}</p> : null}
          </section>

          {/* Adapters — honest status */}
          <section aria-label="Adapter availability" className="glass-panel rounded-lg p-4">
            <SectionTitle title="Adapters" desc="Honest environment capability report — nothing is faked." />
            <div className="mt-3 space-y-2">
              <AdapterRow
                label="TensorFlow.js native loader"
                available={info.adapters.tfjs}
                note="Native TFJS model loading for alternative engines"
              />
              <AdapterRow
                label=".nextool manifest validator"
                available={info.adapters.nextoolManifest}
                note="Validates and registers .nextool JSON packages"
              />
              <AdapterRow
                label="Parquet dataset adapter"
                available={info.adapters.parquet}
                note="Binary columnar dataset interchange"
              />
            </div>
          </section>

          {/* Packages */}
          <section aria-label="Registered packages" className="glass-panel rounded-lg p-4">
            <SectionTitle title="Registered packages" desc=".nextool manifests loaded into the registry." />
            <div className="mt-3">
              {info.packages.length === 0 ? (
                <EmptyState icon={<Box className="size-6" aria-hidden />} title="No packages loaded yet" hint="Load a .nextool JSON manifest — invalid manifests are rejected with the reason." />
              ) : (
                <div className="nextool-scroll max-h-72 space-y-2 overflow-y-auto pr-1">
                  {info.packages.map((pkg) => (
                    <div key={pkg.id} className="glass-card rounded-md px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-foreground">{pkg.name}</span>
                        <Badge variant="outline" className="border-sky-400/25 font-tech bg-sky-400/[0.07] text-[9px] uppercase tracking-wider text-sky-300/90">v{pkg.version}</Badge>
                        <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">{pkg.format}</Badge>
                        <span className="ml-auto">
                          <Badge variant="outline" className={`font-mono text-[10px] ${statusTone(pkg.status) === 'ok' ? 'border-emerald-400/30 text-emerald-300' : statusTone(pkg.status) === 'err' ? 'border-rose-400/30 text-rose-300' : 'border-white/[0.09] text-muted-foreground'}`}>
                            {pkg.status}
                          </Badge>
                        </span>
                      </div>
                      {pkg.note ? <p className="mt-1 text-[11px] text-muted-foreground">{pkg.note}</p> : null}
                      <details className="mt-1">
                        <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground outline-ring/50 focus-visible:ring-2">manifest</summary>
                        <JsonBlock value={pkg.manifest} maxHeight="max-h-40" className="mt-1" />
                      </details>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Benchmarks */}
          <section aria-label="Benchmarks" className="glass-panel rounded-lg p-4">
            <SectionTitle title="Benchmarks" desc="Benchmarks are computed from live runtime metrics — no synthetic scores." />
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="glass-card rounded-md px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">avg core latency</p>
                <p className="font-mono text-sm tabular-nums text-sky-300">{stats ? fmtMs(stats.engine.avgCoreLatencyMs) : '—'}</p>
              </div>
              <div className="glass-card rounded-md px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">avg tool latency</p>
                <p className="font-mono text-sm tabular-nums text-sky-300">{stats ? fmtMs(stats.toolCalls.avgMs) : '—'}</p>
              </div>
              <div className="glass-card rounded-md px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">tool success</p>
                <p className="font-mono text-sm tabular-nums text-foreground">{stats ? `${stats.toolCalls.success}/${stats.toolCalls.total}` : '—'}</p>
              </div>
            </div>
          </section>
        </>
      )}

      {/* Load package dialog */}
      <Dialog open={loadOpen} onOpenChange={setLoadOpen}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Load .nextool package</DialogTitle>
            <DialogDescription>
              Upload a <code className="font-mono">.nextool</code>/<code className="font-mono">.json</code> manifest or paste it. Invalid manifests are rejected with the validator&apos;s reason.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".nextool,.json,application/json"
                className="hidden"
                onChange={(e) => void onFile(e.target.files?.[0])}
                aria-label="Choose manifest file"
              />
              <Button variant="outline" className="min-h-11 w-full border-dashed border-white/[0.15] bg-white/[0.04] text-foreground/90" onClick={() => fileRef.current?.click()}>
                <FileUp className="size-4" aria-hidden /> Choose file…
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manifest-json">Manifest JSON</Label>
              <Textarea
                id="manifest-json"
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                rows={8}
                className="border-white/[0.09] bg-white/[0.04] font-mono text-xs"
                placeholder='{"name":"my-pack","version":"1.0.0","format":"nextool","architecture":"…","compatibility":"…"}'
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={() => setLoadOpen(false)}>Cancel</Button>
            <Button className="bg-primary-gradient min-h-11 text-primary-foreground hover:opacity-90" disabled={busy || !manifestText.trim()} onClick={() => void submitLoad()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <MinusCircle className="size-4" aria-hidden />} Validate &amp; load
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
