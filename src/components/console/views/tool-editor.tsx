'use client';

/**
 * NexTool v1.0.2 — Tool IDE (spec §13-31) · v1.0.4 sync rework · v1.0.5 spec §1-4.
 *
 * Developer-grade editor for user-authorable tools. v1.0.5 changes:
 *
 * §1  TOOL SOURCE RELIABILITY — `source` state is the SINGLE source of truth
 *     shared by the stored definition, the editor surface and the test request:
 *
 *       Stored functionSource ↕ Tool Editor state (source) ↕ Monaco/textarea ↕ Test request
 *
 *     - Every editor write goes through coerceEditorChange(): a non-string
 *       onChange payload (model swap/remount) can NEVER clear the source.
 *     - Code is read for tests/saves straight from the visible surface
 *       (readMonacoValue guards against a disposed editor after tab switches).
 *     - Test completion NEVER writes back into the editor: before == after.
 *     - Unsaved code survives testing (test executes exactly what is on screen).
 *     - Switching tools remounts this view (parent key) so state re-initializes
 *       from the freshly loaded definition (existing session design, §1.5).
 *
 * §2  STRUCTURED METADATA EDITOR — sections instead of raw JSON:
 *     General · Execution Environment · Metadata · Schema (+ Function/Handler,
 *     References, Testing). Dynamic tools get a real handler-kind selector fed
 *     by the RUNTIME registry (GET /api/tools/environments) and structured
 *     handler-config inputs; custom metadata is structured key/value rows.
 *
 * §3  NODEJS ENVIRONMENT — authorable in the same IDE: Node.js reference panel
 *     (allowlisted modules/blocked modules/globals/limits — all from the live
 *     runtime config) and allowlist-aware IntelliSense.
 *
 * §4  MONACO ⇄ TEXTAREA TOGGLE — "Use Monaco Editor" (default ON). Both
 *     surfaces share `source`; switching editors preserves the code exactly
 *     and Test behaves identically in either mode.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import dynamic from 'next/dynamic';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { JsonTree } from '../json-tree';
import {
  ApiClientError, deleteTool, getToolEnvironmentInfo, registerJsTool, registerTool, testTool, updateTool,
  type HandlerKindDescriptor, type ToolEnvironmentInfo,
} from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import type { ToolParamDef, ToolSchema } from '@/lib/nexool/types';
import { buildNodeExtraLib, buildToolExtraLib, getNodeReferenceEntries, getReferenceEntries } from '@/lib/nexool/tool-runtime-declarations';
import { coerceEditorChange, readMonacoValue } from '@/lib/nexool/editor-source';
import { ErrorCard, SectionTitle, TechLabel, fmtMs, statusTone } from '../ui-bits';
import {
  AlertTriangle, Braces, Copy, FileCode2, Loader2, Play, Plus, Save, ShieldAlert, Trash2, Wrench, X,
} from 'lucide-react';

// Monaco is client-only + heavy — load it lazily with a glass skeleton.
const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <Skeleton className="h-full min-h-[260px] w-full rounded-md" />,
});
import type { Monaco, BeforeMount, OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

const DEFAULT_SOURCE = `async function execute(params, context) {
  context.log('tool invoked', params);

  // Tool implementation — the sandbox exposes only the documented references.
  // nodejs tools may additionally require()/import() allowlisted modules.

  return {
    success: true,
    result: { echoed: params },
  };
}
`;

const NODEJS_DEFAULT_SOURCE = `async function execute(params, context) {
  context.log('nodejs tool invoked', params);

  // Restricted Node.js environment — require()/import() work for the
  // ALLOWLISTED modules only (see the References panel). No process/fs/net.

  const crypto = require('crypto');

  return {
    success: true,
    result: { id: crypto.randomUUID(), echoed: params },
  };
}
`;

type AuthorableEnv = 'js-function' | 'nodejs' | 'dynamic';

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
  // v1.0.4 §5: the session's target tool name. `null` ⇒ register-a-new-tool
  // session (also used by Duplicate so Save REGISTERS A COPY).
  const [sessionToolName, setSessionToolName] = useState<string | null>(toolName);
  const isNew = sessionToolName === null;

  // ---- §2.2 General metadata (structured inputs, never raw JSON) ----
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [category, setCategory] = useState(initial?.category ?? 'utility');
  const [toolVersion, setToolVersion] = useState(initial?.toolVersion ?? '1.0.0');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  // ---- §2.3/§3 Execution environment ----
  // The stored environment drives the initial value; builtin/virtual-env tools
  // never reach this editor (read-only), so the fallback is the authorable default.
  const [environment, setEnvironment] = useState<AuthorableEnv>(() => {
    const env = initial?.environment;
    return env === 'nodejs' || env === 'dynamic' ? env : 'js-function';
  });
  /** dynamic tools can only ever be dynamic (handler-based storage). */
  const envLockedDynamic = initial?.environment === 'dynamic';

  // ---- §2.5/§2.6 handler (dynamic tools) ----
  const [handlerKind, setHandlerKind] = useState<string>(initial?.handlerKind ?? 'echo');
  const [handlerConfig, setHandlerConfig] = useState<Record<string, unknown>>(initial?.handlerConfig ?? {});

  // ---- §2.7 custom metadata (structured key/value rows) ----
  const [metadataRows, setMetadataRows] = useState<[string, string][]>(() =>
    Object.entries(initial?.metadata ?? {}).map(([k, v]) => [k, v]),
  );

  // ---- v1.0.4 §4/§6 + v1.0.5 §1.1 — SINGLE source of truth for function code.
  // Initialized from the STORED tool definition; a duplicate session starts
  // with the EXACT function code of the original.
  const [source, setSource] = useState(initial?.functionSource ?? DEFAULT_SOURCE);
  const [schemaText, setSchemaText] = useState(() => JSON.stringify(schemaToEditable(initial?.schema) ?? emptySchema(), null, 2));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [schemaView, setSchemaView] = useState<'structured' | 'json'>('structured');
  const [schemaRows, setSchemaRows] = useState<ToolParamDef[]>([]);

  // ---- §4 Monaco ⇄ textarea toggle (default ON, §4) ----
  const [useMonaco, setUseMonaco] = useState(true);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [test, setTest] = useState<ToolTestState | null>(null);
  const [testParams, setTestParams] = useState('{}');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const monacoInstanceRef = useRef<Monaco | null>(null);
  // v1.0.4 §8 — live Monaco editor instance; cleared on unmount by the
  // MonacoSurface wrapper so a disposed editor is never read (§1 fix).
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // ---- §2.5/§3.6 live runtime environment configuration ----
  const [envInfo, setEnvInfo] = useState<ToolEnvironmentInfo | null>(null);
  const [envInfoError, setEnvInfoError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getToolEnvironmentInfo()
      .then((d) => { if (alive) { setEnvInfo(d); setEnvInfoError(null); } })
      .catch((e) => { if (alive) setEnvInfoError(e instanceof ApiClientError ? e.message : 'Environment config unavailable'); });
    return () => { alive = false; };
  }, []);

  const parsedSchema = useMemo<ToolSchema | null>(() => parseSchemaText(schemaText).schema, [schemaText]);

  const markDirty = () => setDirty(true);

  // ---- schema parsing / validation (v1.0.2 §23/§24) ----
  useEffect(() => {
    const parsed = parseSchemaText(schemaText);
    setSchemaError(parsed.error);
  }, [schemaText]);

  /**
   * §1.2 — read the function code EXACTLY as visible on screen. The Monaco
   * model is the screen truth while Monaco is mounted; `source` (kept in sync
   * through guarded onChange writes) is the fallback for the textarea surface
   * and for a disposed editor (mobile tab switch). Never returns undefined.
   */
  const currentCode = (): string => {
    const code = readMonacoValue(
      () => (useMonaco ? editorRef.current?.getValue() : undefined),
      source,
    );
    if (code !== source) setSource(code);
    return code;
  };

  /**
   * §2.8 — collect metadata rows into the record sent to the registry.
   * Blank rows are dropped; duplicate keys are rejected with a readable error.
   */
  const collectMetadata = (): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (const [k, v] of metadataRows) {
      const key = k.trim();
      if (!key && !v.trim()) continue; // fully blank row — ignore
      if (!key) {
        toast.error('Metadata needs a key', { description: 'Every metadata row needs a non-empty key.' });
        return null;
      }
      if (key in out) {
        toast.error('Duplicate metadata key', { description: `"${key}" appears more than once — merge the rows.` });
        return null;
      }
      out[key] = v;
    }
    return out;
  };

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
    const metadata = collectMetadata();
    if (metadata === null) return;

    let code = '';
    if (environment !== 'dynamic') {
      code = currentCode();
      if (!code.trim()) {
        toast.error('Function source is empty', { description: 'Write an execute(params, context) function before saving.' });
        return;
      }
    } else {
      // §2.6 — validate required handler config fields for the selected kind.
      const kind = envInfo?.handlerKinds.find((k) => k.kind === handlerKind);
      for (const field of kind?.configFields ?? []) {
        if (field.required && !String(handlerConfig[field.key] ?? '').trim()) {
          toast.error(`${kind?.label ?? handlerKind} needs "${field.label}"`, { description: field.description });
          return;
        }
      }
    }

    setSaving(true);
    try {
      let entry: ToolEntry;
      if (environment === 'dynamic') {
        const definition = {
          name: name.trim(),
          description: description.trim() || 'User-registered dynamic tool.',
          purpose: purpose.trim() || undefined,
          category: category.trim() || 'general',
          environment: 'dynamic' as const,
          schema: parsed.schema,
          toolVersion: toolVersion.trim() || undefined,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
        if (isNew) {
          entry = await registerTool({ definition, handlerKind: handlerKind as 'echo' | 'delay' | 'http_get' | 'uuid', handlerConfig });
        } else {
          entry = await updateTool(sessionToolName!, {
            renameTo: name.trim() !== sessionToolName ? name.trim() : undefined,
            description: definition.description,
            purpose: definition.purpose,
            category: definition.category,
            toolVersion: definition.toolVersion,
            schema: parsed.schema,
            metadata,
            handlerKind,
            handlerConfig,
            enabled,
          });
        }
      } else if (isNew) {
        entry = await registerJsTool({
          name: name.trim(),
          description: description.trim() || undefined,
          purpose: purpose.trim() || undefined,
          category: category.trim() || 'utility',
          toolVersion: toolVersion.trim() || undefined,
          environment,
          schema: parsed.schema,
          functionSource: code,
          metadata,
          enabled,
        });
      } else {
        entry = await updateTool(sessionToolName!, {
          renameTo: name.trim() !== sessionToolName ? name.trim() : undefined,
          description: description.trim() || undefined,
          purpose: purpose.trim() || undefined,
          category: category.trim() || 'utility',
          toolVersion: toolVersion.trim() || undefined,
          environment,
          schema: parsed.schema,
          functionSource: code,
          metadata,
          enabled,
        });
      }
      toast.success(isNew ? 'Tool registered' : 'Tool updated', {
        description: `${entry.name} (${entry.environment}) is now ${isNew ? 'available to the CoreModule' : 'saved in the registry'}.`,
      });
      setDirty(false);
      onSaved(entry);
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

    // Dynamic sessions: test the REGISTERED handler by name (a real execution).
    if (environment === 'dynamic') {
      if (isNew) {
        toast.info('Save the tool first', { description: 'Dynamic handler tools are tested through the registry — save, then test.' });
        return;
      }
      setTest({ running: true });
      try {
        const result = await testTool({ name: sessionToolName!, params });
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
      return;
    }

    // §1.2/§1.3 — execute EXACTLY what is on screen (saved or unsaved) and
    // NEVER write back into the editor: before == after, success or failure.
    const code = currentCode();
    if (!code.trim()) {
      toast.error('Function source is empty', { description: 'Write an execute(params, context) function before testing.' });
      return;
    }
    setTest({ running: true });
    try {
      const result = await testTool({
        functionSource: code,
        environment: environment === 'nodejs' ? 'nodejs' : undefined,
        params,
      });
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
    // No setSource() anywhere in this flow — §1.4.
  };

  const doDelete = async () => {
    if (!sessionToolName) return;
    try {
      await deleteTool(sessionToolName);
      toast.success('Tool deleted', { description: `${sessionToolName} removed from the registry.` });
      onDeleted(sessionToolName);
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setDeleteOpen(false);
    }
  };

  /**
   * v1.0.4 §5 + v1.0.5 §2.8 — Duplicate switches this session into "register a
   * copy" mode. The copy keeps the EXACT function code, schema, handler and
   * metadata currently loaded from the original; only the name changes.
   */
  const duplicateTool = () => {
    if (isNew) return;
    const base = name.trim().replace(/^([a-z0-9-]+)\..*$/, '$1') || 'custom';
    setSessionToolName(null);
    setName(`${base}.copy`);
    setDirty(true);
    const parsed = parseSchemaText(schemaText);
    setSchemaError(parsed.error);
    toast.info('Duplicated — adjust the name', { description: 'The copy carries the original function code, handler and metadata. Save to register it.' });
  };

  /** §4.3 — never clear the code while switching editor types. */
  const toggleMonacoEditor = (next: boolean) => {
    if (next === useMonaco) return;
    if (!next) setSource(currentCode()); // Monaco → textarea: capture exact code
    setUseMonaco(next);                  // textarea → Monaco: source already current
  };

  // ---- Monaco setup (schema-driven IntelliSense §18-21, nodejs §3.7) ----

  const extraLib = useMemo(
    () => environment === 'nodejs'
      ? buildNodeExtraLib(parsedSchema, envInfo?.node)
      : buildToolExtraLib(parsedSchema),
    [parsedSchema, environment, envInfo],
  );

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

  const onRuntimeMount = useCallback<OnMount>((ed, monaco: Monaco) => {
    monacoInstanceRef.current = monaco;
    editorRef.current = ed;
    monaco.languages.typescript.javascriptDefaults.addExtraLib(extraLib, 'nextool-runtime.d.ts');
  }, [extraLib]);

  // Stable across renders — the unmount cleanup runs exactly once per mount.
  const handleMonacoDispose = useCallback(() => { editorRef.current = null; }, []);

  // Re-apply extraLib when the schema or environment changes.
  useEffect(() => {
    const monaco = monacoInstanceRef.current;
    if (!monaco?.languages?.typescript?.javascriptDefaults) return;
    monaco.languages.typescript.javascriptDefaults.addExtraLib(extraLib, 'nextool-runtime.d.ts');
  }, [extraLib]);

  const references = useMemo(
    () => environment === 'nodejs'
      ? getNodeReferenceEntries(parsedSchema)
      : getReferenceEntries(parsedSchema),
    [parsedSchema, environment],
  );

  const inputCls = 'min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm';

  // ---- §2.1 editor sections ----

  const generalPanel = (
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
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
      {!isNew && sessionToolName ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          registered as <span className="text-sky-300">{sessionToolName}</span> · {initial?.stats.callCount ?? 0} calls
        </p>
      ) : null}
    </div>
  );

  const envDescriptor = envInfo?.environments.find((e) => e.id === environment);

  const environmentPanel = (
    <div className="space-y-2">
      <Label htmlFor="tool-env">Execution environment</Label>
      <Select
        value={environment}
        onValueChange={(v) => {
          const next = v as AuthorableEnv;
          if (next === environment) return;
          if (next === 'nodejs' && source.trim() === DEFAULT_SOURCE.trim()) {
            // Convenience: seed the Node.js starter so require() is discoverable.
            setSource(NODEJS_DEFAULT_SOURCE);
          }
          setEnvironment(next);
          markDirty();
        }}
        disabled={envLockedDynamic}
      >
        <SelectTrigger id="tool-env" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] text-sm">
          <SelectValue placeholder="Select environment" />
        </SelectTrigger>
        <SelectContent className="glass-strong">
          {(envInfo?.environments ?? []).filter((e) => e.authorable).map((e) => (
            <SelectItem key={e.id} value={e.id} className="text-sm">
              <span className="font-mono">{e.id}</span> — {e.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {envLockedDynamic ? (
        <p className="text-[11px] text-muted-foreground">Handler-based tools stay dynamic — duplicate into a function tool to change environment.</p>
      ) : null}
      {envDescriptor ? (
        <p className="text-[11px] text-muted-foreground">{envDescriptor.description}</p>
      ) : envInfoError ? (
        <p role="alert" className="text-[11px] text-amber-300">{envInfoError} — falling back to the standard environments.</p>
      ) : null}
      {environment === 'js-function' ? (
        <p className="font-mono text-[10px] text-slate-500">sandbox: node:vm · no require/import/process/timers · result ≤ 64 KiB</p>
      ) : null}
      {environment === 'nodejs' ? (
        <p className="font-mono text-[10px] text-slate-500">sandbox: node:vm + module allowlist · require()/import() restricted · {envInfo ? `${Object.keys(envInfo.node.modules).length} modules allowed` : 'loading allowlist…'}</p>
      ) : null}
    </div>
  );

  /** §2.5/§2.6 — handler kind + structured config (dynamic tools only). */
  const activeHandlerKind: HandlerKindDescriptor | undefined = envInfo?.handlerKinds.find((k) => k.kind === handlerKind);

  const handlerPanel = (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="tool-handler-kind">Handler kind</Label>
        <Select value={handlerKind} onValueChange={(v) => { setHandlerKind(v); markDirty(); }}>
          <SelectTrigger id="tool-handler-kind" className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] text-sm">
            <SelectValue placeholder="Select handler" />
          </SelectTrigger>
          <SelectContent className="glass-strong">
            {(envInfo?.handlerKinds ?? [{ kind: handlerKind, label: handlerKind, description: '', configFields: [] }]).map((k) => (
              <SelectItem key={k.kind} value={k.kind} className="text-sm">
                <span className="font-mono">{k.kind}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeHandlerKind?.description ? (
          <p className="text-[11px] text-muted-foreground">{activeHandlerKind.description}</p>
        ) : null}
      </div>
      {(activeHandlerKind?.configFields ?? []).length > 0 ? (
        <div className="space-y-3 rounded-md border border-white/[0.08] bg-white/[0.03] p-3">
          <TechLabel className="text-[9px]">handler configuration</TechLabel>
          {(activeHandlerKind?.configFields ?? []).map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`handler-${field.key}`}>
                {field.label} {field.required ? <span className="text-rose-400">*</span> : null}
              </Label>
              <Input
                id={`handler-${field.key}`}
                inputMode={field.type === 'number' ? 'numeric' : 'text'}
                value={String(handlerConfig[field.key] ?? '')}
                placeholder={field.placeholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  setHandlerConfig((prev) => {
                    const next = { ...prev };
                    if (raw.trim() === '') delete next[field.key];
                    else next[field.key] = field.type === 'number' ? Number(raw) : raw;
                    return next;
                  });
                  markDirty();
                }}
                className="min-h-11 w-full border-white/[0.09] bg-white/[0.04] font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">{field.description}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">This handler has no configuration — its behavior comes from the request parameters defined in the schema.</p>
      )}
    </div>
  );

  /** §2.7 — structured key/value metadata editor (add · edit · remove). */
  const metadataPanel = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Custom metadata</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200"
          onClick={() => { setMetadataRows((rows) => [...rows, ['', '']]); markDirty(); }}
        >
          <Plus className="size-3.5" aria-hidden /> Add metadata
        </Button>
      </div>
      {metadataRows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No custom metadata. Add key/value pairs (e.g. owner → platform) that travel with the tool through edit, duplicate, export and import.</p>
      ) : (
        <div className="space-y-2">
          {metadataRows.map(([k, v], i) => (
            <div key={i} className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
              <Input
                value={k}
                placeholder="key"
                aria-label={`Metadata key ${i + 1}`}
                onChange={(e) => { setMetadataRows((rows) => rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r))); markDirty(); }}
                className={cn(inputCls, 'sm:w-2/5')}
              />
              <Input
                value={v}
                placeholder="value"
                aria-label={`Metadata value ${i + 1}`}
                onChange={(e) => { setMetadataRows((rows) => rows.map((r, j) => (j === i ? [r[0], e.target.value] : r))); markDirty(); }}
                className={cn(inputCls, 'min-w-0 flex-1')}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-9 self-start px-2 text-rose-300 hover:bg-rose-500/10 sm:self-auto"
                aria-label={`Remove metadata row ${i + 1}`}
                onClick={() => { setMetadataRows((rows) => rows.filter((_, j) => j !== i)); markDirty(); }}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const schemaPanel = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="tool-schema">Input schema (ToolParamDef[])</Label>
        <div className="flex items-center gap-2">
          {schemaError === null ? (
            <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">valid</Badge>
          ) : (
            <Badge variant="outline" className="border-rose-400/40 bg-rose-400/10 font-mono text-[10px] text-rose-300">invalid</Badge>
          )}
          <div className="flex overflow-hidden rounded-md border border-white/[0.09]" role="group" aria-label="Schema editor mode">
            <button
              type="button"
              onClick={() => {
                if (schemaView === 'structured') return;
                const parsed = parseSchemaText(schemaText);
                setSchemaRows(parsed.schema?.properties ?? []);
                setSchemaView('structured');
              }}
              className={cn('min-h-8 px-2.5 font-mono text-[11px]', schemaView === 'structured' ? 'bg-sky-400/15 text-sky-200' : 'text-muted-foreground hover:text-foreground')}
            >
              form
            </button>
            <button
              type="button"
              onClick={() => { if (schemaView !== 'json') setSchemaView('json'); }}
              className={cn('min-h-8 px-2.5 font-mono text-[11px]', schemaView === 'json' ? 'bg-sky-400/15 text-sky-200' : 'text-muted-foreground hover:text-foreground')}
            >
              json
            </button>
          </div>
        </div>
      </div>

      {schemaView === 'json' ? (
        <Textarea
          id="tool-schema"
          value={schemaText}
          onChange={(e) => { setSchemaText(e.target.value); markDirty(); }}
          rows={10}
          className={cn('border-white/[0.09] bg-white/[0.04] font-mono text-xs', schemaError && 'border-rose-400/40')}
          aria-invalid={!!schemaError}
        />
      ) : (
        <div className="space-y-2">
          {schemaRows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No parameters defined.</p>
          ) : (
            schemaRows.map((p, i) => (
              <div key={i} className="space-y-2 rounded-md border border-white/[0.08] bg-white/[0.03] p-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={p.name}
                    placeholder="param name"
                    aria-label={`Param ${i + 1} name`}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, name: v } : r)));
                    }}
                    className="min-h-9 min-w-0 flex-1 border-white/[0.09] bg-white/[0.04] font-mono text-xs"
                  />
                  <Select
                    value={p.type}
                    onValueChange={(v) => setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, type: v as ToolParamDef['type'] } : r)))}
                  >
                    <SelectTrigger aria-label={`Param ${i + 1} type`} className="min-h-9 w-24 border-white/[0.09] bg-white/[0.04] font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="glass-strong">
                      {['string', 'number', 'boolean', 'object', 'array'].map((t) => (
                        <SelectItem key={t} value={t} className="font-mono text-xs">{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={p.required}
                      aria-label={`Param ${i + 1} required`}
                      onChange={(e) => setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, required: e.target.checked } : r)))}
                      className="size-4 accent-sky-400"
                    />
                    req
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-9 px-2 text-rose-300 hover:bg-rose-500/10"
                    aria-label={`Remove param ${i + 1}`}
                    onClick={() => setSchemaRows((rows) => rows.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" aria-hidden />
                  </Button>
                </div>
                <Input
                  value={p.description}
                  placeholder="description (drives parameter generation)"
                  aria-label={`Param ${i + 1} description`}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, description: v } : r)));
                  }}
                  className="min-h-9 w-full border-white/[0.09] bg-white/[0.04] text-xs"
                />
                <div className="flex flex-wrap items-center gap-2">
                  {p.type === 'string' ? (
                    <Input
                      value={(p.enumValues ?? []).join(', ')}
                      placeholder="enum values (comma separated)"
                      aria-label={`Param ${i + 1} enum values`}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, enumValues: v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined } : r)));
                      }}
                      className="min-h-9 w-full border-white/[0.09] bg-white/[0.04] font-mono text-[11px] sm:w-auto sm:flex-1"
                    />
                  ) : null}
                  {p.type === 'number' ? (
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                      <Input
                        value={p.min?.toString() ?? ''}
                        placeholder="min"
                        inputMode="numeric"
                        aria-label={`Param ${i + 1} min`}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, min: e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : n } : r)));
                        }}
                        className="min-h-9 w-20 border-white/[0.09] bg-white/[0.04] font-mono text-[11px]"
                      />
                      <Input
                        value={p.max?.toString() ?? ''}
                        placeholder="max"
                        inputMode="numeric"
                        aria-label={`Param ${i + 1} max`}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setSchemaRows((rows) => rows.map((r, j) => (j === i ? { ...r, max: e.target.value.trim() === '' || !Number.isFinite(n) ? undefined : n } : r)));
                        }}
                        className="min-h-9 w-20 border-white/[0.09] bg-white/[0.04] font-mono text-[11px]"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            ))
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200"
              onClick={() => setSchemaRows((rows) => [...rows, { name: '', type: 'string', required: false, description: '' }])}
            >
              <Plus className="size-3.5" aria-hidden /> Add param
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-9 bg-primary-gradient text-primary-foreground hover:opacity-90"
              onClick={() => {
                const rows = schemaRows.map((r) => ({ ...r, name: r.name.trim() || `param${schemaRows.indexOf(r) + 1}` }));
                setSchemaRows(rows);
                setSchemaText(JSON.stringify({ type: 'object', properties: rows }, null, 2));
                markDirty();
                toast.success('Schema updated from the form', { description: 'The JSON schema now matches these parameter rows.' });
              }}
            >
              Apply to schema
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Form edits apply to the JSON schema with “Apply to schema” — the json view stays available for advanced fields.</p>
        </div>
      )}
      {schemaError && schemaView === 'json' ? (
        <p role="alert" className="rounded-md border border-rose-400/30 bg-rose-400/5 px-2.5 py-1.5 font-mono text-[11px] text-rose-300">
          {schemaError}
        </p>
      ) : null}
      {!schemaError && parsedSchema && parsedSchema.properties.length > 0 && schemaView === 'json' ? <SchemaTable schema={parsedSchema} /> : null}
      <p className="text-[11px] text-muted-foreground">
        Schema drives CoreModule parameter generation AND the editor&apos;s IntelliSense.
      </p>
    </div>
  );

  // ---- §3.6 Node.js reference panel — data comes from the live runtime config ----
  const nodeEnvPanel = envInfo ? (
    <div className="space-y-3">
      <TechLabel>node.js sandbox — module allowlist</TechLabel>
      <div className="nextool-scroll max-h-56 space-y-1.5 overflow-y-auto pr-1">
        {Object.entries(envInfo.node.modules).map(([mod, info]) => (
          <div key={mod} className="glass-card rounded-md px-3 py-2">
            <p className="break-words font-mono text-xs text-sky-200">
              require(&apos;{mod}&apos;) <span className="text-emerald-300/80">· allowed</span>
            </p>
            <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{info.description}</p>
            <p className="mt-1 break-words font-mono text-[10px] text-cyan-300/70">{info.methods.join(' · ')}</p>
          </div>
        ))}
      </div>
      <TechLabel className="text-[9px]">deliberately unavailable</TechLabel>
      <div className="nextool-scroll max-h-32 space-y-1 overflow-y-auto pr-1">
        {Object.entries(envInfo.node.blocked).map(([mod, reason]) => (
          <p key={mod} className="break-words font-mono text-[10px] text-rose-300/80">{mod} — {reason}</p>
        ))}
      </div>
      <TechLabel className="text-[9px]">globals</TechLabel>
      <div className="nextool-scroll max-h-32 space-y-1 overflow-y-auto pr-1">
        {envInfo.node.globals.map((g) => (
          <p key={g.name} className="break-words font-mono text-[10px] text-sky-100/80">{g.name} <span className="text-slate-500">: {g.type}</span> — <span className="text-muted-foreground">{g.description}</span></p>
        ))}
      </div>
      <TechLabel className="text-[9px]">execution limits</TechLabel>
      <p className="break-words font-mono text-[10px] text-slate-400">
        timeout {envInfo.node.limits.timeoutMs}ms · sync cap {envInfo.node.limits.syncTimeoutMs}ms · heap sentinel {envInfo.node.limits.memoryLimitMb} MiB · source ≤ {envInfo.node.limits.maxSourceChars} chars · result ≤ {Math.round(envInfo.node.limits.maxResultBytes / 1024)} KiB · logs ≤ {envInfo.node.limits.maxLogLines}
      </p>
      <p className="text-[11px] text-muted-foreground">
        require() and import() pass through the SAME allowlist — a non-allowed module fails with
        <span className="font-mono text-foreground/80"> Module &quot;x&quot; is not available in the NexTool Node.js environment.</span>
      </p>
    </div>
  ) : envInfoError ? (
    <ErrorCard title="Node.js environment config unavailable" message={envInfoError} onRetry={() => window.location.reload()} />
  ) : (
    <div className="space-y-2">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );

  const referencesPanel = (
    <div className="space-y-2">
      <TechLabel>{environment === 'nodejs' ? 'runtime references — restricted Node.js sandbox' : 'runtime references — the real sandbox API'}</TechLabel>
      <div className="space-y-1.5">
        {references.map((r) => (
          <div key={r.name} className="glass-card rounded-md px-3 py-2">
            <p className="break-words font-mono text-xs text-sky-200">{r.name} <span className="text-cyan-300/70">: {r.type}</span></p>
            <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{r.description}</p>
          </div>
        ))}
      </div>
      {environment === 'nodejs' ? nodeEnvPanel : (
        <p className="text-[11px] text-muted-foreground">
          The sandbox exposes ONLY these references — no require/process/fetch/timers.
          See docs/tool-development.md for the full guide.
        </p>
      )}
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
          {environment === 'dynamic'
            ? 'Runs the REGISTERED handler in the sandbox with mode:"test".'
            : <>Runs the <span className="text-foreground/80">current editor source</span> in the {environment === 'nodejs' ? 'Node.js' : 'js'} sandbox with <span className="font-mono text-foreground/80">mode:&quot;test&quot;</span>.</>}
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

  // ---- v1.0.3 §5-8 + v1.0.5 §4 — editor surfaces share `source` (§4.4).
  const editorToggle = (
    <div className="flex items-center justify-between gap-3 rounded-md border border-white/[0.08] bg-white/[0.03] px-3 py-2.5">
      <div className="min-w-0">
        <Label htmlFor="use-monaco" className="text-sm">Use Monaco Editor</Label>
        <p className="text-[11px] text-muted-foreground">Off = plain textarea — both share the same source, tests behave identically.</p>
      </div>
      <Switch id="use-monaco" checked={useMonaco} onCheckedChange={toggleMonacoEditor} aria-label="Use Monaco Editor" />
    </div>
  );

  const monacoPanel = (
    <div
      className="flex h-[420px] w-full flex-col overflow-hidden rounded-md border border-white/[0.09] lg:h-[max(480px,calc(100vh-430px))]"
      data-testid="monaco-editor"
    >
      <MonacoSurface
        height="100%"
        defaultLanguage="javascript"
        language="javascript"
        value={source}
        theme="nextool-dark"
        onChange={(v) => {
          // §1.1 — a non-string payload (undefined/null during model swaps)
          // must NEVER clear the source: coerceEditorChange keeps the previous.
          setSource((prev) => coerceEditorChange(v, prev));
          markDirty();
        }}
        beforeMount={onEditorMount}
        onMount={onRuntimeMount}
        onDispose={handleMonacoDispose}
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

  const textareaPanel = (
    <textarea
      data-testid="function-textarea"
      value={source}
      onChange={(e) => { setSource((prev) => coerceEditorChange(e.target.value, prev)); markDirty(); }}
      spellCheck={false}
      wrap="off"
      aria-label="Function source (plain text editor)"
      className="nextool-scroll h-[420px] w-full resize-none overflow-auto rounded-md border border-white/[0.09] bg-[#0a1120] p-3 font-mono text-[13px] leading-relaxed text-sky-50 outline-none focus:ring-2 focus:ring-sky-400/30 lg:h-[max(480px,calc(100vh-430px))]"
    />
  );

  const functionSectionBody = environment === 'dynamic' ? handlerPanel : (useMonaco ? monacoPanel : textareaPanel);
  const functionSectionDesc = environment === 'dynamic'
    ? 'Dynamic tools run a registered handler — configure it here; no custom code.'
    : environment === 'nodejs'
      ? 'async function execute(params, context) — restricted Node.js sandbox (allowlisted modules only).'
      : 'async function execute(params, context) — IntelliSense comes from your schema.';

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
              {isNew ? (sessionToolName === null && dirty ? 'Duplicate Tool' : 'New Tool') : `Edit ${sessionToolName}`}
            </h2>
            <p className="text-xs text-muted-foreground">
              Tool IDE — {environment === 'nodejs' ? 'restricted Node.js sandbox' : environment === 'dynamic' ? 'dynamic handler tool' : 'sandboxed JavaScript function editor'}
            </p>
          </div>
          <Badge variant="outline" className="ml-1 shrink-0 border-sky-400/30 bg-sky-400/[0.07] font-mono text-[10px] text-sky-300">{environment}</Badge>
          {dirty ? (
            <Badge variant="outline" className="shrink-0 border-amber-400/30 bg-amber-400/10 font-mono text-[10px] text-amber-300">unsaved</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isNew && sessionToolName ? (
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" onClick={duplicateTool}>
              <Copy className="size-3.5" aria-hidden /> Duplicate
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-slate-200" onClick={() => void runTest()} disabled={test?.running}>
            {test?.running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />} Test
          </Button>
          {!isNew && sessionToolName ? (
            <Button variant="outline" size="sm" className="min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" aria-hidden /> Delete
            </Button>
          ) : null}
          <Button size="sm" className="min-h-9 gap-1.5 bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => void save()} disabled={saving || (schemaError !== null)}>
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Save className="size-3.5" aria-hidden />} {isNew ? 'Register' : 'Save'}
          </Button>
          <Button variant="ghost" size="sm" className="min-h-9 text-muted-foreground" onClick={onClose}>Close</Button>
        </div>
      </div>

      {/* Mobile: stacked tabs (§80) — the Function tab keeps a real 420px editor (§9) */}
      <div className="lg:hidden">
        <Tabs defaultValue="function" className="gap-3">
          <TabsList className="glass-card nextool-scroll h-auto w-full justify-start gap-1 overflow-x-auto rounded-lg p-1" aria-label="Tool editor sections">
            {([
              ['details', 'Details'],
              ['schema', 'Schema'],
              ['function', environment === 'dynamic' ? 'Handler' : 'Function'],
              ['references', 'References'],
              ['test', 'Test'],
            ] as const).map(([v, label]) => (
              <TabsTrigger key={v} value={v} className="flex-none min-h-9 px-3 text-xs data-[state=active]:bg-primary-gradient-soft data-[state=active]:shadow-none data-[state=active]:ring-1 data-[state=active]:ring-sky-400/25 dark:data-[state=active]:text-sky-100">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="details" className="mt-3 space-y-4 outline-none">
            <section className="glass-panel rounded-lg p-4">{generalPanel}</section>
            <section className="glass-panel rounded-lg p-4">{environmentPanel}</section>
            <section className="glass-panel rounded-lg p-4">{metadataPanel}</section>
          </TabsContent>
          <TabsContent value="schema" className="mt-3 outline-none">
            <section className="glass-panel rounded-lg p-4">{schemaPanel}</section>
          </TabsContent>
          <TabsContent value="function" className="mt-3 space-y-3 outline-none">
            {environment !== 'dynamic' ? editorToggle : null}
            <section className="glass-panel rounded-lg p-4">{functionSectionBody}</section>
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
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle title="General" desc="Identity and CoreModule matching." />
            <div className="mt-3">{generalPanel}</div>
          </section>
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle title="Execution Environment" desc="Which sandbox runs this tool." />
            <div className="mt-3">{environmentPanel}</div>
          </section>
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle title="Metadata" desc="Structured key/value pairs." />
            <div className="mt-3">{metadataPanel}</div>
          </section>
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle title="Tool Schema" desc="Parameters generated by the CoreModule." />
            <div className="mt-3">{schemaPanel}</div>
          </section>
        </div>
        <div className="space-y-4">
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle
              icon={environment === 'dynamic' ? <ShieldAlert className="size-4 text-sky-300" aria-hidden /> : <FileCode2 className="size-4 text-sky-300" aria-hidden />}
              title={environment === 'dynamic' ? 'Handler' : 'Function'}
              desc={functionSectionDesc}
            />
            <div className="mt-3 space-y-3">
              {environment !== 'dynamic' ? editorToggle : null}
              {functionSectionBody}
            </div>
          </section>
          <section className="glass-panel rounded-lg p-4">
            <SectionTitle icon={<Braces className="size-4 text-sky-300" aria-hidden />} title="Test Tool" desc="Real sandboxed execution of the current source." />
            <div className="mt-3">{testPanel}</div>
          </section>
          <section className="glass-panel rounded-lg p-4">{referencesPanel}</section>
        </div>
      </div>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-rose-300"><AlertTriangle className="size-4" aria-hidden /> Delete {sessionToolName}?</DialogTitle>
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

/**
 * §1 fix — wrapper that clears the live editor ref when Monaco unmounts
 * (mobile tab switch, textarea toggle). Without this, currentCode() could
 * read a DISPOSED model and produce the "blank editor after test" incident.
 */
function MonacoSurface({ onDispose, ...props }: ComponentProps<typeof MonacoEditor> & { onDispose: () => void }) {
  useEffect(() => onDispose, [onDispose]); // cleanup runs at unmount
  return <MonacoEditor {...props} />;
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
