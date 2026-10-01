'use client';

/**
 * Tools (spec §56) — tool registry grid with per-tool enable switch, stats,
 * schema accordion, and dynamic tool registration dialog.
 * v1.0.1: blue gradient glassmorphism — glass cards, sky/cyan accents,
 * glass-strong dialog, 1→2→3 column responsive grid, min-h-11 controls.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ApiClientError, listTools, registerTool, toggleTool } from '@/lib/nexool/client';
import type { ToolEntry } from '@/lib/nexool/api-contract';
import { EmptyState, ErrorCard, SectionTitle, fmtMs } from '../ui-bits';
import { FilePlus2, Loader2, Wrench } from 'lucide-react';

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
  if (environment === 'dynamic') {
    return <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 font-mono text-[10px] text-sky-300">dynamic</Badge>;
  }
  return <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">builtin</Badge>;
}

function ToolCard({ tool, onToggle, toggling }: { tool: ToolEntry; onToggle: (name: string, enabled: boolean) => void; toggling: boolean }) {
  const s = tool.stats;
  return (
    <div className={cn('glass-card flex flex-col rounded-lg p-4', !tool.enabled && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold text-foreground">{tool.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">{tool.category}</Badge>
            <EnvironmentBadge environment={tool.environment} />
            {tool.handlerKind ? <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-slate-400">handler: {tool.handlerKind}</Badge> : null}
          </div>
        </div>
        <Switch checked={tool.enabled} onCheckedChange={(v) => onToggle(tool.name, v)} disabled={toggling} aria-label={`Toggle tool ${tool.name}`} />
      </div>

      <p className="mt-2 text-xs text-foreground/90">{tool.description}</p>
      {tool.purpose ? <p className="mt-1 text-[11px] italic text-muted-foreground">purpose: {tool.purpose}</p> : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-white/[0.07] pt-2 font-mono text-[11px] tabular-nums text-slate-300">
        <span><span className="text-muted-foreground">calls</span> {s.callCount}</span>
        <span className="text-emerald-300"><span className="text-muted-foreground">ok</span> {s.successCount}</span>
        <span className="text-rose-300"><span className="text-muted-foreground">fail</span> {s.failureCount + s.timeoutCount}</span>
        <span><span className="text-muted-foreground">avg</span> {fmtMs(s.avgMs)}</span>
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

export default function ToolsView() {
  const [tools, setTools] = useState<ToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [regOpen, setRegOpen] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', category: 'utility', purpose: '', handlerKind: 'echo', handlerConfig: '{}', schema: EXAMPLE_PARAMS });

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

  const inputCls = 'min-h-11 border-white/[0.09] bg-white/[0.04] text-sm';

  return (
    <div className="space-y-6">
      <SectionTitle
        icon={<Wrench className="size-4 text-sky-300" aria-hidden />}
        title="Tools"
        desc="Registry visible to the CoreModule — dynamic matching, no hardcoded ids."
        right={
          <Button size="sm" className="bg-primary-gradient min-h-9 gap-1.5 text-primary-foreground hover:opacity-90" onClick={() => setRegOpen(true)}>
            <FilePlus2 className="size-3.5" aria-hidden /> Register tool
          </Button>
        }
      />

      {error && tools === null ? (
        <ErrorCard title="Tool registry unavailable" message={error} onRetry={load} />
      ) : tools === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-44 w-full" />)}
        </div>
      ) : tools.length === 0 ? (
        <EmptyState icon={<Wrench className="size-6" aria-hidden />} title="No tools registered" hint="The runtime has not exposed any tools yet — register one or wait for startup." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} onToggle={(n, v) => void onToggle(n, v)} toggling={toggling === tool.name} />
          ))}
        </div>
      )}

      <Dialog open={regOpen} onOpenChange={setRegOpen}>
        <DialogContent className="glass-strong sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Register dynamic tool</DialogTitle>
            <DialogDescription>Registers a handler-backed tool the CoreModule can match and execute.</DialogDescription>
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
    </div>
  );
}
