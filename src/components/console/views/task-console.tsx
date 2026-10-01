'use client';

/**
 * Task Console — task submission form (spec §51).
 * Goal Mode is the default; Live Mode requires explicit opt-in confirmation.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useConsoleStore } from '../console-store';
import { ApiClientError, createTask, listTools } from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import { EmptyState, ErrorCard, SectionTitle } from '../ui-bits';
import { AlertTriangle, ChevronDown, Loader2, Send, Sparkles, TerminalSquare, Wrench } from 'lucide-react';

const REASONING_CAPTIONS: Record<number, string> = {
  1: 'ultra-fast — minimal deliberation',
  2: 'fast — lightweight planning',
  3: 'balanced — default operating point',
  4: 'thorough — deeper plan validation',
  5: 'deep — exhaustive tool matching',
  6: 'maximum — full reasoning budget',
};

const EXAMPLES: { label: string; request: string; live?: boolean }[] = [
  { label: 'Health check + recover', request: 'Check the health of server api-01. If it is unhealthy, run the recovery routine and verify it returns to healthy.' },
  { label: 'Image generation', request: 'Create an image of a red sports car on a rainy city street at night.' },
  { label: 'Memory write + recall', request: 'Store the preferred server api-01 in persistent memory, then recall it to confirm the value.' },
  { label: 'Production monitor (live)', request: 'Monitor the production API and recover it if it becomes unhealthy.', live: true },
];

const DEFAULTS = {
  maxSubtoolCalls: 20,
  safetyLimit: 100,
  maxIterations: 30,
  taskTimeoutMs: 120000,
  toolTimeoutMs: 30000,
  liveIntervalMs: 60000,
};

export default function TaskConsoleView() {
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);

  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<'goal' | 'live'>('goal');
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState(3);
  const [useMemory, setUseMemory] = useState(true);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limits, setLimits] = useState({ ...DEFAULTS });
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listTools()
      .then((data) => alive && setTools(data))
      .catch((e) => alive && setToolsError(e instanceof ApiClientError ? e.message : 'Failed to load tools'));
    return () => {
      alive = false;
    };
  }, []);

  const toolGroups = useMemo(() => {
    const groups = new Map<string, ToolEntry[]>();
    for (const t of tools ?? []) {
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    return [...groups.entries()];
  }, [tools]);

  const setLimit = (key: keyof typeof DEFAULTS, raw: string) => {
    const n = Number(raw);
    setLimits((prev) => ({ ...prev, [key]: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 }));
  };

  const applyExample = (ex: (typeof EXAMPLES)[number]) => {
    setRequest(ex.request);
    if (ex.live) {
      setMode('live');
      setLiveConfirmed(true);
    } else {
      setMode('goal');
    }
    setValidation(null);
  };

  const validate = (): string | null => {
    if (!request.trim()) return 'Request is required — describe what the runtime should do.';
    if (request.trim().length < 4) return 'Request is too short to plan against.';
    if (mode === 'live' && !liveConfirmed) return 'Live Mode requires explicit opt-in — flip the confirmation switch.';
    for (const [k, v] of Object.entries(limits)) {
      if (!Number.isFinite(v) || v <= 0) return `${k} must be a positive number.`;
    }
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      setValidation(err);
      toast.error('Cannot submit task', { description: err });
      return;
    }
    setValidation(null);
    setSubmitting(true);
    try {
      const task = await createTask({
        request: request.trim(),
        config: {
          ...(name.trim() ? { name: name.trim() } : {}),
          mode,
          reasoningLevel: reasoningLevel as 1 | 2 | 3 | 4 | 5 | 6,
          useMemory,
          ...(selectedTools.size > 0 ? { enabledTools: [...selectedTools] } : {}),
          maxSubtoolCalls: limits.maxSubtoolCalls,
          safetyLimit: limits.safetyLimit,
          maxIterations: limits.maxIterations,
          taskTimeoutMs: limits.taskTimeoutMs,
          toolTimeoutMs: limits.toolTimeoutMs,
          ...(mode === 'live' ? { liveIntervalMs: limits.liveIntervalMs } : {}),
        },
      });
      toast.success('Task queued', { description: `#${task.id.slice(0, 8)} — opening live preview.` });
      openTaskPreview(task.id);
      setRequest('');
      setName('');
      setMode('goal');
      setLiveConfirmed(false);
    } catch (e) {
      const msg = e instanceof ApiClientError ? e.message : 'Task submission failed';
      toast.error('Task submission failed', { description: msg });
      setValidation(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<TerminalSquare className="size-4 text-emerald-400" aria-hidden />}
        title="Task Console"
        desc="Submit a request to the runtime. NexTool plans, selects tools, executes and observes — it is not a chatbot."
      />

      <form
        className="space-y-5 rounded-lg border bg-card p-4 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {/* quick-fill examples */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3" aria-hidden /> Examples
          </span>
          {EXAMPLES.map((ex) => (
            <Button key={ex.label} type="button" variant="outline" size="sm" className="min-h-9 h-9 border-zinc-700 text-xs text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-300" onClick={() => applyExample(ex)}>
              {ex.label}
              {ex.live ? <span className="ml-1 font-mono text-[10px] text-amber-400">live</span> : null}
            </Button>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-name">Name <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="task-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. prod-api-watchdog" className="font-mono text-sm" maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-mode">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'goal' | 'live')}>
              <SelectTrigger id="task-mode" className="min-h-11 w-full font-mono text-sm" aria-label="Task mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="goal">goal — finite, runs until completion</SelectItem>
                <SelectItem value="live">live — continuous, until stopped</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {mode === 'live' ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-amber-200">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Live Mode runs continuously until stopped. Requires explicit opt-in.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <Switch id="live-confirm" checked={liveConfirmed} onCheckedChange={setLiveConfirmed} aria-label="Confirm Live Mode opt-in" />
              <Label htmlFor="live-confirm" className="text-xs text-amber-200/80">
                I understand this task keeps running on a schedule ({DEFAULTS.liveIntervalMs / 1000}s default tick) until I stop it.
              </Label>
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="task-request">Request <span className="text-rose-400">*</span></Label>
          <textarea
            id="task-request"
            required
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            placeholder={'Monitor the production server and recover it if unhealthy…\n\nPlain operational language — the CoreModule matches tools dynamically.'}
            className="w-full rounded-md border border-input bg-background/60 px-3 py-2 font-mono text-sm shadow-xs outline-ring/50 placeholder:text-muted-foreground focus-visible:border-emerald-500/50 focus-visible:ring-2 focus-visible:ring-emerald-500/20"
            aria-invalid={!!validation && !request.trim()}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-reasoning">Reasoning Level</Label>
            <Select value={String(reasoningLevel)} onValueChange={(v) => setReasoningLevel(Number(v))}>
              <SelectTrigger id="task-reasoning" className="min-h-11 w-full" aria-label="Reasoning level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5, 6].map((lvl) => (
                  <SelectItem key={lvl} value={String(lvl)}>
                    <span className="font-mono">L{lvl}</span> — {REASONING_CAPTIONS[lvl]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{REASONING_CAPTIONS[reasoningLevel]}</p>
          </div>
          <div className="flex items-end">
            <div className="flex w-full items-center justify-between rounded-md border border-zinc-800 bg-background/60 px-3 py-2.5">
              <div>
                <Label htmlFor="task-memory" className="text-sm">Use persistent memory</Label>
                <p className="text-[11px] text-muted-foreground">Read/write persistent memory during execution</p>
              </div>
              <Switch id="task-memory" checked={useMemory} onCheckedChange={setUseMemory} aria-label="Use persistent memory" />
            </div>
          </div>
        </div>

        {/* Execution limits */}
        <Collapsible open={limitsOpen} onOpenChange={setLimitsOpen}>
          <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between rounded-md border border-zinc-800 bg-background/60 px-3 text-sm text-zinc-300 hover:bg-zinc-800/40">
            <span>Execution limits</span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              defaults: 20 subtools · 100 safety · 30 iters
              <ChevronDown className={cn('size-4 transition-transform', limitsOpen && 'rotate-180')} aria-hidden />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 grid gap-3 rounded-md border border-zinc-800 bg-background/40 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {([
                ['maxSubtoolCalls', 'Max subtool calls', DEFAULTS.maxSubtoolCalls],
                ['safetyLimit', 'Safety limit', DEFAULTS.safetyLimit],
                ['maxIterations', 'Max iterations', DEFAULTS.maxIterations],
                ['taskTimeoutMs', 'Task timeout (ms)', DEFAULTS.taskTimeoutMs],
                ['toolTimeoutMs', 'Tool timeout (ms)', DEFAULTS.toolTimeoutMs],
                ...(mode === 'live' ? ([['liveIntervalMs', 'Live tick interval (ms)', DEFAULTS.liveIntervalMs]] as const) : []),
              ] as [keyof typeof DEFAULTS, string, number][]).map(([key, label, def]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`limit-${key}`} className="text-xs text-zinc-400">{label}</Label>
                  <Input
                    id={`limit-${key}`}
                    type="number"
                    min={1}
                    value={limits[key]}
                    onChange={(e) => setLimit(key, e.target.value)}
                    className="font-mono text-sm"
                  />
                  <p className="font-mono text-[10px] text-zinc-600">default {def}</p>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Tool selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm">Tool selection</Label>
            <span className="font-mono text-[11px] text-muted-foreground">
              {selectedTools.size === 0 ? 'all enabled tools' : `${selectedTools.size} selected`}
            </span>
          </div>
          {toolsError ? (
            <ErrorCard title="Tool registry unavailable" message={toolsError} />
          ) : tools === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : tools.length === 0 ? (
            <EmptyState icon={<Wrench className="size-5" aria-hidden />} title="No tools registered in the runtime" hint="All tools will be considered when the registry repopulates." />
          ) : (
            <div className="nextool-scroll max-h-56 space-y-3 overflow-y-auto rounded-md border border-zinc-800 bg-background/40 p-3">
              {toolGroups.map(([category, list]) => (
                <div key={category}>
                  <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{category}</p>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {list.map((tool) => {
                      const checked = selectedTools.has(tool.name);
                      return (
                        <label
                          key={tool.name}
                          className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-zinc-800/70 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800/40"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(v) =>
                              setSelectedTools((prev) => {
                                const next = new Set(prev);
                                if (v) next.add(tool.name);
                                else next.delete(tool.name);
                                return next;
                              })
                            }
                            aria-label={`Enable tool ${tool.name}`}
                          />
                          <span className="truncate font-mono">{tool.name}</span>
                          {!tool.enabled ? <Badge variant="outline" className="ml-auto border-amber-500/30 text-[9px] text-amber-300">disabled</Badge> : null}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {selectedTools.size > 0 ? (
                <Button type="button" variant="ghost" size="sm" className="min-h-8 text-xs text-muted-foreground" onClick={() => setSelectedTools(new Set())}>
                  Clear selection — use all tools
                </Button>
              ) : null}
            </div>
          )}
        </div>

        {validation ? (
          <p role="alert" className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
            {validation}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-4">
          <p className="text-[11px] text-muted-foreground">NexTool never switches to Live Mode automatically.</p>
          <Button type="submit" disabled={submitting} className="min-h-11 gap-2 bg-emerald-500/90 font-medium text-zinc-950 hover:bg-emerald-400">
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {submitting ? 'Submitting…' : 'Submit task'}
          </Button>
        </div>
      </form>
    </div>
  );
}
