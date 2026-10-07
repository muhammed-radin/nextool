'use client';

/**
 * NexTool v1.0.14 §17-§19 — LIMITATIONS control page.
 *
 * The COMPLETE current configuration-limits JSON is loaded from the ONE
 * authoritative source (/api/config/limits → config/configuration-limits.json)
 * and EVERY configurable property is rendered with its real metadata
 * (type / min / max / default / unit / description / enum / nullable) —
 * no fake subset, no duplicated constraints in the component (spec §8.3).
 *
 * Actions: Load Current · Save · Export JSON · Import JSON (validated BEFORE
 * it can touch the runtime) · Standard/Default preset · ⚠ Complete
 * Unrestricted preset (persistent warning). Saving writes the REAL runtime
 * configuration — the loader hot-reloads within ~2 s and VFS/execution/
 * network/terminal/task limits actually change (§27: never UI-only).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ApiClientError, getConfigurationLimits, getLimitsPreset, saveConfigurationLimits } from '@/lib/nexool/client';
import { ErrorCard, SectionTitle, TechLabel } from '../ui-bits';
import {
  AlertTriangle, Download, FileJson, Loader2, RotateCcw, Save, ShieldAlert, ShieldCheck, Upload,
} from 'lucide-react';

interface LimitProperty {
  type: 'integer' | 'number' | 'boolean' | 'string' | 'enum';
  nullable?: boolean;
  default: unknown;
  min?: number;
  max?: number;
  unit?: string;
  description?: string;
  step?: number;
  enum?: string[];
  category?: string;
  requiresRestart?: boolean;
}
type LimitsObject = { version: number; $meta?: { name?: string; description?: string; notes?: string[] } } & Record<string, unknown>;

const SECTION_LABELS: Record<string, string> = {
  network: 'Network limits',
  vfs: 'VFS limits (real directory sandbox)',
  execution: 'Execution limits (sandbox)',
  childProcess: 'Terminal / child-process limits',
  task: 'Task & Live Mode limits',
  fs: 'Freedom-node (real fs) gate',
};

function isLimitProperty(v: unknown): v is LimitProperty {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && 'type' in v && 'default' in v;
}

export default function LimitationsView() {
  const [limits, setLimits] = useState<LimitsObject | null>(null);
  const [original, setOriginal] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unrestrictedLoaded, setUnrestrictedLoaded] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [unrestOpen, setUnrestOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadCurrent = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dto = await getConfigurationLimits();
      setLimits(dto.limits as LimitsObject);
      setOriginal(JSON.stringify(dto.limits, null, 2));
      setRawText(JSON.stringify(dto.limits, null, 2));
      setUnrestrictedLoaded(false);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Failed to load the configuration limits.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCurrent(); }, [loadCurrent]);

  const dirty = useMemo(() => limits !== null && JSON.stringify(limits, null, 2) !== original, [limits, original]);

  const setPropDefault = (section: string, key: string, value: unknown) => {
    setLimits((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as LimitsObject;
      const sec = next[section] as Record<string, unknown> | undefined;
      const prop = sec?.[key] as LimitProperty | undefined;
      if (!prop) return prev;
      prop.default = value;
      return next;
    });
  };

  const doSave = async (payload?: LimitsObject) => {
    let body = payload ?? limits;
    if (rawMode && !payload) {
      // client-side JSON sanity for raw mode — the authoritative validation
      // is server-side (structure/types/ranges) and happens on PUT.
      try {
        const parsed = JSON.parse(rawText) as LimitsObject;
        setLimits(parsed);
        body = parsed;
      } catch (err) {
        toast.error('Raw JSON is invalid', { description: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    if (!body) return;
    setSaving(true);
    try {
      await saveConfigurationLimits(body as { version: number; [section: string]: unknown });
      setOriginal(JSON.stringify(body, null, 2));
      setRawText(JSON.stringify(body, null, 2));
      setUnrestrictedLoaded(false);
      toast.success('Limitations saved', { description: 'The runtime hot-reloads the new limits within ~2 seconds — VFS, execution, network, terminal and task limits are now active.' });
      await loadCurrent();
    } catch (e) {
      const message = e instanceof ApiClientError ? e.message : 'Failed to save the configuration limits.';
      setError(message);
      toast.error('Save failed — nothing was written', { description: message });
    } finally {
      setSaving(false);
    }
  };

  const doExport = () => {
    if (!limits) return;
    const blob = new Blob([JSON.stringify(limits, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'configuration-limits.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as LimitsObject;
      // §18.1 — do NOT overwrite the working copy until it round-trips;
      // validation happens fully server-side on Save.
      setLimits(parsed);
      setRawText(JSON.stringify(parsed, null, 2));
      setUnrestrictedLoaded(false);
      toast.info('Imported into the editor (not saved yet)', { description: 'Review the values, then press Save to apply. The server validates structure, types and ranges before writing.' });
    } catch (err) {
      toast.error('Import failed', { description: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const doApplyPreset = async (preset: 'standard' | 'unrestricted') => {
    try {
      const dto = await getLimitsPreset(preset);
      setLimits(dto.limits as LimitsObject);
      setRawText(JSON.stringify(dto.limits, null, 2));
      setUnrestrictedLoaded(preset === 'unrestricted');
      toast.info(preset === 'standard' ? 'Standard / Default preset loaded' : '⚠ Complete Unrestricted preset loaded', {
        description: preset === 'standard'
          ? 'The shipped normal configuration. Press Save to apply it to the runtime.'
          : 'Every limit is at its maximum. Review carefully, then press Save to apply — the change affects the real runtime.',
      });
    } catch (e) {
      toast.error('Preset failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  };

  const sections = useMemo(() => {
    if (!limits) return [] as Array<[string, Record<string, LimitProperty>]>;
    return Object.entries(limits)
      .filter(([k, v]) => k !== 'version' && k !== '$meta' && typeof v === 'object' && v !== null && !Array.isArray(v))
      .map(([k, v]) => [k, v as Record<string, LimitProperty>] as [string, Record<string, LimitProperty>]);
  }, [limits]);

  if (loading && !limits) {
    return (
      <div className="space-y-3">
        <SectionTitle title="Limitations" desc="Loading the live configuration limits…" />
        <div className="glass-card flex min-h-40 items-center justify-center rounded-lg">
          <Loader2 className="size-5 animate-spin text-sky-300" aria-hidden />
        </div>
      </div>
    );
  }

  if (error && !limits) {
    return (
      <div className="space-y-3">
        <SectionTitle title="Limitations" desc="Runtime configuration control" />
        <ErrorCard message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Limitations"
        desc={`Complete runtime configuration control — every value below is generated from the ONE authoritative configuration-limits source and enforced by the real runtime. ${dirty ? 'Unsaved changes.' : ''}`}
      />

      {/* action bar */}
      <div className="glass-card flex flex-wrap items-center gap-2 rounded-lg p-3">
        <Button size="sm" variant="outline" onClick={() => void loadCurrent()} disabled={loading} className="min-h-9 gap-1.5 border-white/[0.09] text-muted-foreground">
          <RotateCcw className="size-3.5" aria-hidden /> Load Current
        </Button>
        <Button size="sm" onClick={() => void doSave()} disabled={saving || loading} className="min-h-9 gap-1.5 bg-primary-gradient text-primary-foreground hover:opacity-90">
          {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} Save
        </Button>
        <Button size="sm" variant="outline" onClick={doExport} disabled={!limits} className="min-h-9 gap-1.5 border-white/[0.09] text-muted-foreground">
          <Download className="size-3.5" aria-hidden /> Export JSON
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={saving} className="min-h-9 gap-1.5 border-white/[0.09] text-muted-foreground">
          <Upload className="size-3.5" aria-hidden /> Import JSON
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label="Import limits JSON file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doImportFile(f);
            e.target.value = '';
          }}
        />
        <Button size="sm" variant="outline" onClick={() => void doApplyPreset('standard')} disabled={saving} className="min-h-9 gap-1.5 border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10">
          <ShieldCheck className="size-3.5" aria-hidden /> Standard / Default
        </Button>
        <Button size="sm" variant="outline" onClick={() => setUnrestOpen(true)} disabled={saving} className="min-h-9 gap-1.5 border-amber-400/40 text-amber-300 hover:bg-amber-400/10">
          <ShieldAlert className="size-3.5" aria-hidden /> ⚠ Complete Unrestricted
        </Button>
        <Button size="sm" variant="outline" onClick={() => setRawMode((v) => !v)} className="min-h-9 gap-1.5 border-white/[0.09] text-muted-foreground">
          <FileJson className="size-3.5" aria-hidden /> {rawMode ? 'Structured view' : 'Raw JSON'}
        </Button>
        {dirty ? <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-tech text-[9px] uppercase tracking-wider text-amber-300">unsaved</Badge> : null}
      </div>

      {/* unrestricted warning banner */}
      {unrestrictedLoaded ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.08] p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden />
          <div>
            <p className="text-xs font-semibold text-amber-200">⚠ Complete Unrestricted configuration loaded — NOT saved yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
              Unrestricted configuration removes runtime safety margins (maximum sizes, timeouts, iteration budgets, unrestricted real-fs profile) and should only be used intentionally in a trusted self-hosted environment. Security boundaries (VFS sandbox isolation, network host policy, sandbox escapes) can never be weakened by raising a limit. Press Save to actually apply it to the runtime.
            </p>
          </div>
        </div>
      ) : null}

      {error ? <ErrorCard message={error} /> : null}

      {/* raw JSON editing */}
      {rawMode ? (
        <div className="glass-card rounded-lg p-4">
          <TechLabel className="text-[10px]">raw configuration-limits.json (Save validates structure, types, required fields and ranges server-side — an invalid import never touches the runtime)</TechLabel>
          <Textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={18}
            spellCheck={false}
            className="nextool-scroll mt-2 border-white/[0.09] bg-white/[0.04] font-mono text-[11px]"
            aria-label="Raw configuration limits JSON"
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" onClick={() => void doSave()} disabled={saving} className="min-h-9 gap-1.5 bg-primary-gradient text-primary-foreground hover:opacity-90">
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} Validate & Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setRawText(JSON.stringify(limits, null, 2)); }} className="min-h-9 border-white/[0.09] text-muted-foreground">Revert to structured</Button>
          </div>
        </div>
      ) : null}

      {/* structured sections */}
      {!rawMode && limits
        ? sections.map(([section, props]) => (
          <section key={section} className="glass-card rounded-lg p-4" aria-label={SECTION_LABELS[section] ?? section}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-tech text-[11px] uppercase tracking-wider text-sky-300">{SECTION_LABELS[section] ?? section}</h3>
              <span className="font-mono text-[10px] text-slate-500">{Object.keys(props).length} properties</span>
            </div>
            <div className="mt-3 space-y-2.5">
              {Object.entries(props).map(([key, prop]) => {
                if (!isLimitProperty(prop)) return null;
                const numeric = prop.type === 'integer' || prop.type === 'number';
                return (
                  <div key={key} className="rounded-md border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-mono text-xs text-foreground">
                          {section}.{key}
                          {prop.nullable ? <span className="ml-2 text-[10px] text-slate-500">nullable</span> : null}
                          {prop.requiresRestart ? <span className="ml-2 text-[10px] text-amber-300/80">restart</span> : null}
                        </p>
                        {prop.description ? <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted-foreground">{prop.description}</p> : null}
                        <p className="mt-1 font-mono text-[10px] text-slate-500">
                          type: {prop.type}
                          {numeric && prop.min !== undefined ? ` · min ${prop.min}` : ''}
                          {numeric && prop.max !== undefined ? ` · max ${prop.max}` : ''}
                          {prop.unit ? ` · unit ${prop.unit}` : ''}
                        </p>
                      </div>
                      <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-56">
                        {prop.type === 'boolean' ? (
                          <Switch
                            checked={prop.default === true}
                            onCheckedChange={(v) => setPropDefault(section, key, v)}
                            aria-label={`${section}.${key}`}
                          />
                        ) : prop.type === 'enum' ? (
                          <select
                            value={String(prop.default)}
                            onChange={(e) => setPropDefault(section, key, e.target.value)}
                            className="h-9 w-full rounded-md border border-white/[0.09] bg-white/[0.04] px-2 text-xs text-foreground sm:w-44"
                            aria-label={`${section}.${key}`}
                          >
                            {(prop.enum ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : numeric ? (
                          <Input
                            type="number"
                            value={String(prop.default ?? '')}
                            min={prop.min}
                            max={prop.max}
                            step={prop.step ?? (prop.type === 'integer' ? 1 : 'any')}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (Number.isFinite(n)) setPropDefault(section, key, prop.type === 'integer' ? Math.round(n) : n);
                            }}
                            className="h-9 w-full border-white/[0.09] bg-white/[0.04] font-mono text-xs sm:w-44"
                            aria-label={`${section}.${key} value`}
                          />
                        ) : (
                          <Input
                            type="text"
                            value={String(prop.default ?? '')}
                            onChange={(e) => setPropDefault(section, key, e.target.value)}
                            className="h-9 w-full border-white/[0.09] bg-white/[0.04] font-mono text-xs sm:w-44"
                            aria-label={`${section}.${key} value`}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
        : null}

      {/* Unrestricted confirm dialog */}
      <Dialog open={unrestOpen} onOpenChange={setUnrestOpen}>
        <DialogContent className="glass-strong border-amber-400/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-200">
              <ShieldAlert className="size-4" aria-hidden /> Apply ⚠ Complete Unrestricted preset?
            </DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed text-muted-foreground">
              Every numeric limit will be raised to its shipped maximum and capability booleans fully opened (url imports, self-origin access, unrestricted real-fs profile). This removes runtime safety margins and should only be used intentionally in a trusted self-hosted environment. Security boundaries (VFS sandbox isolation, network host policy, sandbox escapes) can never be weakened. The preset is loaded into the editor — press Save afterwards to apply it to the real runtime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnrestOpen(false)} className="min-h-9 border-white/[0.09] text-muted-foreground">Cancel</Button>
            <Button
              onClick={() => { setUnrestOpen(false); void doApplyPreset('unrestricted'); }}
              className="min-h-9 gap-1.5 border border-amber-400/40 bg-amber-400/15 text-amber-200 hover:bg-amber-400/25"
            >
              <AlertTriangle className="size-3.5" aria-hidden /> Load Unrestricted
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
