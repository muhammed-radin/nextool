/**
 * NexTool v1.0.13 — MCP provider registry (JSON-based, extensible).
 *
 * SUPPORTED MCP SERVERS live in `config/mcp-servers.json` — a declarative
 * registry, NOT hard-coded per-provider branches in the frontend or backend.
 * Flow (spec §1.2):
 *
 *   SUPPORTED MCP SERVERS → JSON registry → CONNECTORS UI → MCP CLIENT
 *
 * Adding a future platform (Slack, Notion, …) means appending ONE JSON object
 * here — no runtime change: the Connectors page, the credential forms, the
 * transport factory, the AUTH engine and the tool importer all read this
 * registry.
 *
 * v1.0.13 (§4/§5) — the registry is also the source of the CUSTOMIZABLE AUTH
 * architecture. Every provider preset declares:
 *   - `authMethods`            which auth methods the UI offers
 *                              (none | bearer | token_pair | oauth2)
 *   - `oauth`                  OAuth 2.0 preset: authorization/token endpoints,
 *                              default (EDITABLE) scopes, PKCE support, token
 *                              request style, and the credential field names
 *                              the callback stores tokens under
 *   - `loginWording`           the login button text ("Login via Google", …)
 *   - `requiredFieldsByMethod` per-method required credential fields —
 *                              `requiredFields` remains the legacy fallback
 *   - `validation`             best-effort manual-token validation strategy
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
export type McpAuthType = 'oauth' | 'access_token' | 'api_token' | 'api_key' | 'none';

/** v1.0.13 §5 — selectable auth methods for a connector. */
export type McpAuthMethod = 'none' | 'bearer' | 'token_pair' | 'oauth2';

/** Best-effort validation strategies for manually entered tokens (§5). */
export type McpAuthValidation = 'google_tokeninfo' | 'github_user' | 'none';

/** OAuth 2.0 authorization-code preset (§5.2) — endpoints + scopes editable per connector. */
export interface McpProviderOAuthPreset {
  /** Default authorization endpoint (user-overridable on the connector). */
  authorizeUrl?: string;
  /** Default token endpoint (user-overridable on the connector). */
  tokenUrl?: string;
  /** Default scopes — the UI shows them as editable chips + an arbitrary adder (§5.3). */
  defaultScopes?: string[];
  /** Separator used in the authorize request (default ' '). */
  scopeSeparator?: string;
  /** Use PKCE (S256) in the authorization-code flow. */
  pkce?: boolean;
  /** Token request body encoding (both are standard application/x-www-form-urlencoded POSTs). */
  tokenStyle?: 'form' | 'json';
  /** Credential field the callback stores the access token under. */
  accessTokenField?: string;
  /** Credential field the callback stores the refresh token under (optional provider-side). */
  refreshTokenField?: string;
  /** Extra fixed authorize parameters (provider quirks). */
  extraAuthorizeParams?: Record<string, string>;
}

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
  /** stdio defaults (overridable per connector via transport config). */
  defaultCommand?: string;
  defaultArgs?: string[];
  /** http default (overridable per connector via transport config). */
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
  /** Legacy flat required-field list (v1.0.12 compat; used when no method is selected yet). */
  requiredFields: string[];
  optionalFields: string[];
  fields: (McpProviderConfigField & { secret?: boolean })[];

  // ---------- v1.0.13 §5 customizable-auth additions (all optional) ----------
  /** Which auth methods the UI offers (ordered). Derived from `type` when absent. */
  authMethods?: McpAuthMethod[];
  /** Required credential fields PER METHOD (overrides requiredFields when a method is set). */
  requiredFieldsByMethod?: Partial<Record<McpAuthMethod, string[]>>;
  /** OAuth 2.0 authorization-code preset — required for the `oauth2` method. */
  oauth?: McpProviderOAuthPreset;
  /** Login button wording, e.g. "Login via Google". Defaults to `Login via <provider name>`. */
  loginWording?: string;
  /** Best-effort validation for manually entered tokens. */
  validation?: McpAuthValidation;
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

// ---------- coercion helpers (defensive JSON loading) ----------

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const AUTH_METHODS: readonly McpAuthMethod[] = ['none', 'bearer', 'token_pair', 'oauth2'];

function coerceAuthMethods(v: unknown): McpAuthMethod[] | undefined {
  const arr = strArray(v);
  if (!arr) return undefined;
  const methods = arr.filter((m): m is McpAuthMethod => (AUTH_METHODS as readonly string[]).includes(m));
  return methods.length > 0 ? methods : undefined;
}

function coerceOauthPreset(v: unknown): McpProviderOAuthPreset | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const preset: McpProviderOAuthPreset = {
    ...(typeof o.authorizeUrl === 'string' && o.authorizeUrl ? { authorizeUrl: o.authorizeUrl } : {}),
    ...(typeof o.tokenUrl === 'string' && o.tokenUrl ? { tokenUrl: o.tokenUrl } : {}),
    ...(strArray(o.defaultScopes) ? { defaultScopes: strArray(o.defaultScopes) } : { defaultScopes: [] }),
    ...(typeof o.scopeSeparator === 'string' && o.scopeSeparator ? { scopeSeparator: o.scopeSeparator } : {}),
    ...(typeof o.pkce === 'boolean' ? { pkce: o.pkce } : {}),
    ...(o.tokenStyle === 'json' ? { tokenStyle: 'json' as const } : { tokenStyle: 'form' as const }),
    ...(typeof o.accessTokenField === 'string' && o.accessTokenField ? { accessTokenField: o.accessTokenField } : {}),
    ...(typeof o.refreshTokenField === 'string' && o.refreshTokenField ? { refreshTokenField: o.refreshTokenField } : {}),
    ...(strRecord(o.extraAuthorizeParams) ? { extraAuthorizeParams: strRecord(o.extraAuthorizeParams) } : {}),
  };
  return preset;
}

function coerceRequiredByMethod(v: unknown): Partial<Record<McpAuthMethod, string[]>> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Partial<Record<McpAuthMethod, string[]>> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if ((AUTH_METHODS as readonly string[]).includes(k)) {
      const fields = strArray(val);
      if (fields) out[k as McpAuthMethod] = fields;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceValidation(v: unknown): McpAuthValidation | undefined {
  if (v === 'google_tokeninfo' || v === 'github_user' || v === 'none') return v;
  return undefined;
}

/** Legacy `authentication.type` → default selectable methods (v1.0.12 records). */
function methodsFromLegacyType(type: string): McpAuthMethod[] {
  switch (type) {
    case 'oauth':
      return ['token_pair', 'oauth2', 'bearer'];
    case 'access_token':
      return ['bearer', 'token_pair'];
    case 'none':
      return ['none'];
    default:
      return ['bearer'];
  }
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
    const authMethods = coerceAuthMethods(auth.authMethods) ?? methodsFromLegacyType(auth.type);
    const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id;
    return {
      id,
      name,
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
        authMethods,
        ...(coerceRequiredByMethod(auth.requiredFieldsByMethod)
          ? { requiredFieldsByMethod: coerceRequiredByMethod(auth.requiredFieldsByMethod) }
          : {}),
        ...(coerceOauthPreset(auth.oauth) ? { oauth: coerceOauthPreset(auth.oauth) } : {}),
        ...(typeof auth.loginWording === 'string' && auth.loginWording ? { loginWording: auth.loginWording } : { loginWording: `Login via ${name}` }),
        ...(coerceValidation(auth.validation) ? { validation: coerceValidation(auth.validation) } : { validation: 'none' as const }),
      },
    } satisfies McpProvider;
  });
  return { version: typeof obj.version === 'number' ? obj.version : 1, providers };
}

const LOADED: McpProviderRegistry = coerceRegistry(raw);

// ---------- public surface ----------

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

/** Auth methods the UI offers for a provider (registry-declared or derived). */
export function providerAuthMethods(provider: McpProvider): McpAuthMethod[] {
  return provider.authentication.authMethods ?? methodsFromLegacyType(provider.authentication.type);
}

/**
 * Required credential fields for one auth method (§5). Falls back to the
 * legacy flat requiredFields when no per-method list is declared.
 */
export function requiredFieldsForMethod(provider: McpProvider, method: McpAuthMethod | null | undefined): string[] {
  const byMethod = provider.authentication.requiredFieldsByMethod;
  if (method && byMethod && Array.isArray(byMethod[method])) return byMethod[method] as string[];
  // Sensible legacy default: the oauth2 method needs tokens only AFTER login.
  if (method === 'oauth2' && provider.authentication.oauth) return [];
  return provider.authentication.requiredFields;
}
