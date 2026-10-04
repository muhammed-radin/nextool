'use client';

/**
 * Datasets (spec §62) — dataset registry cards with split bars, JSON/Parquet
 * import (with preview), export (json | parquet) and delete.
 * v1.0.3: the Parquet adapter (@dsnp/parquetjs) is INSTALLED — import and
 * export of binary columnar Parquet files are real, first-class workflows.
 * v1.0.1: blue gradient glassmorphism — glass cards + glass-inset schema well,
 * glass-strong dialogs, 1→2→3 column responsive grid, min-h-11 controls.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiClientError, deleteDataset, exportDatasetUrl, importDataset, importDatasetFile, listDatasets } from '@/lib/nexool/client';
import type { DatasetInfo, DatasetImportPayload } from '@/lib/nexool/types';
import { EmptyState, ErrorCard, SectionTitle, TimeAgo } from '../ui-bits';
import { Braces, FileJson, FileUp, Loader2, Plus, Table2, Trash2 } from 'lucide-react';

function SplitBar({ train, val, test }: { train: number; val: number; test: number }) {
  const total = Math.max(1, train + val + test);
  const segments = [
    { label: 'train', n: train, cls: 'bg-emerald-500/70' },
    { label: 'validation', n: val, cls: 'bg-amber-500/70' },
    { label: 'test', n: test, cls: 'bg-slate-400/70' },
  ];
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`Split: train ${train}, validation ${val}, test ${test}`}>
        {segments.map((s) => (
          <div key={s.label} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} title={`${s.label}: ${s.n}`} />
        ))}
      </div>
      <div className="mt-1 flex gap-3 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>train {train}</span>
        <span>val {val}</span>
        <span>test {test}</span>
      </div>
    </div>
  );
}

function FormatBadge({ format }: { format: DatasetInfo['format'] }) {
  if (format === 'json') {
    return <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">json</Badge>;
  }
  return (
    <Badge variant="outline" className="border-cyan-400/30 bg-cyan-400/10 font-mono text-[10px] text-cyan-300">parquet</Badge>
  );
}

export default function DatasetsView() {
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [payloadText, setPayloadText] = useState('');
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await listDatasets();
      setDatasets(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Dataset registry unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const preview = (() => {
    try {
      const parsed = JSON.parse(payloadText) as Partial<DatasetImportPayload>;
      if (!Array.isArray(parsed.examples)) return null;
      return parsed.examples;
    } catch {
      return null;
    }
  })();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.parquet')) {
      // v1.0.3: .parquet uploads are decoded by the real Parquet adapter on
      // the server — no JSON preview is possible (binary columnar format).
      setPendingFile(file);
      setPayloadText('');
      return;
    }
    setPendingFile(null);
    setPayloadText(await file.text());
  };

  const closeImport = () => {
    setImportOpen(false);
    setPendingFile(null);
    setPayloadText('');
  };

  const submitImport = async () => {
    if (!name.trim()) {
      toast.error('Dataset name required');
      return;
    }
    setBusy(true);
    try {
      let ds: DatasetInfo;
      if (pendingFile) {
        // Binary (.parquet) path — multipart upload decoded by the adapter.
        ds = await importDatasetFile(pendingFile, {
          name: name.trim(),
          version: version.trim() || '1.0.0',
        });
      } else {
        let parsed: DatasetImportPayload;
        try {
          parsed = JSON.parse(payloadText) as DatasetImportPayload;
        } catch {
          toast.error('Payload is not valid JSON');
          return;
        }
        if (!Array.isArray(parsed.examples) || parsed.examples.length === 0) {
          toast.error('Payload needs a non-empty examples array');
          return;
        }
        ds = await importDataset({
          name: name.trim(),
          version: version.trim() || '1.0.0',
          examples: parsed.examples,
          ...(parsed.note ? { note: parsed.note } : {}),
        });
      }
      toast.success('Dataset imported', { description: `${ds.name} v${ds.version} — ${ds.trainSize + ds.valSize + ds.testSize} examples (${ds.format})` });
      closeImport();
      setName('');
      void load();
    } catch (e) {
      toast.error('Import failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    setBusy(true);
    try {
      await deleteDataset(deleteId);
      toast.success('Dataset deleted');
      setDeleteId(null);
      void load();
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'min-h-11 border-white/[0.09] bg-white/[0.04]';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<FileJson className="size-4 text-sky-300" aria-hidden />}
        title="Datasets"
        desc="Evaluation / fine-tune datasets for the CoreModule — JSON and Parquet interchange."
        right={
          <Button size="sm" className="bg-primary-gradient min-h-9 gap-1.5 text-primary-foreground hover:opacity-90" onClick={() => { setImportOpen(true); setPendingFile(null); setPayloadText(''); }}>
            <Plus className="size-3.5" aria-hidden /> Import dataset
          </Button>
        }
      />

      {/* Dataset example schema + interchange capabilities (v1.0.3) */}
      <div className="glass-panel rounded-lg p-4">
        <p className="text-xs font-medium text-foreground/90">Dataset example schema</p>
        <pre className="glass-inset nextool-scroll mt-2 overflow-x-auto rounded-md p-3 font-mono text-[11px] leading-relaxed text-sky-100/80">{`{
  "category": "monitoring",
  "request": "Check the health of api-01",
  "expectedTool": "server.health",
  "expectedParams": { "serverId": "api-01" },
  "split": "train"   // train | validation | test
}`}</pre>
        <p className="mt-3 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
          <span className="flex items-start gap-1.5">
            <span className="mt-0.5 block size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
            <span><span className="font-medium text-foreground/90">JSON</span> — human-readable row interchange, convenient for small datasets and hand-edited payloads.</span>
          </span>
          <span className="flex items-start gap-1.5">
            <span className="mt-0.5 block size-1.5 shrink-0 rounded-full bg-cyan-400" aria-hidden />
            <span><span className="font-medium text-foreground/90">Parquet</span> — binary columnar format (adapter: <span className="font-mono">@dsnp/parquetjs</span>); efficient storage/compression for larger datasets. Import and export are real — encoded files flow straight into training workflows.</span>
          </span>
        </p>
      </div>

      {error && datasets === null ? (
        <ErrorCard title="Dataset registry unavailable" message={error} onRetry={load} />
      ) : datasets === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 w-full" />)}
        </div>
      ) : datasets.length === 0 ? (
        <EmptyState icon={<FileJson className="size-6" aria-hidden />} title="No datasets imported yet" hint="Import a JSON payload or a binary Parquet file with train/validation/test examples." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {datasets.map((ds) => (
            <div key={ds.id} className="glass-card flex flex-col rounded-lg p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-foreground">{ds.name}</span>
                <Badge variant="outline" className="border-sky-400/25 bg-sky-400/[0.07] font-tech text-[9px] uppercase tracking-wider text-sky-300/90">v{ds.version}</Badge>
                <FormatBadge format={ds.format} />
                <span className="ml-auto"><TimeAgo iso={ds.updatedAt} className="font-mono text-[10px] text-muted-foreground" /></span>
              </div>
              <div className="mt-3">
                <SplitBar train={ds.trainSize} val={ds.valSize} test={ds.testSize} />
              </div>
              {ds.categories && ds.categories.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1">
                  {ds.categories.map((c) => (
                    <Badge key={c} variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">{c}</Badge>
                  ))}
                </div>
              ) : null}
              {ds.note ? <p className="mt-2 text-[11px] text-muted-foreground">{ds.note}</p> : null}
              <div className="mt-auto flex flex-wrap gap-2 border-t border-white/[0.07] pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 border-white/[0.09] bg-white/[0.04] text-foreground/90"
                  onClick={() => window.open(exportDatasetUrl(ds.id, 'json'), '_blank')}
                  aria-label={`Export dataset ${ds.name} as JSON`}
                >
                  <Braces className="size-3.5" aria-hidden /> JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 border-white/[0.09] bg-white/[0.04] text-foreground/90"
                  onClick={() => window.open(exportDatasetUrl(ds.id, 'parquet'), '_blank')}
                  aria-label={`Export dataset ${ds.name} as Parquet`}
                >
                  <Table2 className="size-3.5" aria-hidden /> Parquet
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto min-h-9 border-rose-400/30 text-rose-300 hover:bg-rose-400/10"
                  onClick={() => setDeleteId(ds.id)}
                  aria-label={`Delete dataset ${ds.name}`}
                >
                  <Trash2 className="size-3.5" aria-hidden /> Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Import dialog — JSON paste/file OR binary Parquet upload (v1.0.3) */}
      <Dialog open={importOpen} onOpenChange={(open) => (open ? setImportOpen(true) : closeImport())}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import dataset</DialogTitle>
            <DialogDescription>
              JSON payload or a binary <code className="font-mono">.parquet</code> file — decoded by the Parquet adapter. Split counts are computed by the runtime.
            </DialogDescription>
          </DialogHeader>
          <div className="nextool-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ds-name">Name</Label>
                <Input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="core-eval-v1" className={`${inputCls} font-mono text-sm`} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ds-version">Version</Label>
                <Input id="ds-version" value={version} onChange={(e) => setVersion(e.target.value)} className={`${inputCls} font-mono text-sm`} />
              </div>
            </div>
            <input ref={fileRef} type="file" accept=".json,.parquet,application/json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Choose dataset file" />
            <Button variant="outline" className="min-h-11 w-full border-dashed border-white/[0.15] bg-white/[0.04] text-foreground/90" onClick={() => fileRef.current?.click()}>
              <FileUp className="size-4" aria-hidden /> Choose JSON or Parquet file…
            </Button>
            {pendingFile ? (
              <div className="rounded-md border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-2" data-testid="parquet-file-selected">
                <p className="flex items-center gap-2 break-all font-mono text-[11px] text-cyan-300">
                  <Table2 className="size-3.5 shrink-0" aria-hidden />
                  {pendingFile.name} — {pendingFile.size} bytes
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Binary Parquet file — decoded server-side by the Parquet adapter on import.</p>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ds-payload">Dataset JSON</Label>
                  <Textarea id="ds-payload" value={payloadText} onChange={(e) => setPayloadText(e.target.value)} rows={8} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" placeholder={`{"examples":[{"category":"monitoring","request":"…","expectedTool":"…"}]}`} />
                </div>
                {preview ? (
                  <p className="rounded-md border border-emerald-400/30 bg-emerald-400/5 px-3 py-2 font-mono text-[11px] text-emerald-300">
                    preview: {preview.length} example(s)
                    {' · '}train {preview.filter((x) => (x.split ?? 'train') === 'train').length}
                    {' · '}val {preview.filter((x) => x.split === 'validation').length}
                    {' · '}test {preview.filter((x) => x.split === 'test').length}
                  </p>
                ) : payloadText.trim() ? (
                  <p className="rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 font-mono text-[11px] text-amber-300">payload not recognized yet — needs a JSON object with an examples array</p>
                ) : null}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={closeImport}>Cancel</Button>
            <Button className="bg-primary-gradient min-h-11 text-primary-foreground hover:opacity-90" disabled={busy || (!pendingFile && !preview)} onClick={() => void submitImport()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />} Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="glass-strong sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-rose-300">Delete dataset?</DialogTitle>
            <DialogDescription>The dataset and its examples will be removed from the registry. Export first if you need a copy.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
