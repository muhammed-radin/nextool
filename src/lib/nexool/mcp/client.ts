/**
 * NexTool v1.0.13 — MCP CLIENT runtime (spec §1.4/§1.5, §4 super-client).
 *
 * NexTool acts as an MCP CLIENT. This module wraps the OFFICIAL
 * `@modelcontextprotocol/sdk` (never a hand-rolled protocol implementation):
 *
 *   - initialize/session handling  → `Client.connect(transport)`
 *   - capability discovery         → `client.getServerVersion()` + getServerCapabilities
 *   - tool listing/inspection      → `client.listTools()`
 *   - FULL capability discovery    → listResources / listResourceTemplates /
 *                                    listPrompts (§4 — servers without a
 *                                    capability answer [] , never throw)
 *   - tool execution               → `client.callTool()`
 *   - transports                   → stdio (child process) + Streamable HTTP
 *
 * The transport layer is EXTENSIBLE (§1.5): `resolveTransport` switches on
 * the transport TYPE declared in the JSON provider registry — adding e.g. a
 * WebSocket transport later means adding one branch here, no other change.
 *
 * Protocol handling lives COMPLETELY SEPARATE from the native NexTool tool
 * executor: the executor keeps calling plain ToolHandlers; this module is the
 * only place that speaks MCP. Credentials are consumed here (connect time)
 * and never persisted anywhere by this module (§1.7).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { APP_VERSION } from '../version';
import type { McpProvider } from './provider-registry';

// ---------- typed errors (mapped to structured tool failures by the runner) ----------

/** The MCP server rejected the credential (401/403-style) or none exists. */
export class McpAuthError extends Error {
  code = 'MCP_AUTH_REQUIRED';
  constructor(message = 'MCP server rejected the credentials (authentication required).') {
    super(message);
    this.name = 'McpAuthError';
  }
}

/** The MCP server could not be reached / the session failed. */
export class McpConnectionError extends Error {
  code = 'MCP_CONNECTION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'McpConnectionError';
  }
}

/** The MCP protocol answered with an error (tool missing, bad params, …). */
export class McpProtocolError extends Error {
  code: string;
  constructor(message: string, code = 'MCP_PROTOCOL_ERROR') {
    super(message);
    this.name = 'McpProtocolError';
    this.code = code;
  }
}

// ---------- client surface ----------

/** Normalized tool description (a trimmed projection of the SDK result). */
export interface McpRemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

/** §4 — a resource exposed by the server (growable content, read via uri). */
export interface McpRemoteResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** §4 — a URI template describing HOW to build resource URIs. */
export interface McpRemoteResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** §4 — a reusable prompt template offered by the server. */
export interface McpRemotePrompt {
  name: string;
  title?: string;
  description?: string;
  /** Declared prompt arguments (name + required flag only, UI display). */
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpToolCallResult {
  /** True when the REMOTE tool reported failure (MCP isError result). */
  isError: boolean;
  /** Concatenated text blocks of the response content. */
  text: string;
  /** Raw MCP content blocks (text/image/resource/…), passed through. */
  content: unknown[];
  /** Structured content when the server provided it (MCP 2025+). */
  structuredContent?: unknown;
}

/**
 * Transport-agnostic surface the rest of NexTool uses. A factory returns an
 * ALREADY-CONNECTED client (initialize handshake completed) or throws
 * McpAuthError / McpConnectionError.
 */
export interface McpClientLike {
  /** Server-reported name/version after the initialize handshake. */
  getServerInfo(): { name: string; version: string } | null;
  /** §4 — server-declared capability object from the initialize handshake. */
  getServerCapabilities?(): Record<string, unknown> | null;
  listTools(): Promise<McpRemoteTool[]>;
  /** §4 — capability-aware listing: servers without the capability answer []. */
  listResources?(): Promise<McpRemoteResource[]>;
  listResourceTemplates?(): Promise<McpRemoteResourceTemplate[]>;
  listPrompts?(): Promise<McpRemotePrompt[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolCallResult>;
  /** Terminate the session (kills the stdio process / closes HTTP session). */
  close(): Promise<void>;
}

// ---------- factory (test-swappable) ----------

export interface McpClientFactoryOptions {
  connectorId: string;
  connectorName: string;
  provider: McpProvider;
  /** Non-secret transport configuration from the connector record. */
  config: Record<string, unknown>;
  /** Credential field values resolved server-side (NEVER logged). */
  credential: Record<string, unknown> | null;
}

export type McpClientFactory = (opts: McpClientFactoryOptions) => Promise<McpClientLike>;

let clientFactory: McpClientFactory = defaultMcpClientFactory;

/** Install a custom factory (tests use the SDK InMemoryTransport pair). */
export function setMcpClientFactory(factory: McpClientFactory | null): void {
  clientFactory = factory ?? defaultMcpClientFactory;
}

export async function createMcpClient(opts: McpClientFactoryOptions): Promise<McpClientLike> {
  return clientFactory(opts);
}

// ---------- credential → transport wiring (provider-declared, no id switches) ----------

/** Substitute `${field}` placeholders from the credential values. */
function renderTemplate(template: string, credential: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    const v = credential[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Build the HTTP headers declared by the provider (header injection). */
function buildAuthHeaders(provider: McpProvider, credential: Record<string, unknown>): Record<string, string> {
  const auth = provider.authentication;
  if (auth.injection !== 'header' || !auth.headerName || !auth.headerTemplate) return {};
  const value = renderTemplate(auth.headerTemplate, credential);
  if (!value.trim()) return {};
  return { [auth.headerName]: value };
}

/** Build the environment variables declared by the provider (env injection). */
function buildAuthEnv(provider: McpProvider, credential: Record<string, unknown>): Record<string, string> {
  const auth = provider.authentication;
  if (auth.injection !== 'env') return {};
  const env: Record<string, string> = {};
  for (const field of auth.fields) {
    const envName = (field as { envName?: string }).envName;
    if (!envName) continue;
    const value = credential[field.key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      env[envName] = String(value);
    }
  }
  return env;
}

/** Resolve the per-connector transport from the provider declaration. */
async function resolveTransport(opts: McpClientFactoryOptions): Promise<Transport> {
  const { provider, config, credential } = opts;
  const cred = credential ?? {};
  const transportType = provider.transport.type;

  // stdio — either declared by the provider as stdio, or a connector-level
  // override ("command" present on an http provider = local stdio mode).
  const command = typeof config.command === 'string' && config.command.trim()
    ? config.command.trim()
    : provider.transport.defaultCommand;
  if (transportType === 'stdio' || (transportType === 'http' && command)) {
    if (!command) {
      throw new McpConnectionError(`Provider "${provider.id}" is configured for the stdio transport but no command is set.`);
    }
    const args = typeof config.args === 'string' && config.args.trim()
      ? config.args.trim().split(/\s+/)
      : (provider.transport.defaultArgs ?? []);
    const authEnv = buildAuthEnv(provider, cred);
    return new StdioClientTransport({
      command,
      args,
      // inherit the safe default environment (PATH/HOME/…) + provider-declared
      // credential env vars. Credential values NEVER reach a log from here.
      env: { ...getDefaultEnvironment(), ...authEnv },
    });
  }

  // Streamable HTTP (+ per-connector URL override; auth via headers).
  const url = typeof config.url === 'string' && config.url.trim()
    ? config.url.trim()
    : provider.transport.defaultUrl;
  if (!url) {
    throw new McpConnectionError(`Provider "${provider.id}" is configured for the http transport but no server URL is set.`);
  }
  const headers = buildAuthHeaders(provider, cred);
  return new StreamableHTTPClientTransport(new URL(url), {
    ...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
  });
}

function classifyConnectError(err: unknown): Error {
  if (err instanceof McpAuthError || err instanceof McpConnectionError) return err;
  // The SDK signals 401/403 on Streamable HTTP with UnauthorizedError.
  if (err instanceof UnauthorizedError) {
    return new McpAuthError('The MCP server rejected the credentials (401 unauthorized).');
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|unauthorized|forbidden|invalid[_ ] token|bad credential|auth/i.test(msg) && /40[13]|unauthorized|invalid[_ ]token|bad credential/i.test(msg)) {
    return new McpAuthError(`The MCP server rejected the credentials: ${msg}`);
  }
  return new McpConnectionError(msg);
}

/** Default factory: a real SDK Client over the provider-declared transport. */
async function defaultMcpClientFactory(opts: McpClientFactoryOptions): Promise<McpClientLike> {
  const transport = await resolveTransport(opts);
  const client = new Client(
    { name: 'NexTool Q1', version: APP_VERSION },
    { capabilities: {} },
  );
  try {
    // connect() performs the MCP initialize handshake; it resolves ONLY on a
    // successfully initialized session.
    await client.connect(transport);
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* the transport may already be dead */
    }
    throw classifyConnectError(err);
  }

  // §4 — capability-aware discovery helpers. A server that never declared a
  // capability is NOT asked (the request would round-trip into a -32601
  // "method not found" error); one that declared it but still fails degrades
  // to [] — partial capability must never break full discovery.
  const hasCapability = (key: string): boolean => {
    const caps = client.getServerCapabilities() as Record<string, unknown> | undefined;
    return !!caps && caps[key] !== undefined;
  };
  const safeList = async <T>(capability: 'resources' | 'prompts', itemKey: 'resources' | 'resourceTemplates' | 'prompts', list: () => Promise<Record<string, unknown>>): Promise<T[]> => {
    if (!hasCapability(capability)) return [];
    try {
      const res = await list();
      const items = res[itemKey];
      return Array.isArray(items) ? (items as T[]) : [];
    } catch {
      return [];
    }
  };

  const textFromContent = (content: unknown[]): string =>
    content
      .map((block) => {
        const b = block as { type?: string; text?: string };
        return typeof b?.text === 'string' && b.type === 'text' ? b.text : '';
      })
      .filter(Boolean)
      .join('\n');

  return {
    getServerInfo() {
      const v = client.getServerVersion();
      return v ? { name: v.name, version: v.version } : null;
    },
    getServerCapabilities() {
      // JSON-safe projection of the server's own capability declaration
      // (tools / resources / prompts / logging / experimental / …) or null.
      const caps = client.getServerCapabilities();
      if (!caps) return null;
      try {
        return JSON.parse(JSON.stringify(caps)) as Record<string, unknown>;
      } catch {
        return null;
      }
    },
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        ...(t.description ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
      }));
    },
    listResources() {
      return safeList<McpRemoteResource>('resources', 'resources', () => client.listResources());
    },
    listResourceTemplates() {
      // resource templates are announced under the `resources` capability
      return safeList<McpRemoteResourceTemplate>('resources', 'resourceTemplates', () => client.listResourceTemplates());
    },
    listPrompts() {
      return safeList<McpRemotePrompt>('prompts', 'prompts', () => client.listPrompts());
    },
    async callTool(name, args, timeoutMs) {
      const res = await client.callTool(
        { name, arguments: args },
        undefined,
        // SDK-level timeout mirrors the executor deadline (defense in depth)
        timeoutMs ? { timeout: timeoutMs } : undefined,
      );
      const blocks = (res.content ?? []) as unknown[];
      const isError = res.isError === true;
      return {
        isError,
        text: textFromContent(blocks),
        content: blocks,
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
      };
    },
    async close() {
      await client.close();
    },
  };
}
