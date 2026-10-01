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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, getModels, importModelPackage, loadModel, modelExportUrl } from '@/lib/nexool/client';
import type { ModelsInfo } from '@/lib/nexool/client';
import { useSystemStats } from '../providers';
import { EmptyState, ErrorCard, JsonBlock, SectionTitle, TimeAgo, fmtMs, statusTone } from '../ui-bits';
import { Box, CheckCircle2, Cpu, Download, Loader2, MinusCircle, PackageOpen, Upload } from 'lucide-react';

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
  const [importing, setImporting] = useState(false);

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

  /** v1.0.2 §44-46: real package import (.nextool / tfjs zip / bare manifest). */
  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const result = await importModelPackage(file);
      toast.success('Package imported', {
        description: `${result.name} v${result.version}${result.runnable ? ' (runnable for benchmarks)' : ''}`,
      });
      for (const w of result.warnings) toast.warning(w);
      setLoadOpen(false);
      void load();
    } catch (e) {
      toast.error('Import rejected', {
        description: e instanceof ApiClientError ? e.message : 'Unknown error',
      });
    } finally {
      setImporting(false);
    }
  };

  /** v1.0.2 §44-45: trigger a real zip download of the current/selected model. */
  const exportPackage = (id: string, format: 'tfjs' | 'nextool') => {
    window.location.href = modelExportUrl(id, format);
  };

  const isExportable = (p: { format: string }) => p.format === 'tfjs-trained-classifier' || p.format === 'tfjs-native-import';
  const hasExportable = (info?.packages ?? []).some(isExportable);

  const engineStatus = info?.engine.status ?? 'active';

  return (
    <div className="space-y-6">
      {/* v1.0.4 §9-10 — responsive header: vertical (title / description /
          buttons stacked) on mobile, horizontal on desktop. Buttons keep a
          usable width and never squeeze or overlap. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <Box className="size-4 text-sky-300" aria-hidden />
            Models
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Active decision engine, adapter availability and registered .nextool packages.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center lg:shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="min-h-11 w-full gap-1.5 border-sky-400/30 bg-sky-400/[0.07] px-4 text-sky-300 hover:bg-sky-400/10 sm:min-h-9 sm:w-auto" disabled={!hasExportable}>
                <Download className="size-3.5" aria-hidden /> Export Current Model
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="glass-strong min-w-64">
              <DropdownMenuLabel className="font-tech text-[9px] uppercase tracking-widest text-sky-300/70">export current model</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(info?.packages ?? []).filter(isExportable).map((p) => (
                <div key={p.id} className="px-1 py-0.5">
                  <p className="px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{p.name} v{p.version}</p>
                  <DropdownMenuItem onClick={() => exportPackage(p.id, 'tfjs')}>
                    <Download className="size-3.5" aria-hidden /> native TFJS (model.json + .bin zip)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => exportPackage(p.id, 'nextool')}>
                    <Download className="size-3.5" aria-hidden /> .nextool package
                  </DropdownMenuItem>
                </div>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" className="min-h-11 w-full gap-1.5 bg-primary-gradient px-4 text-primary-foreground hover:opacity-90 sm:min-h-9 sm:w-auto" onClick={() => setLoadOpen(true)}>
            <Upload className="size-3.5" aria-hidden /> Import model
          </Button>
        </div>
      </div>

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

      {/* Load / import package dialog */}
      <Dialog open={loadOpen} onOpenChange={setLoadOpen}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import model package</DialogTitle>
            <DialogDescription>
              Upload a <code className="font-mono">.nextool</code> package, a native TFJS zip (<code className="font-mono">model.json + .bin</code>), or a bare <code className="font-mono">.json</code> manifest. Binary packages are compatibility-validated (real TFJS load check) before registration.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <input
                ref={fileRef}
                type="file"
                accept=".nextool,.zip,.json"
                className="hidden"
                onChange={(e) => void onImportFile(e.target.files?.[0])}
                aria-label="Choose model package file"
              />
              <Button variant="outline" className="min-h-11 w-full border-dashed border-white/[0.15] bg-white/[0.04] text-foreground/90" onClick={() => fileRef.current?.click()} disabled={importing}>
                {importing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <PackageOpen className="size-4" aria-hidden />} Choose package file…
              </Button>
            </div>
            <div className="relative text-center text-[10px] uppercase tracking-widest text-muted-foreground/60">
              <span className="bg-transparent">or paste a bare manifest</span>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manifest-json">Manifest JSON</Label>
              <Textarea
                id="manifest-json"
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                rows={6}
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
