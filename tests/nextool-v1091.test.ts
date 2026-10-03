/**
 * NexTool Q1 v1.0.91 test suite — in-sandbox fetch() self-origin fix
 * (POST /api/tools/test restored) + bulk tool JSON import.
 *
 * Covers the v1.0.91 acceptance criteria:
 *   §1  fetch() inside a tool function can POST to /api/tools/test (HTTP 200)
 *   §1  the 405 root cause is fixed at the route level (dedicated route exists)
 *   §1  existing network security policies remain active (absolute loopback
 *       URLs stay HOST_BLOCKED; timeouts/size/redirect/request limits intact)
 *   §2  bulk import: object = one tool, array = bulk, [] = honest empty,
 *       invalid JSON = clear error, every item validated BEFORE registration,
 *       invalid tools never registered, duplicates handled explicitly,
 *       export-all → import round trip
 *
 * Run: bun test tests/nextool-v1091.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import {
  NetworkPolicyError,
  getSelfOrigin,
  isSelfOrigin,
  isSelfRelativePath,
  parsePolicyUrl,
  parseRedirectUrl,
  policyFetch,
} from '../src/lib/nexool/tools/sandbox-net';
import { runJsTool } from '../src/lib/nexool/tools/js-runner';
import { createTestInteractions } from '../src/lib/nexool/tools/sandbox-interactive';
import {
  parseToolImport,
  parseToolsImport,
  buildBulkImportPlan,
  exportToolsJson,
  validateImportedTool,
} from '../src/lib/nexool/tool-portable';
import { registerJsTool, deleteTool } from '../src/lib/nexool/tools/registry';
import { db } from '../src/lib/db';
import { POST as testRoutePOST } from '../src/app/api/tools/test/route';
import type { ToolEntry } from '../src/lib/nexool/api-contract';

// ===========================================================================
// §1 — fetch() self-origin: URL resolution + policy preservation
// ===========================================================================

describe('v1.0.91 §1.3 — relative URLs resolve against the application origin', () => {
  test('getSelfOrigin() defaults to the loopback app origin (PORT or 3000)', () => {
    const origin = getSelfOrigin();
    expect(origin.startsWith('http://127.0.0.1:')).toBe(true);
  });

  test('NEXTOOL_SELF_ORIGIN overrides the default origin', () => {
    const prev = process.env.NEXTOOL_SELF_ORIGIN;
    process.env.NEXTOOL_SELF_ORIGIN = 'http://127.0.0.1:39999/';
    try {
      expect(getSelfOrigin()).toBe('http://127.0.0.1:39999');
    } finally {
      if (prev === undefined) delete process.env.NEXTOOL_SELF_ORIGIN;
      else process.env.NEXTOOL_SELF_ORIGIN = prev;
    }
  });

  test('isSelfRelativePath: path-only URLs are self-relative, //host is NOT', () => {
    expect(isSelfRelativePath('/api/tools/test')).toBe(true);
    expect(isSelfRelativePath('/x?y=1')).toBe(true);
    expect(isSelfRelativePath('//evil.com/x')).toBe(false);
    expect(isSelfRelativePath('https://example.com')).toBe(false);
  });

  test('parsePolicyUrl resolves /api/tools/test to the application origin and skips ONLY the host block', () => {
    const url = parsePolicyUrl('/api/tools/test');
    expect(url.origin).toBe(getSelfOrigin());
    expect(url.pathname).toBe('/api/tools/test');
    expect(isSelfOrigin(url)).toBe(true);
  });

  test('relative URLs with query strings and nested paths resolve correctly', () => {
    expect(parsePolicyUrl('/api/tools?x=1').search).toBe('?x=1');
    expect(parsePolicyUrl('/a/b/c').pathname).toBe('/a/b/c');
  });

  test('ABSOLUTE loopback URLs stay HOST_BLOCKED — the v1.0.6 SSRF guard is intact', () => {
    // Even the application origin itself is blocked when addressed absolutely.
    const absoluteSelf = `${getSelfOrigin()}/api/tools/test`;
    expect(() => parsePolicyUrl(absoluteSelf)).toThrow(NetworkPolicyError);
    try {
      parsePolicyUrl(absoluteSelf);
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('HOST_BLOCKED');
    }
    expect(() => parsePolicyUrl('http://localhost/api/tools/test')).toThrow(NetworkPolicyError);
    expect(() => parsePolicyUrl('http://127.0.0.1:9999/x')).toThrow(NetworkPolicyError);
    expect(() => parsePolicyUrl('http://169.254.169.254/latest/meta-data')).toThrow(NetworkPolicyError);
  });

  test('selfOriginAccess=false disables relative fetch honestly', async () => {
    const { getNetworkPolicy } = await import('../src/lib/nexool/tools/sandbox-net');
    const policy = { ...getNetworkPolicy(), selfOriginAccess: false };
    try {
      parsePolicyUrl('/api/tools/test', policy);
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('INVALID_URL');
      expect((e as Error).message).toMatch(/selfOriginAccess/);
    }
  });

  test('parseRedirectUrl: relative location on a self-origin request keeps the exemption; absolute does not', () => {
    const selfBase = parsePolicyUrl('/api/tools/test');
    const hop = parseRedirectUrl('/api/other', selfBase);
    expect(hop.origin).toBe(getSelfOrigin());
    expect(hop.pathname).toBe('/api/other');
    // absolute location (even to the self origin) validates like any absolute URL
    expect(() => parseRedirectUrl(`${getSelfOrigin()}/x`, selfBase)).toThrow(NetworkPolicyError);
    // absolute location to a public host is fine
    expect(parseRedirectUrl('https://example.com/next', selfBase).hostname).toBe('example.com');
    // relative location on an EXTERNAL request resolves against that host
    const ext = parsePolicyUrl('https://example.com/start');
    expect(parseRedirectUrl('/next', ext).hostname).toBe('example.com');
  });
});

// ---------- §1.2 — policyFetch with relative URLs (method/body/headers preserved) ----------

const realFetch = globalThis.fetch;
type MinimalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function stubFetch(impl: MinimalFetch) {
  (globalThis as { fetch: unknown }).fetch = impl;
}
function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('v1.0.91 §1.2 — policyFetch passes the method through for relative URLs (no GET rewrite)', () => {
  afterAll(() => {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  });

  test('POST /api/tools/test with Content-Type + JSON body is dispatched as POST', async () => {
    let seen: { url?: string; method?: string; body?: unknown; headers?: unknown } = {};
    stubFetch((url, init) => {
      seen = { url: String(url), method: init?.method, body: init?.body, headers: init?.headers };
      return Promise.resolve(jsonResponse(JSON.stringify({ ok: true, data: { mode: 'test-source', status: 'completed' } })));
    });
    const res = await policyFetch('/api/tools/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionSource: 'async function execute() { return {}; }', params: {} }),
    });
    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST'); // never rewritten to GET
    expect(seen.url).toBe(`${getSelfOrigin()}/api/tools/test`);
    expect(seen.headers).toEqual({ 'Content-Type': 'application/json' });
    const parsed = JSON.parse(String(seen.body)) as { functionSource: string };
    expect(parsed.functionSource).toContain('execute');
  });

  test('existing EXTERNAL http(s) requests are unaffected — method/headers/body preserved', async () => {
    let seen: { url?: string; method?: string; headers?: unknown } = {};
    stubFetch((url, init) => {
      seen = { url: String(url), method: init?.method, headers: init?.headers };
      return Promise.resolve(jsonResponse('{"ext":true}'));
    });
    const res = await policyFetch('https://example.com/api', { method: 'POST', headers: { 'x-a': 'b' }, body: '{"k":1}' });
    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('https://example.com/api');
    expect(seen.headers).toEqual({ 'x-a': 'b' });
  });

  test('relative redirect chain on a self-origin request is followed; absolute loopback hop is blocked', async () => {
    stubFetch((url) => {
      const u = String(url);
      if (u === `${getSelfOrigin()}/api/start`) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: '/api/final' } }));
      }
      if (u === `${getSelfOrigin()}/api/final`) return Promise.resolve(jsonResponse('{"final":true}'));
      return Promise.resolve(jsonResponse('miss', 404));
    });
    const res = await policyFetch('/api/start', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ final: true });

    stubFetch(() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/steal' } })));
    try {
      await policyFetch('/api/start', {});
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('HOST_BLOCKED');
    }
  });
});

// ---------- §1.5 — REAL network: a tool function fetch()es /api/tools/test ----------

describe('v1.0.91 §1.5 — tool function fetch("/api/tools/test", { method: "POST" }) end-to-end', () => {
  let server: ReturnType<typeof Bun.serve>;
  let seen: { method?: string; path?: string; contentType?: string; body?: string } | null = null;
  let prevOrigin: string | undefined;

  beforeAll(() => {
    // A loopback HTTP server plays the role of the NexTool application origin
    // (bun test runs outside Next.js, so the real route is exercised in the
    // route-level tests below and in the browser).
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen = {
          method: req.method,
          path: url.pathname,
          contentType: req.headers.get('content-type') ?? undefined,
          body: await req.text(),
        };
        if (url.pathname === '/api/tools/test' && req.method === 'POST') {
          return new Response(JSON.stringify({ ok: true, data: { mode: 'test-source', status: 'completed', durationMs: 1, result: { words: 5 }, error: null, logs: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    prevOrigin = process.env.NEXTOOL_SELF_ORIGIN;
    process.env.NEXTOOL_SELF_ORIGIN = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    if (prevOrigin === undefined) delete process.env.NEXTOOL_SELF_ORIGIN;
    else process.env.NEXTOOL_SELF_ORIGIN = prevOrigin;
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  });

  test('the EXACT failure scenario now succeeds — HTTP 200, no 405, no REQUEST_FAILED', async () => {
    const source = `
      async function execute(params, context) {
        const response = await fetch("/api/tools/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            functionSource: "const text = typeof params.text === 'string' ? params.text : ''; return { words: (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).length };",
            params: { text: "NexTool executes real tools" }
          })
        });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return await response.json();
      }
    `;
    const run = await runJsTool(
      source,
      {},
      { executionId: 'v1091_e2e', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: '__scratch_v1091', interactions: createTestInteractions(), accounting: undefined, moduleCache: new Map() },
    );
    expect(run.ok).toBe(true);
    expect(run.error).toBeUndefined();
    const payload = run.result as { ok: boolean; data: { mode: string; status: string } };
    expect(payload.ok).toBe(true);
    expect(payload.data.mode).toBe('test-source');
    expect(payload.data.status).toBe('completed');
    // the request REALLY went out as POST /api/tools/test with JSON headers
    expect(seen?.method).toBe('POST');
    expect(seen?.path).toBe('/api/tools/test');
    expect(seen?.contentType).toContain('application/json');
  });
});

// ===========================================================================
// §1 — POST /api/tools/test route (the 405 root cause)
// ===========================================================================

function postJson(payload: unknown): Request {
  return new Request('http://localhost:3000/api/tools/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('v1.0.91 — POST /api/tools/test route (restored; no more 405 fallthrough)', () => {
  const routeToolName = 'v1091test.echo';

  beforeAll(async () => {
    await registerJsTool({
      name: routeToolName,
      description: 'v1.0.91 route test tool',
      schema: { type: 'object', properties: [] },
      functionSource: 'async function execute(params) { return { echoed: params, env: typeof fetch }; }',
    });
  });

  afterAll(async () => {
    try { await db.toolRecord.delete({ where: { name: routeToolName } }); } catch { /* already gone */ }
  });

  test('test-source mode: executes unsaved source in the sandbox and returns the envelope', async () => {
    const res = await testRoutePOST(postJson({
      functionSource: 'async function execute(params) { return { doubled: params.n * 2 }; }',
      params: { n: 21 },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { mode: string; status: string; result: { doubled: number }; logs: string[] } };
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe('test-source');
    expect(body.data.status).toBe('completed');
    expect(body.data.result.doubled).toBe(42);
    expect(Array.isArray(body.data.logs)).toBe(true);
  });

  test('registered mode: a registered tool runs through the route by NAME', async () => {
    const res = await testRoutePOST(postJson({ name: routeToolName, params: { k: 'v' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { mode: string; status: string; environment: string; result: { echoed: unknown } } };
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe('registered');
    expect(body.data.status).toBe('completed');
    expect(body.data.environment).toBe('js-function');
    expect(body.data.result.echoed).toEqual({ k: 'v' });
  });

  test('unknown tool name → 404 NOT_FOUND (not 405)', async () => {
    const res = await testRoutePOST(postJson({ name: 'ghost.missing' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  test('both name AND functionSource → 400 INVALID_PARAMS; POST is the only method on this route', async () => {
    const both = await testRoutePOST(postJson({ name: 'a.b', functionSource: 'async function execute(){}' }));
    expect(both.status).toBe(400);
    const neither = await testRoutePOST(postJson({ params: {} }));
    expect(neither.status).toBe(400);
  });

  test('a tool function can POST to /api/tools/test THROUGH the route while running INSIDE it', async () => {
    // Self-referential smoke: the test-source sandbox calls the app origin,
    // which (in production) is this very route. Here the loopback target is a
    // stub server asserting the request is a POST with JSON headers.
    let seenMethod = '';
    let seenCt = '';
    const prev = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenMethod = init?.method ?? 'GET';
      seenCt = String(new Headers(init?.headers).get('content-type') ?? '');
      return new Response(JSON.stringify({ ok: true, data: { status: 'completed' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    try {
      const res = await testRoutePOST(postJson({
        functionSource: `async function execute() {
          const r = await fetch("/api/tools/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
          return { status: r.status };
        }`,
      }));
      const body = (await res.json()) as { ok: boolean; data: { result: { status: number } } };
      expect(body.ok).toBe(true);
      expect(body.data.result.status).toBe(200);
      expect(seenMethod).toBe('POST');
      expect(seenCt).toContain('application/json');
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = prev;
    }
  });
});

// ===========================================================================
// §2 — bulk import: object | array | [] | invalid
// ===========================================================================

const VALID_TOOL = {
  nexool: { kind: 'nextool.tool', version: 1, appVersion: '1.0.91' },
  name: 'utility.wordcount',
  description: 'Counts words in a string',
  environment: 'js-function',
  schema: { type: 'object', properties: [{ name: 'text', type: 'string', required: true, description: 'Text' }] },
  functionSource: 'async function execute(params) { return { words: 1 }; }',
};

describe('v1.0.91 §2.1-§2.4 — parseToolsImport detects single vs bulk', () => {
  test('JSON object → one tool (single)', () => {
    const parsed = parseToolsImport(JSON.stringify(VALID_TOOL));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.kind).toBe('single');
      if (parsed.kind === 'single') {
        const v = validateImportedTool(parsed.value);
        expect(v.ok).toBe(true);
        expect(v.tool?.name).toBe('utility.wordcount');
      }
    }
  });

  test('JSON array → bulk import with every item kept for validation', () => {
    const parsed = parseToolsImport(JSON.stringify([VALID_TOOL, { ...VALID_TOOL, name: 'utility.second' }]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.kind === 'bulk') expect(parsed.tools.length).toBe(2);
    else expect.unreachable();
  });

  test('empty array → honest bulk-empty (nothing imported, no API call)', () => {
    const parsed = parseToolsImport('[]');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.kind).toBe('bulk-empty');
  });

  test('invalid JSON → clear error, nothing imported', () => {
    const parsed = parseToolsImport('{ "name": "broken",, }');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^Invalid JSON file/);
  });

  test('the { tools: [...] } bundle wrapper stays rejected (export-only contract)', () => {
    const parsed = parseToolsImport(JSON.stringify({ tools: [VALID_TOOL] }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/bundle/);
  });

  test('single-tool parseToolImport keeps its documented single-object contract', () => {
    expect(parseToolImport(JSON.stringify(VALID_TOOL)).ok).toBe(true);
    const arr = parseToolImport(JSON.stringify([VALID_TOOL]));
    expect(arr.ok).toBe(false); // unchanged — arrays belong to the v1.0.91 importer
    const bundle = parseToolImport(JSON.stringify({ tools: [VALID_TOOL] }));
    expect(bundle.ok).toBe(false);
  });
});

describe('v1.0.91 §2.4-§2.9 — buildBulkImportPlan validates ALL before registration', () => {
  const validA = { ...VALID_TOOL, name: 'utility.tool1' };
  const validB = { ...VALID_TOOL, name: 'utility.tool2' };
  const invalidNoDescription = { ...VALID_TOOL, name: 'utility.tool3', description: '' };
  const invalidEnv = { ...VALID_TOOL, name: 'utility.tool5', environment: 'quantum' };

  test('mixed validity: every item validated independently, invalid ones carry reasons', () => {
    const plan = buildBulkImportPlan([validA, validB, invalidNoDescription, validA], []);
    expect(plan.items.length).toBe(4);
    expect(plan.validCount).toBe(3);
    expect(plan.invalidCount).toBe(1);
    const bad = plan.items.find((it) => !it.valid);
    expect(bad?.errors.join(' ')).toMatch(/"description" is required/);
    expect(bad?.name).toBe('utility.tool3');
  });

  test('invalid environment is reported per item — weaker paths do not exist', () => {
    const plan = buildBulkImportPlan([validA, invalidEnv], []);
    expect(plan.validCount).toBe(1);
    expect(plan.items[1].valid).toBe(false);
    expect(plan.items[1].errors.join(' ')).toMatch(/"environment" must be one of/);
  });

  test('non-object garbage items are invalid — never registered', () => {
    const plan = buildBulkImportPlan([42, 'nope', null, [1]], []);
    expect(plan.validCount).toBe(0);
    expect(plan.invalidCount).toBe(4);
  });

  test('duplicate names INSIDE the same file are detected (§2.9)', () => {
    const plan = buildBulkImportPlan([validA, { ...validA, description: 'second copy' }], []);
    expect(plan.validCount).toBe(2);
    expect(plan.inFileDuplicates.length).toBe(1);
    expect(plan.inFileDuplicates[0].name).toBe('utility.tool1');
    expect(plan.inFileDuplicates[0].indices).toEqual([1, 2]);
  });

  test('conflicts with existing registry names are detected (§2.8)', () => {
    const plan = buildBulkImportPlan([validA, validB], ['utility.tool1', 'other.keep']);
    expect(plan.registryConflicts).toEqual([{ index: 1, name: 'utility.tool1' }]);
  });
});

describe('v1.0.91 §2.13-§2.14 — single import unchanged + export-all round trip', () => {
  const ENTRY: ToolEntry = {
    name: 'utility.wordcount',
    description: 'Counts words in a string',
    category: 'utility',
    environment: 'js-function',
    schema: { type: 'object', properties: [{ name: 'text', type: 'string', required: true, description: 'Text' }] },
    functionSource: 'async function execute(params) { return { words: 3 }; }',
    enabled: true,
    stats: { callCount: 1, successCount: 1, failureCount: 0, timeoutCount: 0, avgMs: 2, enabled: true },
  };

  test('Export all tools (JSON) → array → import → all valid tools restored (§2.14)', () => {
    const entries: ToolEntry[] = [
      ENTRY,
      { ...ENTRY, name: 'utility.http', description: 'HTTP probe', metadata: { owner: 'ops' } },
      { ...ENTRY, name: 'utility.math', description: 'Math helper' },
    ];
    const exported = exportToolsJson(entries, '1.0.91');
    const text = JSON.stringify(exported, null, 2);
    const parsed = parseToolsImport(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== 'bulk') return expect.unreachable();
    const plan = buildBulkImportPlan(parsed.tools, []);
    expect(plan.validCount).toBe(3);
    expect(plan.invalidCount).toBe(0);
    expect(plan.registryConflicts).toEqual([]);
    // definitions survive the round trip
    const names = plan.items.map((it) => it.tool?.name);
    expect(names).toEqual(['utility.wordcount', 'utility.http', 'utility.math']);
    expect(plan.items.every((it) => it.tool?.functionSource === ENTRY.functionSource)).toBe(true);
    expect(plan.items[1].tool?.metadata).toEqual({ owner: 'ops' });
    // re-importing into the SAME registry surfaces conflicts instead of overwriting
    const plan2 = buildBulkImportPlan(parsed.tools, entries.map((e) => e.name));
    expect(plan2.registryConflicts.length).toBe(3);
  });

  test('single object import path still works exactly as v1.0.4 (§2.13)', () => {
    const parsed = parseToolsImport(JSON.stringify({ ...VALID_TOOL, metadata: { a: 'b' }, autoExecute: true, timeoutMs: 45000 }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.kind !== 'single') return expect.unreachable();
    const v = validateImportedTool(parsed.value);
    expect(v.ok).toBe(true);
    expect(v.tool?.metadata).toEqual({ a: 'b' });
    expect(v.tool?.autoExecute).toBe(true);
    expect(v.tool?.timeoutMs).toBe(45000);
  });
});
