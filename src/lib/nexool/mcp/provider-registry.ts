/**
 * NexTool v1.0.12 — MCP provider registry (JSON-based, extensible).
 *
 * SUPPORTED MCP SERVERS live in `config/mcp-servers.json` — a declarative
 * registry, NOT hard-coded per-provider branches in the frontend or backend.
 * Flow (spec §1.2):
 *
 *   SUPPORTED MCP SERVERS → JSON registry → CONNECTORS UI → MCP CLIENT
 *
 * Adding a future platform (Slack, Notion, …) means appending ONE JSON object
 * here — no runtime change: the Connectors page, the credential forms, the
 * transport factory and the tool importer all read this registry.
 *
 * Provider-specific AUTH/CONNECTION details (spec §1.3/§1.6) are part of the
 * provider entry: `transport` describes how to reach the server (stdio
 * command or Streamable HTTP URL) and `authentication` describes WHICH
 * credential fields the provider needs and HOW they are injected at connect
 * time (`env` → server environment, `header` → HTTP Authorization-style
 * header built from `headerTemplate`). No code anywhere switches on a
 * provider id.
 */

import raw from '../../../../config/mcp-servers.json';

// ---------- shapes (kept in sync with config/mcp-servers.json) ----------

export type McpTransportType = 'stdio' | 'http';
/** How stored credentials reach the MCP server at connect time. */
export type McpCredentialInjection = 'env' | 'header';
export type McpAuthType = 'oauth' | 'access_token' | 'api_token' | 'api_key';

export interface McpProviderConfigField {
  key: string;
  label: string;
  type: 'string' | 'number';
  required: boolean;
  secret?: boolean;
  placeholder?: string;
  description: string;
}

export interface McpProviderTransport {
  type: McpTransportType;
  /** stdio defaults (overridable per connector via config). */
  defaultCommand?: string;
  defaultArgs?: string[];
  /** http default (overridable per connector via config). */
  defaultUrl?: string;
  /** Non-secret configuration fields rendered by the Connectors UI. */
  configFields: McpProviderConfigField[];
}

export interface McpProviderAuth {
  type: McpAuthType;
  title: string;
  description: string;
  injection: McpCredentialInjection;
  /** http injection only: header name + `${field}` template. */
  headerName?: string;
  headerTemplate?: string;
  requiredFields: string[];
  optionalFields: string[];
  fields: (McpProviderConfigField & { secret?: boolean })[];
}

export interface McpProvider {
  id: string;
  name: string;
  description: string;
  category: string;
  docsUrl?: string;
  enabled: boolean;
  transport: McpProviderTransport;
  authentication: McpProviderAuth;
}

export interface McpProviderRegistry {
  version: number;
  providers: McpProvider[];
}

// ---------- loading / validation ----------

function coerceRegistry(input: unknown): McpProviderRegistry {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config/mcp-servers.json must be a JSON object.');
  }
  const obj = input as { version?: unknown; providers?: unknown };
  if (!Array.isArray(obj.providers)) {
    throw new Error('config/mcp-servers.json: "providers" must be an array.');
  }
  const providers: McpProvider[] = obj.providers.map((p, i) => {
    if (p === null || typeof p !== 'object') {
      throw new Error(`config/mcp-servers.json: provider #${i} must be an object.`);
    }
    const rec = p as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`config/mcp-servers.json: provider #${i} needs a kebab-case "id" (got "${id}").`);
    }
    const transport = rec.transport as McpProviderTransport | undefined;
    if (!transport || (transport.type !== 'stdio' && transport.type !== 'http')) {
      throw new Error(`config/mcp-servers.json: provider "${id}" needs transport.type "stdio" or "http".`);
    }
    const auth = rec.authentication as McpProviderAuth | undefined;
    if (!auth || typeof auth.type !== 'string' || (auth.injection !== 'env' && auth.injection !== 'header')) {
      throw new Error(`config/mcp-servers.json: provider "${id}" needs authentication with injection "env"|"header".`);
    }
    if (auth.injection === 'header' && (typeof auth.headerName !== 'string' || typeof auth.headerTemplate !== 'string')) {
      throw new Error(`config/mcp-servers.json: provider "${id}" uses header injection but misses headerName/headerTemplate.`);
    }
    return {
      id,
      name: typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id,
      description: typeof rec.description === 'string' ? rec.description : '',
      category: typeof rec.category === 'string' && rec.category.trim() ? rec.category.trim() : 'general',
      ...(typeof rec.docsUrl === 'string' ? { docsUrl: rec.docsUrl } : {}),
      enabled: rec.enabled !== false,
      transport: {
        ...transport,
        configFields: Array.isArray(transport.configFields) ? transport.configFields : [],
      },
      authentication: {
        ...auth,
        requiredFields: Array.isArray(auth.requiredFields) ? auth.requiredFields : [],
        optionalFields: Array.isArray(auth.optionalFields) ? auth.optionalFields : [],
        fields: Array.isArray(auth.fields) ? auth.fields : [],
      },
    } satisfies McpProvider;
  });
  return { version: typeof obj.version === 'number' ? obj.version : 1, providers };
}

const LOADED: McpProviderRegistry = coerceRegistry(raw);

/** All supported MCP providers (enabled + disabled, the UI filters). */
export function listMcpProviders(): McpProvider[] {
  return LOADED.providers;
}

/** Registry version (bump when the JSON file changes shape). */
export function mcpProviderRegistryVersion(): number {
  return LOADED.version;
}

/** One provider by id, or undefined when the id is not in the registry. */
export function getMcpProvider(id: string): McpProvider | undefined {
  return LOADED.providers.find((p) => p.id === id);
}

/** A provider id known to the registry AND enabled for new connections. */
export function isProviderSupported(id: string): boolean {
  const p = getMcpProvider(id);
  return !!p && p.enabled;
}
