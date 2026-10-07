'use client';

/**
 * Task Console — task submission form (spec §51).
 * Goal Mode is the default; Live Mode requires explicit opt-in confirmation.
 * v1.0.1: glass panel form, blue brand accents, works at 320px (full-width
 * controls, wrapping quick-fill chips, prominent full-width submit on mobile).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { ApiClientError, createTask, getConfigurationLimits, getSettings, listTasks, listTools } from '@/lib/nexool/client';
import type { LimitPropertyDTO } from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import type { TaskSummary } from '@/lib/nexool/types';
import { EmptyState, ErrorCard, SectionTitle, StatusChip, TechLabel, TimeAgo } from '../ui-bits';
import { AlertTriangle, ChevronDown, FileText, ListPlus, Loader2, Send, ShieldCheck, Sparkles, TerminalSquare, Trash2, Upload, Wrench, Zap } from 'lucide-react';
// v1.0.12 Phase 7 — shared deterministic instructions logic (pure module,
// same combine rules the server applies — frontend/backend always agree).
import {
  ACCEPTED_INSTRUCTION_FILE_EXT,
  MAX_TEXT_INSTRUCTIONS_CHARS,
  MAX_UPLOADED_INSTRUCTIONS_CHARS,
  combineInstructions,
} from '@/lib/nexool/instructions';

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
  maxParallelToolCalls: 4,
};

/** v1.0.8 §9.4 — the Task Console's configurable fields map to ONE central
 *  limits property each; min/max metadata arrives from /api/config/limits. */
const LIMIT_PROPERTY_BY_FIELD: Record<keyof typeof DEFAULTS, { section: string; key: string }> = {
  maxSubtoolCalls: { section: 'task', key: 'maxSubtoolCalls' },
  safetyLimit: { section: 'task', key: 'safetyLimit' },
  maxIterations: { section: 'task', key: 'maxIterations' },
  taskTimeoutMs: { section: 'task', key: 'taskTimeoutMs' },
  toolTimeoutMs: { section: 'task', key: 'toolTimeoutMs' },
  liveIntervalMs: { section: 'task', key: 'liveIntervalMs' },
  maxParallelToolCalls: { section: 'task', key: 'maxParallelToolCalls' },
};

export default function TaskConsoleView() {
  const openTaskPreview = useConsoleStore((s) => s.openTaskPreview);

  const [name, setName] = useState('');
  // v1.0.8 §9.4 — limits metadata (min/max/default) for the config fields.
  const [limitMeta, setLimitMeta] = useState<Record<string, LimitPropertyDTO> | null>(null);
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<'goal' | 'live'>('goal');
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  // v1.0.10 §14 — per-task planner selection (override of the global default).
  // Defaults initialize from the global Settings once loaded (§18: default =
  // global setting) and travel inside the submitted task config.
  const [plannerType, setPlannerType] = useState<'pre-plan' | 'one-by-one'>('pre-plan');
  const [prePlanMaxSteps, setPrePlanMaxSteps] = useState<number>(10);
  // v1.0.13 — per-task safety-limit continuation cap (0..5, default 1;
  // 0 disables the continuation question for this task).
  const [limitContinuations, setLimitContinuations] = useState<number>(1);
  const [reasoningLevel, setReasoningLevel] = useState(3);
  const [useMemory, setUseMemory] = useState(true);
  // v1.0.3 §18/§24: explicit parallel tool call policy for THIS task (the
  // runtime default lives in Settings; this toggle is passed through to the
  // execution engine and actually changes runtime behavior).
  const [parallelToolCalls, setParallelToolCalls] = useState(true);
  // v1.0.6 §12/§13 — task-level approval + multi-event overrides (undefined = global/tool decide)
  const [autoExecuteTools, setAutoExecuteTools] = useState(false);
  const [allowMultipleEvents, setAllowMultipleEvents] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limits, setLimits] = useState({ ...DEFAULTS });
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  // v1.0.13 §1 — which tool CATEGORIES are expanded in the selector. Sections
  // start collapsed (header count is enough); collapsed sections render no
  // per-tool rows so the selector stays fast with large registries.
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  // v1.0.12 Phase 7 — custom task instructions: free-form textarea AND/OR an
  // uploaded/drag-dropped Markdown file. Both sources are kept SEPARATELY so
  // neither can be silently discarded; the deterministic combined preview
  // (identical to the server-side combination) is computed below.
  const [instructionsText, setInstructionsText] = useState('');
  const [instructionsFile, setInstructionsFile] = useState<{ name: string; content: string } | null>(null);
  const [instructionsDragOver, setInstructionsDragOver] = useState(false);
  const instructionsInputRef = useRef<HTMLInputElement>(null);
  // v1.0.3 §26-29: the Tasks page ends naturally with REAL content — recent
  // tasks (click → preview) or a meaningful empty state instead of blank space.
  const [recentTasks, setRecentTasks] = useState<TaskSummary[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listTools()
      .then((data) => alive && setTools(data))
      .catch((e) => alive && setToolsError(e instanceof ApiClientError ? e.message : 'Failed to load tools'));
    return () => {
      alive = false;
    };
  }, []);

  // v1.0.10 §18 — the Task Console's planner fields default to the GLOBAL
  // settings (Default planner + pre-plan step limit); the task may override.
  // v1.0.11 §41 — the global auto-execution value also drives the honest
  // "Controlled by global auto-execution setting" hint on the task switch.
  const [globalAutoExecHint, setGlobalAutoExecHint] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        if (!alive) return;
        if (s.defaultPlannerType === 'one-by-one' || s.defaultPlannerType === 'pre-plan') setPlannerType(s.defaultPlannerType);
        if (Number.isFinite(s.prePlanMaxSteps) && s.prePlanMaxSteps > 0) setPrePlanMaxSteps(Math.floor(s.prePlanMaxSteps));
        setGlobalAutoExecHint(s.autoExecuteTools === true);
      })
      .catch(() => { /* global settings unavailable — shipped defaults remain */ });
    return () => {
      alive = false;
    };
  }, []);

  const loadRecent = useCallback(async () => {
    try {
      const data = await listTasks({ limit: 8 });
      setRecentTasks(data);
      setRecentError(null);
    } catch (e) {
      setRecentError(e instanceof ApiClientError ? e.message : 'Task history unavailable');
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const toolGroups = useMemo(() => {
    const groups = new Map<string, ToolEntry[]>();
    for (const t of tools ?? []) {
      const list = groups.get(t.category) ?? [];
      list.push(t);
      groups.set(t.category, list);
    }
    // v1.0.13 §1 — stable order: categories alphabetically, tools by name
    // within each category, so collapsible sections keep a predictable place.
    return [...groups.entries()]
      .map(([category, list]) => [category, [...list].sort((a, b) => a.name.localeCompare(b.name))] as [string, ToolEntry[]])
      .sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);

  // v1.0.13 §1 — category select-all support. Only real tool NAMES ever enter
  // the set (categories are never written into config.enabledTools).
  const allToolNames = useMemo(() => (tools ?? []).map((t) => t.name), [tools]);
  const allSelected = allToolNames.length > 0 && selectedTools.size >= allToolNames.length;

  /** Select/deselect EVERY tool of one category in a single set update.
   *  Radix Checkbox fires `true` from both unchecked AND indeterminate states
   *  → clicking an indeterminate section selects all its tools (spec §1). */
  const toggleCategory = (list: ToolEntry[], selectAll: boolean) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (selectAll) {
        for (const t of list) next.add(t.name);
      } else {
        for (const t of list) next.delete(t.name);
      }
      return next;
    });
  };

  const toggleCategoryOpen = (category: string, open: boolean) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (open) next.add(category);
      else next.delete(category);
      return next;
    });
  };

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

  // ---------- v1.0.12 Phase 7 — custom task instructions ----------

  /** Deterministic combined preview of BOTH sources — exactly the same pure
   *  logic the server applies (spec §7.4: file section first, then textarea;
   *  neither source is ever silently discarded). */
  const combinedInstructions = useMemo(
    () => combineInstructions({ uploadedMarkdown: instructionsFile?.content, text: instructionsText }),
    [instructionsFile, instructionsText],
  );

  /** Read an uploaded/drag-dropped Markdown file into instruction CONTEXT
   *  (spec §7.1/§7.2). The content is never executed — it only ever becomes
   *  instruction/context text attached to the task. */
  const acceptInstructionsFile = useCallback(async (file: File) => {
    const lower = file.name.toLowerCase();
    const isMarkdown = ACCEPTED_INSTRUCTION_FILE_EXT.some((ext) => lower.endsWith(ext)) || file.type === 'text/markdown';
    if (!isMarkdown) {
      toast.error('Unsupported file', { description: `Attach a Markdown file (${ACCEPTED_INSTRUCTION_FILE_EXT.join(', ')}).` });
      return;
    }
    try {
      const content = await file.text();
      if (content.length > MAX_UPLOADED_INSTRUCTIONS_CHARS) {
        toast.error('Markdown file too large', { description: `"${file.name}" is ${content.length.toLocaleString()} chars — the limit is ${MAX_UPLOADED_INSTRUCTIONS_CHARS.toLocaleString()}.` });
        return;
      }
      setInstructionsFile({ name: file.name, content });
      toast.success('Markdown attached', { description: `${file.name} — ${content.length.toLocaleString()} chars of instruction context.` });
    } catch {
      toast.error('Could not read file', { description: file.name });
    }
  }, []);

  const validate = (): string | null => {
    if (!request.trim()) return 'Request is required — describe what the runtime should do.';
    if (request.trim().length < 4) return 'Request is too short to plan against.';
    // v1.0.4 §21/§22 — a task runs TOOLS: at least one tool must be selected.
    if (selectedTools.size < 1) return 'Select at least one tool before running the task.';
    if (mode === 'live' && !liveConfirmed) return 'Live Mode requires explicit opt-in — flip the confirmation switch.';
    for (const [k, v] of Object.entries(limits)) {
      if (!Number.isFinite(v) || v <= 0) return `${k} must be a positive number.`;
    }
    // v1.0.8 §9.4 — the parallel cap is the central task.maxParallelToolCalls.max.
    const parallelCap = limitMeta?.['task.maxParallelToolCalls']?.max ?? 8;
    if (parallelToolCalls && (limits.maxParallelToolCalls < 1 || limits.maxParallelToolCalls > parallelCap)) {
      return `maxParallelToolCalls must be between 1 and ${parallelCap}.`;
    }
    // v1.0.10 §18/§19 — pre-plan step limit: 1..122 (central bounds; the
    // server validates the same bounds — this is UX-level early feedback).
    if (plannerType === 'pre-plan') {
      const maxCap = limitMeta?.['task.prePlanMaxSteps']?.max ?? 122;
      if (!Number.isFinite(prePlanMaxSteps) || prePlanMaxSteps < 1 || prePlanMaxSteps > maxCap) {
        return `Maximum pre-plan steps must be between 1 and ${maxCap}.`;
      }
    }
    // v1.0.12 Phase 7 — instruction sources: honest client-side caps (the
    // server enforces the same limits via zod).
    if (instructionsText.length > MAX_TEXT_INSTRUCTIONS_CHARS) {
      return `Instruction text is too long — ${instructionsText.length.toLocaleString()} chars (limit ${MAX_TEXT_INSTRUCTIONS_CHARS.toLocaleString()}).`;
    }
    if (instructionsFile && instructionsFile.content.length > MAX_UPLOADED_INSTRUCTIONS_CHARS) {
      return `Markdown file "${instructionsFile.name}" is too large (limit ${MAX_UPLOADED_INSTRUCTIONS_CHARS.toLocaleString()} chars).`;
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
          // v1.0.4 §21/§24 — the selected tools travel explicitly in the task
          // config (always present now; the backend rejects an empty set too).
          enabledTools: [...selectedTools],
          maxSubtoolCalls: limits.maxSubtoolCalls,
          safetyLimit: limits.safetyLimit,
          maxIterations: limits.maxIterations,
          taskTimeoutMs: limits.taskTimeoutMs,
          toolTimeoutMs: limits.toolTimeoutMs,
          // v1.0.3 §25: parallel policy travels inside the task config object
          // and is applied by the execution engine for this task.
          parallelToolCalls,
          maxParallelToolCalls: parallelToolCalls ? limits.maxParallelToolCalls : 1,
          // v1.0.6 §13 — approval + event policy travel inside the task config;
          // separate concerns: parallelToolCalls ≠ allowMultipleEvents.
          autoExecuteTools,
          allowMultipleEvents,
          // v1.0.10 §14/§18 — the selected planner is ALWAYS included in the
          // submitted task configuration; prePlanMaxSteps only applies to
          // pre-plan (one-by-one always plans exactly one step per call).
          plannerType,
          ...(plannerType === 'pre-plan' ? { prePlanMaxSteps } : {}),
          // v1.0.13 — the continuation cap always travels in the task config.
          limitContinuations,
          ...(mode === 'live' ? { liveIntervalMs: limits.liveIntervalMs } : {}),
        },
        // v1.0.12 Phase 7 — BOTH instruction sources travel to the server,
        // which combines them deterministically (file section first, then
        // textarea) and persists the result with the task.
        instructions: combinedInstructions
          ? {
              ...(instructionsFile ? { uploadedMarkdown: instructionsFile.content } : {}),
              ...(instructionsText.trim() ? { text: instructionsText } : {}),
            }
          : undefined,
      });
      toast.success('Task queued', { description: `#${task.id.slice(0, 8)} — opening live preview.` });
      openTaskPreview(task.id);
      setRequest('');
      setName('');
      setMode('goal');
      setLiveConfirmed(false);
      setInstructionsText('');
      setInstructionsFile(null);
      void loadRecent();
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
        icon={<TerminalSquare className="size-4 text-sky-300" aria-hidden />}
        title="Task Console"
        desc="Submit a request to the runtime. NexTool plans, selects tools, executes and observes — it is not a chatbot."
      />

      <form
        className="glass-panel space-y-5 rounded-lg p-4 md:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {/* v1.0.4 §18-20 — quick-fill examples: the title sits on its own row
            and the compact example buttons wrap below it (never squeezed into
            the title row). Buttons are small secondary quick-actions: compact
            padding, still readable and touch-friendly. */}
        <div className="space-y-2">
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-3 text-sky-300/70" aria-hidden />
            <TechLabel>Examples</TechLabel>
          </span>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <Button
                key={ex.label}
                type="button"
                variant="outline"
                size="sm"
                className="h-8 min-h-8 border-white/[0.09] bg-white/[0.04] px-2.5 text-[11px] leading-none text-slate-300 hover:border-sky-400/40 hover:bg-white/[0.06] hover:text-sky-300"
                onClick={() => applyExample(ex)}
              >
                {ex.label}
                {ex.live ? <span className="ml-1 font-mono text-[9px] text-amber-300">live</span> : null}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-name">Name <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="task-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. prod-api-watchdog" className="min-h-11 border-white/[0.09] bg-white/[0.04] font-mono text-sm" maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-mode">Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'goal' | 'live')}>
              <SelectTrigger id="task-mode" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm" aria-label="Task mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="goal">goal — finite, runs until completion</SelectItem>
                <SelectItem value="live">live — continuous, until stopped</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {mode === 'live' ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
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

        {/* v1.0.10 §14 — planner selection with concise descriptions. The
            selected planner always travels in the submitted task config. */}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-planner">Planner</Label>
            <Select value={plannerType} onValueChange={(v) => setPlannerType(v as 'pre-plan' | 'one-by-one')}>
              <SelectTrigger id="task-planner" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm" aria-label="Planner strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
                <SelectItem value="pre-plan">pre-plan</SelectItem>
                <SelectItem value="one-by-one">one-by-one</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {plannerType === 'one-by-one'
                ? 'Plans one step, observes the result, then plans the next. Useful for dynamic/live tasks and adaptive subgoals.'
                : 'Plans several steps ahead. Efficient for finite, well-defined tasks.'}
            </p>
          </div>
          {plannerType === 'pre-plan' ? (
            <div className="space-y-1.5">
              <Label htmlFor="task-preplan-steps">Maximum pre-plan steps</Label>
              <Input
                id="task-preplan-steps"
                type="number"
                min={limitMeta?.['task.prePlanMaxSteps']?.min ?? 1}
                max={limitMeta?.['task.prePlanMaxSteps']?.max ?? 122}
                value={prePlanMaxSteps}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setPrePlanMaxSteps(Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
                }}
                className="min-h-11 border-white/[0.09] bg-white/[0.04] font-mono text-sm"
                aria-label="Maximum pre-plan steps"
              />
              <p className="font-mono text-[10px] text-muted-foreground/70">
                1–{limitMeta?.['task.prePlanMaxSteps']?.max ?? 122} · default from global Settings ({prePlanMaxSteps})
              </p>
            </div>
          ) : (
            <div className="self-end rounded-lg border border-white/[0.09] bg-white/[0.03] px-3 py-2.5">
              <p className="text-[11px] text-muted-foreground">
                One-by-one planning generates exactly ONE step per cycle from the latest observation — no pre-generated step list exists for this task.
              </p>
            </div>
          )}
        </div>

        {/* v1.0.13 — per-task safety-limit continuation cap. */}
        <div className="space-y-1.5">
          <Label htmlFor="task-limit-continuations">Safety-limit continuations</Label>
          <Input
            id="task-limit-continuations"
            type="number"
            min={limitMeta?.['task.limitContinuations']?.min ?? 0}
            max={limitMeta?.['task.limitContinuations']?.max ?? 5}
            value={limitContinuations}
            onChange={(e) => {
              const n = Number(e.target.value);
              setLimitContinuations(Number.isFinite(n) ? Math.floor(n) : 1);
            }}
            className="min-h-11 w-32 border-white/[0.09] bg-white/[0.04] font-mono text-sm"
            aria-label="Safety-limit continuations"
          />
          <p className="font-mono text-[10px] text-muted-foreground/70">
            0–{limitMeta?.['task.limitContinuations']?.max ?? 5} · how often the operator may grant extra budget when this task trips its iteration/safety limit (0 = fail at the limit as before)
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="task-request">Request <span className="text-rose-400">*</span></Label>
          <textarea
            id="task-request"
            required
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={4}
            placeholder={'Monitor the production server and recover it if unhealthy…\n\nPlain operational language — the CoreModule matches tools dynamically.'}
            className="w-full rounded-md border border-white/[0.09] bg-white/[0.04] px-3 py-2.5 font-mono text-sm shadow-xs outline-ring/50 placeholder:text-muted-foreground focus-visible:border-sky-400/50 focus-visible:ring-2 focus-visible:ring-sky-400/20"
            aria-invalid={!!validation && !request.trim()}
          />
        </div>

        {/* v1.0.12 Phase 7 — Custom task instructions (textarea + Markdown file).
            Instruction CONTEXT only: guidance for how the task should be
            performed (verification requirements, forbidden approaches, failure/
            success handling, format rules). It never overrides system/runtime
            constraints and Markdown is never executed as code. */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor="task-instructions">Instructions <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <div className="flex items-center gap-2">
              <input
                ref={instructionsInputRef}
                id="task-instructions-file"
                type="file"
                accept=".md,.markdown,.mdown,.mkd,text/markdown"
                className="sr-only"
                aria-label="Upload Markdown instructions file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void acceptInstructionsFile(file);
                  e.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]"
                onClick={() => instructionsInputRef.current?.click()}
              >
                <Upload className="size-3.5" aria-hidden /> Upload .md
              </Button>
              {combinedInstructions ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-9 text-muted-foreground hover:text-foreground"
                  onClick={() => { setInstructionsText(''); setInstructionsFile(null); }}
                >
                  <Trash2 className="size-3.5" aria-hidden /> Clear all
                </Button>
              ) : null}
            </div>
          </div>

          {/* Drag & drop zone for Markdown files (also acts as the drop target
              for the whole instructions card). */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Drag and drop a Markdown instructions file here, or use the Upload button"
            onDragOver={(e) => { e.preventDefault(); setInstructionsDragOver(true); }}
            onDragLeave={() => setInstructionsDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setInstructionsDragOver(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void acceptInstructionsFile(file);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                instructionsInputRef.current?.click();
              }
            }}
            className={cn(
              'rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground transition-colors',
              instructionsDragOver ? 'border-sky-400/60 bg-sky-400/[0.06] text-sky-200' : 'border-white/[0.12] bg-white/[0.02]',
            )}
          >
            <span className="flex items-center gap-1.5">
              <FileText className="size-3.5 shrink-0" aria-hidden />
              Drag &amp; drop a <span className="font-mono">.md</span> file here — its content becomes instruction context (never executed).
            </span>
          </div>

          {instructionsFile ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-white/[0.09] bg-white/[0.04] px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-emerald-300" aria-hidden />
                <span className="truncate font-mono text-[11px] text-foreground/90">{instructionsFile.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{instructionsFile.content.length.toLocaleString()} chars</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-8 shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => setInstructionsFile(null)}
                aria-label={`Remove uploaded file ${instructionsFile.name}`}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </div>
          ) : null}

          <textarea
            id="task-instructions"
            value={instructionsText}
            onChange={(e) => setInstructionsText(e.target.value)}
            rows={4}
            maxLength={MAX_TEXT_INSTRUCTIONS_CHARS}
            placeholder={'Follow these rules:\n- Verify every important result before reporting success\n- Never delete files without confirmation\n- Report failures with the exact error message…'}
            className="w-full rounded-md border border-white/[0.09] bg-white/[0.04] px-3 py-2.5 font-mono text-sm shadow-xs outline-ring/50 placeholder:text-muted-foreground focus-visible:border-sky-400/50 focus-visible:ring-2 focus-visible:ring-sky-400/20"
            aria-label="Custom task instructions"
          />
          <p className="font-mono text-[10px] text-muted-foreground/70">
            {instructionsText.length.toLocaleString()}/{MAX_TEXT_INSTRUCTIONS_CHARS.toLocaleString()} chars · reaches Planner, CoreModule and Observer · hierarchy: system constraints &gt; task config &gt; your instructions &gt; goal
          </p>

          {combinedInstructions ? (
            <Collapsible>
              <CollapsibleTrigger className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 text-xs text-slate-300 hover:bg-white/[0.06]">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-emerald-300" aria-hidden />
                  Combined preview — {combinedInstructions.chars.toLocaleString()} chars
                  {combinedInstructions.hasUploaded && combinedInstructions.hasText ? ' (file + text)' : combinedInstructions.hasUploaded ? ' (file)' : ' (text)'}
                </span>
                <ChevronDown className="size-3.5" aria-hidden />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-white/[0.08] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
{combinedInstructions.combined}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-reasoning">Reasoning Level</Label>
            <Select value={String(reasoningLevel)} onValueChange={(v) => setReasoningLevel(Number(v))}>
              <SelectTrigger id="task-reasoning" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04]" aria-label="Reasoning level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="glass-strong">
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
            <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-2.5">
              <div className="min-w-0">
                <Label htmlFor="task-memory" className="text-sm">Use persistent memory</Label>
                <p className="text-[11px] text-muted-foreground">Read/write persistent memory during execution</p>
              </div>
              <Switch id="task-memory" checked={useMemory} onCheckedChange={setUseMemory} aria-label="Use persistent memory" />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-2.5">
          <div className="min-w-0">
            <Label htmlFor="task-parallel" className="flex items-center gap-1.5 text-sm">
              <Zap className="size-3.5 text-sky-300" aria-hidden /> Parallel tool calls
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Independent plan steps may execute concurrently — dependent steps always stay sequential.
            </p>
          </div>
          <Switch id="task-parallel" checked={parallelToolCalls} onCheckedChange={setParallelToolCalls} aria-label="Parallel tool calls" />
        </div>

        {/* v1.0.6 §12 / v1.0.11 §37/§41 — task-level approval + multi-event policy.
            The Task Console preference is the LOWEST layer of the auto-execution
            hierarchy: Global Settings (highest) → Tool config → this. */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="task-autoexec" className="flex items-center gap-1.5 text-sm">
                <ShieldCheck className="size-3.5 text-emerald-300" aria-hidden /> Auto-Execute Tools
                <span className="rounded border border-white/[0.12] bg-white/[0.05] px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Task — lowest priority</span>
              </Label>
              <p className="text-[11px] text-muted-foreground">
                {globalAutoExecHint
                  ? 'Controlled by global auto-execution setting — this task preference cannot override it.'
                  : 'When ON, tools in this task run without approval unless a per-tool config decides. Global has higher priority; per-tool config overrides this.'}
              </p>
            </div>
            <Switch id="task-autoexec" checked={autoExecuteTools} onCheckedChange={setAutoExecuteTools} aria-label="Auto-execute tools for this task" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="task-multievents" className="flex items-center gap-1.5 text-sm">
                <ListPlus className="size-3.5 text-sky-300" aria-hidden /> Read &amp; Act All Events
              </Label>
              <p className="text-[11px] text-muted-foreground">Allow Multiple Events at Same Time — queue incoming live events, process one-by-one.</p>
            </div>
            <Switch id="task-multievents" checked={allowMultipleEvents} onCheckedChange={setAllowMultipleEvents} aria-label="Allow multiple live events at the same time" />
          </div>
        </div>

        {/* Execution limits */}
        <Collapsible open={limitsOpen} onOpenChange={setLimitsOpen}>
          <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 text-left text-sm text-foreground/90 hover:bg-white/[0.06]">
            <span>Execution limits</span>
            <span className="flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">defaults: 20 subtools · 100 safety · 30 iters{parallelToolCalls ? ` · ${limits.maxParallelToolCalls || DEFAULTS.maxParallelToolCalls} parallel` : ''}</span>
              <ChevronDown className={cn('size-4 text-sky-300/70 transition-transform', limitsOpen && 'rotate-180')} aria-hidden />
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 grid gap-3 rounded-lg border border-white/[0.07] bg-white/[0.03] p-3 sm:grid-cols-2 lg:grid-cols-3">
              {([
                ['maxSubtoolCalls', 'Max subtool calls', DEFAULTS.maxSubtoolCalls],
                ['safetyLimit', 'Safety limit', DEFAULTS.safetyLimit],
                ['maxIterations', 'Max iterations', DEFAULTS.maxIterations],
                ['taskTimeoutMs', 'Task timeout (ms)', DEFAULTS.taskTimeoutMs],
                ['toolTimeoutMs', 'Tool timeout (ms)', DEFAULTS.toolTimeoutMs],
                ...(parallelToolCalls ? ([['maxParallelToolCalls', 'Max parallel calls', DEFAULTS.maxParallelToolCalls]] as const) : []),
                ...(mode === 'live' ? ([['liveIntervalMs', 'Live tick interval (ms)', DEFAULTS.liveIntervalMs]] as const) : []),
              ] as [keyof typeof DEFAULTS, string, number][]).map(([key, label, def]) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`limit-${key}`} className="text-xs text-muted-foreground">{label}</Label>
                  <Input
                    id={`limit-${key}`}
                    type="number"
                    min={1}
                    value={limits[key]}
                    onChange={(e) => setLimit(key, e.target.value)}
                    className="min-h-11 border-white/[0.09] bg-white/[0.04] font-mono text-sm"
                  />
                  <p className="font-mono text-[10px] text-muted-foreground/60">default {def}</p>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Tool selection — v1.0.4 §21: at least one tool must be selected
            before the task can run.
            v1.0.13 §1 — tools render grouped by category as collapsible
            sections (header: name · tri-state select-all checkbox · selected/
            total count · expand affordance). Collapsed sections render NO
            per-tool rows. The payload keeps REAL tool names only — category
            labels never reach config.enabledTools. */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="text-sm">
              Tool selection <span className="text-rose-400" aria-hidden>*</span>
              <span className="sr-only">(required — select at least one tool)</span>
            </Label>
            <div className="flex items-center gap-2">
              <span className={cn('font-mono text-[11px]', selectedTools.size === 0 ? 'text-amber-300' : 'text-muted-foreground')}>
                {selectedTools.size === 0 ? 'required — select at least 1' : `${selectedTools.size} selected`}
              </span>
              {/* v1.0.13 §1 — master control across all categories. */}
              {tools !== null && tools.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 min-h-8 border-white/[0.09] bg-white/[0.04] px-2.5 text-[11px] leading-none text-slate-300 hover:border-sky-400/40 hover:bg-white/[0.06] hover:text-sky-300"
                  onClick={() => setSelectedTools(allSelected ? new Set<string>() : new Set(allToolNames))}
                >
                  {allSelected ? 'Clear all' : 'Select all'}
                </Button>
              ) : null}
            </div>
          </div>
          {toolsError ? (
            <ErrorCard title="Tool registry unavailable" message={toolsError} />
          ) : tools === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : tools.length === 0 ? (
            <EmptyState icon={<Wrench className="size-5" aria-hidden />} title="No tools registered in the runtime" hint="All tools will be considered when the registry repopulates." />
          ) : (
            // v1.0.8 §19 — `relative` anchors the hidden absolute inputs Radix
            // renders inside each Checkbox to THIS scroll container; without it
            // they escape to the document and inflate the page height past the
            // footer (artificial blank space below the footer).
            <div className="nextool-scroll relative max-h-96 space-y-2 overflow-y-auto rounded-lg border border-white/[0.07] bg-white/[0.03] p-2">
              {toolGroups.map(([category, list]) => {
                const selCount = list.reduce((n, t) => n + (selectedTools.has(t.name) ? 1 : 0), 0);
                const catChecked: boolean | 'indeterminate' =
                  selCount === 0 ? false : selCount >= list.length ? true : 'indeterminate';
                const isOpen = openCategories.has(category);
                return (
                  <Collapsible
                    key={category}
                    open={isOpen}
                    onOpenChange={(open) => toggleCategoryOpen(category, open)}
                    className={cn(
                      'rounded-lg border bg-white/[0.02] transition-colors',
                      selCount > 0 ? 'border-sky-400/25' : 'border-white/[0.07]',
                    )}
                  >
                    {/* Header — the tri-state checkbox and the expand trigger are
                        SIBLINGS (never a control nested inside the trigger
                        button); clicking the checkbox must not toggle expansion. */}
                    <div className="flex items-center gap-1 px-1.5 py-1">
                      <Checkbox
                        checked={catChecked}
                        onCheckedChange={(v) => toggleCategory(list, v === true)}
                        aria-label={`Select all tools in category ${category}`}
                        className="ml-1 shrink-0"
                      />
                      <CollapsibleTrigger className="flex min-h-9 min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left outline-ring/50 focus-visible:ring-2">
                        <TechLabel className="truncate text-[9px] text-sky-300/70">{category}</TechLabel>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="font-mono text-[10px] text-muted-foreground" aria-label={`${selCount} of ${list.length} tools selected in ${category}`}>
                            {selCount}/{list.length}
                          </span>
                          {selCount >= list.length && list.length > 0 ? (
                            <Badge variant="outline" className="border-sky-400/30 text-[9px] text-sky-300">all</Badge>
                          ) : null}
                          <ChevronDown
                            className={cn('size-3.5 text-sky-300/70 transition-transform', isOpen && 'rotate-180')}
                            aria-hidden
                          />
                        </span>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      {/* v1.0.13 §1 — per-tool rows exist ONLY while the section
                          is expanded; a collapsed section costs nothing but the
                          count already shown on its header. */}
                      {isOpen ? (
                        <div className="grid gap-1.5 px-2 pb-2 pt-0.5 sm:grid-cols-2">
                          {list.map((tool) => {
                            const checked = selectedTools.has(tool.name);
                            return (
                              <label
                                key={tool.name}
                                className={cn(
                                  'flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors outline-ring/50 focus-within:ring-2',
                                  checked
                                    ? 'border-sky-400/30 bg-primary-gradient-soft text-sky-100'
                                    : 'border-white/[0.07] text-slate-300 hover:bg-white/[0.06]',
                                )}
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
                      ) : null}
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
              {selectedTools.size > 0 ? (
                <Button type="button" variant="ghost" size="sm" className="min-h-11 text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelectedTools(new Set())}>
                  Clear selection
                </Button>
              ) : (
                <p className="px-1 pb-1 text-[11px] text-muted-foreground">
                  The planner may only use the selected tools — expand a category to pick tools, or use Select all.
                </p>
              )}
            </div>
          )}
        </div>

        {validation ? (
          <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
            {validation}
          </p>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="order-2 text-center text-[11px] text-muted-foreground sm:order-1 sm:text-left">NexTool never switches to Live Mode automatically.</p>
          <Button
            type="submit"
            disabled={submitting}
            className="order-1 min-h-11 w-full justify-center gap-2 bg-primary-gradient font-medium text-primary-foreground hover:opacity-90 sm:order-2 sm:w-auto"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {submitting ? 'Submitting…' : 'Submit task'}
          </Button>
        </div>
      </form>

      {/* v1.0.3 §26-29 — Recent tasks: the page ends naturally with REAL
          execution history (no reserved blank area below the form). Zero
          tasks → a meaningful empty state pointing at the actual action. */}
      <section aria-label="Recent tasks" className="space-y-3" data-testid="recent-tasks">
        <SectionTitle
          icon={<TerminalSquare className="size-4 text-sky-300" aria-hidden />}
          title="Recent tasks"
          desc="Latest executions — click a task to open its live preview."
        />
        {recentError ? (
          <ErrorCard title="Task history unavailable" message={recentError} onRetry={() => void loadRecent()} />
        ) : recentTasks === null ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : recentTasks.length === 0 ? (
          <EmptyState
            icon={<TerminalSquare className="size-6" aria-hidden />}
            title="No tasks yet"
            hint="Create your first NexTool task with the form above to see execution history here."
          />
        ) : (
          <div className="glass-panel rounded-lg p-2">
            <ul className="space-y-1">
              {recentTasks.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openTaskPreview(t.id)}
                    className="glass-card glass-card-hover flex w-full items-center gap-3 rounded-md px-3 py-2 text-left outline-ring/50 focus-visible:ring-2"
                    aria-label={`Open task ${t.name || t.request}`}
                  >
                    <StatusChip status={t.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-foreground/90">{t.name || t.request}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {t.mode} · L{t.reasoningLevel} · {t.steps} steps · {t.toolCalls} tools
                      </span>
                    </span>
                    <TimeAgo iso={t.createdAt} className="shrink-0 font-mono text-[10px] text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
