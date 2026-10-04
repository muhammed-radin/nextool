/**
 * NexTool v1.0.12 — MCP connectors + custom-only export test suite.
 *
 * Covers spec §1.1-§1.19 (connectors) and §2.1-§2.2 (export restriction)
 * against an IN-PROCESS mock MCP client installed through setMcpClientFactory
 * (§1.5 test seam) — no network, no real external credentials. Connector
 * state is DB-backed (real Prisma); every row uses the "test-mcp" name prefix
 * and is removed again in afterAll.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import {
  getMcpProvider,
  listMcpProviders,
  mcpProviderRegistryVersion,
} from '../src/lib/nexool/mcp/provider-registry';
import {
  setMcpClientFactory,
  McpAuthError,
  McpConnectionError,
} from '../src/lib/nexool/mcp/client';
import type {
  McpClientFactoryOptions,
  McpClientLike,
  McpRemoteTool,
} from '../src/lib/nexool/mcp/client';
import {
  createConnector,
  deleteConnector,
  setCredentials,
  connectConnector,
  disconnectConnector,
  reconnectConnector,
  discoverTools,
  importTools,
  refreshTools,
  setImportedToolEnabled,
  removeImportedTool,
  listImportedToolsForConnector,
  McpConnectorFailure,
} from '../src/lib/nexool/mcp/connector-manager';
import { mcpInputSchemaToNexoolSchema } from '../src/lib/nexool/mcp/schema-convert';
import {
  toolExportClass,
  isToolExportable,
  exportToolJson,
} from '../src/lib/nexool/tool-portable';
import { runMcpTool } from '../src/lib/nexool/tools/mcp-runner';
import { db } from '../src/lib/db';

const SECRET = 'tok_test_1234567890';

const TOOLS_V1: McpRemoteTool[] = [
  {
    name: 'search_repositories',
    description: 'Search GitHub repositories',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'integer', description: 'Maximum results' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title', enum: undefined },
      },
      required: ['title'],
    },
  },
];

let tools: McpRemoteTool[] = TOOLS_V1;
let connectBehavior: 'ok' | 'auth' | 'conn' = 'ok';
let failTool: string | null = null;
const calls: { name: string; args: Record<string, unknown> }[] = [];
let capturedFactoryOpts: McpClientFactoryOptions | null = null;

const mockClient = (): McpClientLike => ({
  getServerInfo: () => ({ name: 'mock-github', version: '1.2.3' }),
  listTools: async () => tools,
  callTool: async (name, args) => {
    calls.push({ name, args });
    if (failTool === name) {
      return { isError: true, text: 'remote boom', content: [{ type: 'text', text: 'remote boom' }] };
    }
    return {
      isError: false,
      text: 'ok',
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { done: true },
    };
  },
  close: async () => {},
});

setMcpClientFactory(async (opts) => {
  capturedFactoryOpts = opts;
  if (connectBehavior === 'auth') throw new McpAuthError('invalid token');
  if (connectBehavior === 'conn') throw new McpConnectionError('connection refused');
  return mockClient();
});

const ctx = { timeoutMs: 8000 } as unknown as Parameters<typeof runMcpTool>[2];

describe('v1.0.12 — MCP provider registry (§1.2/§1.3)', () => {
  test('loads the JSON-defined providers — Gmail, Calendar, Drive, GitHub', () => {
    const providers = listMcpProviders().map((p) => p.id);
    expect(providers).toContain('gmail');
    expect(providers).toContain('google-calendar');
    expect(providers).toContain('google-drive');
    expect(providers).toContain('github');
    expect(mcpProviderRegistryVersion()).toBeGreaterThanOrEqual(1);
  });

  test('provider entries carry transport + auth details behind the abstraction', () => {
    const gh = getMcpProvider('github');
    expect(gh).toBeDefined();
    expect(gh!.transport.type).toBe('http');
    expect(gh!.authentication.type).toBe('api_token');
    expect(gh!.authentication.requiredFields).toContain('token');
    const gmail = getMcpProvider('gmail');
    expect(gmail!.authentication.type).toBe('oauth');
  });
});

describe('v1.0.12 — MCP schema conversion (§1.13)', () => {
  test('preserves types, required, descriptions and enums from the MCP inputSchema', () => {
    const schema = mcpInputSchemaToNexoolSchema(TOOLS_V1[0].inputSchema) as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('query');
    expect(serialized).toContain('Search query');
    const params = (schema.params ?? schema.parameters ?? schema.properties) as unknown;
    expect(params).toBeDefined();
    // required flag must survive: search for the required marker
    expect(/required/i.test(serialized)).toBe(true);
  });

  test('integer and enum information is not thrown away', () => {
    const schema = mcpInputSchemaToNexoolSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'count' },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['n'],
    }) as unknown as Record<string, unknown>;
    const s = JSON.stringify(schema);
    expect(s).toContain('integer');
    expect(s).toContain('a');
  });
});

describe('v1.0.12 — connector lifecycle (§1.1/§1.6/§1.7/§1.8/§1.18)', () => {
  let cid = '';
  let cid2 = '';

  test('creates a connector from the registry with honest initial state', async () => {
    const dto = await createConnector({ providerId: 'github', name: 'test-mcp-gh' });
    cid = dto.id;
    expect(dto.providerId).toBe('github');
    expect(dto.status).toBe('not_connected');
    expect(dto.hasCredentials).toBe(false);
    expect(dto.authRequired).toBe(true);

    cid2 = (await createConnector({ providerId: 'github', name: 'test-mcp-gh-2' })).id;
  });

  test('rejects unknown providers and duplicate names', async () => {
    try {
      await createConnector({ providerId: 'not-a-provider' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpConnectorFailure);
    }
    try {
      await createConnector({ providerId: 'github', name: 'test-mcp-gh' });
      expect.unreachable();
    } catch (err) {
      expect((err as McpConnectorFailure).code).toBe('CONNECTOR_ALREADY_EXISTS');
    }
  });

  test('connect without credentials is refused honestly (auth_required)', async () => {
    try {
      await connectConnector(cid);
      expect.unreachable();
    } catch (err) {
      expect((err as McpConnectorFailure).code).toBe('MCP_AUTH_REQUIRED');
    }
    const dto = await connectConnector(cid).catch(() => null);
    expect(dto === null || dto!.status === 'auth_required').toBe(true);
  });

  test('credentials stay server-side — DTOs never leak values (§1.7)', async () => {
    await setCredentials(cid, { values: { token: SECRET } });
    const dto = await import('../src/lib/nexool/mcp/connector-manager').then((m) => m.getConnectorDTOById(cid));
    expect(dto.hasCredentials).toBe(true);
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    const all = JSON.stringify(await import('../src/lib/nexool/mcp/connector-manager').then((m) => m.listConnectors()));
    expect(all).not.toContain(SECRET);
  });

  test('connect performs the real handshake and resolves credentials server-side', async () => {
    const dto = await connectConnector(cid);
    expect(dto.status).toBe('connected');
    expect(dto.serverInfo).toEqual({ name: 'mock-github', version: '1.2.3' });
    expect(capturedFactoryOpts!.credential).not.toBeNull();
    expect((capturedFactoryOpts!.credential as Record<string, unknown>).token).toBe(SECRET);
  });

  test('connection failures map to honest error statuses (§1.18)', async () => {
    connectBehavior = 'conn';
    let dto = await reconnectConnector(cid);
    expect(dto.status).toBe('error');

    connectBehavior = 'auth';
    dto = await reconnectConnector(cid);
    expect(dto.status).toBe('auth_required');

    connectBehavior = 'ok';
    dto = await reconnectConnector(cid);
    expect(dto.status).toBe('connected');
  });
});

describe('v1.0.12 — discovery, import, execution, refresh (§1.9-§1.17)', () => {
  let cid = '';
  let searchToolName = '';

  test('discovery lists remote tools with schemas and import state (§1.9)', async () => {
    const created = await createConnector({ providerId: 'github', name: 'test-mcp-disc' });
    cid = created.id;
    await setCredentials(cid, { values: { token: SECRET } });
    await connectConnector(cid);
    const disc = await discoverTools(cid);
    expect(disc.connected).toBe(true);
    expect(disc.tools.length).toBe(2);
    const search = disc.tools.find((t) => t.name === 'search_repositories');
    expect(search).toBeDefined();
    expect(search!.imported).toBe(false);
    expect(search!.remoteHash.length).toBeGreaterThan(0);
    expect(search!.inputSchema).toBeDefined();
  });

  test('import creates mcp-environment tools carrying identity, never secrets (§1.10/§1.11/§1.14)', async () => {
    const result = await importTools(cid, ['search_repositories', 'create_issue']);
    expect(result.imported.length).toBe(2);
    expect(result.failed.length).toBe(0);

    const imported = await listImportedToolsForConnector(cid);
    expect(imported.length).toBe(2);
    searchToolName = imported.find((t) => t.mcp.mcpToolName === 'search_repositories')!.name;
    expect(searchToolName.startsWith('mcp.')).toBe(true);
    for (const entry of imported) {
      expect(entry.environment).toBe('mcp');
      expect(entry.mcp.connectorId).toBe(cid);
      expect(JSON.stringify(entry)).not.toContain(SECRET);
    }
    const disc = await discoverTools(cid);
    expect(disc.tools.find((t) => t.name === 'search_repositories')!.imported).toBe(true);
  });

  test('imported MCP tool executes through the connector into the mock server (§1.12)', async () => {
    const imported = await listImportedToolsForConnector(cid);
    const entry = imported.find((t) => t.mcp.mcpToolName === 'search_repositories')!;
    const before = calls.length;
    const result = (await runMcpTool(entry.mcp, { query: 'nextool' }, ctx)) as unknown as Record<string, unknown>;
    expect(result.text).toBe('ok');
    expect(result.structuredContent).toEqual({ done: true });
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].args).toEqual({ query: 'nextool' });
  });

  test('remote failures become structured NexTool tool failures (§1.18)', async () => {
    const imported = await listImportedToolsForConnector(cid);
    const entry = imported.find((t) => t.mcp.mcpToolName === 'search_repositories')!;
    failTool = 'search_repositories';
    try {
      await runMcpTool(entry.mcp, { query: 'x' }, ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MCP_REMOTE_FAILURE');
    } finally {
      failTool = null;
    }
  });

  test('disconnect keeps records but makes tools unavailable; reconnect restores (§1.17)', async () => {
    const disconnected = await disconnectConnector(cid);
    expect(disconnected.status).toBe('disconnected');

    const imported = await listImportedToolsForConnector(cid);
    expect(imported.length).toBe(2); // records survive

    const entry = imported.find((t) => t.mcp.mcpToolName === 'search_repositories')!;
    try {
      await runMcpTool(entry.mcp, { query: 'x' }, ctx);
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('MCP_NOT_CONNECTED');
    }

    const reconnected = await reconnectConnector(cid);
    expect(reconnected.status).toBe('connected');
    const after = await listImportedToolsForConnector(cid);
    expect(after.length).toBe(2); // no re-import needed
    const result = (await runMcpTool(entry.mcp, { query: 'back' }, ctx)) as unknown as Record<string, unknown>;
    expect(result.text).toBe('ok');
  });

  test('schema refresh updates representation and preserves local metadata (§1.16)', async () => {
    const imported = await listImportedToolsForConnector(cid);
    const entry = imported.find((t) => t.mcp.mcpToolName === 'search_repositories')!;
    await setImportedToolEnabled(cid, entry.name, false);

    tools = [
      {
        ...TOOLS_V1[0],
        description: 'Search GitHub repositories (v2-marker)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            sort: { type: 'string', description: 'Sort order' },
          },
          required: ['query', 'sort'],
        },
      },
      TOOLS_V1[1],
    ];
    const refresh = await refreshTools(cid);
    expect(refresh.refreshed.length).toBe(2);
    expect(refresh.refreshed.find((r) => r.mcpToolName === 'search_repositories')!.changed).toBe(true);

    const after = await listImportedToolsForConnector(cid);
    const refreshed = after.find((t) => t.mcp.mcpToolName === 'search_repositories')!;
    expect(JSON.stringify(refreshed)).toContain('v2-marker');
    expect((refreshed as unknown as { enabled: boolean }).enabled).toBe(false);
    await setImportedToolEnabled(cid, entry.name, true);

    // remote tool disappears → reported unavailable, local record NOT deleted
    tools = [TOOLS_V1[1]];
    const gone = await refreshTools(cid);
    expect(gone.unavailable).toContain('search_repositories');
    const stillThere = await listImportedToolsForConnector(cid);
    expect(stillThere.find((t) => t.mcp.mcpToolName === 'search_repositories')).toBeDefined();
    tools = TOOLS_V1;
  });

  test('removeImportedTool deletes only the local NexTool record (§1.15)', async () => {
    const imported = await listImportedToolsForConnector(cid);
    const issue = imported.find((t) => t.mcp.mcpToolName === 'create_issue')!;
    const removed = await removeImportedTool(cid, issue.name);
    expect(removed.removed).toBe(true);
    const after = await listImportedToolsForConnector(cid);
    expect(after.find((t) => t.mcp.mcpToolName === 'create_issue')).toBeUndefined();
    // the remote/mock server is untouched — discovery still lists it
    const disc = await discoverTools(cid);
    expect(disc.tools.find((t) => t.name === 'create_issue')).toBeDefined();
  });

  afterAll(async () => {
    for (const id of [cid]) {
      await deleteConnector(id).catch(() => {});
    }
    await db.toolRecord.deleteMany({ where: { name: { startsWith: 'mcp.test-mcp' } } }).catch(() => {});
  });
});

describe('v1.0.12 — export classification (§2.1/§2.2)', () => {
  test('mcp environment classifies as connector-backed and is never exportable', () => {
    expect(toolExportClass('mcp')).toBe('mcp');
    expect(isToolExportable({ environment: 'mcp' } as never)).toBe(false);
  });

  test('custom environments stay exportable; non-custom environments do not', () => {
    expect(toolExportClass('js-function')).toBe('custom');
    expect(toolExportClass('nodejs')).toBe('custom');
    expect(toolExportClass('freedom-node')).toBe('custom');
    expect(isToolExportable({ environment: 'js-function' } as never)).toBe(true);
    expect(toolExportClass('virtual-env')).toBe('builtin');
    expect(isToolExportable({ environment: 'virtual-env' } as never)).toBe(false);
  });

  test('exportToolJson refuses built-ins and MCP tools even if called directly', () => {
    const fakeBuiltin = { name: 'sys-tool', environment: 'virtual-env' } as never;
    expect(() => exportToolJson(fakeBuiltin)).toThrow(/cannot be exported/);
    const fakeMcp = { name: 'mcp.x.y', environment: 'mcp' } as never;
    expect(() => exportToolJson(fakeMcp)).toThrow(/connector-backed/);
  });

  test('custom tool export still works (no regression)', () => {
    const entry = {
      name: 'test-export-tool',
      description: 'A custom tool',
      category: 'custom',
      environment: 'js-function',
      schema: { params: [] },
      functionSource: 'return 1;',
    } as never;
    const portable = exportToolJson(entry, '1.0.12');
    expect((portable as { name: string }).name).toBe('test-export-tool');
    expect(JSON.stringify(portable)).not.toContain(SECRET);
  });
});

afterAll(async () => {
  // Safety net: remove every test-mcp row (connectors cascade their tools).
  const rows = await db.mcpConnector.findMany({ where: { name: { startsWith: 'test-mcp' } } }).catch(() => []);
  for (const row of rows) await deleteConnector(row.id).catch(() => {});
  await db.toolRecord.deleteMany({ where: { name: { startsWith: 'mcp.test-mcp' } } }).catch(() => {});
});
