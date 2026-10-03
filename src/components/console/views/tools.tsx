'use client';

/**
 * Tools (spec §13/§31/§56) — tool registry grid with per-tool enable switch,
 * stats, schema accordion, dynamic tool registration dialog AND the full
 * v1.0.2 tool lifecycle: New Tool (Tool IDE) · Edit · Duplicate · Test ·
 * Enable/Disable · Delete (destructive ops confirmed).
 *
 * v1.0.4 §11-17 — tool portability:
 *  - Export a single tool (or all tools) as JSON with the EXACT function
 *    source code preserved as text (real registry data, no placeholders).
 *  - Import a tool JSON: parse → validate (structure/name/schema/function) →
 *    preview → conflict handling (replace / import as copy / cancel) →
 *    register through the REAL registry endpoints → editable in the Tool IDE.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { JsonTree } from '../json-tree';
import {
  ApiClientError, deleteTool, listTools, registerJsTool, registerTool, testTool, toggleTool, updateTool,
} from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import type { ToolTestResult } from '@/lib/nexool/client';
import {
  exportToolJson, exportToolsJson, parseToolImport, proposeCopyName, toolExportFilename, validateImportedTool,
  type PortableTool,
} from '@/lib/nexool/tool-portable';
import { APP_VERSION } from '@/lib/nexool/version';
import { filterTools } from '@/lib/nexool/tool-search';
import { EmptyState, ErrorCard, SectionTitle, TechLabel, fmtMs } from '../ui-bits';
import {
  Copy, Download, FilePlus2, FileUp, Loader2, Pencil, Play, Plus, Search, Squircle, Trash2, Upload, Wrench, X,
} from 'lucide-react';

function EnvironmentBadge({ environment }: { environment: ToolEntry['environment'] }) {
  if (environment === 'virtual-env') {
    return (
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-300">virtual environment</Badge>
          </TooltipTrigger>
          <TooltipContent>Runs against the simulated server fleet</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  if (environment === 'js-function') {
    return <Badge variant="outline" className="border-cyan-400/30 bg-cyan-400/10 font-mono text-[10px] text-cyan-300">js-function</Badge>;
  }
  if (environment === 'dynamic') {
    return <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 font-mono text-[10px] text-sky-300">dynamic</Badge>;
  }
  return <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">builtin</Badge>;
}

function ToolCard({
  tool, onToggle, toggling, onEdit, onTest, onDuplicate, onDelete, deleteBusy, onExport,
}: {
  tool: ToolEntry;
  onToggle: (name: string, enabled: boolean) => void;
  toggling: boolean;
  onEdit: (tool: ToolEntry) => void;
  onTest: (tool: ToolEntry) => void;
  onDuplicate: (tool: ToolEntry) => void;
  onDelete: (tool: ToolEntry) => void;
  deleteBusy: boolean;
  onExport: (tool: ToolEntry) => void;
}) {
  const s = tool.stats;
  const readOnly = tool.environment === 'builtin' || tool.environment === 'virtual-env';
  return (
    <div className={cn('glass-card flex flex-col rounded-lg p-4', !tool.enabled && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold text-foreground" title={tool.name}>{tool.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">{tool.category}</Badge>
            <EnvironmentBadge environment={tool.environment} />
            {tool.handlerKind ? <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-slate-400">handler: {tool.handlerKind}</Badge> : null}
            {tool.toolVersion ? <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-slate-400">v{tool.toolVersion}</Badge> : null}
          </div>
        </div>
        <Switch checked={tool.enabled} onCheckedChange={(v) => onToggle(tool.name, v)} disabled={toggling} aria-label={`Toggle tool ${tool.name}`} />
      </div>

      <p className="mt-2 break-words text-xs text-foreground/90">{tool.description}</p>
      {tool.purpose ? <p className="mt-1 break-words text-[11px] italic text-muted-foreground">purpose: {tool.purpose}</p> : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-white/[0.07] pt-2 font-mono text-[11px] tabular-nums text-slate-300">
        <span><span className="text-muted-foreground">calls</span> {s.callCount}</span>
        <span className="text-emerald-300"><span className="text-muted-foreground">ok</span> {s.successCount}</span>
        <span className="text-rose-300"><span className="text-muted-foreground">fail</span> {s.failureCount + s.timeoutCount}</span>
        <span><span className="text-muted-foreground">avg</span> {fmtMs(s.avgMs)}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {!readOnly ? (
          <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs text-slate-200" onClick={() => onEdit(tool)}>
            <Pencil className="size-3.5" aria-hidden /> Edit
          </Button>
        ) : (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs text-slate-200" onClick={() => onDuplicate(tool)}>
                  <Copy className="size-3.5" aria-hidden /> Duplicate to customize
                </Button>
              </TooltipTrigger>
              <TooltipContent>Built-ins are read-only — duplicate creates a js-function copy you can edit</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs text-slate-200" onClick={() => onTest(tool)}>
          <Play className="size-3.5" aria-hidden /> Test
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs text-slate-200"
          onClick={() => onExport(tool)}
          aria-label={`Export tool ${tool.name} as JSON`}
        >
          <Download className="size-3.5" aria-hidden /> Export
        </Button>
        {!readOnly ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
            onClick={() => onDelete(tool)}
            disabled={deleteBusy}
            aria-label={`Delete tool ${tool.name}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>

      <Accordion type="single" collapsible className="mt-2">
        <AccordionItem value="schema" className="border-none">
          <AccordionTrigger className="py-1.5 text-[11px] text-muted-foreground hover:no-underline">Schema ({tool.schema?.properties?.length ?? 0} params)</AccordionTrigger>
          <AccordionContent>
            {(tool.schema?.properties ?? []).length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No parameters.</p>
            ) : (
              <div className="nextool-scroll overflow-x-auto">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="pb-1 pr-2 font-medium">name</th>
                      <th className="pb-1 pr-2 font-medium">type</th>
                      <th className="pb-1 font-medium">notes</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {(tool.schema?.properties ?? []).map((p) => (
                      <tr key={p.name} className="border-t border-white/[0.06] align-top">
                        <td className="py-1 pr-2 text-foreground/90">
                          {p.name}
                          {p.required ? <span className="text-rose-400">*</span> : null}
                        </td>
                        <td className="py-1 pr-2 text-cyan-300/90">{p.type}</td>
                        <td className="py-1 text-muted-foreground">
                          {p.generation ? <span className="mr-1 rounded border border-white/[0.09] px-1 text-[9px] uppercase">{p.generation}</span> : null}
                          {p.description}
                          {p.enumValues?.length ? (
                            <span className="ml-1 inline-flex flex-wrap gap-1">
                              {p.enumValues.map((v) => (
                                <span key={v} className="rounded bg-white/[0.06] px-1 text-[9px] text-foreground/80">{v}</span>
                              ))}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

const EXAMPLE_PARAMS = JSON.stringify(
  {
    properties: [
      { name: 'input', type: 'string', required: true, description: 'Primary input value' },
      { name: 'delayMs', type: 'number', required: false, description: 'Optional delay hint' },
    ],
  },
  null,
  2,
);

export default function ToolsView({
  onOpenEditor,
}: {
  onOpenEditor: (req: { mode: 'new' | 'edit' | 'duplicate'; name: string | null; source?: ToolEntry }) => void;
}) {
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', category: 'utility', purpose: '', handlerKind: 'echo', handlerConfig: '{}', schema: EXAMPLE_PARAMS });

  const [testTarget, setTestTarget] = useState<ToolEntry | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<ToolTestResult | null>(null);

  const [deleteCandidate, setDeleteCandidate] = useState<ToolEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // v1.0.7 §2 — client-side tool search/filter (no page reload).
  const [query, setQuery] = useState('');

  // ---- v1.0.4 §11-17: tool export / import state ----
  const importFileRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  /** Validated tool awaiting confirmation (preview dialog). */
  const [importPreview, setImportPreview] = useState<{ tool: PortableTool; warnings: string[] } | null>(null);
  /** Validated tool whose name already exists (conflict dialog). */
  const [importConflict, setImportConflict] = useState<{ tool: PortableTool; existing: ToolEntry } | null>(null);
  /** Import rejected — readable validation errors. */
  const [importErrors, setImportErrors] = useState<{ errors: string[]; warnings: string[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listTools();
      setTools(data);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Tool registry unavailable');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = async (name: string, enabled: boolean) => {
    setToggling(name);
    try {
      const updated = await toggleTool(name, enabled);
      setTools((prev) => (prev ?? []).map((t) => (t.name === name ? { ...t, enabled: updated.enabled } : t)));
      toast.success(`${name} ${updated.enabled ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast.error('Toggle failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setToggling(null);
    }
  };

  const submitRegister = async () => {
    if (!/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(form.name.trim())) {
      toast.error('Invalid tool name', { description: 'Use namespace.action, e.g. utility.summarize' });
      return;
    }
    let properties: unknown;
    try {
      properties = JSON.parse(form.schema);
    } catch {
      toast.error('Schema is not valid JSON');
      return;
    }
    let handlerConfig: Record<string, unknown> | undefined;
    if (form.handlerConfig.trim()) {
      try {
        handlerConfig = JSON.parse(form.handlerConfig);
      } catch {
        toast.error('handlerConfig is not valid JSON');
        return;
      }
    }
    setRegistering(true);
    try {
      await registerTool({
        definition: {
          name: form.name.trim(),
          description: form.description.trim() || 'Dynamically registered tool',
          category: form.category.trim() || 'utility',
          ...(form.purpose.trim() ? { purpose: form.purpose.trim() } : {}),
          environment: 'dynamic',
          schema: { type: 'object', properties: Array.isArray(properties) ? properties : [] },
        },
        handlerKind: form.handlerKind as 'echo' | 'delay' | 'http_get' | 'uuid',
        ...(handlerConfig ? { handlerConfig } : {}),
      });
      toast.success('Tool registered', { description: `${form.name} is now available to the CoreModule.` });
      setRegOpen(false);
      void load();
    } catch (e) {
      toast.error('Registration rejected', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setRegistering(false);
    }
  };

  const openTest = (tool: ToolEntry) => {
    setTestTarget(tool);
    setTestResult(null);
    setTestParams('{}');
  };

  const runTest = async () => {
    if (!testTarget) return;
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(testParams || '{}');
    } catch {
      toast.error('Test params must be valid JSON');
      return;
    }
    setTestRunning(true);
    try {
      const result = await testTool({ name: testTarget.name, params });
      setTestResult(result);
    } catch (e) {
      toast.error('Test failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setTestRunning(false);
    }
  };

  const doDelete = async () => {
    if (!deleteCandidate) return;
    setDeleteBusy(true);
    try {
      await deleteTool(deleteCandidate.name);
      toast.success('Tool deleted', { description: `${deleteCandidate.name} removed from the registry.` });
      setDeleteCandidate(null);
      void load();
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setDeleteBusy(false);
    }
  };

  // ---------- v1.0.4 §11-12: export ----------

  const downloadJson = (filename: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportOne = (tool: ToolEntry) => {
    downloadJson(toolExportFilename(tool.name), exportToolJson(tool, APP_VERSION));
    toast.success('Tool exported', { description: `${tool.name} — function code preserved as text.` });
  };

  const exportAll = () => {
    if (!tools || tools.length === 0) return;
    downloadJson(`nextool-tools-${new Date().toISOString().slice(0, 10)}.json`, exportToolsJson(tools, APP_VERSION));
    toast.success('Tools exported', { description: `${tools.length} tool definition(s) exported.` });
  };

  // ---------- v1.0.4 §13-16: import ----------

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.error('Import failed', { description: 'The file could not be read.' });
      return;
    }
    const parsed = parseToolImport(text);
    if (!parsed.ok) {
      setImportErrors({ errors: [parsed.error], warnings: [] });
      return;
    }
    const result = validateImportedTool(parsed.value);
    if (!result.ok || !result.tool) {
      setImportErrors({ errors: result.errors, warnings: result.warnings });
      return;
    }
    const existing = (tools ?? []).find((t) => t.name === result.tool!.name);
    if (existing) {
      setImportConflict({ tool: result.tool, existing });
    } else {
      setImportPreview({ tool: result.tool, warnings: result.warnings });
    }
  };

  /** §15 — register a validated import through the REAL registry endpoints. */
  const registerImported = async (tool: PortableTool, successDesc: string) => {
    setImportBusy(true);
    try {
      if (tool.environment === 'js-function') {
        await registerJsTool({
          name: tool.name,
          description: tool.description,
          purpose: tool.purpose,
          category: tool.category,
          toolVersion: tool.toolVersion,
          schema: tool.schema,
          functionSource: tool.functionSource ?? '',
          enabled: tool.enabled ?? true,
        });
      } else {
        await registerTool({
          definition: {
            name: tool.name,
            description: tool.description,
            category: tool.category,
            ...(tool.purpose ? { purpose: tool.purpose } : {}),
            environment: 'dynamic',
            schema: tool.schema,
          },
          handlerKind: tool.handlerKind as 'echo' | 'delay' | 'http_get' | 'uuid',
          ...(tool.handlerConfig ? { handlerConfig: tool.handlerConfig } : {}),
        });
      }
      toast.success('Tool imported', { description: successDesc });
      setImportPreview(null);
      setImportConflict(null);
      void load();
    } catch (e) {
      // Registry-side re-validation (syntax/schema/exists) — surface honestly.
      toast.error('Import rejected', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setImportBusy(false);
    }
  };

  /** §16 — replace the existing tool with the imported definition. */
  const replaceImported = async (conflict: { tool: PortableTool; existing: ToolEntry }) => {
    setImportBusy(true);
    try {
      await updateTool(conflict.existing.name, {
        description: conflict.tool.description,
        purpose: conflict.tool.purpose,
        category: conflict.tool.category,
        toolVersion: conflict.tool.toolVersion,
        schema: conflict.tool.schema,
        functionSource: conflict.tool.environment === 'js-function' ? conflict.tool.functionSource : undefined,
        enabled: conflict.tool.enabled ?? true,
      });
      toast.success('Tool replaced', { description: `${conflict.existing.name} now uses the imported definition.` });
      setImportConflict(null);
      void load();
    } catch (e) {
      toast.error('Replace failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setImportBusy(false);
    }
  };

  /** §16 — import under a fresh, non-conflicting copy name. */
  const importAsCopy = async (conflict: { tool: PortableTool; existing: ToolEntry }) => {
    const copyName = proposeCopyName(new Set((tools ?? []).map((t) => t.name)), conflict.tool.name);
    await registerImported({ ...conflict.tool, name: copyName }, `${copyName} registered as a copy of ${conflict.existing.name}.`);
  };

  const inputCls = 'min-h-11 border-white/[0.09] bg-white/[0.04] text-sm';

  // v1.0.7 §2 — live filter across name/description/category/environment/
  // handler kind/metadata. Pure helper (shared with tests), no page reload.
  const visibleTools = useMemo(() => filterTools(tools ?? [], query), [tools, query]);
  const searchActive = query.trim().length > 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Wrench className="size-4 text-sky-300" aria-hidden />}
        title="Tools"
        desc="Registry visible to the CoreModule — dynamic matching, no hardcoded ids."
        right={
          <div className="flex items-center gap-2">
            <Button size="sm" className="bg-primary-gradient min-h-9 gap-1.5 text-primary-foreground hover:opacity-90" onClick={() => onOpenEditor({ mode: 'new', name: null })}>
              <Plus className="size-3.5" aria-hidden /> New Tool
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" aria-label="More tool actions">
                  <Squircle className="size-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-strong">
                <DropdownMenuItem onClick={() => setRegOpen(true)}>
                  <FilePlus2 className="size-3.5" aria-hidden /> Register handler tool…
                </DropdownMenuItem>
                {/* v1.0.4 §13 — import a tool JSON file */}
                <DropdownMenuItem onClick={() => importFileRef.current?.click()}>
                  <FileUp className="size-3.5" aria-hidden /> Import tool (JSON)…
                </DropdownMenuItem>
                {/* v1.0.4 §11 — export all tools */}
                <DropdownMenuItem onClick={exportAll} disabled={!tools || tools.length === 0}>
                  <Download className="size-3.5" aria-hidden /> Export all tools (JSON)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {/* v1.0.7 §2 — responsive search/filter: own row on narrow screens, never
          squeezes adjacent controls; filters live without a page reload. */}
      {!error || tools !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools..."
              aria-label="Search tools"
              className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] pl-9 pr-9 text-sm [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
            />
            {searchActive ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
          {tools !== null ? (
            <p className="font-mono text-[11px] text-muted-foreground sm:ml-auto" aria-live="polite">
              {searchActive ? `${visibleTools.length} of ${tools.length} tools match` : `${tools.length} tools registered`}
            </p>
          ) : null}
        </div>
      ) : null}

      {error && tools === null ? (
        <ErrorCard title="Tool registry unavailable" message={error} onRetry={load} />
      ) : tools === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}
        </div>
      ) : tools.length === 0 ? (
        <EmptyState icon={<Wrench className="size-6" aria-hidden />} title="No tools registered" hint="Create one with the Tool IDE or register a handler tool." />
      ) : visibleTools.length === 0 ? (
        /* v1.0.7 §2 — honest empty state for a non-matching search */
        <EmptyState
          icon={<Search className="size-6" aria-hidden />}
          title="No tools found"
          hint={`Nothing matches “${query.trim()}”. Try a different term or clear the search.`}
          action={
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" onClick={() => setQuery('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleTools.map((tool) => (
            <ToolCard
              key={tool.name}
              tool={tool}
              onToggle={(n, v) => void onToggle(n, v)}
              toggling={toggling === tool.name}
              onEdit={(t) => onOpenEditor({ mode: 'edit', name: t.name })}
              onTest={openTest}
              onDuplicate={(t) => onOpenEditor({ mode: 'duplicate', name: null, source: t })}
              onDelete={setDeleteCandidate}
              deleteBusy={deleteBusy}
              onExport={exportOne}
            />
          ))}
        </div>
      )}

      {/* v1.0.4 §11/§13 — import file picker (hidden; triggered from the actions menu) */}
      <input
        ref={importFileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          void onImportFile(e.target.files?.[0]);
          e.target.value = '';
        }}
        aria-label="Import tool JSON file"
      />

      {/* Handler-tool registration dialog (dynamic handler kinds) */}
      <Dialog open={regOpen} onOpenChange={setRegOpen}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register handler tool</DialogTitle>
            <DialogDescription>Registers a built-in-handler-backed tool the CoreModule can match and execute. For full JavaScript tools use the Tool IDE.</DialogDescription>
          </DialogHeader>
          <div className="nextool-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tool-name">Name <span className="text-muted-foreground">(namespace.action)</span></Label>
                <Input id="tool-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="utility.summarize" className={cn('font-mono', inputCls)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tool-category">Category</Label>
                <Input id="tool-category" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className={inputCls} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-desc">Description</Label>
              <Input id="tool-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-purpose">Purpose <span className="text-muted-foreground">(optional)</span></Label>
              <Input id="tool-purpose" value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-handler">Handler kind</Label>
              <Select value={form.handlerKind} onValueChange={(v) => setForm((f) => ({ ...f, handlerKind: v }))}>
                <SelectTrigger id="tool-handler" className="min-h-11 w-full font-mono text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="echo">echo — returns its input</SelectItem>
                  <SelectItem value="delay">delay — sleeps then acks</SelectItem>
                  <SelectItem value="http_get">http_get — fetches a URL</SelectItem>
                  <SelectItem value="uuid">uuid — generates an id</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-handlercfg">handlerConfig (JSON)</Label>
              <Textarea id="tool-handlercfg" value={form.handlerConfig} onChange={(e) => setForm((f) => ({ ...f, handlerConfig: e.target.value }))} rows={2} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" placeholder="{}" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-schema">Schema params (JSON — array of param defs)</Label>
              <Textarea id="tool-schema" value={form.schema} onChange={(e) => setForm((f) => ({ ...f, schema: e.target.value }))} rows={6} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={() => setRegOpen(false)}>Cancel</Button>
            <Button className="bg-primary-gradient min-h-11 text-primary-foreground hover:opacity-90" disabled={registering} onClick={() => void submitRegister()}>
              {registering ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FilePlus2 className="size-4" aria-hidden />} Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tool test dialog — real execution of the registered tool (§27-30) */}
      <Dialog open={testTarget !== null} onOpenChange={(open) => !open && setTestTarget(null)}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Test {testTarget?.name}</DialogTitle>
            <DialogDescription>
              Executes the ACTUAL registered handler in a controlled test context with a 20s cap.
            </DialogDescription>
          </DialogHeader>
          <div className="nextool-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <Label htmlFor="test-params">Input parameters (JSON)</Label>
              <Textarea id="test-params" value={testParams} onChange={(e) => setTestParams(e.target.value)} rows={5} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" placeholder="{}" />
            </div>
            <Button className="min-h-11 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={testRunning} onClick={() => void runTest()}>
              {testRunning ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />} Run test
            </Button>
            {testResult ? (
              <div className="space-y-2" data-testid="tools-view-test-result">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={cn('font-mono text-[11px]', testResult.status === 'completed' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-400/30 bg-rose-400/10 text-rose-300')}>
                    {testResult.status}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">{fmtMs(testResult.durationMs)}</span>
                  <span className="font-mono text-[10px] text-slate-500">{testResult.mode}</span>
                </div>
                {testResult.error ? (
                  <p role="alert" className="break-words rounded-md border border-rose-400/30 bg-rose-400/5 px-3 py-2 font-mono text-xs text-rose-300">
                    {testResult.error.code}: {testResult.error.message}
                  </p>
                ) : null}
                {testResult.logs.length > 0 ? (
                  <div className="glass-inset nextool-scroll max-h-32 overflow-y-auto rounded-md p-2.5">
                    {testResult.logs.map((line, i) => (
                      <p key={i} className="break-words font-mono text-[11px] leading-relaxed text-sky-100/70">{line}</p>
                    ))}
                  </div>
                ) : null}
                <div>
                  <p className="mb-1"><Label className="text-[10px] uppercase tracking-wider text-sky-300/80">result</Label></p>
                  <JsonTree value={testResult.result ?? null} maxHeight={260} />
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04]" onClick={() => setTestTarget(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm (destructive op, §31) */}
      <Dialog open={deleteCandidate !== null} onOpenChange={(open) => !open && setDeleteCandidate(null)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300">Delete {deleteCandidate?.name}?</DialogTitle>
            <DialogDescription>The tool is removed from the registry and stops being available to the CoreModule. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setDeleteCandidate(null)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" disabled={deleteBusy} onClick={() => void doDelete()}>
              {deleteBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />} Delete tool
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v1.0.4 §15 — import preview / confirmation before registering */}
      <Dialog open={importPreview !== null} onOpenChange={(open) => !open && setImportPreview(null)}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import tool</DialogTitle>
            <DialogDescription>Validated against the tool schema. Review before registering.</DialogDescription>
          </DialogHeader>
          {importPreview ? (
            <div className="nextool-scroll max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <p><TechLabel className="text-[9px]">name</TechLabel><span className="mt-0.5 block break-words font-mono text-sky-200">{importPreview.tool.name}</span></p>
                <p><TechLabel className="text-[9px]">environment</TechLabel><span className="mt-0.5 block font-mono text-foreground/90">{importPreview.tool.environment}</span></p>
                <p><TechLabel className="text-[9px]">category</TechLabel><span className="mt-0.5 block font-mono text-foreground/90">{importPreview.tool.category}</span></p>
                <p><TechLabel className="text-[9px]">schema params</TechLabel><span className="mt-0.5 block font-mono text-foreground/90">{importPreview.tool.schema.properties?.length ?? 0}</span></p>
              </div>
              <p className="break-words text-xs text-muted-foreground">{importPreview.tool.description}</p>
              {importPreview.tool.functionSource ? (
                <div>
                  <TechLabel className="text-[9px]">function code (exact source from the file)</TechLabel>
                  <pre className="glass-inset nextool-scroll mt-1 max-h-40 overflow-auto rounded-md p-2.5 font-mono text-[11px] leading-relaxed text-sky-100/90">
                    {importPreview.tool.functionSource}
                  </pre>
                </div>
              ) : null}
              {importPreview.warnings.length > 0 ? (
                <div className="rounded-md border border-amber-400/30 bg-amber-400/[0.06] p-2">
                  <ul className="space-y-0.5">
                    {importPreview.warnings.map((w) => (
                      <li key={w} className="break-words text-[11px] text-amber-200/90">⚠ {w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setImportPreview(null)}>Cancel</Button>
            <Button className="min-h-11 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={importBusy} onClick={() => importPreview && void registerImported(importPreview.tool, `${importPreview.tool.name} is now available to the CoreModule.`)}>
              {importBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />} Register tool
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v1.0.4 §16 — name conflict: replace / import as copy / cancel */}
      <Dialog open={importConflict !== null} onOpenChange={(open) => !open && setImportConflict(null)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-300">Tool already exists</DialogTitle>
            <DialogDescription>
              A tool named <span className="font-mono text-foreground/90">{importConflict?.existing.name}</span> is already registered ({importConflict?.existing.environment}). Choose how to proceed — nothing is overwritten without confirmation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
            <Button className="min-h-11 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90" disabled={importBusy} onClick={() => importConflict && void replaceImported(importConflict)}>
              {importBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />} Replace existing tool
            </Button>
            <Button variant="outline" className="min-h-11 border-white/[0.09] bg-white/[0.04] text-slate-200" disabled={importBusy} onClick={() => importConflict && void importAsCopy(importConflict)}>
              <Copy className="size-4" aria-hidden /> Import as copy
            </Button>
            <Button variant="ghost" className="min-h-11 text-muted-foreground" onClick={() => setImportConflict(null)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* v1.0.4 §14 — import rejected: readable validation errors */}
      <Dialog open={importErrors !== null} onOpenChange={(open) => !open && setImportErrors(null)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300">Import rejected</DialogTitle>
            <DialogDescription>The file was not registered. Fix the issues below and try again.</DialogDescription>
          </DialogHeader>
          {importErrors ? (
            <div className="nextool-scroll max-h-[50vh] space-y-3 overflow-y-auto pr-1">
              <ul className="space-y-1.5">
                {importErrors.errors.map((err) => (
                  <li key={err} role="alert" className="break-words rounded-md border border-rose-400/30 bg-rose-400/5 px-2.5 py-1.5 font-mono text-[11px] text-rose-300">{err}</li>
                ))}
              </ul>
              {importErrors.warnings.length > 0 ? (
                <ul className="space-y-1">
                  {importErrors.warnings.map((w) => (
                    <li key={w} className="break-words text-[11px] text-amber-200/90">⚠ {w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setImportErrors(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
