/**
 * NexTool v1.0.12 — Connector manager (spec §1.1-§1.18).
 *
 * DB-backed (Prisma McpConnector + McpCredential) state machine that owns:
 *   - connector CRUD (instances of providers from the JSON registry)
 *   - server-side credential storage (values NEVER leave the backend)
 *   - connection lifecycle: connect / disconnect / reconnect + the REAL
 *     status model (not_connected | connecting | auth_required | connected |
 *     disconnected | error | reconnecting) reconciled against live sessions
 *   - tool discovery (initialize → listTools), selection + import
 *   - the `mcp` tool environment: imported tools are ToolRecords whose
 *     definition carries identity (connectorId + mcpToolName + converted
 *     schema) and NEVER credentials (§1.14)
 *   - schema refresh with local-metadata preservation (§1.16)
 *   - disconnect/reconnect semantics: imported tools survive disconnects and
 *     become unavailable until the connector is back (§1.17)
 *
 * Protocol handling stays inside mcp/client.ts (official SDK) — this file
 * orchestrates; it never speaks MCP itself.
 */

import crypto from 'node:crypto';
import { db } from '@/lib/db';
import type { McpConnectorStatus, McpToolRef, ToolDefinition } from '../types';
import { emitEvent } from '../eventbus';
import { invalidateCachedHandler } from '../tools/registry';
import type { ToolEntryFull } from '../tools/registry';
import { createMcpClient, McpAuthError, McpConnectionError } from './client';
import type { McpRemoteTool } from './client';
import { getMcpProvider, listMcpProviders, mcpProviderRegistryVersion } from './provider-registry';
import type { McpProvider } from './provider-registry';
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
  return {
    id: row.id,
    providerId: provider.id,
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
    serverInfo,
    importedTools: imported.map(importedToolDTO),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

/** Keep only keys the provider's configFields declare; drop everything else. */
function sanitizeConfig(provider: McpProvider, config: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(provider.transport.configFields.map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (allowed.has(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = v;
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
}

export async function setCredentials(id: string, input: SetCredentialsInput): Promise<ConnectorDTO> {
  const row = await getRow(id);
  const provider = getProviderOrThrow(row.providerId);
  const auth = provider.authentication;
  const current = readCredential(row);
  // Merge with the stored values so a partial update (e.g. rotating one field)
  // does not silently erase the others. Empty strings delete a field.
  const merged: Record<string, unknown> = { ...(current?.values ?? {}) };
  const allowed = new Set(auth.fields.map((f) => f.key));
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if (!allowed.has(k)) continue;
    if (v === null || (typeof v === 'string' && v.trim() === '')) delete merged[k];
    else merged[k] = typeof v === 'string' ? v : String(v);
  }
  const missing = auth.requiredFields.filter((f) => {
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
  // New credentials invalidate a previous auth_required state honestly.
  const status: McpConnectorStatus = hasLiveClient(id) ? 'connected' : row.status === 'auth_required' ? 'not_connected' : (row.status as McpConnectorStatus);
  await db.mcpConnector.update({
    where: { id },
    data: {
      status,
      ...(status === 'not_connected' ? { statusDetail: 'Credentials stored — connect when ready.' } : {}),
    },
  });
  await emitConnectorEvent('connector.credentials.set', row, `Credentials updated for MCP connector "${row.name}".`);
  return getConnectorDTOById(id);
}

export async function clearCredentials(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  await db.mcpCredential.deleteMany({ where: { connectorId: id } });
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
 */
export async function connectConnector(id: string): Promise<ConnectorDTO> {
  const row = await getRow(id);
  const provider = getProviderOrThrow(row.providerId);
  if (!row.enabled) {
    throw new McpConnectorFailure('CONNECTOR_DISABLED', `Connector "${row.name}" is disabled.`);
  }
  if (hasLiveClient(id)) return getConnectorDTOById(id); // already connected
  if (isConnecting(id)) return getConnectorDTOById(id); // connect already in flight

  const cred = readCredential(row);
  const missing = missingRequiredFields(provider, cred);
  if (missing.length > 0) {
    await setStatus(id, 'auth_required', `Credentials required (${missing.join(', ')}).`, null);
    throw new McpConnectorFailure('MCP_AUTH_REQUIRED', `Connect requires credentials (${missing.join(', ')}). Set them on the Connectors page first.`);
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

// ---------- discovery (§1.9) ----------

/** Live tool discovery — requires a connected session. */
export async function discoverTools(id: string): Promise<{ connected: boolean; tools: DiscoveredToolDTO[] }> {
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
  const imported = await listImportedToolsForConnector(id);
  const byRemoteName = new Map(imported.map((t) => [t.mcp.mcpToolName, t]));
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

// ---------- imported tool management (§1.15) ----------

/** Enable/disable an imported tool (registry enablement only — never the remote server). */
export async function setImportedToolEnabled(connectorId: string, toolName: string, enabled: boolean): Promise<ImportedToolDTO> {
  const imported = await listImportedToolsForConnector(connectorId);
  const entry = imported.find((t) => t.name === toolName);
  if (!entry) {
    throw new McpConnectorFailure('TOOL_NOT_FOUND', `"${toolName}" is not an imported tool of this connector.`);
  }
  await db.toolRecord.update({ where: { name: toolName }, data: { enabled } });
  invalidateCachedHandler(toolName);
  const after = imported.find((t) => t.name === toolName)!;
  return { ...importedToolDTO(after), enabled };
}

/** Remove an imported tool from NexTool. The REMOTE MCP tool is untouched. */
export async function removeImportedTool(connectorId: string, toolName: string): Promise<{ removed: true; name: string }> {
  const row = await getRow(connectorId);
  const imported = await listImportedToolsForConnector(connectorId);
  const entry = imported.find((t) => t.name === toolName);
  if (!entry) {
    throw new McpConnectorFailure('TOOL_NOT_FOUND', `"${toolName}" is not an imported tool of connector "${row.name}".`);
  }
  await db.toolRecord.delete({ where: { name: toolName } });
  invalidateCachedHandler(toolName);
  await emitConnectorEvent('connector.tools.removed', row, `Imported MCP tool "${toolName}" removed from NexTool (remote server untouched).`);
  return { removed: true, name: toolName };
}
