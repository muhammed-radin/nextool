'use client';

/**
 * NexTool v1.0.2 — Tool IDE (spec §13-31).
 *
 * Developer-grade editor for js-function tools:
 *  - Monaco Editor (JS) with schema-driven IntelliSense (params.<name>),
 *    runtime reference IntelliSense, error markers, minimap, find/replace.
 *  - Structured layout: header (name · save · test · actions) + left column
 *    (Settings / Schema / References / Metadata) + right column (Monaco).
 *    Mobile: tabbed Details / Schema / Function / References / Test (§80).
 *  - Save validates schema + syntax server-side and updates the REAL registry.
 *  - Test executes the actual function in the controlled sandbox and shows
 *    status, duration, result (JSON tree), error and logs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { JsonTree } from '../json-tree';
import {
  ApiClientError, deleteTool, registerJsTool, testTool, updateTool,
} from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import type { ToolParamDef, ToolSchema } from '@/lib/nexool/types';
import { buildToolExtraLib, getReferenceEntries } from '@/lib/nexool/tool-runtime-declarations';
import { ErrorCard, SectionTitle, TechLabel, fmtMs, statusTone } from '../ui-bits';
import {
  AlertTriangle, Braces, Copy, FileCode2, Loader2, Play, Save, Trash2, Wrench,
} from 'lucide-react';

// Monaco is client-only + heavy — load it lazily with a glass skeleton.
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-[260px] w-full rounded-md" />,
});
import type { Monaco, BeforeMount, OnMount } from '@monaco-editor/react';

const DEFAULT_SOURCE = `async function execute(params, context) {
  context.log('tool invoked', params);

  // Tool implementation — sandbox exposes only documented runtime references.
  // ES builtins (JSON, Math, Date, Array...) are available.

  return {
    success: true,
    result: { echoed: params },
  };
}
`;

interface ToolTestState {
  running: boolean;
  status?: string;
  durationMs?: number;
  result?: unknown;
  error?: { code: string; message: string } | null;
  logs?: string[];
  paramsEcho?: Record<string, unknown>;
}

interface ToolEditorProps {
  /** Existing tool name when editing; null for a new tool. */
  toolName: string | null;
  /** Full registry entry (loaded by the parent before opening the editor). */
  initial: ToolEntry | null;
  onSaved: (tool: ToolEntry) => void;
  onDeleted: (name: string) => void;
  onClose: () => void;
}

export default function ToolEditorView({ toolName, initial, onSaved, onDeleted, onClose }: ToolEditorProps) {
  const isNew = toolName === null;

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'utility');
  const [toolVersion, setToolVersion] = useState(initial?.toolVersion ?? '1.0.0');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [source, setSource] = useState(initial?.functionSource ?? DEFAULT_SOURCE);
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(schemaToEditable(initial?.schema) ?? emptySchema(), null, 2));
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [test, setTest] = useState<ToolTestState | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const monacoInstanceRef = useRef<Monaco | null>(null);

  const parsedSchema = useMemo<ToolSchema | null>(() => parseSchemaText(schemaText).schema, [schemaText]);

  const markDirty = () => setDirty(true);

  // ---- schema parsing / validation (v1.0.2 §23/§24) ----

  useEffect(() => {
    const parsed = parseSchemaText(schemaText);
    setSchemaError(parsed.error);
  }, [schemaText]);

  const save = async () => {
    if (!/^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$/.test(name.trim())) {
      toast.error('Invalid tool name', { description: 'Use namespace.action, e.g. utility.summarize' });
      return;
    }
    const parsed = parseSchemaText(schemaText);
    if (parsed.error || !parsed.schema) {
      toast.error('Schema is invalid', { description: parsed.error ?? 'Fix the schema before saving.' });
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const entry = await registerJsTool({
          name: name.trim(),
          description: description.trim() || undefined,
          purpose: purpose.trim() || undefined,
          category: category.trim() || 'utility',
          toolVersion: toolVersion.trim() || undefined,
          schema: parsed.schema,
          functionSource: source,
          enabled,
        });
        toast.success('Tool registered', { description: `${entry.name} is now available to the CoreModule.` });
        setDirty(false);
        onSaved(entry);
      } else if (toolName) {
        const entry = await updateTool(toolName, {
          renameTo: name.trim() !== toolName ? name.trim() : undefined,
          description: description.trim() || undefined,
          purpose: purpose.trim() || undefined,
          category: category.trim() || 'utility',
          toolVersion: toolVersion.trim() || undefined,
          schema: parsed.schema,
          functionSource: source,
          enabled,
        });
        toast.success('Tool updated', { description: `${entry.name} saved to the registry.` });
        setDirty(false);
        onSaved(entry);
      }
    } catch (e) {
      toast.error(isNew ? 'Registration rejected' : 'Save failed', {
        description: e instanceof ApiClientError ? e.message : 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(testParams || '{}');
    } catch {
      toast.error('Test params must be valid JSON');
      return;
    }
    setTest({ running: true });
    try {
      // Unsaved changes are tested against the CURRENT editor source (§27/§29:
      // a real sandboxed execution — never a mock result).
      const result = await testTool({ functionSource: source, params });
      setTest({
        running: false,
        status: result.status,
        durationMs: result.durationMs,
        result: result.result,
        error: result.error,
        logs: result.logs,
        paramsEcho: params,
      });
    } catch (e) {
      setTest({ running: false, status: 'failed', error: { code: 'REQUEST_FAILED', message: e instanceof ApiClientError ? e.message : 'Test request failed' } });
    }
  };

  const doDelete = async () => {
    if (!toolName) return;
    try {
      await deleteTool(toolName);
      toast.success('Tool deleted', { description: `${toolName} removed from the registry.` });
      onDeleted(toolName);
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setDeleteOpen(false);
    }
  };

  const duplicateTool = async () => {
    const base = name.trim().replace(/^([a-z0-9-]+)\..*$/, '$1') || 'custom';
    setName(`${base}.copy`);
    setDirty(true);
    toast.info('Renamed for duplicate', { description: 'Adjust the name, then Save to register the copy.' });
  };

  // ---- Monaco setup (schema-driven IntelliSense, §18-21) ----

  const extraLib = useMemo(() => buildToolExtraLib(parsedSchema), [parsedSchema]);

  const onEditorMount = useCallback<BeforeMount>((monaco: Monaco) => {
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      checkJs: false,
      lib: ['es2020'],
    });
    monaco.languages.typescript.javascriptDefaults.addExtraLib(extraLib, 'nextool-runtime.d.ts');

    // NexTool dark-glass editor theme (consistent with the visual system §18).
    monaco.editor.defineTheme('nextool-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
        { token: 'keyword', foreground: '7dd3fc' },
        { token: 'string', foreground: '86efac' },
        { token: 'number', foreground: 'fbbf24' },
        { token: 'type', foreground: '67e8f9' },
        { token: 'delimiter', foreground: '94a3b8' },
      ],
      colors: {
        'editor.background': '#0a1120',
        'editorGutter.background': '#0a1120',
        'editor.lineHighlightBackground': '#13203655',
        'editorLineNumber.foreground': '#3b4a63',
        'editorLineNumber.activeForeground': '#7dd3fc',
        'editorCursor.foreground': '#38bdf8',
        'editorIndentGuide.background1': '#1c2942',
        'editorWidget.background': '#0d1526',
        'editorSuggestWidget.background': '#0d1526',
        'editorSuggestWidget.selectedBackground': '#16233d',
        'scrollbarSlider.background': '#24355266',
      },
    });
    monaco.editor.setTheme('nextool-dark');
  }, [extraLib]);

  const onRuntimeMount = useCallback<OnMount>((_editor, monaco: Monaco) => {
    monacoInstanceRef.current = monaco;
    monaco.languages.typescript.javascriptDefaults.addExtraLib(extraLib, 'nextool-runtime.d.ts');
  }, [extraLib]);

  // Re-apply extraLib when the schema changes (schema-driven IntelliSense §20).
  useEffect(() => {
    const monaco = monacoInstanceRef.current;
    if (!monaco?.languages?.typescript?.javascriptDefaults) return;
    monaco.languages.typescript.javascriptDefaults.addExtraLib(extraLib, 'nextool-runtime.d.ts');
  }, [extraLib]);

  const references = useMemo(() => getReferenceEntries(parsedSchema), [parsedSchema]);

  const inputCls = 'min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm';

  // ---- layout: header + (desktop split | mobile tabs) ----

  const settingsPanel = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="tool-name">Tool name <span className="text-muted-foreground">(namespace.action)</span> <span className="text-rose-400">*</span></Label>
        <Input id="tool-name" value={name} onChange={(e) => { setName(e.target.value); markDirty(); }} placeholder="utility.summarize" className={inputCls} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tool-desc">Description</Label>
        <Input id="tool-desc" value={description} onChange={(e) => { setDescription(e.target.value); markDirty(); }} className={inputCls} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tool-purpose">Purpose <span className="text-muted-foreground">(guides CoreModule matching)</span></Label>
        <Input id="tool-purpose" value={purpose} onChange={(e) => { setPurpose(e.target.value); markDirty(); }} className={inputCls} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="tool-cat">Category</Label>
          <Input id="tool-cat" value={category} onChange={(e) => { setCategory(e.target.value); markDirty(); }} className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tool-ver">Version</Label>
          <Input id="tool-ver" value={toolVersion} onChange={(e) => { setToolVersion(e.target.value); markDirty(); }} className={inputCls} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
        <div className="min-w-0">
          <Label htmlFor="tool-enabled" className="text-sm">Enabled</Label>
          <p className="text-[11px] text-muted-foreground">Disabled tools are hidden from the CoreModule</p>
        </div>
        <Switch id="tool-enabled" checked={enabled} onCheckedChange={(v) => { setEnabled(v); markDirty(); }} aria-label="Tool enabled" />
      </div>
      {!isNew && toolName ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          registered as <span className="text-sky-300">{toolName}</span> · {initial?.stats.callCount ?? 0} calls
        </p>
      ) : null}
    </div>
  );

  const schemaPanel = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="tool-schema">Input schema (ToolParamDef[] JSON)</Label>
        {schemaError === null ? (
          <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">valid</Badge>
        ) : (
          <Badge variant="outline" className="border-rose-400/40 bg-rose-400/10 font-mono text-[10px] text-rose-300">invalid</Badge>
        )}
      </div>
      <Textarea
        id="tool-schema"
        value={schemaText}
        onChange={(e) => { setSchemaText(e.target.value); markDirty(); }}
        rows={10}
        className={cn('border-white/[0.09] bg-white/[0.04] font-mono text-xs', schemaError && 'border-rose-400/40')}
        aria-invalid={!!schemaError}
      />
      {schemaError ? (
        <p role="alert" className="rounded-md border border-rose-400/30 bg-rose-400/5 px-2.5 py-1.5 font-mono text-[11px] text-rose-300">
          {schemaError}
        </p>
      ) : (
        <SchemaTable schema={parsedSchema} />
      )}
      <p className="text-[11px] text-muted-foreground">
        Schema drives CoreModule parameter generation AND the editor&apos;s IntelliSense.
      </p>
    </div>
  );

  const referencesPanel = (
    <div className="space-y-2">
      <TechLabel>runtime references — the real sandbox API</TechLabel>
      <div className="space-y-1.5">
        {references.map((r) => (
          <div key={r.name} className="glass-card rounded-md px-3 py-2">
            <p className="break-words font-mono text-xs text-sky-200">{r.name} <span className="text-cyan-300/70">: {r.type}</span></p>
            <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{r.description}</p>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The sandbox exposes ONLY these references — no require/process/fetch/timers.
        See docs/tool-development.md for the full guide.
      </p>
    </div>
  );

  const metadataPanel = (
    <div className="space-y-2 text-[11px] text-muted-foreground">
      <TechLabel>metadata</TechLabel>
      <p>environment: <span className="font-mono text-foreground/90">js-function</span></p>
      <p>execution: sandboxed node:vm · sync 4s cap · async 10s cap · result ≤ 64 KiB</p>
      <p>production runs record stats to the registry; test runs do not.</p>
      {!isNew && initial ? (
        <p className="break-words">stats: {initial.stats.callCount} calls · {initial.stats.successCount} ok · {initial.stats.failureCount + initial.stats.timeoutCount} fail · avg {fmtMs(initial.stats.avgMs)}</p>
      ) : null}
    </div>
  );

  const testPanel = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="test-params">Input parameters (JSON)</Label>
        <Textarea id="test-params" value={testParams} onChange={(e) => setTestParams(e.target.value)} rows={5} className="border-white/[0.09] bg-white/[0.04] font-mono text-xs" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-11 flex-1 gap-2 bg-primary-gradient text-primary-foreground hover:opacity-90 sm:flex-none" onClick={() => void runTest()} disabled={test?.running}>
          {test?.running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />} Test Tool
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Runs the current editor source in the sandbox with <span className="font-mono text-foreground/80">mode:&quot;test&quot;</span>.
        </p>
      </div>

      {test && !test.running ? (
        <div className="space-y-2" data-testid="tool-test-result">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={cn('font-mono text-[11px]', statusTone(test.status) === 'ok' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : statusTone(test.status) === 'err' ? 'border-rose-400/30 bg-rose-400/10 text-rose-300' : 'border-white/[0.09] text-muted-foreground')}>
              {test.status}
            </Badge>
            {test.durationMs !== undefined ? <span className="font-mono text-xs text-muted-foreground">{fmtMs(test.durationMs)}</span> : null}
            <span className="font-mono text-[10px] text-slate-500">mode: test (no production side effects from sandbox tools)</span>
          </div>
          {test.error ? (
            <p role="alert" className="break-words rounded-md border border-rose-400/30 bg-rose-400/5 px-3 py-2 font-mono text-xs text-rose-300">
              {test.error.code}: {test.error.message}
            </p>
          ) : null}
          {test.logs && test.logs.length > 0 ? (
            <div className="glass-inset nextool-scroll max-h-32 overflow-y-auto rounded-md p-2.5">
              {test.logs.map((line, i) => (
                <p key={i} className="break-words font-mono text-[11px] leading-relaxed text-sky-100/70">{line}</p>
              ))}
            </div>
          ) : null}
          <div>
            <p className="mb-1"><TechLabel className="text-[9px]">result</TechLabel></p>
            <JsonTree value={test.result ?? null} maxHeight={280} />
          </div>
        </div>
      ) : null}
    </div>
  );

  const editorPanel = (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-md border border-white/[0.09] lg:h-[560px]" data-testid="monaco-editor">
      <MonacoEditor
        height="100%"
        defaultLanguage="javascript"
        language="javascript"
        value={source}
        theme="nextool-dark"
        onChange={(v) => { setSource(v ?? ''); markDirty(); }}
        beforeMount={onEditorMount}
        onMount={onRuntimeMount}
        options={{
          minimap: { enabled: true, scale: 1 },
          fontSize: 13,
          lineNumbers: 'on',
          folding: true,
          formatOnPaste: true,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: 'on',
          renderWhitespace: 'selection',
        }}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Header — name / save / test / actions (§15) */}
      <div className="glass-panel flex flex-col gap-3 rounded-lg p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-primary-gradient-soft glow-blue flex size-10 shrink-0 items-center justify-center rounded-lg ring-1 ring-sky-400/25">
            <Wrench className="size-5 text-sky-300" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {isNew ? 'New Tool' : `Edit ${toolName}`}
            </h2>
            <p className="text-xs text-muted-foreground">Tool IDE — sandboxed JavaScript function editor</p>
          </div>
          {dirty ? (
            <Badge variant="outline" className="ml-1 shrink-0 border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-300">unsaved</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isNew ? (
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" onClick={duplicateTool}>
              <Copy className="size-3.5" aria-hidden /> Duplicate
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" onClick={() => void runTest()} disabled={test?.running}>
            {test?.running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />} Test
          </Button>
          {!isNew ? (
            <Button variant="outline" size="sm" className="min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" aria-hidden /> Delete
            </Button>
          ) : null}
          <Button size="sm" className="min-h-9 gap-1.5 bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => void save()} disabled={saving || (schemaError !== null)}>
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} Save
          </Button>
          <Button variant="ghost" size="sm" className="min-h-9 text-muted-foreground" onClick={onClose}>Close</Button>
        </div>
      </div>

      {/* Mobile: stacked tabs (§80) */}
      <div className="lg:hidden">
        <Tabs defaultValue="function" className="gap-3">
          <TabsList className="glass-card nextool-scroll h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1" aria-label="Tool editor sections">
            {([
              ['details', 'Details'],
              ['schema', 'Schema'],
              ['function', 'Function'],
              ['references', 'References'],
              ['test', 'Test'],
            ] as const).map(([v, label]) => (
              <TabsTrigger key={v} value={v} className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="details" className="mt-3 space-y-4 outline-none">
            <section className="glass-panel rounded-lg p-4">{settingsPanel}</section>
            <section className="glass-panel rounded-lg p-4">{metadataPanel}</section>
          </TabsContent>
          <TabsContent value="schema" className="mt-3 outline-none">
            <section className="glass-panel rounded-lg p-4">{schemaPanel}</section>
          </TabsContent>
          <TabsContent value="function" className="mt-3 outline-none">
            {editorPanel}
          </TabsContent>
          <TabsContent value="references" className="mt-3 outline-none">
            <section className="glass-panel rounded-lg p-4">{referencesPanel}</section>
          </TabsContent>
          <TabsContent value="test" className="mt-3 outline-none">
            <section className="glass-panel rounded-lg p-4">{testPanel}</section>
          </TabsContent>
        </Tabs>
      </div>

      {/* Desktop split layout (§15) */}
      <div className="hidden gap-4 lg:grid lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="glass-panel rounded-lg p-4">{settingsPanel}</section>
          <section className="glass-panel rounded-lg p-4">{schemaPanel}</section>
          <section className="glass-panel rounded-lg p-4">{metadataPanel}</section>
          <section className="glass-panel rounded-lg p-4">{referencesPanel}</section>
        </div>
        <div className="space-y-4">
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle icon={<FileCode2 className="size-4 text-sky-300" aria-hidden />} title="Function" desc="async function execute(params, context) — IntelliSense comes from your schema." />
            <div className="mt-3">{editorPanel}</div>
          </section>
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle icon={<Braces className="size-4 text-sky-300" aria-hidden />} title="Test Tool" desc="Real sandboxed execution of the current source." />
            <div className="mt-3">{testPanel}</div>
          </section>
        </div>
      </div>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><AlertTriangle className="size-4" aria-hidden /> Delete {toolName}?</DialogTitle>
            <DialogDescription>
              The tool is removed from the registry and stops being available to the CoreModule. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" className="min-h-11" onClick={() => void doDelete()}>Delete tool</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------- helpers ----------

function emptySchema(): ToolSchema {
  return { type: 'object', properties: [] };
}

function schemaToEditable(schema: ToolSchema | undefined): ToolSchema | null {
  if (!schema) return null;
  return { type: 'object', properties: schema.properties ?? [] };
}

function parseSchemaText(text: string): { schema: ToolSchema | null; error: string | null } {
  if (!text.trim()) return { schema: emptySchema(), error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { schema: null, error: `Invalid JSON — ${err instanceof Error ? err.message : 'parse error'}` };
  }
  const body = Array.isArray(parsed) ? { type: 'object', properties: parsed } : parsed;
  const obj = body as { type?: string; properties?: unknown };
  if (obj.type !== 'object') return { schema: null, error: 'schema.type must be "object".' };
  if (!Array.isArray(obj.properties)) return { schema: null, error: 'schema.properties must be an array of param definitions.' };
  const props: ToolParamDef[] = [];
  for (const raw of obj.properties) {
    const p = raw as Partial<ToolParamDef> & Record<string, unknown>;
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return { schema: null, error: 'Every param needs a "name".' };
    if (!['string', 'number', 'boolean', 'object', 'array'].includes(String(p.type))) {
      return { schema: null, error: `Param ${p.name}: unsupported type "${String(p.type)}" (string|number|boolean|object|array).` };
    }
    if (p.enumValues && !Array.isArray(p.enumValues)) return { schema: null, error: `Param ${p.name}: enumValues must be an array.` };
    props.push({
      name: p.name.trim(),
      type: p.type as ToolParamDef['type'],
      required: !!p.required,
      description: typeof p.description === 'string' ? p.description : '',
      generation: p.generation as ToolParamDef['generation'],
      enumValues: p.enumValues as string[] | undefined,
      min: typeof p.min === 'number' ? p.min : undefined,
      max: typeof p.max === 'number' ? p.max : undefined,
      default: p.default,
    });
  }
  return { schema: { type: 'object', properties: props }, error: null };
}

function SchemaTable({ schema }: { schema: ToolSchema | null }) {
  const props = schema?.properties ?? [];
  if (props.length === 0) return <p className="text-[11px] text-muted-foreground">No parameters defined.</p>;
  return (
    <div className="nextool-scroll overflow-x-auto rounded-md border border-white/[0.07]">
      <table className="w-full min-w-[280px] text-left text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">name</th>
            <th className="px-2 py-1.5 font-medium">type</th>
            <th className="px-2 py-1.5 font-medium">req</th>
            <th className="px-2 py-1.5 font-medium">notes</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {props.map((p) => (
            <tr key={p.name} className="border-t border-white/[0.06] align-top">
              <td className="px-2 py-1.5 text-foreground/90">{p.name}</td>
              <td className="px-2 py-1.5 text-cyan-300/90">{p.type}</td>
              <td className="px-2 py-1.5">{p.required ? <span className="text-rose-400">*</span> : '—'}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{p.enumValues?.length ? `enum: ${p.enumValues.join(' | ')}` : p.description || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
