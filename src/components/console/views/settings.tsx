'use client';

/**
 * Settings (spec §63) — bound to GET/PUT /api/settings with unsaved-changes
 * tracking. Live Mode is never switched automatically; transport is honestly
 * locked to SSE.
 * v1.0.1: new About / Version section (application / model / dataset versions
 * from the canonical version module + live system stats), blue gradient
 * glassmorphism panels, min-h-11 controls.
 * v1.0.4 §28-29: the "Branding & icons" Settings CARD was removed — only the
 * UI section. The underlying icon infrastructure (uploaded icon packages,
 * /api/icons endpoints, layout metadata icons) remains fully functional and
 * continues to serve the app favicon + in-app NexTool logo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  ApiClientError, analyzeMaintenance, getConfigurationLimits, getSettings, resetApplicationData, runMaintenanceCleanup, updateSettings, validateRuntimeDependencies,
  type ApplicationResetReport, type CleanupReport, type LimitPropertyDTO, type RuntimeValidationReport,
} from '@/lib/nexool/client';
import type { NexToolSettings } from '@/lib/nexool/types';
import { APP_NAME, APP_VERSION, RELEASE_NAME, CORE_MODULE_VERSION, CORE_MODULE_NAME } from '@/lib/nexool/version';
import { useSystemStats } from '../providers';
import { ErrorCard, SectionTitle, TechLabel, fmtMs } from '../ui-bits';
import { AlertTriangle, CheckCircle2, Info, Loader2, RefreshCw, Save, ShieldAlert, SlidersHorizontal, Trash2, Wrench } from 'lucide-react';

const REASONING_CAPTIONS: Record<number, string> = {
  1: 'ultra-fast', 2: 'fast', 3: 'balanced', 4: 'thorough', 5: 'deep', 6: 'maximum',
};

type Draft = Omit<NexToolSettings, 'realTimeTransport'> & { realTimeTransport: 'sse' };

const DEFAULTS: Draft = {
  defaultMode: 'goal',
  defaultReasoningLevel: 3,
  maxSubtoolCalls: 20,
  safetyLimit: 100,
  maxIterations: 30,
  taskTimeoutMs: 120000,
  // v1.0.7 §1 — default tool execution timeout is 10 seconds.
  toolTimeoutMs: 10000,
  // v1.0.9 §14 — Global Network Policy request timeout (default 60 s).
  networkRequestTimeoutMs: 60000,
  liveIntervalMs: 60000,
  useMemory: true,
  parallelToolCalls: true,
  maxParallelToolCalls: 4,
  autoExecuteTools: false,
  allowMultipleEvents: false,
  logLevel: 'info',
  realTimeTransport: 'sse',
};

/** v1.0.7 §1 — preset durations offered by the timeout quick-select. */
const TOOL_TIMEOUT_PRESETS: { value: number; label: string }[] = [
  { value: 10_000, label: '10 s (default)' },
  { value: 30_000, label: '30 s' },
  { value: 60_000, label: '1 min' },
  { value: 300_000, label: '5 min' },
  { value: 1_800_000, label: '30 min' },
  { value: 3_600_000, label: '1 hour (maximum)' },
];

/** v1.0.9 §14 — preset durations for the Network Request Timeout quick-select. */
const NETWORK_TIMEOUT_PRESETS: { value: number; label: string }[] = [
  { value: 10_000, label: '10 s' },
  { value: 30_000, label: '30 s' },
  { value: 60_000, label: '1 min (default)' },
  { value: 120_000, label: '2 min' },
  { value: 180_000, label: '3 min' },
  { value: 300_000, label: '5 min' },
  { value: 3_600_000, label: '1 hour (maximum)' },
];

function NumberField({ id, label, value, onChange, hint, min, max }: { id: string; label: string; value: number; onChange: (v: number) => void; hint?: string; min?: number; max?: number }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="number"
        // v1.0.8 §8.2 — min/max come from the central limits metadata, never
        // duplicated here (fallback bounds keep the input usable pre-hydration).
        min={min ?? 1}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
        }}
        className="min-h-11 border-white/[0.09] bg-white/[0.04] font-mono text-sm"
      />
      {hint ? <p className="font-mono text-[10px] text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

/** v1.0.8 §8.1/§8.2 — Settings input metadata mapping: every numeric field
 *  is bound to ONE property of the central configuration-limits JSON. The
 *  UI derives min/max/default/unit/description from the resolved metadata. */
const LIMIT_FIELDS: { field: keyof Draft; section: string; key: string; label: string }[] = [
  { field: 'maxSubtoolCalls', section: 'task', key: 'maxSubtoolCalls', label: 'Max subtool calls' },
  { field: 'safetyLimit', section: 'task', key: 'safetyLimit', label: 'Safety limit' },
  { field: 'maxIterations', section: 'task', key: 'maxIterations', label: 'Max iterations (goal)' },
  { field: 'taskTimeoutMs', section: 'task', key: 'taskTimeoutMs', label: 'Task timeout (ms)' },
  { field: 'toolTimeoutMs', section: 'task', key: 'toolTimeoutMs', label: 'Tool timeout (ms)' },
  { field: 'liveIntervalMs', section: 'task', key: 'liveIntervalMs', label: 'Live interval (ms)' },
  { field: 'maxParallelToolCalls', section: 'task', key: 'maxParallelToolCalls', label: 'Max parallel tool calls' },
];

function limitsHint(prop: LimitPropertyDTO | undefined): string | undefined {
  if (!prop) return undefined;
  const parts: string[] = [];
  if (prop.default !== undefined) parts.push(`Default: ${prop.default}${prop.unit ? ` ${prop.unit}` : ''}`);
  if (typeof prop.min === 'number') parts.push(`Min: ${prop.min}`);
  if (typeof prop.max === 'number') parts.push(`Max: ${prop.max}${prop.unit ? ` ${prop.unit}` : ''}`);
  return parts.join(' · ');
}

/** One labeled version row — Application / Model / Dataset stay distinct. */
function VersionRow({ label, version, note, highlight }: { label: string; version: string; note: string; highlight?: boolean }) {
  return (
    <div className="glass-card flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md px-3 py-2.5">
      <div className="min-w-0">
        <TechLabel>{label} version</TechLabel>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>
      </div>
      <span className={highlight ? 'text-gradient font-tech shrink-0 text-base tracking-wider' : 'font-tech shrink-0 text-base tracking-wider text-foreground'}>
        {version}
      </span>
    </div>
  );
}

/** Report list used by the maintenance cards — ✓ protected / ✗ removed. */
function ResourceList({ title, rows, tone }: { title: string; rows: { id?: string; name: string; version: string }[]; tone: 'protected' | 'removed' | 'candidate' }) {
  if (rows.length === 0) return null;
  const icon = tone === 'protected' ? <CheckCircle2 className="size-3.5 text-emerald-300" aria-hidden /> : tone === 'removed' ? <Trash2 className="size-3.5 text-rose-300" aria-hidden /> : <AlertTriangle className="size-3.5 text-amber-300" aria-hidden />;
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{icon} {title} ({rows.length})</p>
      <ul className="nextool-scroll max-h-28 space-y-1 overflow-y-auto pr-1">
        {rows.map((r) => (
          <li key={r.id ?? r.name} className="flex items-center justify-between gap-2 rounded border border-white/[0.05] bg-white/[0.02] px-2 py-1">
            <span className="truncate font-mono text-[11px] text-foreground/90">{r.name}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">v{r.version}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * v1.0.7 §4/§5/§4.11 — Maintenance: dependency validation + idempotent
 * model/dataset cleanup with the traceable report (protected/candidates/
 * removed). Uses the REAL maintenance endpoints — never frontend-only.
 */
function MaintenanceSection() {
  const [validation, setValidation] = useState<RuntimeValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const runValidation = async () => {
    setValidating(true);
    try {
      const data = await validateRuntimeDependencies();
      setValidation(data);
      if (data.ok) toast.success('Runtime dependencies OK', { description: 'Active model, datasets and references validated.' });
      else toast.error('Runtime validation found problems', { description: `${data.problems.filter((p) => p.severity === 'error').length} error(s) reported below.` });
    } catch (e) {
      toast.error('Validation failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setValidating(false);
    }
  };

  const analyze = async () => {
    setAnalyzing(true);
    try {
      const data = await analyzeMaintenance();
      setReport(data);
      toast.success('Dependency analysis complete', { description: 'Dry-run report — nothing was deleted.' });
    } catch (e) {
      toast.error('Analysis failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setAnalyzing(false);
    }
  };

  const cleanup = async () => {
    setCleaning(true);
    try {
      const data = await runMaintenanceCleanup();
      setReport(data);
      const removed = data.models.removed.length + data.datasets.removed.length;
      toast.success(removed > 0 ? `Cleanup removed ${removed} orphaned resource(s)` : 'Nothing to clean up', {
        description: removed > 0 ? 'Only confirmed orphaned records were removed. Idempotent — run again any time.' : 'No orphaned models or datasets found.',
      });
    } catch (e) {
      toast.error('Cleanup failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setCleaning(false);
    }
  };

  return (
    <section aria-label="Maintenance" className="glass-panel rounded-lg p-4 md:p-6">
      <SectionTitle
        icon={<Wrench className="size-4 text-sky-300" aria-hidden />}
        title="Maintenance"
        desc="Dependency-aware resource validation and cleanup. Protected resources are never removed; cleanup is idempotent."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="glass-card space-y-2 rounded-md p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Validate dependencies</p>
              <p className="text-[11px] text-muted-foreground">Active model, model artifacts, required datasets and reference integrity</p>
            </div>
            <Button variant="outline" size="sm" className="min-h-9 shrink-0 border-white/[0.09] bg-white/[0.04] text-slate-200" disabled={validating} onClick={() => void runValidation()}>
              {validating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />} Check
            </Button>
          </div>
          {validation ? (
            <div className="space-y-1.5" data-testid="maintenance-validation">
              <p className="flex items-center gap-1.5 font-mono text-[11px]">
                {validation.ok ? <CheckCircle2 className="size-3.5 text-emerald-300" aria-hidden /> : <AlertTriangle className="size-3.5 text-rose-300" aria-hidden />}
                <span className={validation.ok ? 'text-emerald-300' : 'text-rose-300'}>{validation.ok ? 'OK' : 'problems found'}</span>
                <span className="text-muted-foreground">· active model {validation.activeModel.name} v{validation.activeModel.version} · {validation.checks.models} models · {validation.checks.datasets} datasets</span>
              </p>
              {validation.problems.slice(0, 5).map((p, i) => (
                <p key={i} className={`break-words font-mono text-[10px] ${p.severity === 'error' ? 'text-rose-300' : 'text-amber-300'}`}>{p.severity}: {p.resource} — {p.message}</p>
              ))}
            </div>
          ) : null}
        </div>
        <div className="glass-card space-y-2 rounded-md p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Model / dataset cleanup</p>
              <p className="text-[11px] text-muted-foreground">Removes only confirmed orphaned resources — analysis first, current model and required datasets protected</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" disabled={analyzing || cleaning} onClick={() => void analyze()}>
              {analyzing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Info className="size-3.5" aria-hidden />} Analyze (dry run)
            </Button>
            <Button variant="outline" size="sm" className="min-h-9 border-amber-400/30 bg-amber-400/10 text-amber-200 hover:bg-amber-400/20" disabled={analyzing || cleaning} onClick={() => void cleanup()}>
              {cleaning ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Wrench className="size-3.5" aria-hidden />} Clean up
            </Button>
          </div>
          {report ? (
            <div className="space-y-2 pt-1" data-testid="maintenance-report">
              <p className="font-mono text-[10px] text-muted-foreground">
                {report.dryRun ? 'Dry-run report (nothing deleted)' : report.ran ? `Cleanup ran in ${report.durationMs}ms` : 'Report'} · {report.analyzedAt}
              </p>
              <ResourceList title="protected models" tone="protected" rows={report.models.protected} />
              <ResourceList title="orphaned model candidates" tone="candidate" rows={report.models.candidates} />
              <ResourceList title="removed models" tone="removed" rows={report.models.removed} />
              <ResourceList title="protected datasets" tone="protected" rows={report.datasets.protected} />
              <ResourceList title="orphaned dataset candidates" tone="candidate" rows={report.datasets.candidates} />
              <ResourceList title="removed datasets" tone="removed" rows={report.datasets.removed} />
              {report.warnings.length > 0 ? (
                <p className="break-words font-mono text-[10px] text-amber-300">{report.warnings.length} broken reference warning(s) — preserved, see API report for details.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * v1.0.7 §3 — Danger zone: "Reset Application Data". Visually destructive,
 * dialog-confirmed, and gated behind typing the exact phrase RESET (§3.3).
 * The BACKEND performs the reset; tools, models and datasets are protected.
 */
function DangerZoneSection() {
  const { refresh } = useSystemStats();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ApplicationResetReport | null>(null);

  const phraseOk = confirmText === 'RESET';
  const canConfirm = phraseOk && !busy;

  const openDialog = () => {
    setConfirmText('');
    setReport(null);
    setOpen(true);
  };

  const doReset = async () => {
    if (!phraseOk) return;
    setBusy(true);
    try {
      const data = await resetApplicationData();
      setReport(data);
      toast.success('Application data reset', {
        description: `Runtime data cleared in ${data.durationMs}ms — tools, models and datasets preserved.`,
      });
      // §3.9 — refresh the UI so it reflects the new empty runtime state.
      refresh();
    } catch (e) {
      toast.error('Reset failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Danger zone" className="rounded-lg border border-rose-500/30 bg-rose-500/[0.04] p-4 md:p-6">
      <SectionTitle
        icon={<ShieldAlert className="size-4 text-rose-300" aria-hidden />}
        title="Danger zone"
        desc="Destructive maintenance operations. These actions cannot be automatically undone."
      />
      <div className="mt-4 flex flex-col gap-3 rounded-md border border-rose-500/20 bg-rose-500/[0.05] p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-rose-200">Reset application data</p>
          <p className="text-[11px] text-muted-foreground">
            Clears cached data, memory, statistics, stored events, task histories and runtime state. Tools, models and datasets are NOT deleted.
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          className="min-h-11 shrink-0 gap-2 bg-rose-600 text-white hover:bg-rose-700"
          onClick={openDialog}
          data-testid="reset-data-button"
        >
          <Trash2 className="size-4" aria-hidden /> Reset Application Data
        </Button>
      </div>

      {/* §3.2/§3.3 — explicit confirmation dialog with typed phrase */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) setOpen(false); }}>
        <DialogContent className="glass-strong border-rose-500/30 sm:max-w-lg" data-testid="reset-confirm-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300">Reset Application Data?</DialogTitle>
            <DialogDescription>
              This will clear application runtime data including:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <ul className="space-y-1 rounded-md border border-white/[0.08] bg-white/[0.03] p-3 text-[12px] text-foreground/90">
              <li>• cached data (incl. generated images)</li>
              <li>• memory</li>
              <li>• statistics</li>
              <li>• stored events</li>
              <li>• task histories (incl. execution + live-state history)</li>
              <li>• runtime state (incl. tool Virtual FS workspaces)</li>
            </ul>
            <p className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] p-3 text-[12px] text-emerald-200">
              Tools, models, and datasets will <span className="font-semibold">NOT</span> be deleted.
            </p>
            <p className="text-[12px] text-amber-300">This action cannot be automatically undone.</p>
            {report ? (
              <div className="rounded-md border border-emerald-400/25 bg-emerald-400/[0.06] p-3 font-mono text-[11px] text-emerald-200" data-testid="reset-report">
                Reset completed in {report.durationMs}ms — cleared: {Object.entries(report.cleared).map(([k, v]) => `${k}=${v}`).join(', ')}.
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="reset-confirm-input" className="text-xs text-muted-foreground">
                  Type <span className="font-mono font-semibold text-rose-300">RESET</span> to enable the final button
                </Label>
                <Input
                  id="reset-confirm-input"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="RESET"
                  autoComplete="off"
                  className="min-h-11 border-rose-500/30 bg-white/[0.04] font-mono text-sm"
                  aria-describedby="reset-confirm-hint"
                />
                <p id="reset-confirm-hint" className="font-mono text-[10px] text-muted-foreground/70">
                  The reset only runs with the exact phrase — a single click can never trigger it.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={() => setOpen(false)}>
              {report ? 'Close' : 'Cancel'}
            </Button>
            {!report ? (
              <Button
                variant="destructive"
                className="min-h-11 gap-2 bg-rose-600 text-white hover:bg-rose-700"
                disabled={!canConfirm}
                onClick={() => void doReset()}
                data-testid="reset-confirm-button"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
                I understand — reset now
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AboutSection() {
  const { stats } = useSystemStats();
  const datasetVersion = stats?.datasetVersion ?? null;

  return (
    <section aria-label="About and version" className="glass-panel rounded-lg p-4 md:p-6">
      <SectionTitle
        icon={<Info className="size-4 text-sky-300" aria-hidden />}
        title="About"
        desc={`${APP_NAME} — ${RELEASE_NAME}.`}
      />
      <div className="mt-4 space-y-2">
        <VersionRow
          label="Application"
          version={`v${APP_VERSION}`}
          note={`${APP_NAME} console — this application release.`}
          highlight
        />
        <VersionRow
          label="Model"
          version={`v${CORE_MODULE_VERSION}`}
          note={`${CORE_MODULE_NAME} decision unit — unchanged since v1.0.0.`}
        />
        <VersionRow
          label="Dataset"
          version={datasetVersion ? `v${datasetVersion}` : '—'}
          note={datasetVersion ? 'Most recently updated dataset in the registry.' : stats ? 'No datasets imported yet.' : 'Runtime stats not loaded yet.'}
        />
      </div>

      {/* Live runtime engine — honest values from GET /api/system, '—' when unavailable */}
      <div className="glass-card mt-2 grid grid-cols-2 gap-3 rounded-md px-3 py-2.5 sm:grid-cols-4">
        <div className="min-w-0">
          <TechLabel>engine</TechLabel>
          <p className="mt-1 truncate font-mono text-sm text-foreground">{stats?.engine.active ?? '—'}</p>
        </div>
        <div className="min-w-0">
          <TechLabel>engine ver</TechLabel>
          <p className="mt-1 truncate font-mono text-sm text-foreground">{stats?.engine.version ?? '—'}</p>
        </div>
        <div className="min-w-0">
          <TechLabel>avg latency</TechLabel>
          <p className="mt-1 truncate font-mono text-sm tabular-nums text-sky-300">{stats ? fmtMs(stats.engine.avgCoreLatencyMs) : '—'}</p>
        </div>
        <div className="min-w-0">
          <TechLabel>core calls</TechLabel>
          <p className="mt-1 truncate font-mono text-sm tabular-nums text-foreground">{stats ? stats.engine.coreCalls : '—'}</p>
        </div>
      </div>
    </section>
  );
}

export default function SettingsView() {
  const [server, setServer] = useState<NexToolSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // v1.0.8 §8 — Settings loads the LIMITS FIRST, then the editable values;
  // numeric inputs derive their constraints from the resolved metadata.
  const [limitProps, setLimitProps] = useState<Record<string, LimitPropertyDTO> | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getSettings();
      setServer(data);
      setDraft({ ...data });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Settings unavailable');
    }
    try {
      const lim = await getConfigurationLimits();
      const props: Record<string, LimitPropertyDTO> = {};
      for (const [section, entries] of Object.entries(lim.limits)) {
        if (section === 'version' || section === '$meta' || typeof entries !== 'object' || entries === null) continue;
        for (const [key, prop] of Object.entries(entries as Record<string, LimitPropertyDTO>)) {
          props[`${section}.${key}`] = prop;
        }
      }
      setLimitProps(props);
      setLimitsError(null);
    } catch (e) {
      // Invalid configuration-limits.json must fail CLEARLY in the UI (spec §7.7).
      setLimitsError(e instanceof ApiClientError ? e.message : 'Configuration limits unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!server || !draft) return false;
    return JSON.stringify(server) !== JSON.stringify(draft);
  }, [server, draft]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { realTimeTransport: _ignored, ...partial } = draft;
      const updated = await updateSettings(partial);
      setServer(updated);
      setDraft({ ...updated });
      toast.success('Settings saved', { description: 'Runtime configuration updated.' });
    } catch (e) {
      toast.error('Save failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setSaving(false);
    }
  };

  const inputCls = 'min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<SlidersHorizontal className="size-4 text-sky-300" aria-hidden />}
        title="Settings"
        desc="Runtime defaults and execution limits — applies to newly created tasks."
        right={
          dirty ? (
            <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-300">unsaved changes</Badge>
          ) : (
            <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">in sync</Badge>
          )
        }
      />

      {/* About / Version — application vs model vs dataset, honest when unknown */}
      <AboutSection />

      {error && server === null ? (
        <ErrorCard title="Settings unavailable" message={error} onRetry={load} />
      ) : draft === null ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {/* Mode & reasoning */}
          <section aria-label="Defaults" className="glass-panel grid gap-4 rounded-lg p-4 md:grid-cols-2 md:p-6">
            <div className="space-y-1.5">
              <Label htmlFor="set-mode">Default mode</Label>
              <Select value={draft.defaultMode} onValueChange={(v) => set('defaultMode', v as Draft['defaultMode'])}>
                <SelectTrigger id="set-mode" className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="goal">goal — finite, runs until completion</SelectItem>
                  <SelectItem value="live">live — continuous, until stopped</SelectItem>
                </SelectContent>
              </Select>
              <p className="flex items-center gap-1.5 text-[11px] text-amber-300/90">
                <AlertTriangle className="size-3 shrink-0" aria-hidden />
                NexTool never switches to Live Mode automatically.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-reasoning">Default reasoning level</Label>
              <Select value={String(draft.defaultReasoningLevel)} onValueChange={(v) => set('defaultReasoningLevel', Number(v) as Draft['defaultReasoningLevel'])}>
                <SelectTrigger id="set-reasoning" className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6].map((lvl) => (
                    <SelectItem key={lvl} value={String(lvl)}><span className="font-mono">L{lvl}</span> — {REASONING_CAPTIONS[lvl]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 md:col-span-2">
              <div className="min-w-0">
                <Label htmlFor="set-memory" className="text-sm">Use persistent memory by default</Label>
                <p className="text-[11px] text-muted-foreground">Tasks may override this in their config</p>
              </div>
              <Switch id="set-memory" checked={draft.useMemory} onCheckedChange={(v) => set('useMemory', v)} aria-label="Use persistent memory by default" />
            </div>
          </section>

          {/* Execution limits — v1.0.8 §8: constraints derive from the central limits */}
          <section aria-label="Execution limits" className="glass-panel rounded-lg p-4 md:p-6">
            <h3 className="text-sm font-semibold text-foreground">Execution limits</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Runtime guardrails — metadata (default / min / max / unit) comes from config/configuration-limits.json via /api/config/limits.</p>
            {limitsError ? (
              <p role="alert" className="mt-3 rounded-md border border-rose-400/30 bg-rose-400/5 p-3 font-mono text-[11px] text-rose-300">{limitsError}</p>
            ) : null}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {LIMIT_FIELDS.map(({ field, section, key, label }) => (
                <NumberField
                  key={key}
                  id={`set-${key}`}
                  label={label}
                  value={draft[field] as number}
                  onChange={(v) => set(field, v as Draft[typeof field])}
                  hint={limitsHint(limitProps?.[`${section}.${key}`])}
                  min={limitProps?.[`${section}.${key}`]?.min}
                  max={limitProps?.[`${section}.${key}`]?.max}
                />
              ))}
              <div className="space-y-1">
                <Label htmlFor="set-tooltimeout-preset" className="text-xs text-muted-foreground">Tool timeout preset</Label>
                <Select
                  value={TOOL_TIMEOUT_PRESETS.some((p) => p.value === draft.toolTimeoutMs) ? String(draft.toolTimeoutMs) : 'custom'}
                  onValueChange={(v) => { if (v !== 'custom') set('toolTimeoutMs', Number(v)); }}
                >
                  <SelectTrigger id="set-tooltimeout-preset" className={inputCls}><SelectValue placeholder="Custom value" /></SelectTrigger>
                  <SelectContent>
                    {TOOL_TIMEOUT_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
                    ))}
                    {!TOOL_TIMEOUT_PRESETS.some((p) => p.value === draft.toolTimeoutMs) ? (
                      <SelectItem value="custom">Custom — {draft.toolTimeoutMs} ms</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
                <p className="font-mono text-[10px] text-muted-foreground/70">Applies to tools without their own timeout (Tool IDE)</p>
              </div>
            </div>
            {/* v1.0.3 §24: the parallel tool call policy — runtime defaults
                here; tasks may override per task in the Task Console. */}
            <div className="mt-4 grid gap-4 rounded-md border border-white/[0.08] bg-white/[0.03] p-3 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="set-parallel" className="text-sm">Parallel tool calls by default</Label>
                  <p className="text-[11px] text-muted-foreground">Independent plan steps run concurrently — dependencies stay sequential</p>
                </div>
                <Switch id="set-parallel" checked={draft.parallelToolCalls} onCheckedChange={(v) => set('parallelToolCalls', v)} aria-label="Parallel tool calls by default" />
              </div>
              {draft.parallelToolCalls ? (
                <NumberField
                  id="set-maxparallel"
                  label="Max parallel calls"
                  value={draft.maxParallelToolCalls}
                  onChange={(v) => set('maxParallelToolCalls', v)}
                  hint={limitsHint(limitProps?.['task.maxParallelToolCalls'])}
                  min={limitProps?.['task.maxParallelToolCalls']?.min}
                  max={limitProps?.['task.maxParallelToolCalls']?.max}
                />
              ) : (
                <p className="self-center text-[11px] text-muted-foreground">Parallel execution disabled — tools run strictly one after another.</p>
              )}
            </div>

            {/* v1.0.6 §9.3/§10 — tool approval + multi-event policy switches */}
            <div className="mt-4 grid gap-4 rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor="set-autoexecute" className="text-sm">Auto-Execute Tools</Label>
                  <p className="text-[11px] text-muted-foreground">
                    Global override — when ON, tools run without approval. When OFF, each task/tool config decides (per-tool default: approval required).
                  </p>
                </div>
                <Switch id="set-autoexecute" checked={draft.autoExecuteTools} onCheckedChange={(v) => set('autoExecuteTools', v)} aria-label="Auto-Execute Tools globally" />
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
                <div className="min-w-0">
                  <Label htmlFor="set-multievents" className="text-sm">Allow Multiple Events at Same Time</Label>
                  <p className="text-[11px] text-muted-foreground">
                    “Read &amp; Act All Events” — live tasks queue every incoming event and process them one-by-one. Default OFF: one event at a time.
                  </p>
                </div>
                <Switch id="set-multievents" checked={draft.allowMultipleEvents} onCheckedChange={(v) => set('allowMultipleEvents', v)} aria-label="Allow multiple live events at the same time" />
              </div>
            </div>
          </section>

          {/* v1.0.9 §14 — Network Policy: direct configuration of the timeout
              applied to EACH individual network request made inside a tool
              (fetch/XHR/virtual http(s)/URL imports/npm). Deliberately
              SEPARATE from the Tool Execution Timeout — neither setting
              silently overwrites the other. Metadata (default/min/max/unit/
              description) comes from the central limits like every other
              field; the value persists via GET/PUT /api/settings. */}
          <section aria-label="Network policy" className="glass-panel rounded-lg p-4 md:p-6">
            <h3 className="text-sm font-semibold text-foreground">Network policy</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Timeout for each individual network request made inside a tool — separate from the Tool Execution Timeout above. Example: tool timeout 300000 ms + network request timeout 120000 ms means a tool may live 5 minutes while one request may live 2 minutes.
            </p>
            {limitsError ? (
              <p role="alert" className="mt-3 rounded-md border border-rose-400/30 bg-rose-400/5 p-3 font-mono text-[11px] text-rose-300">{limitsError}</p>
            ) : null}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <NumberField
                id="set-network-timeout"
                label="Network request timeout (ms)"
                value={draft.networkRequestTimeoutMs}
                onChange={(v) => set('networkRequestTimeoutMs', v)}
                hint={limitsHint(limitProps?.['network.timeoutMs'])}
                min={limitProps?.['network.timeoutMs']?.min}
                max={limitProps?.['network.timeoutMs']?.max}
              />
              <div className="space-y-1">
                <Label htmlFor="set-network-timeout-preset" className="text-xs text-muted-foreground">Network timeout preset</Label>
                <Select
                  value={NETWORK_TIMEOUT_PRESETS.some((p) => p.value === draft.networkRequestTimeoutMs) ? String(draft.networkRequestTimeoutMs) : 'custom'}
                  onValueChange={(v) => { if (v !== 'custom') set('networkRequestTimeoutMs', Number(v)); }}
                >
                  <SelectTrigger id="set-network-timeout-preset" className={inputCls}><SelectValue placeholder="Custom value" /></SelectTrigger>
                  <SelectContent>
                    {NETWORK_TIMEOUT_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={String(p.value)}>{p.label}</SelectItem>
                    ))}
                    {!NETWORK_TIMEOUT_PRESETS.some((p) => p.value === draft.networkRequestTimeoutMs) ? (
                      <SelectItem value="custom">Custom — {draft.networkRequestTimeoutMs} ms</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
                <p className="font-mono text-[10px] text-muted-foreground/70">Reaches fetch / XHR / http(s) / URL imports / npm inside tools at runtime</p>
              </div>
            </div>
            <p className="mt-3 rounded-md border border-white/[0.08] bg-white/[0.03] p-3 text-[11px] text-muted-foreground">
              A request-specific override or a tool-level Network Policy may still narrow this value for individual calls; the tool execution timeout always remains the hard outer boundary. When a request exceeds this timeout the tool fails with <span className="font-mono text-rose-300">NETWORK_TIMEOUT</span> and the configured value in the message.
            </p>
          </section>
          <section aria-label="Logging and transport" className="glass-panel grid gap-4 rounded-lg p-4 md:grid-cols-2 md:p-6">
            <div className="space-y-1.5">
              <Label htmlFor="set-log">Log level</Label>
              <Select value={draft.logLevel} onValueChange={(v) => set('logLevel', v as Draft['logLevel'])}>
                <SelectTrigger id="set-log" className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">info</SelectItem>
                  <SelectItem value="debug">debug</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-transport">Real-time transport</Label>
              <Select value="sse" disabled>
                <SelectTrigger id="set-transport" className={`${inputCls} opacity-80`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sse">sse — Server-Sent Events</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                WebSocket adapter not installed in this environment — Server-Sent Events active.
              </p>
            </div>
          </section>

          <div className="flex items-center justify-end gap-3">
            {dirty ? (
              <Button type="button" variant="ghost" className="min-h-11 text-muted-foreground" onClick={() => setDraft({ ...(server as NexToolSettings) })}>
                Discard
              </Button>
            ) : null}
            <Button type="submit" className="bg-primary-gradient min-h-11 gap-2 text-primary-foreground hover:opacity-90" disabled={saving || !dirty}>
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Save className="size-4" aria-hidden />}
              Save settings
            </Button>
          </div>
        </form>
      )}

      {/* v1.0.7 §4/§5 — dependency validation + idempotent resource cleanup */}
      <MaintenanceSection />

      {/* v1.0.7 §3 — destructive Reset Application Data (typed confirmation) */}
      <DangerZoneSection />
    </div>
  );
}
