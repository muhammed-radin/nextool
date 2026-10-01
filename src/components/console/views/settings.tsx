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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ApiClientError, getSettings, updateSettings } from '@/lib/nexool/client';
import type { NexToolSettings } from '@/lib/nexool/types';
import { APP_NAME, APP_VERSION, RELEASE_NAME, CORE_MODULE_VERSION, CORE_MODULE_NAME } from '@/lib/nexool/version';
import { useSystemStats } from '../providers';
import { ErrorCard, SectionTitle, TechLabel, fmtMs } from '../ui-bits';
import { AlertTriangle, Info, Loader2, Save, SlidersHorizontal } from 'lucide-react';

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
  toolTimeoutMs: 30000,
  liveIntervalMs: 60000,
  useMemory: true,
  parallelToolCalls: true,
  maxParallelToolCalls: 4,
  logLevel: 'info',
  realTimeTransport: 'sse',
};

function NumberField({ id, label, value, onChange, hint }: { id: string; label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Input
        id={id}
        type="number"
        min={1}
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

  const load = useCallback(async () => {
    try {
      const data = await getSettings();
      setServer(data);
      setDraft({ ...data });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Settings unavailable');
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

          {/* Execution limits */}
          <section aria-label="Execution limits" className="glass-panel rounded-lg p-4 md:p-6">
            <h3 className="text-sm font-semibold text-foreground">Execution limits</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Hard runtime guardrails (defaults shown as hints).</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <NumberField id="set-subtool" label="Max subtool calls" value={draft.maxSubtoolCalls} onChange={(v) => set('maxSubtoolCalls', v)} hint="default 20" />
              <NumberField id="set-safety" label="Safety limit" value={draft.safetyLimit} onChange={(v) => set('safetyLimit', v)} hint="default 100" />
              <NumberField id="set-iters" label="Max iterations (goal)" value={draft.maxIterations} onChange={(v) => set('maxIterations', v)} hint="default 30" />
              <NumberField id="set-tasktimeout" label="Task timeout (ms)" value={draft.taskTimeoutMs} onChange={(v) => set('taskTimeoutMs', v)} hint="default 120000" />
              <NumberField id="set-tooltimeout" label="Tool timeout (ms)" value={draft.toolTimeoutMs} onChange={(v) => set('toolTimeoutMs', v)} hint="default 30000" />
              <NumberField id="set-liveinterval" label="Live tick interval (ms)" value={draft.liveIntervalMs} onChange={(v) => set('liveIntervalMs', v)} hint="default 60000" />
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
                <NumberField id="set-maxparallel" label="Max parallel calls" value={draft.maxParallelToolCalls} onChange={(v) => set('maxParallelToolCalls', Math.min(Math.max(v, 1), 8))} hint="default 4 · cap 8" />
              ) : (
                <p className="self-center text-[11px] text-muted-foreground">Parallel execution disabled — tools run strictly one after another.</p>
              )}
            </div>
          </section>

          {/* Logging & transport */}
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
    </div>
  );
}
