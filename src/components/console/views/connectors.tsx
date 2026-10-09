'use client';

/**
 * Connectors (v1.0.12) — central MCP connection management.
 * v1.0.13 §5 — customizable authentication: per-provider auth-method selector
 * (none | bearer/token | oauth2 redirect), the OAuth scope editor (§5.3) with
 * the confirm-before-redirect login (§5.1), the refresh-token action (§5.4)
 * and the §4 server-capability display in discovery. NOTHING provider-specific
 * is hard-coded here — every label/field/endpoint comes from the provider
 * registry metadata returned by GET /api/connectors.
 *
 * Supported MCP servers come from the JSON provider registry
 * (config/mcp-servers.json → GET /api/connectors); per connector: connect /
 * authenticate / disconnect / reconnect, the REAL connection status (never
 * faked), live tool discovery with multi-select import, and imported-tool
 * management (enable/disable, schema refresh, remove). NexTool-native/custom
 * tools stay on the Tools page — this page ONLY manages the connector layer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  ApiClientError, clearConnectorCredentials, connectorConnectionAction, connectorRefreshAuth, createConnector,
  deleteConnector, discoverConnectorTools, importConnectorTools, listConnectors,
  refreshConnectorTools, removeImportedTool, setConnectorCredentials, startConnectorOAuth, toggleImportedTool,
  updateConnector,
} from '@/lib/nexool/client';
import type {
  ConnectorDTO, DiscoveredToolDTO, ImportedToolDTO, McpAuthMethodDTO, McpProviderDTO,
} from '@/lib/nexool/client';
import { EmptyState, ErrorCard, SectionTitle, fmtMs } from '../ui-bits';
import {
  Cable, CircleAlert, Download, Eye, EyeOff, KeyRound, Loader2, LogIn, Plug, PlugZap, Plus,
  RefreshCw, RotateCw, ShieldCheck, Trash2, Unplug, Wrench, X,
} from 'lucide-react';

// ---------- v1.0.13 §5 — auth-method presentation (registry-driven labels) ----------

const AUTH_METHOD_LABELS: Record<McpAuthMethodDTO, string> = {
  none: 'No authentication',
  bearer: 'Access token',
  token_pair: 'I got token already (access + refresh)',
  oauth2: 'Login via NexTool: Redirect',
};

/** Registry-declared auth methods for a provider (falls back to the legacy type). */
function authMethodsOf(p: McpProviderDTO): McpAuthMethodDTO[] {
  if (p.authentication.authMethods && p.authentication.authMethods.length > 0) return p.authentication.authMethods;
  return ['none', 'bearer', 'token_pair', 'oauth2'];
}

/** Credential-field keys the given method needs (§5 requiredFieldsByMethod). */
function fieldsForMethod(p: McpProviderDTO, m: McpAuthMethodDTO): string[] {
  const byMethod = p.authentication.requiredFieldsByMethod?.[m];
  if (byMethod && byMethod.length > 0) return byMethod;
  if (m === 'none') return [];
  return p.authentication.requiredFields;
}

// ---------- status badge (honest states, §1.8) ----------

const STATUS_META: Record<ConnectorDTO['status'], { label: string; className: string; pulse?: boolean }> = {
  not_connected: { label: 'Not connected', className: 'border-white/[0.12] bg-white/[0.05] text-slate-300' },
  connecting: { label: 'Connecting…', className: 'border-amber-400/30 bg-amber-400/10 text-amber-300', pulse: true },
  auth_required: { label: 'Authentication required', className: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  connected: { label: 'Connected', className: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
  disconnected: { label: 'Disconnected', className: 'border-white/[0.12] bg-white/[0.05] text-slate-300' },
  error: { label: 'Error', className: 'border-rose-400/30 bg-rose-400/10 text-rose-300' },
  reconnecting: { label: 'Reconnecting…', className: 'border-amber-400/30 bg-amber-400/10 text-amber-300', pulse: true },
};

function StatusBadge({ status }: { status: ConnectorDTO['status'] }) {
  const meta = STATUS_META[status] ?? STATUS_META.not_connected;
  return (
    <Badge variant="outline" className={cn('font-mono text-[10px]', meta.className)} aria-label={`Connection status: ${meta.label}`}>
      {meta.pulse ? <Loader2 className="mr-1 size-3 animate-spin" aria-hidden /> : null}
      {meta.label}
    </Badge>
  );
}

function TransportBadge({ provider }: { provider: McpProviderDTO | undefined }) {
  if (!provider) return null;
  return (
    <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">
      {provider.transport.type === 'stdio' ? 'stdio' : 'streamable http'}
    </Badge>
  );
}

// ---------- add-connector dialog ----------

interface AddState {
  provider: McpProviderDTO;
  name: string;
  config: Record<string, string>;
  busy: boolean;
}

function AddConnectorDialog({ state, onPatch, onClose, onCreated }: { state: AddState | null; onPatch: (patch: Partial<AddState>) => void; onClose: () => void; onCreated: () => void }) {
  if (!state) return null;
  const p = state.provider;
  const submit = async () => {
    const filled = Object.fromEntries(Object.entries(state.config).filter(([, v]) => v.trim() !== ''));
    onPatch({ busy: true });
    try {
      await createConnector({ providerId: p.id, ...(state.name.trim() ? { name: state.name.trim() } : {}), ...(Object.keys(filled).length > 0 ? { config: filled } : {}) });
      toast.success('Connector added', { description: `${state.name.trim() || p.name} — set credentials, then connect.` });
      onCreated();
      onClose();
    } catch (e) {
      toast.error('Could not add connector', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      onPatch({ busy: false });
    }
  };
  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="glass-strong sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add {p.name} connector</DialogTitle>
          <DialogDescription>{p.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="conn-name">Connector name</Label>
            <Input id="conn-name" value={state.name} onChange={(e) => onPatch({ name: e.target.value })} placeholder={p.name} className="border-white/[0.09] bg-white/[0.04]" />
          </div>
          {p.transport.configFields.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`cfg-${f.key}`}>{f.label}{f.required ? ' *' : ''}</Label>
              <Input
                id={`cfg-${f.key}`}
                value={state.config[f.key] ?? ''}
                onChange={(e) => onPatch({ config: { ...state.config, [f.key]: e.target.value } })}
                placeholder={f.placeholder ?? (f.key === 'args' ? p.transport.defaultArgs?.join(' ') : undefined)}
                className="border-white/[0.09] bg-white/[0.04] font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">{f.description}</p>
            </div>
          ))}
          <p className="rounded-md border border-white/[0.07] bg-white/[0.03] p-2 text-[11px] text-muted-foreground">
            Transport: <span className="font-mono">{p.transport.type}</span> · Auth: <span className="font-mono">{p.authentication.type}</span>. Credentials are stored server-side only and never leave the NexTool process.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => void submit()} disabled={state.busy}>
            {state.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />} Add connector
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- credentials dialog (server-side only storage) ----------

interface CredState {
  connector: ConnectorDTO;
  provider: McpProviderDTO | undefined;
  values: Record<string, string>;
  show: Record<string, boolean>;
  busy: boolean;
  /** v1.0.13 §5 — the auth method THIS save declares (drives the visible fields). */
  method?: McpAuthMethodDTO;
}

function CredentialsDialog({ state, onPatch, onClose, onSaved }: { state: CredState | null; onPatch: (patch: Partial<CredState>) => void; onClose: () => void; onSaved: () => void }) {
  if (!state) return null;
  const auth = state.provider?.authentication;
  // v1.0.13 §5 — field set for the DECLARED method: required-by-method fields
  // first; when the method list does not declare any (legacy presets) fall
  // back to the provider's full field list. OAuth client fields appear for
  // the oauth2 method when the preset exists.
  const method = state.method;
  const methodKeys = state.provider && method ? fieldsForMethod(state.provider, method) : [];
  const oauthClientKeys = method === 'oauth2' && auth?.oauth ? ['clientId', 'clientSecret'] : [];
  const visibleFields = auth
    ? (methodKeys.length > 0 || oauthClientKeys.length > 0
      ? auth.fields.filter((f) => methodKeys.includes(f.key) || oauthClientKeys.includes(f.key))
        .concat(
          oauthClientKeys
            .filter((k) => !auth.fields.some((f) => f.key === k))
            .map((k) => ({ key: k, label: k === 'clientId' ? 'OAuth Client ID' : 'OAuth Client Secret', type: 'string' as const, required: false, secret: k === 'clientSecret', description: 'Stored server-side only; used for the OAuth token exchange.' })),
        )
      : auth.fields)
    : [];
  const submit = async () => {
    try {
      onPatch({ busy: true });
      const filled = Object.fromEntries(Object.entries(state.values).filter(([, v]) => v.trim() !== ''));
      await setConnectorCredentials(state.connector.id, filled, method);
      toast.success('Credentials stored', { description: `Method: ${method ? AUTH_METHOD_LABELS[method] : auth?.title ?? 'default'} — saved server-side only.` });
      onSaved();
      onClose();
    } catch (e) {
      toast.error('Could not store credentials', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      onPatch({ busy: false });
    }
  };
  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="glass-strong sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{method ? AUTH_METHOD_LABELS[method] : auth?.title ?? 'Credentials'} — {state.connector.name}</DialogTitle>
          <DialogDescription>{auth?.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {visibleFields.length === 0 ? (
            <p className="rounded-md border border-white/[0.07] bg-white/[0.03] p-2 text-[11px] text-muted-foreground">
              This method requires no credential fields.
            </p>
          ) : (
            visibleFields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={`cred-${f.key}`}>{f.label}{f.required ? ' *' : ''}</Label>
                <div className="relative">
                  <Input
                    id={`cred-${f.key}`}
                    type={f.secret === false || state.show[f.key] ? 'text' : 'password'}
                    value={state.values[f.key] ?? ''}
                    onChange={(e) => onPatch({ values: { ...state.values, [f.key]: e.target.value } })}
                    placeholder={f.placeholder}
                    autoComplete="off"
                    className="border-white/[0.09] bg-white/[0.04] pr-9 font-mono text-xs"
                  />
                  {f.secret !== false ? (
                    <button
                      type="button"
                      onClick={() => onPatch({ show: { ...state.show, [f.key]: !state.show[f.key] } })}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      aria-label={state.show[f.key] ? 'Hide value' : 'Show value'}
                    >
                      {state.show[f.key] ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                    </button>
                  ) : null}
                </div>
                <p className="text-[10px] text-muted-foreground">{f.description}</p>
              </div>
            ))
          )}
          <p className="flex items-start gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-400/5 p-2 text-[11px] text-emerald-200/90">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Stored in the server database only. The browser never receives credential values, and they are excluded from tool definitions and exports.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => void submit()} disabled={state.busy}>
            {state.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <KeyRound className="size-3.5" aria-hidden />} Save credentials
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- discovery + import dialog ----------

interface DiscoverState {
  connector: ConnectorDTO;
  loading: boolean;
  error: string | null;
  tools: DiscoveredToolDTO[];
  selected: Set<string>;
  importing: boolean;
  /** v1.0.13 §4 — server capabilities beyond tools. */
  resources: { uri: string; name?: string; title?: string; description?: string }[];
  prompts: { name: string; title?: string; description?: string }[];
  serverInfo: { name: string; version: string; capabilities: Record<string, unknown> | null } | null;
}

function DiscoveryDialog({ state, onPatch, onClose, onImported }: { state: DiscoverState | null; onPatch: (patch: Partial<DiscoverState>) => void; onClose: () => void; onImported: () => void }) {
  if (!state) return null;
  const selectedCount = state.selected.size;
  const toggleSelect = (name: string, checked: boolean) => {
    const next = new Set(state.selected);
    if (checked) next.add(name);
    else next.delete(name);
    onPatch({ selected: next });
  };
  const doImport = async () => {
    if (selectedCount === 0) return;
    try {
      onPatch({ importing: true });
      const res = await importConnectorTools(state.connector.id, [...state.selected]);
      const parts = [
        res.imported.length > 0 ? `${res.imported.length} imported` : null,
        res.updated.length > 0 ? `${res.updated.length} updated` : null,
        res.failed.length > 0 ? `${res.failed.length} failed` : null,
      ].filter(Boolean);
      toast.success('MCP tools imported', { description: `${parts.join(', ')} — available as environment "mcp" tools.` });
      if (res.failed.length > 0) {
        toast.warning('Some tools failed', { description: res.failed.map((f) => `${f.name}: ${f.reason}`).join(' · ') });
      }
      onImported();
      onClose();
    } catch (e) {
      toast.error('Import failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
      onPatch({ importing: false });
    }
  };
  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="glass-strong sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>MCP tools — {state.connector.name}</DialogTitle>
          <DialogDescription>
            {state.loading
              ? 'Discovering tools on the MCP server…'
              : state.error
                ? state.error
                : `${state.tools.length} tool(s) discovered on the server. Select the ones NexTool should import.`}
          </DialogDescription>
        </DialogHeader>
        <div className="nextool-scroll max-h-[420px] space-y-2 overflow-y-auto pr-1" role="group" aria-label="Discovered MCP tools">
          {state.loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
          ) : state.error ? (
            <ErrorCard title="Discovery unavailable" message={state.error} onRetry={() => onPatch({ error: null, loading: true })} />
          ) : state.tools.length === 0 ? (
            <EmptyState icon={<Cable className="size-6" aria-hidden />} title="No tools discovered" hint="The server session is connected but exposes no tools." />
          ) : (
            state.tools.map((t) => {
              const checked = state.selected.has(t.name);
              return (
                <label
                  key={t.name}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                    checked ? 'border-sky-400/40 bg-sky-400/5' : 'border-white/[0.07] bg-white/[0.03] hover:bg-white/[0.05]',
                    t.imported && 'opacity-80',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => toggleSelect(t.name, v === true)}
                    aria-label={`Select tool ${t.name}`}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-semibold text-foreground">{t.name}</span>
                      {t.imported ? (
                        <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">
                          imported{t.importedToolName ? `: ${t.importedToolName}` : ''}
                        </Badge>
                      ) : null}
                    </div>
                    {t.description ? <p className="mt-0.5 break-words text-[11px] text-foreground/80">{t.description}</p> : null}
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      schema: {describeSchema(t.inputSchema)} · hash {t.remoteHash.slice(0, 8)}
                    </p>
                  </div>
                </label>
              );
            })
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={onClose}>Close</Button>
          <Button
            size="sm"
            className="bg-primary-gradient text-primary-foreground hover:opacity-90"
            onClick={() => void doImport()}
            disabled={state.importing || selectedCount === 0}
          >
            {state.importing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            Import selected tools{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </Button>
        </DialogFooter>

        {/* v1.0.13 §4 — server capabilities beyond tools (resources / prompts / declared capability object) */}
        {!state.loading && !state.error && (state.resources.length > 0 || state.prompts.length > 0 || state.serverInfo) ? (
          <div className="space-y-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] p-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              server capabilities {state.serverInfo ? `· ${state.serverInfo.name} ${state.serverInfo.version}` : ''}
            </p>
            {state.serverInfo?.capabilities ? (
              <div className="flex flex-wrap gap-1">
                {Object.keys(state.serverInfo.capabilities).map((cap) => (
                  <Badge key={cap} variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">{cap}</Badge>
                ))}
              </div>
            ) : null}
            {state.resources.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer text-[11px] text-sky-300">Resources ({state.resources.length})</summary>
                <div className="nextool-scroll mt-1 max-h-28 space-y-0.5 overflow-y-auto">
                  {state.resources.map((r) => (
                    <p key={r.uri} className="truncate font-mono text-[10px] text-muted-foreground" title={r.description ?? r.uri}>
                      {r.name ?? r.title ?? r.uri} — <span className="text-sky-300/70">{r.uri}</span>
                    </p>
                  ))}
                </div>
              </details>
            ) : null}
            {state.prompts.length > 0 ? (
              <details className="group">
                <summary className="cursor-pointer text-[11px] text-violet-300">Prompts ({state.prompts.length})</summary>
                <div className="nextool-scroll mt-1 max-h-28 space-y-0.5 overflow-y-auto">
                  {state.prompts.map((pr) => (
                    <p key={pr.name} className="truncate font-mono text-[10px] text-muted-foreground" title={pr.description ?? pr.name}>
                      {pr.title ?? pr.name}
                    </p>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One-line human description of a raw MCP inputSchema. */
function describeSchema(inputSchema: unknown): string {
  if (inputSchema === null || typeof inputSchema !== 'object') return 'no input schema';
  const s = inputSchema as { properties?: Record<string, unknown>; required?: unknown[] };
  const names = s.properties ? Object.keys(s.properties) : [];
  if (names.length === 0) return 'no parameters';
  const req = Array.isArray(s.required) ? new Set(s.required as string[]) : new Set<string>();
  return `${names.length} param(s): ${names.map((n) => `${n}${req.has(n) ? '*' : ''}`).join(', ')}`;
}

// ---------- connector card ----------

function ConnectorCard({
  connector, providers, busy, onConnect, onDisconnect, onReconnect, onDiscover, onCredentials, onRemove, onRefreshAll, onToolToggle, onToolRefresh, onToolRemove, onToggleEnabled, onSetAuthMethod, onStartOAuth, onRefreshAuth,
}: {
  connector: ConnectorDTO;
  providers: McpProviderDTO[];
  busy: boolean;
  onConnect: (c: ConnectorDTO) => void;
  onDisconnect: (c: ConnectorDTO) => void;
  onReconnect: (c: ConnectorDTO) => void;
  onDiscover: (c: ConnectorDTO) => void;
  onCredentials: (c: ConnectorDTO) => void;
  onRemove: (c: ConnectorDTO) => void;
  onRefreshAll: (c: ConnectorDTO) => void;
  onToolToggle: (c: ConnectorDTO, t: ImportedToolDTO, enabled: boolean) => void;
  onToolRefresh: (c: ConnectorDTO, t: ImportedToolDTO) => void;
  onToolRemove: (c: ConnectorDTO, t: ImportedToolDTO) => void;
  onToggleEnabled: (c: ConnectorDTO, enabled: boolean) => void;
  /** v1.0.13 §5 — declare the auth method (opens the matching flow); the
   *  opts carry scope edits from the OAuth panel (§5.3). */
  onSetAuthMethod: (c: ConnectorDTO, m: McpAuthMethodDTO, opts?: { addScope?: string; removeScope?: string }) => void;
  /** §5.1 — ask for confirmation, then POST oauth/start + redirect. */
  onStartOAuth: (c: ConnectorDTO) => void;
  /** §5.4 — rotate the stored access token via the refresh grant. */
  onRefreshAuth: (c: ConnectorDTO) => void;
}) {
  const provider = providers.find((p) => p.id === connector.providerId);
  const isActive = connector.status === 'connected';
  const isTransitioning = connector.status === 'connecting' || connector.status === 'reconnecting';
  // v1.0.13 §5 — the effective method: stored/inferred from the DTO, else the
  // first declared method of the provider.
  const methods = provider ? authMethodsOf(provider) : [];
  const effectiveMethod: McpAuthMethodDTO | undefined = connector.authMethod ?? methods[0];
  const oauthPreset = provider?.authentication.oauth;
  const loginWording = provider?.authentication.loginWording ?? 'Login via NexTool: Redirect';
  // §5.3 — editable scopes: connector config override, else preset defaults.
  const [scopeDraft, setScopeDraft] = useState('');
  const configuredScopes = (() => {
    const raw = connector.config?.scopes;
    if (typeof raw === 'string' && raw.trim()) return raw.split(/[\s,]+/).filter(Boolean);
    if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
    return oauthPreset?.defaultScopes ?? [];
  })();

  return (
    <div className="glass-card flex flex-col rounded-lg p-4" aria-label={`Connector ${connector.name}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold text-foreground" title={connector.name}>{connector.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">{connector.providerName}</Badge>
            <TransportBadge provider={provider} />
            <StatusBadge status={connector.status} />
            {!connector.enabled ? <Badge variant="outline" className="border-white/[0.09] font-mono text-[10px] text-muted-foreground">disabled</Badge> : null}
          </div>
        </div>
        <Switch checked={connector.enabled} onCheckedChange={(v) => onToggleEnabled(connector, v)} disabled={busy} aria-label={`Toggle connector ${connector.name}`} />
      </div>

      {connector.statusDetail ? (
        <p className="mt-2 break-words text-[11px] text-muted-foreground">{connector.statusDetail}</p>
      ) : (
        <p className="mt-2 line-clamp-2 break-words text-[11px] text-muted-foreground">{connector.providerDescription}</p>
      )}
      {connector.lastError ? (
        <p className="mt-1 flex items-start gap-1 break-words text-[11px] text-rose-300" role="alert">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden /> {connector.lastError}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span>
          credentials: {connector.hasCredentials ? (
            <span className="text-emerald-300">stored ({connector.credentialFieldsProvided.length} field(s))</span>
          ) : (
            <span className="text-amber-300">none</span>
          )}
        </span>
        {connector.serverInfo ? <span>server: {connector.serverInfo.name} {connector.serverInfo.version}</span> : null}
        {connector.lastConnectedAt ? <span>last connected: {fmtMs(Date.now() - Date.parse(connector.lastConnectedAt))} ago</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/[0.07] pt-3">
        {isActive ? (
          <>
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs" onClick={() => onDiscover(connector)}>
              <Cable className="size-3.5" aria-hidden /> Discover tools
            </Button>
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs" onClick={() => onReconnect(connector)} disabled={busy}>
              <RotateCw className="size-3.5" aria-hidden /> Reconnect
            </Button>
            <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs text-amber-200" onClick={() => onDisconnect(connector)} disabled={busy}>
              <Unplug className="size-3.5" aria-hidden /> Disconnect
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs" onClick={() => onConnect(connector)} disabled={busy || isTransitioning || !connector.enabled}>
            {isTransitioning ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <PlugZap className="size-3.5" aria-hidden />} Connect
          </Button>
        )}
        <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs" onClick={() => onCredentials(connector)}>
          <KeyRound className="size-3.5" aria-hidden /> {connector.hasCredentials ? 'Update credentials' : 'Set credentials'}
        </Button>
        {connector.hasCredentials ? (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 border-white/[0.09] bg-white/[0.04] px-2 text-xs text-muted-foreground"
                  onClick={() => onCredentials(connector)}
                  aria-label="Credential presence info"
                >
                  <ShieldCheck className="size-3.5" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Values stored server-side only — the browser never sees them.</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto min-h-9 border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
          onClick={() => onRemove(connector)}
          disabled={busy}
          aria-label={`Remove connector ${connector.name}`}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </Button>
      </div>

      {/* v1.0.13 §5 — customizable authentication (method selector + OAuth panel) */}
      {provider && methods.length > 0 ? (
        <div className="mt-3 space-y-2 border-t border-white/[0.07] pt-3">
          <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Authentication</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={effectiveMethod}
              onValueChange={(v) => onSetAuthMethod(connector, v as McpAuthMethodDTO)}
              disabled={busy}
            >
              <SelectTrigger className="h-9 min-w-0 flex-1 border-white/[0.09] bg-white/[0.04] text-xs" aria-label="Authentication method">
                <SelectValue placeholder="Auth method" />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m} value={m} className="text-xs">{AUTH_METHOD_LABELS[m]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {connector.hasRefreshToken ? (
              <Button variant="outline" size="sm" className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs" onClick={() => onRefreshAuth(connector)} disabled={busy}>
                <RotateCw className="size-3.5" aria-hidden /> Refresh token
              </Button>
            ) : null}
          </div>

          {/* §5.1/§5.2/§5.3 — OAuth redirect panel: editable scopes + confirmed login */}
          {effectiveMethod === 'oauth2' && oauthPreset ? (
            <div className="space-y-2 rounded-md border border-sky-400/25 bg-sky-400/[0.04] p-2.5">
              <p className="text-[11px] text-foreground/90">
                Scopes <span className="text-muted-foreground">(sent to the provider&apos;s authorization endpoint — editable)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {configuredScopes.length === 0 ? (
                  <span className="text-[10px] text-muted-foreground">no scopes configured — the provider default applies</span>
                ) : (
                  configuredScopes.map((s) => (
                    <Badge key={s} variant="outline" className="max-w-full gap-1 border-sky-400/30 bg-sky-400/10 font-mono text-[10px] text-sky-200">
                      <span className="truncate">{s}</span>
                      <button
                        type="button"
                        aria-label={`Remove scope ${s}`}
                        className="text-sky-300/80 hover:text-rose-300"
                        onClick={() => onSetAuthMethod(connector, 'oauth2', { removeScope: s })}
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
              <div className="flex gap-1.5">
                <Input
                  value={scopeDraft}
                  onChange={(e) => setScopeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && scopeDraft.trim()) {
                      onSetAuthMethod(connector, 'oauth2', { addScope: scopeDraft.trim() });
                      setScopeDraft('');
                    }
                  }}
                  placeholder="Add scope (e.g. https://www.googleapis.com/auth/drive)"
                  className="h-9 min-w-0 flex-1 border-white/[0.09] bg-white/[0.04] font-mono text-[11px]"
                  aria-label="Add scope"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 border-white/[0.09] bg-white/[0.04] text-xs"
                  disabled={busy || !scopeDraft.trim()}
                  onClick={() => {
                    onSetAuthMethod(connector, 'oauth2', { addScope: scopeDraft.trim() });
                    setScopeDraft('');
                  }}
                >
                  <Plus className="size-3.5" aria-hidden /> Add scope
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <Button size="sm" className="min-h-9 bg-primary-gradient text-primary-foreground hover:opacity-90" onClick={() => onStartOAuth(connector)} disabled={busy}>
                  <LogIn className="size-3.5" aria-hidden /> {loginWording}
                </Button>
                <span className="text-[10px] text-muted-foreground">
                  opens the provider login in a new redirect — you confirm first · {oauthPreset.pkce ? 'PKCE' : 'authorization code'}
                </span>
              </div>
            </div>
          ) : null}
          {effectiveMethod === 'none' ? (
            <p className="text-[11px] text-muted-foreground">No authentication — the connector connects without credentials.</p>
          ) : null}
          {effectiveMethod === 'oauth2' && !oauthPreset ? (
            <p className="text-[11px] text-amber-300/90">This provider preset declares no OAuth endpoints — use a token method instead.</p>
          ) : null}
        </div>
      ) : null}

      {/* imported tools (§1.15) — connector-scoped management */}
      {connector.importedTools.length > 0 ? (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              Imported tools ({connector.importedTools.filter((t) => t.enabled).length}/{connector.importedTools.length} enabled)
            </p>
            <Button
              variant="outline"
              size="sm"
              className="min-h-7 border-white/[0.09] bg-white/[0.04] px-2 text-[11px]"
              onClick={() => onRefreshAll(connector)}
              disabled={busy || !isActive}
              aria-label="Refresh all imported tool schemas"
            >
              <RefreshCw className="size-3" aria-hidden /> Refresh schemas
            </Button>
          </div>
          <div className="nextool-scroll max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {connector.importedTools.map((t) => (
              <div key={t.name} className={cn('flex items-center gap-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5', !t.enabled && 'opacity-60')}>
                <Switch checked={t.enabled} onCheckedChange={(v) => onToolToggle(connector, t, v)} disabled={busy} aria-label={`Toggle tool ${t.name}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] font-medium text-foreground" title={t.name}>{t.name}</p>
                  <p className="truncate text-[10px] text-muted-foreground" title={t.description}>{t.description}</p>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{t.paramCount}p · {t.mcpToolName}</span>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-7 border-white/[0.09] bg-white/[0.04] px-1.5"
                        onClick={() => onToolRefresh(connector, t)}
                        disabled={busy || !isActive}
                        aria-label={`Refresh schema of ${t.name}`}
                      >
                        <RefreshCw className="size-3" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Refresh schema from the MCP server (keeps local metadata)</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-7 border-white/[0.09] bg-white/[0.04] px-1.5 text-rose-300 hover:bg-rose-500/10"
                  onClick={() => onToolRemove(connector, t)}
                  disabled={busy}
                  aria-label={`Remove ${t.name} from NexTool`}
                >
                  <Trash2 className="size-3" aria-hidden />
                </Button>
              </div>
            ))}
          </div>
          {!isActive ? (
            <p className="mt-2 text-[10px] text-amber-300/90">
              Connector {STATUS_META[connector.status].label.toLowerCase()} — imported tools are registered but unavailable until reconnect (no re-import needed).
            </p>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 border-t border-white/[0.07] pt-3">
          <p className="text-[11px] text-muted-foreground">
            No MCP tools imported yet.{isActive ? ' Use “Discover tools” to select and import.' : ' Connect the connector to discover its tools.'}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export default function ConnectorsView() {
  const [data, setData] = useState<{ providers: McpProviderDTO[]; connectors: ConnectorDTO[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [add, setAdd] = useState<AddState | null>(null);
  const [cred, setCred] = useState<CredState | null>(null);
  const [discover, setDiscover] = useState<DiscoverState | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<ConnectorDTO | null>(null);
  const [removing, setRemoving] = useState(false);
  // v1.0.13 §5 — the connector awaiting the EXPLICIT confirm before the
  // external OAuth redirect (§5.1 — never redirect without confirmation).
  const [oauthConfirm, setOauthConfirm] = useState<ConnectorDTO | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listConnectors();
      setData({ providers: res.providers, connectors: res.connectors });
      setError(null);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // v1.0.13 §5.2 — OAuth callback return: /api/connectors/[id]/oauth/callback
  // redirects back with ?oauth=<id>&status=ok|error&detail=…; surface the
  // outcome once and strip the params from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('oauth')) return;
    const status = params.get('status');
    const detail = params.get('detail');
    if (status === 'ok') {
      toast.success('Connected via OAuth', { description: 'Access + refresh tokens were exchanged and stored server-side.' });
    } else {
      toast.error('OAuth login failed', { description: detail ?? 'The provider did not return an authorization code.' });
    }
    window.history.replaceState({}, '', window.location.pathname + '#connectors');
    void load();
  }, [load]);

  const withBusy = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
      void load();
    }
  }, [load]);

  const connect = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      const res = await connectorConnectionAction(c.id, 'connect');
      if (res.status === 'connected') toast.success('Connector connected', { description: `${c.name} — the MCP session is live.` });
      else toast.warning(`Connection not established (${res.status})`, { description: res.statusDetail ?? res.lastError ?? '' });
    } catch (e) {
      toast.error('Connect failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const disconnect = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      await connectorConnectionAction(c.id, 'disconnect');
      toast.info('Connector disconnected', { description: `${c.name} — imported tools stay registered but are unavailable until reconnect.` });
    } catch (e) {
      toast.error('Disconnect failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const reconnect = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      const res = await connectorConnectionAction(c.id, 'reconnect');
      if (res.status === 'connected') toast.success('Connector reconnected', { description: c.name });
      else toast.warning(`Reconnect not established (${res.status})`, { description: res.statusDetail ?? res.lastError ?? '' });
    } catch (e) {
      toast.error('Reconnect failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const openDiscover = (c: ConnectorDTO) => {
    setDiscover({ connector: c, loading: true, error: null, tools: [], selected: new Set(), importing: false, resources: [], prompts: [], serverInfo: null });
    void discoverConnectorTools(c.id)
      .then((res) => {
        // imported tools start UNCHECKED (re-import = explicit update); their badge shows the import state
        setDiscover((s) => (s && s.connector.id === c.id ? {
          ...s,
          loading: false,
          tools: res.tools,
          resources: res.resources ?? [],
          prompts: res.prompts ?? [],
          serverInfo: res.serverInfo ?? null,
        } : s));
      })
      .catch((e) => {
        setDiscover((s) => (s && s.connector.id === c.id ? { ...s, loading: false, error: e instanceof ApiClientError ? e.message : 'Unknown error' } : s));
      });
  };

  const openCredentials = (c: ConnectorDTO) => {
    const provider = data?.providers.find((p) => p.id === c.providerId);
    setCred({ connector: c, provider, values: {}, show: {}, busy: false });
  };

  const removeCredentials = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      await clearConnectorCredentials(c.id);
      toast.info('Credentials removed', { description: c.name });
    } catch (e) {
      toast.error('Could not remove credentials', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const confirmRemove = async () => {
    if (!removeCandidate) return;
    setRemoving(true);
    try {
      const res = await deleteConnector(removeCandidate.id);
      toast.success('Connector removed', { description: `${removeCandidate.name} — ${res.removedTools.length} imported tool(s) removed from NexTool. The remote MCP server was not touched.` });
      setRemoveCandidate(null);
      await load();
    } catch (e) {
      toast.error('Remove failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    } finally {
      setRemoving(false);
    }
  };

  const refreshAll = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      const res = await refreshConnectorTools(c.id);
      const changed = res.refreshed.filter((r) => r.changed);
      toast.info('Schema refresh complete', {
        description: `${res.refreshed.length} checked · ${changed.length} changed${res.unavailable.length > 0 ? ` · ${res.unavailable.length} unavailable on the server (kept locally)` : ''}`,
      });
      if (changed.length > 0) {
        toast.success('Schemas updated', { description: changed.map((r) => `${r.mcpToolName}: ${r.summary}`).join(' · ') });
      }
    } catch (e) {
      toast.error('Refresh failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const toolToggle = (c: ConnectorDTO, t: ImportedToolDTO, enabled: boolean) => void withBusy(c.id, async () => {
    try {
      await toggleImportedTool(c.id, t.mcpToolName, enabled);
      toast.success(enabled ? 'Tool enabled' : 'Tool disabled', { description: `${t.name} — ${enabled ? 'visible to the CoreModule again.' : 'hidden from the CoreModule.'}` });
    } catch (e) {
      toast.error('Toggle failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const toolRefresh = (c: ConnectorDTO, t: ImportedToolDTO) => void withBusy(c.id, async () => {
    try {
      const res = await refreshConnectorTools(c.id, [t.mcpToolName]);
      const item = res.refreshed[0];
      if (!item) toast.warning('Tool unavailable on the server', { description: `${t.mcpToolName} kept locally (no silent destruction).` });
      else if (item.changed) toast.success('Schema updated', { description: `${t.mcpToolName}: ${item.summary}` });
      else toast.info('Schema unchanged', { description: t.mcpToolName });
    } catch (e) {
      toast.error('Refresh failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const toolRemove = (c: ConnectorDTO, t: ImportedToolDTO) => void withBusy(c.id, async () => {
    try {
      await removeImportedTool(c.id, t.mcpToolName);
      toast.success('Imported tool removed', { description: `${t.name} removed from NexTool — the remote MCP server is untouched.` });
    } catch (e) {
      toast.error('Remove failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const toggleEnabled = (c: ConnectorDTO, enabled: boolean) => void withBusy(c.id, async () => {
    try {
      await updateConnector(c.id, { enabled });
      toast.info(enabled ? 'Connector enabled' : 'Connector disabled', { description: c.name });
    } catch (e) {
      toast.error('Update failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  // ---------- v1.0.13 §5 — customizable authentication handlers ----------

  /** Scope edits (§5.3) persist into connector config.scopes (arbitrary scope
   *  strings are valid — the provider decides). Also declares the method. */
  const setAuthMethod = (c: ConnectorDTO, m: McpAuthMethodDTO, opts?: { addScope?: string; removeScope?: string }) => {
    if (opts?.addScope || opts?.removeScope) {
      const provider = providers.find((p) => p.id === c.providerId);
      const defaults = provider?.authentication.oauth?.defaultScopes ?? [];
      const raw = c.config?.scopes;
      const current = typeof raw === 'string' && raw.trim()
        ? raw.split(/[\s,]+/).filter(Boolean)
        : Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : defaults;
      const next = opts.addScope
        ? [...new Set([...current, opts.addScope])]
        : current.filter((s) => s !== opts.removeScope);
      void withBusy(c.id, async () => {
        try {
          await updateConnector(c.id, { config: { scopes: next.join(' ') } });
          toast.success('Scopes updated', { description: `${next.length} scope(s) — used by the next OAuth login.` });
        } catch (e) {
          toast.error('Could not update scopes', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
        }
      });
      return;
    }
    if (m === 'none' || m === 'oauth2') {
      // Declared without typed fields — 'none' needs nothing; 'oauth2' gets its
      // tokens from the redirect (client id/secret are OPTIONAL credential fields).
      void withBusy(c.id, async () => {
        try {
          await setConnectorCredentials(c.id, {}, m);
          toast.info('Authentication method set', { description: `${c.name} — ${AUTH_METHOD_LABELS[m]}.` });
        } catch (e) {
          toast.error('Could not set method', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
        }
      });
      return;
    }
    // Token methods open the credentials dialog scoped to the method fields.
    const provider = providers.find((p) => p.id === c.providerId);
    setCred({ connector: c, provider, values: {}, show: {}, busy: false, method: m });
  };

  /** §5.1 — the user confirmed; begin the redirect flow. */
  const startOAuth = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      const res = await startConnectorOAuth(c.id);
      window.location.assign(res.authorizeUrl);
    } catch (e) {
      toast.error('Could not start the OAuth login', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const refreshAuth = (c: ConnectorDTO) => void withBusy(c.id, async () => {
    try {
      const res = await connectorRefreshAuth(c.id);
      toast.success('Access token refreshed', { description: res.tokenExpiresAt ? `New expiry: ${res.tokenExpiresAt}` : c.name });
    } catch (e) {
      toast.error('Token refresh failed', { description: e instanceof ApiClientError ? e.message : 'Unknown error' });
    }
  });

  const providers = data?.providers ?? [];
  const connectors = data?.connectors ?? [];
  const supportedProviders = useMemo(() => providers.filter((p) => p.enabled), [providers]);
  const existingProviderIds = useMemo(() => new Set(connectors.map((c) => c.providerId)), [connectors]);

  return (
    <div className="space-y-5">
      <SectionTitle
        icon={<Plug className="size-4 text-sky-300" aria-hidden />}
        title="Connectors"
        desc="MCP client connections — authenticate, connect, discover and import external MCP server tools."
        right={
          <Button
            size="sm"
            className="bg-primary-gradient min-h-9 gap-1.5 text-primary-foreground hover:opacity-90"
            onClick={() => supportedProviders.length > 0 && setAdd({ provider: supportedProviders[0], name: '', config: {}, busy: false })}
            disabled={supportedProviders.length === 0}
          >
            <Plus className="size-3.5" aria-hidden /> Add connector
          </Button>
        }
      />

      {/* supported MCP servers (JSON registry) */}
      {error && data === null ? (
        <ErrorCard title="Connector registry unavailable" message={error} onRetry={() => void load()} />
      ) : data === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {supportedProviders.map((p) => {
            const has = existingProviderIds.has(p.id);
            return (
              <div key={p.id} className="glass-card flex flex-col rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-sm font-semibold text-foreground">{p.name}</p>
                  {has ? <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 font-mono text-[10px] text-emerald-300">in use</Badge> : null}
                </div>
                <p className="mt-1 line-clamp-2 break-words text-[11px] text-muted-foreground">{p.description}</p>
                <div className="mt-2 font-mono text-[10px] text-muted-foreground">{p.transport.type} · auth: {p.authentication.type}</div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3 min-h-9 w-full border-white/[0.09] bg-white/[0.04] text-xs"
                  onClick={() => setAdd({ provider: p, name: '', config: {}, busy: false })}
                >
                  <Plus className="size-3.5" aria-hidden /> {has ? 'Add another' : 'Add connector'}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {/* connector instances */}
      {data !== null && connectors.length === 0 ? (
        <EmptyState
          icon={<PlugZap className="size-6" aria-hidden />}
          title="No connectors configured"
          hint="Add a connector for a supported MCP server, set its credentials, then connect and import its tools."
        />
      ) : null}
      {data !== null && connectors.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {connectors.map((c) => (
            <ConnectorCard
              key={c.id}
              connector={c}
              providers={providers}
              busy={busyId === c.id}
              onConnect={connect}
              onDisconnect={disconnect}
              onReconnect={reconnect}
              onDiscover={openDiscover}
              onCredentials={openCredentials}
              onRemove={setRemoveCandidate}
              onRefreshAll={refreshAll}
              onToolToggle={toolToggle}
              onToolRefresh={toolRefresh}
              onToolRemove={toolRemove}
              onToggleEnabled={toggleEnabled}
              onSetAuthMethod={setAuthMethod}
              onStartOAuth={(c) => setOauthConfirm(c)}
              onRefreshAuth={refreshAuth}
            />
          ))}
        </div>
      ) : null}

      {data !== null && connectors.length > 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Wrench className="size-3.5" aria-hidden />
          Imported MCP tools appear in the Tools registry with environment <span className="font-mono">mcp</span> and execute through their connector inside the normal tool lifecycle.
        </p>
      ) : null}

      {/* v1.0.13 §5.1 — EXPLICIT confirmation before ANY external OAuth redirect */}
      <AlertDialog open={oauthConfirm !== null} onOpenChange={(v) => (!v ? setOauthConfirm(null) : undefined)}>
        <AlertDialogContent className="glass-strong">
          <AlertDialogHeader>
            <AlertDialogTitle>
              This connector will open an external authentication page.
            </AlertDialogTitle>
            <AlertDialogDescription>
              Continue to {oauthConfirm ? (providers.find((p) => p.id === oauthConfirm.providerId)?.name ?? oauthConfirm.providerName) : 'the provider'}?
              {' '}NexTool will redirect you to the provider&apos;s login, receive the callback and exchange the code for tokens server-side.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/[0.09] bg-white/[0.04]">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-primary-gradient text-primary-foreground hover:opacity-90"
              onClick={(e) => {
                e.preventDefault();
                if (oauthConfirm) {
                  const target = oauthConfirm;
                  setOauthBusy(true);
                  startOAuth(target).finally(() => {
                    setOauthBusy(false);
                    setOauthConfirm(null);
                  });
                }
              }}
              disabled={oauthBusy}
            >
              {oauthBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null} Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddConnectorDialog state={add} onPatch={(patch) => setAdd((s) => (s ? { ...s, ...patch } : s))} onClose={() => setAdd(null)} onCreated={() => void load()} />
      <CredentialsDialog state={cred} onPatch={(patch) => setCred((s) => (s ? { ...s, ...patch } : s))} onClose={() => setCred(null)} onSaved={() => void load()} />
      <DiscoveryDialog state={discover} onPatch={(patch) => setDiscover((s) => (s ? { ...s, ...patch } : s))} onClose={() => setDiscover(null)} onImported={() => void load()} />

      {/* remove-connector confirmation */}
      <Dialog open={removeCandidate !== null} onOpenChange={(v) => (!v ? setRemoveCandidate(null) : undefined)}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove connector “{removeCandidate?.name}”?</DialogTitle>
            <DialogDescription>
              This removes the connector {removeCandidate?.importedTools.length ? `and its ${removeCandidate.importedTools.length} imported MCP tool(s) ` : ''}from NexTool.
              The remote MCP server and its tools are NOT touched. Credentials stored for this connector are deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" className="border-white/[0.09] bg-white/[0.04]" onClick={() => setRemoveCandidate(null)}>Cancel</Button>
            <Button size="sm" className="border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20" onClick={() => void confirmRemove()} disabled={removing}>
              {removing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Trash2 className="size-3.5" aria-hidden />} Remove connector
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
