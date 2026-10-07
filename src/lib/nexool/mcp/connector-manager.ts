/**
 * NexTool v1.0.13 — Connector manager (spec §1.1-§1.18, §4/§5/§8).
 *
 * DB-backed (Prisma McpConnector + McpCredential) state machine that owns:
 *   - connector CRUD (instances of providers from the JSON registry)
 *   - server-side credential storage (values NEVER leave the backend)
 *   - connection lifecycle: connect / disconnect / reconnect + the REAL
 *     status model (not_connected | connecting | auth_required | connected |
 *     disconnected | error | reconnecting) reconciled against live sessions
 *   - tool discovery (initialize → listTools) + FULL capability discovery
 *     (§4: resources / resource templates / prompts / server capabilities)
 *   - the `mcp` tool environment: imported tools are ToolRecords whose
 *     definition carries identity (connectorId + mcpToolName + converted
 *     schema) and NEVER credentials (§1.14)
 *   - schema refresh with local-metadata preservation (§1.16)
 *   - disconnect/reconnect semantics: imported tools survive disconnects and
 *     become unavailable until the connector is back (§1.17)
 *   - §8 — identity-stable imported-tool lookup (`findImportedTool`): enable/
 *     disable/remove accept the registry name, the REMOTE mcpToolName or a
 *     registry-name pattern, and always resolve to the STABLE ToolRecord name
 *     (toggle state survives reloads and reconnects — nothing re-imports or
 *     renames imported tools on connect)
 *   - §5 — customizable authentication: OAuth 2.0 authorization-code engine
 *     (start → pending-state store → callback exchange → credential store),
 *     lazy + explicit refresh-token rotation and best-effort token validation
 *
 * Protocol handling stays inside mcp/client.ts (official SDK) — this file
 * orchestrates; it never speaks MCP itself. The OAuth token endpoints are the
 * only outbound HTTP this module performs, and token values never reach a
 * log, an event or an API response.
 */

import crypto from 'node:crypto';
import { db } from '@/lib/db';
import type { McpConnectorStatus, McpToolRef, ToolDefinition } from '../types';
import { emitEvent } from '../eventbus';
import { invalidateCachedHandler } from '../tools/registry';
import type { ToolEntryFull } from '../tools/registry';
import { createMcpClient, McpAuthError, McpConnectionError } from './client';
import type { McpRemotePrompt, McpRemoteResource, McpRemoteResourceTemplate, McpRemoteTool } from './client';
import { getMcpProvider, listMcpProviders, mcpProviderRegistryVersion, providerAuthMethods, requiredFieldsForMethod } from './provider-registry';
import type { McpAuthMethod, McpProvider, McpProviderOAuthPreset } from './provider-registry';
import { hashInputSchema, mcpInputSchemaToNexoolSchema } from './schema-convert';
import { dropLiveClient, getLiveClient, hasLiveClient, isConnecting, setLiveClient, trackPending } from './runtime-registry';

// ---------- structured failures ----------

/** Structured failure carrying a STABLE code — the API maps it 1:1. */
export class McpConnectorFailure extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpConnectorFailure';
    this.code = code;
  }
}

/** Map any thrown error into a stable connector failure code. */
export function toConnectorFailure(err: unknown, fallbackCode = 'MCP_CONNECTION_FAILED'): McpConnectorFailure {
  if (err instanceof McpConnectorFailure) return err;
  if (err instanceof McpAuthError) return new McpConnectorFailure('MCP_AUTH_REQUIRED', err.message);
  if (err instanceof McpConnectionError) return new McpConnectorFailure('MCP_CONNECTION_FAILED', err.message);
  return new McpConnectorFailure(fallbackCode, err instanceof Error ? err.message : String(err));
}

// ---------- DTOs (BINDING response shapes for /api/connectors) ----------

export interface ImportedToolDTO {
  /** NexTool registry name (environment 'mcp'). */
  name: string;
  mcpToolName: string;
  description: string;
  enabled: boolean;
  paramCount: number;
  remoteHash?: string;
  importedAt?: string;
  lastRefreshedAt?: string;
  /** The user edited the description locally — Refresh preserves it. */
  customizedDescription: boolean;
}

export interface ConnectorDTO {
  id: string;
  providerId: string;
  providerName: string;
  providerDescription: string;
  providerCategory: string;
  docsUrl?: string;
  transportType: 'stdio' | 'http';
  authType: string;
  /** Non-secret transport config (command/args/url) for the UI forms. */
  config: Record<string, unknown>;
  enabled: boolean;
  status: McpConnectorStatus;
  statusDetail?: string | null;
  lastError?: string | null;
  lastConnectedAt?: string | null;
  /** Credential PRESENCE info only — values never leave the server (§1.7). */
  hasCredentials: boolean;
  credentialFieldsProvided: string[];
  missingRequiredFields: string[];
  authRequired: boolean;
  /** §5 — effective selectable auth method (stored on the connector or inferred from stored fields). */
  authMethod?: McpAuthMethod;
  /** §5 — true when a refresh token is stored (presence only, NEVER the value) — enables the Refresh-token action. */
  hasRefreshToken?: boolean;
  /** Remote server identity when connected (from the initialize handshake). */
  serverInfo?: { name: string; version: string } | null;
  importedTools: ImportedToolDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveredToolDTO {
  name: string;
  title?: string;
  description?: string;
  /** Raw MCP inputSchema (JSON Schema) — displayed/inspected in the UI. */
  inputSchema: unknown;
  remoteHash: string;
  imported: boolean;
  /** NexTool registry name when already imported. */
  importedToolName?: string;
}

// ---------- §4 — capability discovery beyond tools ----------

/** A resource exposed by the connected MCP server (may be many, read by URI). */
export interface DiscoveredResourceDTO {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A URI template describing how resource URIs are built on this server. */
export interface DiscoveredResourceTemplateDTO {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** A reusable prompt template offered by the server. */
export interface DiscoveredPromptDTO {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** Server identity + the capability object the server itself declared. */
export interface DiscoveredServerInfoDTO {
  name: string;
  version: string;
  capabilities: Record<string, unknown> | null;
}

/** GET /api/connectors/[id]/tools — discovery response (§1.9 + §4). */
export interface DiscoveryResultDTO {
  connected: boolean;
  tools: DiscoveredToolDTO[];
  /** §4 — servers without the capability answer an empty array (never throws). */
  resources: DiscoveredResourceDTO[];
  resourceTemplates: DiscoveredResourceTemplateDTO[];
  prompts: DiscoveredPromptDTO[];
  /** §4 — initialize handshake identity + declared capabilities. */
  serverInfo: DiscoveredServerInfoDTO | null;
}

// ---------- small helpers ----------

const CONNECT_TIMEOUT_MS = 60_000;

function newConnectorId(): string {
  return `mconn_${crypto.randomBytes(8).toString('hex')}`;
}

function slugify(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'x';
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function iso(d: Date | null | undefined): string | undefined {
  return d ? d.toISOString() : undefined;
}

async function emitConnectorEvent(
  type: string,
  connector: { id: string; name: string; providerId: string },
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  void emitEvent({
    type,
    source: 'system',
    message,
    data: { connectorId: connector.id, connectorName: connector.name, providerId: connector.providerId, ...(data ?? {}) },
    priority: 6,
  });
}

// ---------- §5 — auth state + OAuth helpers (NON-secret data only) ----------

/**
 * Non-secret per-connector auth state (Prisma `auth` column, JSON-encoded):
 * { method, authenticatedAt, tokenExpiresAt, lastRefreshAt, lastError }.
 * TOKENS NEVER LIVE HERE — they are stored in McpCredential.secret only.
 */
interface ConnectorAuthState {
  method?: McpAuthMethod;
  authenticatedAt?: string;
  tokenExpiresAt?: string;
  lastRefreshAt?: string;
  lastError?: string | null;
}

function readAuthState(row: { auth: string | null }): ConnectorAuthState {
  return parseJson<ConnectorAuthState>(row.auth, {});
}

/** Merge-patch the auth state column (null clears it). */
async function writeAuthState(id: string, patch: Partial<ConnectorAuthState> | null): Promise<void> {
  const current = await db.mcpConnector.findUnique({ where: { id }, select: { auth: true } });
  const merged: ConnectorAuthState = patch === null ? {} : { ...parseJson<ConnectorAuthState>(current?.auth, {}), ...patch };
  await db.mcpConnector.update({ where: { id }, data: { auth: JSON.stringify(merged) } });
}

function isAuthMethod(v: unknown): v is McpAuthMethod {
  return v === 'none' || v === 'bearer' || v === 'token_pair' || v === 'oauth2';
}

const ACCESS_FIELD_CANDIDATES = ['accessToken', 'access_token', 'token'];
const REFRESH_FIELD_CANDIDATES = ['refreshToken', 'refresh_token'];

/** First credential field with a non-empty string value among the candidates. */
function firstNonEmpty(values: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = values[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/** §5.2 — OAuth client credentials resolve from the stored credential fields first, then non-secret config. */
function resolveOauthClientCredentials(config: Record<string, unknown>, values: Record<string, unknown>): { clientId?: string; clientSecret?: string } {
  const clientId = firstNonEmpty(values, ['clientId', 'client_id']) ?? firstNonEmpty(config, ['clientId', 'client_id']);
  const clientSecret = firstNonEmpty(values, ['clientSecret', 'client_secret']) ?? firstNonEmpty(config, ['clientSecret', 'client_secret']);
  return { ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) };
}

/** Connector config scopes (string "a b c", "a,b" or array) override the preset defaults (§5.3). */
function resolveConnectorScopes(provider: McpProvider, config: Record<string, unknown>): string[] {
  const raw = config.scopes;
  let scopes: string[] = [];
  if (typeof raw === 'string') scopes = raw.split(/[\s,]+/).filter(Boolean);
  else if (Array.isArray(raw)) scopes = raw.filter((s): s is string => typeof s === 'string');
  if (scopes.length === 0) scopes = provider.authentication.oauth?.defaultScopes ?? [];
  return [...new Set(scopes.map((s) => s.trim()).filter(Boolean))];
}

/** Endpoint override from the connector config, falling back to the preset. */
function resolveOauthEndpoint(config: Record<string, unknown>, preset: McpProviderOAuthPreset | undefined, key: 'authorizeUrl' | 'tokenUrl'): string | undefined {
  const override = config[key];
  if (typeof override === 'string' && /^https?:\/\//i.test(override.trim())) return override.trim();
  return preset?.[key];
}

/**
 * §5.5 — best-effort manual-token validation. NEVER blocks a save: network
 * failures degrade to an honest statusDetail suffix. The token itself is only
 * ever sent to the provider's own validation endpoint.
 */
async function validateProviderToken(provider: McpProvider, accessToken: string | undefined): Promise<string | null> {
  const strategy = provider.authentication.validation ?? 'none';
  if (strategy === 'none' || !accessToken) return null;
  try {
    if (strategy === 'google_tokeninfo') {
      const res = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return `token validation failed (HTTP ${res.status})`;
      const data = (await res.json()) as { email?: unknown; sub?: unknown };
      const user = typeof data.email === 'string' && data.email ? data.email : typeof data.sub === 'string' ? data.sub : 'unknown';
      return `token validated (user: ${user})`;
    }
    if (strategy === 'github_user') {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'NexTool-Q1' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return `token validation failed (HTTP ${res.status})`;
      const data = (await res.json()) as { login?: unknown };
      const user = typeof data.login === 'string' && data.login ? data.login : 'unknown';
      return `token validated (user: ${user})`;
    }
  } catch {
    return 'token validation unavailable (network) — credentials saved anyway';
  }
  return null;
}

// ---------- rows → DTO ----------

/** Connector row INCLUDING the credential relation (server-side only). */
interface ConnectorRowWithCredential {
  id: string;
  providerId: string;
  name: string;
  config: string;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  lastError: string | null;
  lastConnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  credential: { connectorId: string; type: string; secret: string; updatedAt: Date } | null;
  /** §5 — non-secret auth state JSON (method/expiry/refresh timestamps). */
  auth: string | null;
  /** §4.5 — last capability snapshot JSON (best-effort, never read for status). */
  capabilities: string | null;
}

type ConnectorRow = ConnectorRowWithCredential;

interface CredentialInfo {
  type: string;
  values: Record<string, unknown>;
}

function readCredential(row: ConnectorRow): CredentialInfo | null {
  if (!row?.credential) return null;
  return { type: row.credential.type, values: parseJson<Record<string, unknown>>(row.credential.secret, {}) };
}

/** Names of credential fields with a non-empty stored value (NO values). */
function providedFieldNames(provider: McpProvider, cred: CredentialInfo | null): string[] {
  if (!cred) return [];
  return provider.authentication.fields
    .filter((f) => {
      const v = cred.values[f.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    })
    .map((f) => f.key);
}

function missingRequiredFields(provider: McpProvider, cred: CredentialInfo | null): string[] {
  const provided = new Set(providedFieldNames(provider, cred));
  return provider.authentication.requiredFields.filter((f) => !provided.has(f));
}

/** All imported (environment 'mcp') tools belonging to one connector. */
export async function listImportedToolsForConnector(connectorId: string): Promise<(ToolEntryFull & { mcp: McpToolRef })[]> {
  const rows = await db.toolRecord.findMany({ where: { environment: 'mcp' } });
  const out: (ToolEntryFull & { mcp: McpToolRef })[] = [];
  for (const row of rows) {
    const def = parseJson<ToolDefinition | null>(row.definition, null);
    const ref = def?.mcp;
    if (def && ref && ref.connectorId === connectorId) {
      out.push({
        name: row.name,
        description: row.description,
        purpose: row.purpose ?? undefined,
        category: row.category,
        environment: 'mcp',
        definition: def,
        schema: def.schema,
        metadata: def.metadata,
        autoExecute: def.autoExecute === true,
        enabled: row.enabled,
        mcp: ref,
        stats: {
          callCount: row.callCount,
          successCount: row.successCount,
          failureCount: row.failureCount,
          timeoutCount: row.timeoutCount,
          avgMs: row.callCount > 0 ? Math.round(row.totalMs / row.callCount) : 0,
          enabled: row.enabled,
        },
        createdAt: row.createdAt.toISOString(),
      });
    }
  }
  return out.sort((a, b) => a.mcp.mcpToolName.localeCompare(b.mcp.mcpToolName));
}

function importedToolDTO(entry: ToolEntryFull & { mcp: McpToolRef }): ImportedToolDTO {
  return {
    name: entry.name,
    mcpToolName: entry.mcp.mcpToolName,
    description: entry.description,
    enabled: entry.enabled,
    paramCount: entry.schema?.properties?.length ?? 0,
    remoteHash: entry.mcp.remoteHash,
    importedAt: entry.mcp.importedAt,
    lastRefreshedAt: entry.mcp.lastRefreshedAt,
    customizedDescription: entry.mcp.customizedDescription === true,
  };
}

function connectorToDTO(row: NonNullable<ConnectorRow>, provider: McpProvider, imported: (ToolEntryFull & { mcp: McpToolRef })[]): ConnectorDTO {
  const cred = readCredential(row);
  const missing = missingRequiredFields(provider, cred);
  const live = getLiveClient(row.id);
  const serverInfo = live?.getServerInfo() ?? null;
  const authState = readAuthState(row);
  return {
    id: row.id,
    providerId: provider.id,
    // v1.0.13 §6 — the connector's own display name MUST be serialized: every
    // label in the UI/logs comes from this metadata (never a hardcoded
    // provider name). Its absence rendered blank connector names.
    name: row.name,
    providerName: provider.name,
    providerDescription: provider.description,
    providerCategory: provider.category,
    ...(provider.docsUrl ? { docsUrl: provider.docsUrl } : {}),
    transportType: provider.transport.type,
    authType: provider.authentication.type,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    enabled: row.enabled,
    status: row.status as McpConnectorStatus,
    statusDetail: row.statusDetail,
    lastError: row.lastError,
    lastConnectedAt: iso(row.lastConnectedAt) ?? null,
    hasCredentials: !!cred,
    credentialFieldsProvided: providedFieldNames(provider, cred),
    missingRequiredFields: missing,
    authRequired: missing.length > 0,
    authMethod: isAuthMethod(authState.method) ? authState.method : inferAuthMethod(provider, cred),
    hasRefreshToken: !!firstNonEmpty(cred?.values ?? {}, REFRESH_FIELD_CANDIDATES),
    serverInfo,
    importedTools: imported.map(importedToolDTO),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * §5 — infer the auth method the UI preselects when none is stored: the
 * stored credential fields drive it (refresh token → token_pair, access
 * token → bearer, client id → oauth2); otherwise the provider's first method.
 */
function inferAuthMethod(provider: McpProvider, cred: CredentialInfo | null): McpAuthMethod {
  const methods = providerAuthMethods(provider);
  const values = cred?.values ?? {};
  const hasRefresh = !!firstNonEmpty(values, REFRESH_FIELD_CANDIDATES);
  const hasAccess = !!firstNonEmpty(values, ACCESS_FIELD_CANDIDATES);
  const { clientId } = resolveOauthClientCredentials({}, values);
  if (hasRefresh && methods.includes('token_pair')) return 'token_pair';
  if (hasAccess && methods.includes('bearer')) return 'bearer';
  if (clientId && methods.includes('oauth2')) return 'oauth2';
  return methods[0] ?? 'bearer';
}

// ---------- status reconciliation (honest statuses, §1.8) ----------

/**
 * A DB row is only "connected" if a live client exists in THIS process.
 * After a server restart every DB 'connected' row is a stale claim — the
 * reconcile pass demotes such rows to 'disconnected' (session lost) and
 * heals interrupted 'connecting'/'reconnecting' rows.
 */
async function reconcileRow(row: NonNullable<ConnectorRow>): Promise<NonNullable<ConnectorRow>> {
  const live = hasLiveClient(row.id);
  const inFlight = isConnecting(row.id);
  let status = row.status as McpConnectorStatus;
  let statusDetail = row.statusDetail;
  const updates: Partial<{ status: string; statusDetail: string | null }> = {};

  if (!live && !inFlight && status === 'connected') {
    status = 'disconnected';
    statusDetail = 'Session lost — the runtime restarted. Reconnect to make this connector available again.';
    updates.status = status;
    updates.statusDetail = statusDetail;
  }
  if (!inFlight && (status === 'connecting' || status === 'reconnecting')) {
    status = 'not_connected';
    statusDetail = 'Connection attempt was interrupted.';
    updates.status = status;
    updates.statusDetail = statusDetail;
  }
  if (live && status !== 'connected' && !inFlight) {
    status = 'connected';
    statusDetail = null;
    updates.status = status;
    updates.statusDetail = null;
  }
  if (Object.keys(updates).length === 0) return row;
  // re-fetch with the credential relation so the row keeps its full shape
  return getRow(row.id);
}

async function getRow(id: string): Promise<NonNullable<ConnectorRow>> {
  const row = await db.mcpConnector.findUnique({ where: { id }, include: { credential: true } });
  if (!row) throw new McpConnectorFailure('CONNECTOR_NOT_FOUND', `No connector with id "${id}".`);
  return row;
}

function getProviderOrThrow(providerId: string): McpProvider {
  const provider = getMcpProvider(providerId);
  if (!provider) {
    throw new McpConnectorFailure('PROVIDER_UNKNOWN', `Provider "${providerId}" is not in the MCP server registry.`);
  }
  return provider;
}

async function getDTO(row: NonNullable<ConnectorRow>): Promise<ConnectorDTO> {
  const provider = getProviderOrThrow(row.providerId);
  const imported = await listImportedToolsForConnector(row.id);
  return connectorToDTO(row, provider, imported);
}

// ---------- queries ----------

/** All supported providers (from the JSON registry) + all connector instances. */
export async function listConnectors(): Promise<{
  registryVersion: number;
  providers: ReturnType<typeof listMcpProviders>;
  connectors: ConnectorDTO[];
}> {
  const rows = await db.mcpConnector.findMany({ orderBy: { createdAt: 'asc' }, include: { credential: true } });
  const reconciled = await Promise.all(rows.map(reconcileRow));
  const connectors = await Promise.all(reconciled.map(getDTO));
  return { registryVersion: mcpProviderRegistryVersion(), providers: listMcpProviders(), connectors };
}

export async function getConnectorDTOById(id: string): Promise<ConnectorDTO> {
  const row = await reconcileRow(await getRow(id));
  return getDTO(row);
}

// ---------- mutations: connectors ----------

export interface CreateConnectorInput {
  providerId: string;
  name?: string;
  config?: Record<string, unknown>;
}

export async function createConnector(input: CreateConnectorInput): Promise<ConnectorDTO> {
  const provider = getProviderOrThrow(input.providerId);
  if (!provider.enabled) {
    throw new McpConnectorFailure('PROVIDER_DISABLED', `Provider "${provider.id}" is disabled in the registry.`);
  }
  const name = input.name?.trim() || provider.name;
  const existing = await db.mcpConnector.findFirst({ where: { name } });
  if (existing) {
    throw new McpConnectorFailure('CONNECTOR_ALREADY_EXISTS', `A connector named "${name}" already exists.`);
  }
  const config = sanitizeConfig(provider, input.config ?? {});
  const row = await db.mcpConnector.create({
    data: {
      id: newConnectorId(),
      providerId: provider.id,
      name,
      config: JSON.stringify(config),
      status: 'not_connected',
      statusDetail: missingRequiredFields(provider, null).length > 0
        ? 'Credentials required before connecting.'
        : null,
    },
    include: { credential: true },
  });
  await emitConnectorEvent('connector.created', row, `MCP connector "${row.name}" created (${provider.name}).`);
  return getDTO(row);
}

/**
 * Keep only keys the provider's configFields declare; drop everything else.
 * §5 exception: when the provider declares an OAuth preset, the connector may
 * carry NON-secret OAuth overrides — `scopes` (string "a b c" / array →
 * stored as a clean string array) and https authorizeUrl/tokenUrl overrides.
 */
function sanitizeConfig(provider: McpProvider, config: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(provider.transport.configFields.map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (allowed.has(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
  }
  const preset = provider.authentication.oauth;
  if (preset) {
    const raw = config.scopes;
    if (typeof raw === 'string') {
      // the UI PATCHes scopes as a space/comma separated string (schema-safe);
      // an empty string is an explicit "no scopes" reset.
      out.scopes = [...new Set(raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    } else if (Array.isArray(raw)) {
      out.scopes = [...new Set(raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()))];
    }
    for (const key of ['authorizeUrl', 'tokenUrl'] as const) {
      const v = config[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) out[key] = v.trim();
    }
  }
  return out;
}

export interface UpdateConnectorInput {
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export async function updateConnector(id: string, input: UpdateConnectorInput): Promise<ConnectorDTO> {
  const row = await getRow(id);
  const provider = getProviderOrThrow(row.providerId);
  const data: Record<string, unknown> = {};
  if (input.name !== undefined && input.name.trim() && input.name.trim() !== row.name) {
    const clash = await db.mcpConnector.findFirst({ where: { name: input.name.trim() } });
    if (clash && clash.id !== id) {
      throw new McpConnectorFailure('CONNECTOR_ALREADY_EXISTS', `A connector named "${input.name.trim()}" already exists.`);
    }
    data.name = input.name.trim();
  }
  if (input.config !== undefined) {
    data.config = JSON.stringify({ ...parseJson<Record<string, unknown>>(row.config, {}), ...sanitizeConfig(provider, input.config) });
  }
  if (input.enabled !== undefined) {
    data.enabled = input.enabled === true;
  }
  // A config change invalidates the live session honestly.
  const hadLive = hasLiveClient(id);
  if (hadLive) await dropLiveClient(id);
  if (hadLive) {
    data.status = 'disconnected';
    data.statusDetail = 'Configuration changed — reconnect required.';
  }
  const updated = await db.mcpConnector.update({ where: { id }, data, include: { credential: true } });
  await emitConnectorEvent('connector.updated', updated, `MCP connector "${updated.name}" updated.`);
  return getDTO(updated);
}

export async function deleteConnector(id: string): Promise<{ deleted: true; id: string; removedTools: string[] }> {
  const row = await getRow(id);
  // Imported tools (environment 'mcp' owned by this connector) are removed —
  // the REMOTE server and its tools are untouched (§1.15).
  const imported = await listImportedToolsForConnector(id);
  const removedNames = imported.map((t) => t.name);
  if (removedNames.length > 0) {
    await db.toolRecord.deleteMany({ where: { name: { in: removedNames } } });
    for (const name of removedNames) invalidateCachedHandler(name);
  }
  await dropLiveClient(id);
  await db.mcpConnector.delete({ where: { id } });
  await emitConnectorEvent(
    'connector.deleted',
    { id, name: row.name, providerId: row.providerId },
    `MCP connector "${row.name}" removed (${removedNames.length} imported tool(s) removed from NexTool).`,
    { removedTools: removedNames },
  );
  return { deleted: true, id, removedTools: removedNames };
}

// ---------- credentials (server-side only, §1.7) ----------

export interface SetCredentialsInput {
  type?: string;
  values: Record<string, unknown>;
  /** v1.0.13 §5 — declare the EFFECTIVE auth method with the same request
   *  (stored in the non-secret auth state; tokens never live here). */
  authMethod?: McpAuthMethod;
}

export async function setCredentials(id: string, input: SetCredentialsInput): Promise<ConnectorDTO> {
  const row = await getRow(id);
  const provider = getProviderOrThrow(row.providerId);
  const auth = provider.authentication;
  const current = readCredential(row);
  // Merge with the stored values so a partial update (e.g. rotating one field)
  // does not silently erase the others. Empty strings delete a field.
  const merged: Record<string, unknown> = { ...(current?.values ?? {}) };
  // v1.0.13 §5 — the effective method for THIS save: the declared one wins,
  // then the previously stored one, then the provider legacy default.
  const effectiveMethod: McpAuthMethod | undefined = input.authMethod
    ?? (isAuthMethod(readAuthState(row).method) ? readAuthState(row).method : undefined)
    ?? inferAuthMethod(provider, current);
  const allowed = new Set(auth.fields.map((f) => f.key));
  // §5.3 — the OAuth login UI stores client id/secret as credential fields
  // even when the provider preset does not declare them as typed fields.
  if (auth.oauth) {
    for (const key of ['clientId', 'clientSecret', 'client_id', 'client_secret']) allowed.add(key);
  }
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if (!allowed.has(k)) continue;
    if (v === null || (typeof v === 'string' && v.trim() === '')) delete merged[k];
    else merged[k] = typeof v === 'string' ? v : String(v);
  }
  // v1.0.13 §5 — required fields are METHOD-AWARE (requiredFieldsByMethod):
  // 'none' requires nothing, 'oauth2' needs the stored tokens only AFTER the
  // redirect login, token modes need their declared fields.
  const requiredForMethod = requiredFieldsForMethod(provider, effectiveMethod);
  const missing = requiredForMethod.filter((f) => {
    const v = merged[f];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missing.length > 0) {
    throw new McpConnectorFailure('MCP_AUTH_REQUIRED', `Missing required credential fields: ${missing.join(', ')}.`);
  }
  await db.mcpCredential.upsert({
    where: { connectorId: id },
    update: { type: input.type ?? current?.type ?? auth.type, secret: JSON.stringify(merged) },
    create: { connectorId: id, type: input.type ?? auth.type, secret: JSON.stringify(merged) },
  });
  // v1.0.13 §5 — persist the EFFECTIVE auth method when the UI declares one.
  if (input.authMethod) {
    await writeAuthState(id, { method: input.authMethod, lastError: null });
  }
  // New credentials invalidate a previous auth_required state honestly.
  const status: McpConnectorStatus = hasLiveClient(id) ? 'connected' : row.status === 'auth_required' ? 'not_connected' : (row.status as McpConnectorStatus);
  // §5.5 — best-effort validation of the stored access token (never blocks).
  const validation = await validateProviderToken(provider, firstNonEmpty(merged, ACCESS_FIELD_CANDIDATES));
  const statusDetail = [status === 'not_connected' ? 'Credentials stored — connect when ready.' : null, validation].filter(Boolean).join(' · ') || null;
  await db.mcpConnector.update({
    where: { id },
    data: {
      status,
      ...(statusDetail ? { statusDetail } : {}),
    },
  });
  await emitConnectorEvent('connector.credentials.set', row, `Credentials updated for MCP connector "${row.name}"${validation ? ` (${validation})` : ''}.`);
  return getConnectorDTOById(id);
}

export async function clearCredentials(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  await db.mcpCredential.deleteMany({ where: { connectorId: id } });
  // §5 — the non-secret auth state (method/expiry/refresh timestamps) belonged
  // to the removed credential — clear it too so the UI infers a clean method.
  await writeAuthState(id, null);
  if (!hasLiveClient(id)) {
    await db.mcpConnector.update({ where: { id }, data: { status: 'not_connected', statusDetail: 'Credentials removed — connect requires credentials.' } });
  }
  await emitConnectorEvent('connector.credentials.cleared', row, `Credentials removed for MCP connector "${row.name}".`);
  return getConnectorDTOById(id);
}

// ---------- connection lifecycle (§1.8/§1.17) ----------

interface ConnectOutcome {
  status: McpConnectorStatus;
  detail: string | null;
}

async function setStatus(id: string, status: McpConnectorStatus, detail: string | null, lastError?: string | null): Promise<void> {
  await db.mcpConnector.update({
    where: { id },
    data: {
      status,
      statusDetail: detail,
      ...(lastError !== undefined ? { lastError } : {}),
      ...(status === 'connected' ? { lastConnectedAt: new Date() } : {}),
    },
  });
}

/**
 * Connect one connector: resolve credentials (auth-type aware), build the
 * provider-declared transport through the client factory, perform the MCP
 * initialize handshake and persist the REAL resulting state.
 *
 * §5.4 — if the stored access token has an EXPIRY in the past and a refresh
 * token + token endpoint exist, it is refreshed transparently BEFORE the
 * handshake. A failed refresh is not fatal — the connect attempt itself
 * reports the honest auth error.
 *
 * §8 — connect NEVER re-imports or renames imported ToolRecords: their
 * enabled/disabled state and registry names survive reconnects untouched.
 */
export async function connectConnector(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  const provider = getProviderOrThrow(row.providerId);
  if (!row.enabled) {
    throw new McpConnectorFailure('CONNECTOR_DISABLED', `Connector "${row.name}" is disabled.`);
  }
  if (hasLiveClient(id)) return getConnectorDTOById(id); // already connected
  if (isConnecting(id)) return getConnectorDTOById(id); // connect already in flight

  let cred = readCredential(row);
  const missing = missingRequiredFields(provider, cred);
  if (missing.length > 0) {
    await setStatus(id, 'auth_required', `Credentials required (${missing.join(', ')}).`, null);
    throw new McpConnectorFailure('MCP_AUTH_REQUIRED', `Connect requires credentials (${missing.join(', ')}). Set them on the Connectors page first.`);
  }

  // §5.4 — lazy token refresh when the stored access token has expired.
  const authState = readAuthState(row);
  const expiresAtMs = authState.tokenExpiresAt ? Date.parse(authState.tokenExpiresAt) : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    const refresh = await tryRefreshToken(row);
    if (refresh.ok && refresh.values) {
      cred = { type: cred?.type ?? provider.authentication.type, values: refresh.values };
    }
    // A failed refresh is NOT fatal here — the handshake reports the truth.
  }

  const doConnect = async (): Promise<ConnectOutcome> => {
    await setStatus(id, 'connecting', `Connecting to ${provider.name}…`, null);
    await emitConnectorEvent('connector.connecting', row, `Connecting MCP connector "${row.name}" (${provider.name})…`);
    try {
      const client = await Promise.race([
        createMcpClient({
          connectorId: id,
          connectorName: row.name,
          provider,
          config: parseJson<Record<string, unknown>>(row.config, {}),
          credential: cred ? cred.values : null,
        }),
        // A hung transport (unreachable HTTP endpoint, stuck stdio child)
        // must never block the manager — bounded, honest connect window.
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new McpConnectionError(`Connect timed out after ${CONNECT_TIMEOUT_MS}ms.`)), CONNECT_TIMEOUT_MS);
          if (typeof t.unref === 'function') t.unref();
        }),
      ]);
      setLiveClient(id, client);
      const info = client.getServerInfo();
      await setStatus(id, 'connected', null, null);
      await emitConnectorEvent(
        'connector.connected',
        row,
        `MCP connector "${row.name}" connected${info ? ` — server ${info.name} ${info.version}` : ''}.`,
      );
      return { status: 'connected', detail: null };
    } catch (err) {
      const failure = toConnectorFailure(err);
      const status: McpConnectorStatus = failure.code === 'MCP_AUTH_REQUIRED' ? 'auth_required' : 'error';
      await setStatus(id, status, failure.message, failure.message);
      await emitConnectorEvent(
        status === 'auth_required' ? 'connector.auth_required' : 'connector.error',
        row,
        `MCP connector "${row.name}" failed to connect: ${failure.message}`,
      );
      return { status, detail: failure.message };
    }
  };

  await trackPending(id, doConnect());
  return getConnectorDTOById(id);
}

/** User-initiated disconnect. Imported tools stay registered (§1.17). */
export async function disconnectConnector(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  await dropLiveClient(id);
  await setStatus(id, 'disconnected', 'Disconnected by user. Imported tools stay registered but are unavailable until reconnect.', null);
  await emitConnectorEvent('connector.disconnected', row, `MCP connector "${row.name}" disconnected (imported tools unavailable).`);
  return getConnectorDTOById(id);
}

/** Drop whatever session exists and connect again. */
export async function reconnectConnector(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  if (hasLiveClient(id)) await dropLiveClient(id);
  await setStatus(id, 'reconnecting', 'Reconnecting…', null);
  return connectConnector(id);
}

// ---------- discovery (§1.9 + §4 capability super-discovery) ----------

/** Run one §4 capability listing — a missing method or a failing server degrades to []. */
async function safeCapabilityList<T>(list: (() => Promise<T[]>) | undefined): Promise<T[]> {
  if (!list) return [];
  try {
    return await list();
  } catch {
    return [];
  }
}

/**
 * Live discovery — requires a connected session. Returns the remote TOOLS
 * plus every OTHER capability the server advertised (§4): resources,
 * resource templates and prompts. Servers without a capability simply
 * contribute empty lists (client.ts never throws for missing capabilities).
 * A best-effort snapshot is written to the connector `capabilities` column
 * (§4.5) so the last-known capability set survives a dropped session.
 */
export async function discoverTools(id: string): Promise<DiscoveryResultDTO> {
  let row = await getRow(id);
  row = await reconcileRow(row);
  const client = getLiveClient(id);
  if (!client) {
    throw new McpConnectorFailure('MCP_NOT_CONNECTED', `Connector "${row.name}" is not connected (status: ${row.status}). Connect it to discover tools.`);
  }
  let remote: McpRemoteTool[];
  try {
    remote = await client.listTools();
  } catch (err) {
    const failure = toConnectorFailure(err);
    // The session died mid-discovery — reflect the truth.
    if (failure.code !== 'MCP_AUTH_REQUIRED') {
      await dropLiveClient(id);
      await setStatus(id, 'error', failure.message, failure.message);
    }
    throw failure;
  }
  // §4 — the extra capability lists are individually failure-proof (custom
  // factories may not implement them at all — optional on McpClientLike).
  const [resources, resourceTemplates, prompts] = await Promise.all([
    safeCapabilityList(client.listResources?.bind(client)),
    safeCapabilityList(client.listResourceTemplates?.bind(client)),
    safeCapabilityList(client.listPrompts?.bind(client)),
  ]);
  const liveServerInfo = client.getServerInfo();
  const declared = client.getServerCapabilities?.() ?? null;

  const imported = await listImportedToolsForConnector(id);
  const byRemoteName = new Map(imported.map((t) => [t.mcp.mcpToolName, t]));

  // Best-effort capability snapshot (§4.5) — never fails discovery.
  try {
    await db.mcpConnector.update({
      where: { id },
      data: {
        capabilities: JSON.stringify({
          serverInfo: liveServerInfo,
          declared,
          toolCount: remote.length,
          resourceCount: resources.length,
          resourceTemplateCount: resourceTemplates.length,
          promptCount: prompts.length,
          capturedAt: new Date().toISOString(),
        }),
      },
    });
  } catch {
    /* snapshot only */
  }

  return {
    connected: true,
    tools: remote.map((t) => {
      const existing = byRemoteName.get(t.name);
      return {
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
        remoteHash: hashInputSchema(t.inputSchema),
        imported: !!existing,
        ...(existing ? { importedToolName: existing.name } : {}),
      };
    }),
    resources: resources.map((r) => ({
      uri: r.uri,
      ...(r.name ? { name: r.name } : {}),
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    })),
    resourceTemplates: resourceTemplates.map((r) => ({
      uriTemplate: r.uriTemplate,
      ...(r.name ? { name: r.name } : {}),
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    })),
    prompts: prompts.map((p) => ({
      name: p.name,
      ...(p.title ? { title: p.title } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(Array.isArray(p.arguments) && p.arguments.length > 0
        ? { arguments: p.arguments.map((a) => ({ name: a.name, ...(a.description ? { description: a.description } : {}), ...(a.required !== undefined ? { required: a.required } : {}) })) }
        : {}),
    })),
    serverInfo: liveServerInfo
      ? { name: liveServerInfo.name, version: liveServerInfo.version, capabilities: declared }
      : null,
  };
}

// ---------- import (§1.10/§1.11/§1.14) ----------

export interface ImportResult {
  imported: string[];
  updated: string[];
  failed: { name: string; reason: string }[];
}

/** Build the NexTool registry name for an imported MCP tool. */
export function mcpToolRegistryName(connectorName: string, mcpToolName: string, taken: Set<string>): string {
  const base = `mcp.${slugify(connectorName)}.${slugify(mcpToolName)}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Import (or re-import/update) the SELECTED remote tools as NexTool tools
 * with environment 'mcp'. Definitions carry identity ONLY — the credential
 * store is never consulted here and no secret can enter a definition (§1.14).
 */
export async function importTools(id: string, mcpToolNames: string[]): Promise<ImportResult> {
  if (!Array.isArray(mcpToolNames) || mcpToolNames.length === 0) {
    throw new McpConnectorFailure('INVALID_PARAMS', 'Select at least one tool to import.');
  }
  let row = await getRow(id);
  row = await reconcileRow(row);
  const client = getLiveClient(id);
  if (!client) {
    throw new McpConnectorFailure('MCP_NOT_CONNECTED', `Connector "${row.name}" is not connected — connect before importing tools.`);
  }
  const provider = getProviderOrThrow(row.providerId);
  const remoteList = await client.listTools();
  const remoteByName = new Map(remoteList.map((t) => [t.name, t]));

  const imported = await listImportedToolsForConnector(id);
  const importedByRemoteName = new Map(imported.map((t) => [t.mcp.mcpToolName, t]));

  const result: ImportResult = { imported: [], updated: [], failed: [] };
  const takenNames = new Set((await db.toolRecord.findMany({ select: { name: true } })).map((r) => r.name));
  const nowIso = new Date().toISOString();

  for (const remoteName of mcpToolNames) {
    const remoteTool = remoteByName.get(remoteName);
    if (!remoteTool) {
      result.failed.push({ name: remoteName, reason: 'Tool not found on the MCP server.' });
      continue;
    }
    const schema = mcpInputSchemaToNexoolSchema(remoteTool.inputSchema);
    const remoteHash = hashInputSchema(remoteTool.inputSchema);
    const existing = importedByRemoteName.get(remoteName);
    const registryName = existing?.name ?? mcpToolRegistryName(row.name, remoteName, takenNames);
    takenNames.add(registryName);

    const ref: McpToolRef = {
      connectorId: id,
      providerId: provider.id,
      mcpToolName: remoteName,
      serverName: provider.name,
      remoteHash,
      importedAt: existing?.mcp.importedAt ?? nowIso,
      lastRefreshedAt: nowIso,
      ...(existing?.mcp.customizedDescription ? { customizedDescription: true } : {}),
      remoteInputSchema: remoteTool.inputSchema ?? null,
    };

    const description = existing?.mcp.customizedDescription
      ? existing.description
      : (remoteTool.description?.trim() || remoteTool.title?.trim() || `MCP tool ${remoteName} from ${provider.name}.`);

    const def: ToolDefinition = {
      name: registryName,
      description,
      category: 'mcp',
      environment: 'mcp',
      schema,
      mcp: ref,
    };

    await db.toolRecord.upsert({
      where: { name: registryName },
      update: {
        description: def.description,
        category: 'mcp',
        environment: 'mcp',
        definition: JSON.stringify(def),
      },
      create: {
        name: registryName,
        description: def.description,
        category: 'mcp',
        environment: 'mcp',
        definition: JSON.stringify(def),
        enabled: true,
      },
    });
    invalidateCachedHandler(registryName);
    (existing ? result.updated : result.imported).push(registryName);
  }

  await emitConnectorEvent(
    'connector.tools.imported',
    row,
    `Imported ${result.imported.length} and updated ${result.updated.length} MCP tool(s) from "${row.name}".`,
    { imported: result.imported, updated: result.updated, failed: result.failed },
  );
  return result;
}

// ---------- refresh (§1.16) ----------

export interface RefreshResult {
  refreshed: { name: string; mcpToolName: string; changed: boolean; summary: string }[];
  unavailable: string[];
}

/**
 * Refresh imported tools from the live server: re-read the remote schema,
 * diff against the stored one, update the NexTool representation when it
 * changed — PRESERVING local metadata and locally customized descriptions.
 * Never deletes a local tool when the remote tool disappeared; it is
 * reported as unavailable instead (honesty + no silent destruction).
 */
export async function refreshTools(id: string, mcpToolNames?: string[]): Promise<RefreshResult> {
  let row = await getRow(id);
  row = await reconcileRow(row);
  const client = getLiveClient(id);
  if (!client) {
    throw new McpConnectorFailure('MCP_NOT_CONNECTED', `Connector "${row.name}" is not connected — connect before refreshing tools.`);
  }
  const imported = await listImportedToolsForConnector(id);
  const targets = mcpToolNames?.length
    ? imported.filter((t) => mcpToolNames.includes(t.mcp.mcpToolName))
    : imported;
  const remoteList = await client.listTools();
  const remoteByName = new Map(remoteList.map((t) => [t.name, t]));
  const { diffNexoolSchemas } = await import('./schema-convert');

  const result: RefreshResult = { refreshed: [], unavailable: [] };
  const nowIso = new Date().toISOString();

  for (const entry of targets) {
    const remoteTool = remoteByName.get(entry.mcp.mcpToolName);
    if (!remoteTool) {
      result.unavailable.push(entry.mcp.mcpToolName);
      continue;
    }
    const freshSchema = mcpInputSchemaToNexoolSchema(remoteTool.inputSchema);
    const freshHash = hashInputSchema(remoteTool.inputSchema);
    const unchangedHash = freshHash === entry.mcp.remoteHash;
    const diff = diffNexoolSchemas(entry.schema, freshSchema);
    if (unchangedHash && !diff.changed) {
      result.refreshed.push({ name: entry.name, mcpToolName: entry.mcp.mcpToolName, changed: false, summary: 'schema unchanged' });
      // still stamp lastRefreshedAt so the UI shows the check happened
      await updateMcpDefinition(entry.name, (def) => ({ ...def, mcp: { ...def.mcp!, lastRefreshedAt: nowIso } }));
      continue;
    }
    const nextDescription = entry.mcp.customizedDescription
      ? entry.description
      : (remoteTool.description?.trim() || entry.description);
    await updateMcpDefinition(entry.name, (def) => ({
      ...def,
      description: nextDescription,
      schema: freshSchema,
      mcp: { ...def.mcp!, remoteHash: freshHash, remoteInputSchema: remoteTool.inputSchema ?? null, lastRefreshedAt: nowIso },
    }));
    result.refreshed.push({
      name: entry.name,
      mcpToolName: entry.mcp.mcpToolName,
      changed: true,
      summary: diff.summary,
    });
  }

  await emitConnectorEvent(
    'connector.tools.refreshed',
    row,
    `Refreshed ${result.refreshed.length} imported MCP tool(s) from "${row.name}" (${result.refreshed.filter((r) => r.changed).length} changed).`,
    { ...result },
  );
  return result;
}

/** Targeted definition update (keeps stats/enabled columns untouched). */
async function updateMcpDefinition(name: string, mutate: (def: ToolDefinition) => ToolDefinition): Promise<void> {
  const row = await db.toolRecord.findUnique({ where: { name } });
  if (!row) return;
  const def = parseJson<ToolDefinition | null>(row.definition, null);
  if (!def) return;
  const next = mutate(def);
  await db.toolRecord.update({ where: { name }, data: { definition: JSON.stringify(next), description: next.description } });
  invalidateCachedHandler(name);
}

// ---------- imported tool management (§1.15 + §8 identity fix) ----------

/**
 * §8 — IDENTITY-STABLE lookup of ONE imported tool.
 *
 * The caller may identify the tool by ANY of these (first match wins):
 *   (a/c) the NexTool registry name of a tool owned by THIS connector
 *         (`t.name === toolName` — every entry here already satisfies
 *         `definition.mcp.connectorId === row.id`)
 *   (b)   the REMOTE MCP tool name (`definition.mcp.mcpToolName`)
 *   (d)   a registry-name pattern built from the connector slug whose
 *         tool-slug part matches the remote tool name
 *         (`mcp.<connector-slug>.<tool-slug>[-N]`)
 *
 * When a match arrives via (b)/(d) the caller RESOLVES to `match.name` — the
 * actual, stable ToolRecord name — before toggling/removing. Imported names
 * are never recreated or renamed by connect/reconnect, so the resolved
 * identity round-trips enable/disable across reloads and reconnects.
 */
export async function findImportedTool(
  row: { id: string; name: string },
  toolName: string,
): Promise<(ToolEntryFull & { mcp: McpToolRef }) | undefined> {
  const imported = await listImportedToolsForConnector(row.id);
  return findImportedToolIn(row, toolName, imported);
}

function findImportedToolIn(
  row: { id: string; name: string },
  toolName: string,
  imported: (ToolEntryFull & { mcp: McpToolRef })[],
): (ToolEntryFull & { mcp: McpToolRef }) | undefined {
  const wanted = toolName.trim();
  if (!wanted) return undefined;
  // (a)/(c) — exact registry name of a tool of THIS connector.
  const byName = imported.find((t) => t.name === wanted && t.mcp.connectorId === row.id);
  if (byName) return byName;
  // (b) — the remote/display mcpToolName.
  const byRemoteName = imported.find((t) => t.mcp.mcpToolName === wanted);
  if (byRemoteName) return byRemoteName;
  // (d) — registry-name pattern with the connector slug AND a matching tool slug.
  const prefix = `mcp.${slugify(row.name)}.`;
  if (wanted.startsWith(prefix)) {
    const toolSlug = wanted.slice(prefix.length).replace(/-\d+$/, '');
    if (toolSlug) {
      const byPattern = imported.find((t) => slugify(t.mcp.mcpToolName) === toolSlug);
      if (byPattern) return byPattern;
    }
  }
  return undefined;
}

/** §8 — the honest 404 message lists the connector's imported tools to aid debugging. */
function toolNotFoundMessage(connectorName: string, toolName: string, imported: (ToolEntryFull & { mcp: McpToolRef })[]): string {
  const names = imported.map((t) => t.name);
  const available = names.length > 0 ? `Imported tools on this connector: ${names.join(', ')}.` : 'No tools are imported on this connector yet.';
  return `"${toolName}" is not an imported tool of connector "${connectorName}". ${available}`;
}

/** Enable/disable an imported tool (registry enablement only — never the remote server). */
export async function setImportedToolEnabled(connectorId: string, toolName: string, enabled: boolean): Promise<ImportedToolDTO> {
  const row = await getRow(connectorId);
  const entry = await findImportedTool(row, toolName);
  if (!entry) {
    throw new McpConnectorFailure('TOOL_NOT_FOUND', toolNotFoundMessage(row.name, toolName, await listImportedToolsForConnector(connectorId)));
  }
  // Resolve to the STABLE ToolRecord name — the caller may have passed the
  // remote name or a pattern (§8 (b)/(d)).
  const name = entry.name;
  await db.toolRecord.update({ where: { name }, data: { enabled } });
  invalidateCachedHandler(name);
  return { ...importedToolDTO(entry), enabled };
}

/** Remove an imported tool from NexTool. The REMOTE MCP tool is untouched. */
export async function removeImportedTool(connectorId: string, toolName: string): Promise<{ removed: true; name: string }> {
  const row = await getRow(connectorId);
  const entry = await findImportedTool(row, toolName);
  if (!entry) {
    throw new McpConnectorFailure('TOOL_NOT_FOUND', toolNotFoundMessage(row.name, toolName, await listImportedToolsForConnector(connectorId)));
  }
  const name = entry.name;
  await db.toolRecord.delete({ where: { name } });
  invalidateCachedHandler(name);
  await emitConnectorEvent(
    'connector.tools.removed',
    row,
    `Imported MCP tool "${toolName}"${name !== toolName ? ` (registry: ${name})` : ''} removed from NexTool (remote server untouched).`,
  );
  return { removed: true, name };
}

// ---------- §5.2 — OAuth 2.0 authorization-code engine ----------

/** A pending login: created by /oauth/start, consumed ONCE by /oauth/callback. */
interface PendingOAuthState {
  connectorId: string;
  state: string;
  /** PKCE verifier (43–128 base64url chars) when the preset uses PKCE. */
  codeVerifier?: string;
  createdAt: number;
  redirectUri: string;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Module-level Map on globalThis (same pattern as the MCP runtime registry) so
// the pending states survive dev-server hot reloads within one process.
const gOauth = globalThis as unknown as { __nextoolMcpOauthPending?: Map<string, PendingOAuthState> };

function oauthPendingStore(): Map<string, PendingOAuthState> {
  if (!gOauth.__nextoolMcpOauthPending) gOauth.__nextoolMcpOauthPending = new Map();
  return gOauth.__nextoolMcpOauthPending;
}

function pruneOauthPending(): void {
  const store = oauthPendingStore();
  const now = Date.now();
  for (const [state, entry] of store) {
    if (now - entry.createdAt > OAUTH_STATE_TTL_MS) store.delete(state);
  }
}

/**
 * Consume a pending state ONCE: unknown, expired (10 min TTL) or already-used
 * states all return undefined. Single-use by construction — the entry is
 * removed before any further processing.
 */
export function consumeOauthState(state: string): PendingOAuthState | undefined {
  pruneOauthPending();
  const store = oauthPendingStore();
  const entry = store.get(state);
  if (!entry) return undefined;
  store.delete(state);
  if (Date.now() - entry.createdAt > OAUTH_STATE_TTL_MS) return undefined;
  return entry;
}

export interface OAuthStartResult {
  /** The authorization URL the browser must be redirected to. */
  authorizeUrl: string;
  /** How long the server keeps the pending state (seconds). */
  stateExpiresInSeconds: number;
}

/**
 * §5.2 — begin the OAuth login: build the authorize URL from the PROVIDER
 * preset (endpoints/scopes/PKCE/extra params), the connector's editable
 * scopes and its stored client credentials; park a single-use, 10-min-TTL
 * pending state server-side. The browser never receives anything secret.
 */
export async function startOAuth(connectorId: string, origin: string): Promise<OAuthStartResult> {
  const row = await getRow(connectorId);
  const provider = getProviderOrThrow(row.providerId);
  const preset = provider.authentication.oauth;
  if (!preset) {
    throw new McpConnectorFailure('OAUTH_NOT_CONFIGURED', `Provider "${provider.name}" does not declare an OAuth 2.0 preset — the redirect login is unavailable.`);
  }
  const config = parseJson<Record<string, unknown>>(row.config, {});
  const authorizeEndpoint = resolveOauthEndpoint(config, preset, 'authorizeUrl');
  if (!authorizeEndpoint) {
    throw new McpConnectorFailure('OAUTH_NOT_CONFIGURED', `Provider "${provider.name}" declares no authorization endpoint.`);
  }
  const cred = readCredential(row);
  const { clientId } = resolveOauthClientCredentials(config, cred?.values ?? {});
  if (!clientId) {
    throw new McpConnectorFailure('OAUTH_CLIENT_ID_MISSING', 'Set the OAuth client id (and client secret) for this connector before starting the login.');
  }

  const state = crypto.randomBytes(32).toString('hex');
  // RFC 7636: verifier is 43–128 chars of base64url. 48 random bytes → 64 chars.
  const codeVerifier = preset.pkce ? crypto.randomBytes(48).toString('base64url') : undefined;
  const redirectUri = `${origin.replace(/\/+$/, '')}/api/connectors/${encodeURIComponent(row.id)}/oauth/callback`;

  const url = new URL(authorizeEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  const scopes = resolveConnectorScopes(provider, config);
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(preset.scopeSeparator ?? ' '));
  if (codeVerifier) {
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(preset.extraAuthorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }

  oauthPendingStore().set(state, { connectorId: row.id, state, ...(codeVerifier ? { codeVerifier } : {}), createdAt: Date.now(), redirectUri });
  pruneOauthPending();
  await writeAuthState(row.id, { method: 'oauth2', lastError: null });
  await emitConnectorEvent('connector.oauth.started', row, `OAuth login started for MCP connector "${row.name}" (${provider.name}).`);
  return { authorizeUrl: url.toString(), stateExpiresInSeconds: Math.round(OAUTH_STATE_TTL_MS / 1000) };
}

/** Normalized token-endpoint response (raw payloads are never kept or logged). */
interface OAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

/**
 * POST to the token endpoint — request encoding follows `tokenStyle`
 * (form default, json supported); BOTH response styles (JSON and
 * form-urlencoded) are accepted. Response fields are read with standard
 * snake_case names and the preset field names as fallbacks.
 */
async function oauthTokenRequest(tokenUrl: string, params: Record<string, string>, style: 'form' | 'json'): Promise<OAuthTokenResponse> {
  let res: Response;
  try {
    if (style === 'json') {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(20_000),
      });
    } else {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    }
  } catch (err) {
    throw new McpConnectorFailure('OAUTH_TOKEN_EXCHANGE_FAILED', `Token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let payload: Record<string, unknown> = {};
  if ((res.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded')) {
    payload = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      /* non-JSON, non-form body — handled below via the empty payload */
    }
  }
  if (!res.ok) {
    const detail = typeof payload.error_description === 'string'
      ? payload.error_description
      : typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${res.status}`;
    throw new McpConnectorFailure('OAUTH_TOKEN_EXCHANGE_FAILED', `Token endpoint rejected the request: ${detail}`);
  }
  const accessToken = firstNonEmpty(payload, ['access_token', 'accessToken']);
  if (!accessToken) {
    throw new McpConnectorFailure('OAUTH_TOKEN_EXCHANGE_FAILED', 'Token endpoint response did not contain an access token.');
  }
  const expiresInRaw = payload.expires_in ?? payload.expiresIn;
  const refreshToken = firstNonEmpty(payload, ['refresh_token', 'refreshToken']);
  const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof expiresInRaw === 'number' && expiresInRaw > 0 ? { expiresIn: expiresInRaw } : {}),
    ...(scope ? { scope } : {}),
  };
}

export interface OAuthCompletionContext {
  /** The ?code query value from the callback. */
  code: string;
  /** PKCE verifier from the consumed pending state (when PKCE is used). */
  codeVerifier?: string;
  /** The exact redirect_uri used in the authorize request. */
  redirectUri: string;
}

/**
 * §5.2 — finish the OAuth login: exchange the authorization code, extract the
 * tokens with the preset field names, STORE them as the connector credential
 * (same store as the manual credentials PUT), record the non-secret auth
 * state and run the provider's best-effort validation. Token values never
 * leave this function — the returned DTO carries presence info only.
 */
export async function completeOAuth(connectorId: string, ctx: OAuthCompletionContext): Promise<ConnectorDTO> {
  const row = await getRow(connectorId);
  const provider = getProviderOrThrow(row.providerId);
  const preset = provider.authentication.oauth;
  const tokenUrl = resolveOauthEndpoint(parseJson<Record<string, unknown>>(row.config, {}), preset, 'tokenUrl');
  if (!tokenUrl) {
    throw new McpConnectorFailure('OAUTH_NOT_CONFIGURED', `Provider "${provider.name}" declares no token endpoint — the OAuth login cannot be completed.`);
  }
  const cred = readCredential(row);
  const { clientId, clientSecret } = resolveOauthClientCredentials(parseJson<Record<string, unknown>>(row.config, {}), cred?.values ?? {});
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: ctx.code,
    redirect_uri: ctx.redirectUri,
  };
  if (clientId) params.client_id = clientId;
  if (clientSecret) params.client_secret = clientSecret;
  if (ctx.codeVerifier) params.code_verifier = ctx.codeVerifier;

  const tokens = await oauthTokenRequest(tokenUrl, params, preset?.tokenStyle ?? 'form');
  const tokenExpiresAt = tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : undefined;

  // Store as the credential type the provider expects (same store as PUT).
  const merged: Record<string, unknown> = { ...(cred?.values ?? {}) };
  merged[preset?.accessTokenField ?? 'accessToken'] = tokens.accessToken;
  if (tokens.refreshToken) merged[preset?.refreshTokenField ?? 'refreshToken'] = tokens.refreshToken;
  const type = provider.authentication.type;
  await db.mcpCredential.upsert({
    where: { connectorId },
    update: { type, secret: JSON.stringify(merged) },
    create: { connectorId, type, secret: JSON.stringify(merged) },
  });

  // Non-secret auth state (§5 schema contract on the `auth` column).
  await writeAuthState(connectorId, {
    method: 'oauth2',
    authenticatedAt: new Date().toISOString(),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    lastError: null,
  });

  // Honest status + best-effort validation (never blocks completion).
  const status: McpConnectorStatus = hasLiveClient(connectorId) ? 'connected' : row.status === 'auth_required' ? 'not_connected' : (row.status as McpConnectorStatus);
  const validation = await validateProviderToken(provider, tokens.accessToken);
  await db.mcpConnector.update({
    where: { id: connectorId },
    data: {
      status,
      statusDetail: `authenticated via OAuth${validation ? ` — ${validation}` : ''}.`,
    },
  });
  await emitConnectorEvent('connector.oauth.completed', row, `OAuth login completed for MCP connector "${row.name}" (${provider.name}).`);
  return getConnectorDTOById(connectorId);
}

/** Record an OAuth failure on the connector (honest statusDetail, best-effort). */
export async function markOauthFailure(connectorId: string, message: string): Promise<void> {
  try {
    await writeAuthState(connectorId, { lastError: message });
    await db.mcpConnector.update({ where: { id: connectorId }, data: { statusDetail: `OAuth login failed: ${message}` } });
  } catch {
    /* the connector may be gone — the redirect already reports the error */
  }
}

export interface RefreshAuthResult {
  refreshed: boolean;
  detail?: string;
}

/** Internal refresh — returns the merged credential values on success. */
async function tryRefreshToken(row: ConnectorRow): Promise<{ ok: boolean; values?: Record<string, unknown>; code?: string; message?: string }> {
  const provider = getProviderOrThrow(row.providerId);
  const preset = provider.authentication.oauth;
  const tokenUrl = resolveOauthEndpoint(parseJson<Record<string, unknown>>(row.config, {}), preset, 'tokenUrl');
  if (!tokenUrl) {
    return { ok: false, code: 'OAUTH_NOT_CONFIGURED', message: `Provider "${provider.name}" declares no token endpoint — token refresh is unavailable.` };
  }
  const cred = readCredential(row);
  if (!cred) {
    return { ok: false, code: 'MCP_AUTH_REQUIRED', message: 'No credentials are stored for this connector.' };
  }
  const refreshToken = firstNonEmpty(cred.values, preset?.refreshTokenField ? [preset.refreshTokenField, ...REFRESH_FIELD_CANDIDATES] : REFRESH_FIELD_CANDIDATES);
  if (!refreshToken) {
    return { ok: false, code: 'OAUTH_REFRESH_UNAVAILABLE', message: 'No refresh token is stored — run the OAuth login again to obtain one.' };
  }
  const { clientId, clientSecret } = resolveOauthClientCredentials(parseJson<Record<string, unknown>>(row.config, {}), cred.values);
  const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken };
  if (clientId) params.client_id = clientId;
  if (clientSecret) params.client_secret = clientSecret;

  let tokens: OAuthTokenResponse;
  try {
    tokens = await oauthTokenRequest(tokenUrl, params, preset?.tokenStyle ?? 'form');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token refresh failed.';
    await writeAuthState(row.id, { lastError: message }).catch(() => undefined);
    return { ok: false, code: err instanceof McpConnectorFailure ? err.code : 'OAUTH_REFRESH_FAILED', message };
  }

  const merged: Record<string, unknown> = { ...cred.values };
  merged[preset?.accessTokenField ?? 'accessToken'] = tokens.accessToken;
  if (tokens.refreshToken) merged[preset?.refreshTokenField ?? 'refreshToken'] = tokens.refreshToken;
  const tokenExpiresAt = tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000).toISOString() : undefined;
  await db.mcpCredential.update({ where: { connectorId: row.id }, data: { secret: JSON.stringify(merged) } }).catch(async () => {
    await db.mcpCredential.create({ data: { connectorId: row.id, type: provider.authentication.type, secret: JSON.stringify(merged) } });
  });
  await writeAuthState(row.id, { lastRefreshAt: new Date().toISOString(), ...(tokenExpiresAt ? { tokenExpiresAt } : {}), lastError: null });
  await emitConnectorEvent('connector.oauth.refreshed', row, `Access token refreshed for MCP connector "${row.name}".`);
  return { ok: true, values: merged };
}

/**
 * §5.4 — explicit refresh-token rotation (POST connection action
 * 'refresh-auth'). Uses the preset token endpoint + stored refresh token;
 * throws a structured failure on any problem (the UI shows the message).
 */
export async function refreshConnectorToken(id: string): Promise<RefreshAuthResult> {
  const row = await getRow(id);
  const result = await tryRefreshToken(row);
  if (!result.ok) {
    throw new McpConnectorFailure(result.code ?? 'OAUTH_REFRESH_FAILED', result.message ?? 'Token refresh failed.');
  }
  return { refreshed: true, detail: 'Access token refreshed and stored server-side.' };
}
