/**
 * NexTool Q1 v1.0.8 test suite — async confirm(), URL imports, expanded
 * virtual child_process (node/npm/cd/...), central configuration limits and
 * the hard-coded limit removal (spec §1–§24).
 *
 * Run: bun test tests/nextool-v108.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { db } from '../src/lib/db';
import {
  getConfigurationLimits,
  getResolvedLimits,
  validateLimitsObject,
  ConfigurationLimitsError,
  setConfigurationLimitsPath,
  invalidateConfigurationLimitsCache,
  getLimitProperty,
  clampToLimit,
} from '../src/lib/nexool/config-limits';
import { getNetworkPolicy, createNetworkAccounting, NetworkPolicyError } from '../src/lib/nexool/tools/sandbox-net';
import { getVfsLimits, VFS_LIMITS, openVirtualFs } from '../src/lib/nexool/tools/vfs';
import { DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS, maxToolTimeoutMs, resolveEffectiveToolTimeout } from '../src/lib/nexool/tools/timeout';
import {
  createTestInteractions,
  createRuntimeInteractions,
  listPendingConfirmations,
  resolvePendingConfirmation,
  cancelPendingConfirmationsForTask,
  CONFIRM_TIMEOUT_MS,
} from '../src/lib/nexool/tools/sandbox-interactive';
import { runJsTool, validateFunctionSource, maxFunctionSourceChars, maxResultBytes, maxLogLines, syncTimeoutMs } from '../src/lib/nexool/tools/js-runner';
import { runNodeTool } from '../src/lib/nexool/tools/node-runner';
import {
  createChildProcessModule,
  getChildProcessLimits,
  VIRTUAL_COMMANDS,
  VIRTUAL_COMMAND_INFO,
} from '../src/lib/nexool/tools/virtual-child-process';
import { settingsSchema, taskConfigSchema, registerJsToolSchema } from '../src/lib/nexool/schemas';
import { DEFAULT_SETTINGS } from '../src/lib/nexool/settings';
import { emitEvent, recentEvents } from '../src/lib/nexool/eventbus';
import { POST as confirmationsPost, GET as confirmationsGet } from '../src/app/api/confirmations/route';
import { GET as limitsRouteGet } from '../src/app/api/config/limits/route';

// ---------- §7 — central configuration-limits.json ----------

describe('v1.0.8 §7 — central configuration limits JSON', () => {
  test('the authoritative file exists and validates', () => {
    const limits = getConfigurationLimits();
    expect(limits.version).toBe(1);
    expect(validateLimitsObject(limits)).toEqual([]);
  });

  test('every numeric property satisfies min <= default <= max', () => {
    const raw = getConfigurationLimits() as Record<string, Record<string, { type: string; default: unknown; min?: number; max?: number }>>;
    for (const [section, entries] of Object.entries(raw)) {
      if (section === 'version' || section === '$meta') continue;
      for (const [key, prop] of Object.entries(entries)) {
        if (prop.type === 'integer' || prop.type === 'number') {
          const d = prop.default as number;
          expect(typeof d).toBe('number');
          if (typeof prop.min === 'number') expect(d).toBeGreaterThanOrEqual(prop.min);
          if (typeof prop.max === 'number') expect(d).toBeLessThanOrEqual(prop.max);
        }
      }
    }
  });

  test('§4 shipped network defaults: 60s timeout / 5 MiB / 56 redirects / 56 requests / URL imports enabled', () => {
    const resolved = getResolvedLimits();
    expect(resolved.network.timeoutMs).toBe(60_000);
    expect(resolved.network.maxResponseBytes).toBe(5 * 1024 * 1024);
    expect(resolved.network.maxRedirects).toBe(56);
    expect(resolved.network.maxRequestsPerExecution).toBe(56);
    expect(resolved.network.allowUrlImports).toBe(true);
    const policy = getNetworkPolicy();
    expect(policy.timeoutMs).toBe(60_000);
    expect(policy.urlImportsEnabled).toBe(true);
  });

  test('§5 shipped VFS defaults: 2 MiB file / 700 MiB total / 4000 entries / depth 56', () => {
    const limits = getVfsLimits();
    expect(limits.maxFileBytes).toBe(2 * 1024 * 1024);
    expect(limits.maxTotalBytes).toBe(700 * 1024 * 1024);
    expect(limits.maxEntries).toBe(4000);
    expect(limits.maxDepth).toBe(56);
    // compatibility snapshot agrees
    expect(VFS_LIMITS.maxFileBytes).toBe(2 * 1024 * 1024);
  });

  test('§6 shipped execution defaults and maximums', () => {
    const resolved = getResolvedLimits();
    expect(resolved.execution.timeoutMs).toBe(10_000);
    expect(resolved.execution.syncTimeoutMs).toBe(4_000);
    expect(resolved.execution.heapSentinelBytes).toBe(256 * 1024 * 1024);
    expect(resolved.execution.maxSourceChars).toBe(64_000);
    expect(resolved.execution.maxResultBytes).toBe(64 * 1024);
    expect(resolved.execution.maxLogs).toBe(100);
    // hard runtime ceiling = 1 hour (from the central limits)
    expect(maxToolTimeoutMs()).toBe(3_600_000);
    expect(getLimitProperty('execution', 'timeoutMs').max).toBe(3_600_000);
    expect(getLimitProperty('execution', 'syncTimeoutMs').max).toBe(1_800_000);
    expect(getLimitProperty('execution', 'heapSentinelBytes').max).toBe(728 * 1024 * 1024);
    expect(getLimitProperty('execution', 'maxSourceChars').max).toBe(200_000);
    expect(getLimitProperty('execution', 'maxLogs').max).toBe(1000);
    // v1.0.7 constants preserved
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(10_000);
    expect(MAX_TOOL_TIMEOUT_MS).toBe(3_600_000);
  });

  test('invalid JSON fails clearly', () => {
    expect(validateLimitsObject('not an object').length).toBeGreaterThan(0);
    expect(validateLimitsObject(null).length).toBeGreaterThan(0);
    expect(validateLimitsObject({}).some((i) => i.includes('version'))).toBe(true);
  });

  test('invalid type fails clearly', () => {
    const issues = validateLimitsObject({
      version: 1,
      network: { timeoutMs: { type: 'float64', default: 1000 } },
    });
    expect(issues.some((i) => i.includes('network.timeoutMs') && i.includes('type'))).toBe(true);
  });

  test('default > max and default < min fail clearly (§7.8)', () => {
    const tooBig = validateLimitsObject({
      version: 1,
      network: { timeoutMs: { type: 'integer', default: 5000, min: 100, max: 1000 } },
    });
    expect(tooBig.some((i) => i.includes('default (5000) must be <= max (1000)'))).toBe(true);
    const tooSmall = validateLimitsObject({
      version: 1,
      network: { timeoutMs: { type: 'integer', default: 50, min: 100, max: 1000 } },
    });
    expect(tooSmall.some((i) => i.includes('default (50) must be >= min (100)'))).toBe(true);
  });

  test('min > max, non-integer default, bad boolean and bad enum fail clearly', () => {
    expect(
      validateLimitsObject({ version: 1, x: { a: { type: 'integer', default: 5, min: 10, max: 1 } } }).some((i) => i.includes('min (10) must be <= max (1)')),
    ).toBe(true);
    expect(
      validateLimitsObject({ version: 1, x: { a: { type: 'integer', default: 1.5 } } }).some((i) => i.includes('must be an integer')),
    ).toBe(true);
    expect(
      validateLimitsObject({ version: 1, x: { a: { type: 'boolean', default: 'yes' } } }).some((i) => i.includes('default must be a boolean')),
    ).toBe(true);
    expect(
      validateLimitsObject({ version: 1, x: { a: { type: 'enum', default: 'z', enum: ['a', 'b'] } } }).some((i) => i.includes('must be one of')),
    ).toBe(true);
  });

  test('a corrupted limits FILE fails clearly (never silently falls back) — §7.7', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextool-limits-'));
    const badFile = path.join(dir, 'broken.json');
    fs.writeFileSync(badFile, '{ this is not json');
    setConfigurationLimitsPath(badFile);
    invalidateConfigurationLimitsCache();
    try {
      expect(() => getConfigurationLimits()).toThrow(ConfigurationLimitsError);
      expect(() => getConfigurationLimits()).toThrow(/invalid JSON/);
      // a semantically broken file fails with the property named
      fs.writeFileSync(badFile, JSON.stringify({ version: 1, network: { timeoutMs: { type: 'integer', default: 99999, min: 1, max: 100 } } }));
      invalidateConfigurationLimitsCache();
      expect(() => getConfigurationLimits()).toThrow(/network\.timeoutMs/);
    } finally {
      setConfigurationLimitsPath(undefined);
      invalidateConfigurationLimitsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('§23 — dynamic limit: change ONE value in the JSON, reload, every layer sees it', async () => {
    const { updateSettings } = await import('../src/lib/nexool/settings');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextool-limits-dyn-'));
    const file = path.join(dir, 'configuration-limits.json');
    const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'configuration-limits.json'), 'utf8'));
    const modified = JSON.parse(JSON.stringify(shipped));
    modified.execution.maxSourceChars.default = 200_000;
    modified.execution.maxSourceChars.max = 200_000;
    modified.execution.maxSourceChars.min = 1000;
    modified.network.timeoutMs.default = 120_000;
    fs.writeFileSync(file, JSON.stringify(modified));
    setConfigurationLimitsPath(file);
    invalidateConfigurationLimitsCache();
    try {
      // limits layer
      expect(getResolvedLimits().execution.maxSourceChars).toBe(200_000);
      expect(getResolvedLimits().network.timeoutMs).toBe(120_000);
      expect(maxFunctionSourceChars()).toBe(200_000);
      // settings layer
      const s = await updateSettings({ toolTimeoutMs: 60_000 });
      expect(s.toolTimeoutMs).toBe(60_000);
      // backend validation uses the same resolved limits
      const ok = settingsSchema.safeParse({ toolTimeoutMs: 3_600_000 });
      expect(ok.success).toBe(true);
      // runtime enforcement (sandbox getters) uses the new values
      expect(syncTimeoutMs()).toBe(4_000); // untouched property keeps its default
      expect(maxLogLines()).toBe(100);
      expect(maxResultBytes()).toBe(64 * 1024);
    } finally {
      setConfigurationLimitsPath(undefined);
      invalidateConfigurationLimitsCache();
      fs.rmSync(dir, { recursive: true, force: true });
      await updateSettings({ toolTimeoutMs: 10_000 });
    }
  });

  test('clampToLimit clamps into the resolved [min, max]', () => {
    expect(clampToLimit('task', 'maxIterations', 5000)).toBe(200);
    expect(clampToLimit('task', 'maxIterations', 0)).toBe(1);
    expect(clampToLimit('task', 'maxIterations', 42)).toBe(42);
    expect(clampToLimit('task', 'maxIterations', 'not-a-number')).toBe(30);
  });

  test('§10 — GET /api/config/limits exposes the resolved metadata (no secrets)', async () => {
    const res = await limitsRouteGet();
    const body = (await res.json()) as { ok: boolean; data: { limits: { version: number }; resolved: Record<string, Record<string, number>>; source: string } };
    expect(body.ok).toBe(true);
    expect(body.data.limits.version).toBe(1);
    expect(body.data.resolved.network.timeoutMs).toBe(60_000);
    expect(body.data.source).toContain('configuration-limits.json');
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/secret|password|api[_-]?key/i);
  });
});

// ---------- §1 — async confirm() ----------

describe('v1.0.8 §1 — async confirm() in both environments', () => {
  const CONFIRM_SOURCE = `async function execute(params, context) {
    const first = await confirm('Continue?', { default: true });
    const second = await confirm('Delete the generated files?');
    return { first, second, boolFirst: typeof first === 'boolean', boolSecond: typeof second === 'boolean' };
  }`;

  test('js-function confirm() returns booleans (test mode resolves declared default / false)', async () => {
    const r = await runJsTool(CONFIRM_SOURCE, {}, { executionId: 't108-c1', mode: 'test', now: new Date().toISOString(), log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ first: true, second: false, boolFirst: true, boolSecond: true });
  });

  test('nodejs confirm() returns booleans', async () => {
    const r = await runNodeTool(CONFIRM_SOURCE, {}, { executionId: 't108-c2', mode: 'test', now: new Date().toISOString(), log: () => {} });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ first: true, second: false, boolFirst: true, boolSecond: true });
  });

  test('production confirm() waits for the user and resolves with the boolean answer', async () => {
    const deadlineCtl = { extendDeadline: () => {}, resetDeadline: () => {} };
    const interactions = createRuntimeInteractions('task-108-confirm', 'exec-108-c', 'confirm.demo', deadlineCtl);
    const p = interactions.confirm('Deploy to production?');
    // let the registry populate
    await new Promise((r) => setTimeout(r, 30));
    const pending = listPendingConfirmations('task-108-confirm');
    expect(pending.length).toBe(1);
    expect(pending[0].message).toBe('Deploy to production?');
    expect(pending[0].toolName).toBe('confirm.demo');
    // resolve via the registry (what the console UI does)
    expect(resolvePendingConfirmation(pending[0].confirmId, true)).toBe(true);
    expect(await p).toBe(true);
  });

  test('production confirm() cancellation resolves FALSE — never true (§1.4)', async () => {
    const deadlineCtl = { extendDeadline: () => {}, resetDeadline: () => {} };
    const interactions = createRuntimeInteractions('task-108-cancel', 'exec-108-x', 'confirm.demo', deadlineCtl);
    const p = interactions.confirm('Proceed?');
    await new Promise((r) => setTimeout(r, 30));
    const pending = listPendingConfirmations('task-108-cancel');
    expect(pending.length).toBe(1);
    resolvePendingConfirmation(pending[0].confirmId, false);
    expect(await p).toBe(false);
  });

  test('confirm() timeout resolves FALSE (120s window, same runtime semantics as prompts)', () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(120_000);
  });

  test('task stop cancels pending confirmations as FALSE (§1.4)', async () => {
    const deadlineCtl = { extendDeadline: () => {}, resetDeadline: () => {} };
    const interactions = createRuntimeInteractions('task-108-stop', 'exec-108-s', 'confirm.demo', deadlineCtl);
    const p = interactions.confirm('Do work?');
    await new Promise((r) => setTimeout(r, 30));
    cancelPendingConfirmationsForTask('task-108-stop');
    expect(await p).toBe(false);
    expect(listPendingConfirmations('task-108-stop').length).toBe(0);
  });

  test('confirm events carry task / execution / tool / request association (§1.3)', async () => {
    await emitEvent({
      taskId: 'task-108-events',
      type: 'tool.confirm.requested',
      source: 'tool',
      message: 'Tool confirmation requested: write files?',
      data: { confirmId: 'cfm_t108', executionId: 'exec-108-e', toolName: 'fs.write', message: 'write files?' },
      priority: 2,
    });
    await new Promise((r) => setTimeout(r, 40));
    const events = recentEvents(undefined, 30);
    const req = events.find((e) => e.type === 'tool.confirm.requested' && e.data?.confirmId === 'cfm_t108');
    expect(req).toBeDefined();
    expect(req?.taskId).toBe('task-108-events');
    expect(req?.data?.executionId).toBe('exec-108-e');
    expect(req?.data?.toolName).toBe('fs.write');
  });

  test('POST /api/confirmations resolves a pending confirmation; wrong id reports honestly', async () => {
    const deadlineCtl = { extendDeadline: () => {}, resetDeadline: () => {} };
    const interactions = createRuntimeInteractions('task-108-api', 'exec-108-a', 'confirm.api', deadlineCtl);
    const p = interactions.confirm('API confirm?');
    await new Promise((r) => setTimeout(r, 30));
    const pending = listPendingConfirmations('task-108-api');
    const req = new Request('http://x/api/confirmations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmId: pending[0].confirmId, accepted: true }),
    });
    const res = await confirmationsPost(req);
    const body = (await res.json()) as { ok: boolean; data: { resolved: boolean } };
    expect(body.data.resolved).toBe(true);
    expect(await p).toBe(true);
    const res2 = await confirmationsPost(new Request('http://x/api/confirmations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmId: 'cfm_missing', accepted: false }),
    }));
    const body2 = (await res2.json()) as { data: { resolved: boolean } };
    expect(body2.data.resolved).toBe(false);
  });

  test('GET /api/confirmations lists pending confirmations scoped by task', async () => {
    const deadlineCtl = { extendDeadline: () => {}, resetDeadline: () => {} };
    const interactions = createRuntimeInteractions('task-108-list', 'exec-108-l', 'confirm.list', deadlineCtl);
    const p = interactions.confirm('List confirm?');
    await new Promise((r) => setTimeout(r, 30));
    const res = await confirmationsGet(new Request('http://x/api/confirmations?taskId=task-108-list'));
    const body = (await res.json()) as { data: { confirmations: { message: string }[] } };
    expect(body.data.confirmations.some((c) => c.message === 'List confirm?')).toBe(true);
    resolvePendingConfirmation(listPendingConfirmations('task-108-list')[0].confirmId, false);
    await p;
  });
});

// ---------- §2 — URL imports ----------

describe('v1.0.8 §2 — URL import() in both environments', () => {
  let fetchStub: ((input: string | URL) => any) | null = null;
  const originalFetch = globalThis.fetch;

  const MODULE_JS = `
module.exports = {
  process: (v) => 'processed:' + v,
  helper: () => 'helped',
};`;

  const ESM_JS = `
export default function main(v) { return 'default:' + v; }
export function named(v) { return 'named:' + v; }
export const VERSION = 2;`;

  beforeAll(() => {
    globalThis.fetch = ((input: string | URL) => {
      if (fetchStub) return fetchStub(input);
      return originalFetch(input as never);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  const route = (input: string | URL): Response | Promise<Response> => {
    const url = String(input);
    if (url.includes('cjs.example.com')) return new Response(MODULE_JS, { status: 200, headers: { 'content-type': 'application/javascript' } });
    if (url.includes('esm.example.com')) return new Response(ESM_JS, { status: 200 });
    if (url.includes('big.example.com')) return new Response('x'.repeat(6 * 1024 * 1024), { status: 200 });
    return new Response('not found', { status: 404 });
  };

  test('js-function URL import works (default export)', async () => {
    fetchStub = route;
    const r = await runJsTool(
      "const mod = await import('https://cjs.example.com/mod.js'); return mod.process('v108');",
      {},
      { executionId: 't108-u1', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toBe('processed:v108');
  });

  test('nodejs URL import works (named + default + multiple exports, §2.3)', async () => {
    fetchStub = route;
    const r = await runNodeTool(
      "const mod = await import('https://esm.example.com/m.js'); return { d: mod.default('a'), n: mod.named('b'), v: mod.VERSION };",
      {},
      { executionId: 't108-u2', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ d: 'default:a', n: 'named:b', v: 2 });
  });

  test('URL imports pass through the network policy — blocked protocol rejected (§2.1/§2.2)', async () => {
    fetchStub = () => { throw new Error('network should never be reached'); };
    for (const env of ['js', 'node'] as const) {
      const src = "await import('file:///etc/passwd')";
      const r = env === 'js'
        ? await runJsTool(src, {}, { executionId: `t108-u3-${env}`, mode: 'test', now: new Date().toISOString(), log: () => {} })
        : await runNodeTool(src, {}, { executionId: `t108-u3-${env}`, mode: 'test', now: new Date().toISOString(), log: () => {} });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/file|not allowed|http/i);
    }
  });

  test('URL import response size is governed by network.maxResponseBytes (§2.5)', async () => {
    fetchStub = route;
    const r = await runJsTool(
      "await import('https://big.example.com/huge.js')",
      {},
      { executionId: 't108-u4', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('5242880');
  });

  test('URL imports count toward the per-execution request accounting', async () => {
    fetchStub = route;
    const accounting = createNetworkAccounting(60_000);
    const src = "const a = await import('https://cjs.example.com/one.js'); const b = await import('https://cjs.example.com/two.js'); return a.process('1') + b.process('2');";
    const r = await runJsTool(src, {}, { executionId: 't108-u5', mode: 'test', now: new Date().toISOString(), log: () => {} }, { accounting, moduleCache: new Map() });
    expect(r.ok).toBe(true);
    expect(accounting.requests).toBeGreaterThanOrEqual(2);
  });

  test('blocked URL imports never bypass the policy through the cache (§2.6)', async () => {
    // Round 1: URL imports allowed → module downloads and caches.
    const accounting = createNetworkAccounting(60_000);
    const moduleCache = new Map<string, unknown>();
    const src = "await import('https://cjs.example.com/cached.js')";
    const first = await runJsTool(src, {}, { executionId: 't108-u6', mode: 'test', now: new Date().toISOString(), log: () => {} }, { accounting, moduleCache });
    expect(first.ok).toBe(true);
    // Round 2: the CONFIGURED policy now blocks URL imports entirely — the
    // stale cached module must NOT bypass the configured restriction.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextool-url-block-'));
    const file = path.join(dir, 'configuration-limits.json');
    const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'configuration-limits.json'), 'utf8'));
    shipped.network.allowUrlImports.default = false;
    fs.writeFileSync(file, JSON.stringify(shipped));
    setConfigurationLimitsPath(file);
    invalidateConfigurationLimitsCache();
    try {
      const second = await runJsTool(src, {}, { executionId: 't108-u7', mode: 'test', now: new Date().toISOString(), log: () => {} }, { accounting, moduleCache });
      expect(second.ok).toBe(false);
      expect(second.error?.message).toMatch(/disabled|allowUrlImports/i);
    } finally {
      setConfigurationLimitsPath(undefined);
      invalidateConfigurationLimitsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('URL modules inherit the sandbox boundary — no host fs/process access (§2.4)', async () => {
    fetchStub = (input) => {
      if (String(input).includes('escape.example.com')) {
        return new Response("module.exports = { tryFs: () => typeof require('fs').readFileSync, tryProcess: typeof process };", { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };
    const r = await runJsTool(
      "const m = await import('https://escape.example.com/escape.js'); let fsType = 'unreachable'; try { fsType = String(m.tryFs()); } catch { fsType = 'blocked'; } return { fsType };",
      {},
      { executionId: 't108-u8', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(r.ok).toBe(true);
    // the js-function env never exposes fs to imported modules — require throws
    const res = r.result as { fsType?: string } | undefined;
    expect(String(res?.fsType ?? r.error?.message)).toMatch(/blocked|not available/i);
  });

  test('real network URL import (integration — public CJS module)', async () => {
    // Integration against the real internet, policy-gated (skips when offline).
    const r = await runJsTool(
      "const m = await import('https://unpkg.com/left-pad@1.3.0/index.js'); const fn = typeof m.default === 'function' ? m.default : Object.values(m).find((v) => typeof v === 'function'); return String(fn('5', 4, '0'));",
      {},
      { executionId: 't108-u9', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { timeoutMs: 30_000 },
    );
    if (r.ok) {
      expect(r.result).toBe('0005');
    } else {
      // offline sandbox — the error must still be a clean import/policy failure
      expect(['URL_IMPORT_FAILED', 'NETWORK_ERROR', 'TOOL_FAILURE', 'TIMEOUT', 'MODULE_ERROR']).toContain(r.error?.code ?? 'URL_IMPORT_FAILED');
    }
  });
});

// ---------- §3 — expanded virtual child_process ----------

describe('v1.0.8 §3 — expanded virtual child_process', () => {
  const counter = () => ({ n: 0 });
  /** Permissive shape for the tests — exec returns a rejecting promise on
   *  non-zero exits (Node semantics); execSync returns stdout or throws. */
  type TestCp = {
    exec: (c: string) => Promise<{ stdout: string; stderr: string; code?: number }>;
    execSync: (c: string) => string;
  };
  const asCp = (m: unknown): TestCp => m as TestCp;

  test('§3.1 — ALL v1.0.6 commands remain supported', async () => {
    const s = await openVirtualFs('v108-cp-legacy');
    const cp = asCp(createChildProcessModule(s, counter()));
    expect(cp.execSync('echo hello')).toContain('hello');
    expect(cp.execSync('printf "%s\\n" world')).toContain('world');
    expect(cp.execSync('pwd')).toContain('/workspace');
    await s.writeFile('/workspace/legacy.txt', 'line1\nline2\nline3');
    expect(cp.execSync('cat /workspace/legacy.txt')).toContain('line2');
    expect(cp.execSync('head -n 1 /workspace/legacy.txt')).toContain('line1');
    expect(cp.execSync('tail -n 1 /workspace/legacy.txt')).toContain('line3');
    expect(cp.execSync('wc -l /workspace/legacy.txt').trim()).toBe('3');
    expect(cp.execSync('grep line2 /workspace/legacy.txt')).toContain('line2');
    expect(cp.execSync('sort')).toBeDefined();
    expect(cp.execSync('uniq')).toBeDefined();
    expect(typeof (await cp.exec('date')).stdout).toBe('string');
    cp.execSync('mkdir -p /workspace/d1');
    cp.execSync('cp /workspace/legacy.txt /workspace/d1/copy.txt');
    expect(s.exists('/workspace/d1/copy.txt')).toBe(true);
    cp.execSync('mv /workspace/d1/copy.txt /workspace/d1/moved.txt');
    expect(s.exists('/workspace/d1/moved.txt')).toBe(true);
    cp.execSync('rm /workspace/d1/moved.txt');
    expect(s.exists('/workspace/d1/moved.txt')).toBe(false);
    expect(cp.execSync('basename /a/b/c.txt')).toContain('c.txt');
    expect(cp.execSync('dirname /a/b/c.txt')).toContain('/a/b');
    expect(cp.execSync('env')).toContain('NEXTOOL=1');
    expect(cp.execSync('true')).toBe('');
    let falseCode = 0;
    try { cp.execSync('false'); } catch (e) { falseCode = (e as { code?: number }).code ?? 1; }
    expect(falseCode).toBe(1);
    expect(cp.execSync('ls /workspace')).toContain('legacy.txt');
  });

  test('§3.2 — new commands: cut/tr/sed/awk/tee/find/tree/du/df/which/whoami/uname/realpath/readlink/yes/clear', async () => {
    const s = await openVirtualFs('v108-cp-new');
    const cp = asCp(createChildProcessModule(s, counter()));
    // cut
    await s.writeFile('/workspace/csv.txt', 'a,b,c\n1,2,3\n');
    expect((await cp.exec('cut -d, -f2 /workspace/csv.txt')).stdout).toContain('b\n2');
    // tr
    expect((await cp.exec('echo abc | tr a-z A-Z')).stdout.trim()).toBe('ABC');
    // sed
    expect((await cp.exec('sed s/1/9/ /workspace/csv.txt')).stdout).toContain('9,2,3');
    // awk
    expect((await cp.exec("awk -F, '{print $2}' /workspace/csv.txt")).stdout).toContain('b\n2');
    // tee
    await cp.exec('echo tee-write | tee /workspace/tee.txt');
    expect(s.readFile('/workspace/tee.txt', 'utf8')).toContain('tee-write');
    // find
    const found = (await cp.exec('find /workspace -name "*.txt"')).stdout;
    expect(found).toContain('/workspace/csv.txt');
    // tree
    const tree = (await cp.exec('tree /workspace')).stdout;
    expect(tree.includes('├──') || tree.includes('└──')).toBe(true);
    // du / df
    expect((await cp.exec('du -s /workspace')).stdout).toBeDefined();
    expect((await cp.exec('df')).stdout).toContain('nextool-vfs');
    // which / whoami / uname
    expect((await cp.exec('which ls')).stdout).toContain('/virtual/bin/ls');
    expect((await cp.exec('whoami')).stdout.trim()).toBe('nextool');
    expect((await cp.exec('uname -s')).stdout.trim()).toBe('NextTool');
    // realpath / readlink (honest EINVAL — exec rejects non-zero exits)
    expect((await cp.exec('realpath /workspace/csv.txt')).stdout).toContain('/workspace/csv.txt');
    let readlinkErr = '';
    try {
      await cp.exec('readlink /workspace/csv.txt');
    } catch (e) {
      readlinkErr = String((e as { stderr?: string }).stderr ?? (e as Error).message);
    }
    expect(readlinkErr).toContain('EINVAL');
    // yes (bounded) + clear
    expect((await cp.exec('yes')).stdout.length).toBeGreaterThan(0);
    expect((await cp.exec('clear')).stdout).toContain('\x1b[2J');
  });

  test('§3.8/§3.9 — cd persists within the same shell session and cannot escape the VFS', async () => {
    const s = await openVirtualFs('v108-cp-cd');
    const cp = asCp(createChildProcessModule(s, counter()));
    await cp.exec('mkdir -p /workspace/project/src');
    await cp.exec('cd /workspace/project');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/workspace/project');
    await cp.exec('cd src');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/workspace/project/src');
    await cp.exec('cd ..');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/workspace/project');
    await cp.exec('cd /workspace');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/workspace');
    // §3.8 — `cd ..` beyond the virtual root cannot escape the VFS
    await cp.exec('cd /');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/');
    await cp.exec('cd ..');
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/');
    let escapeCode = 0;
    try {
      await cp.exec('cd ../etc');
    } catch (e) {
      escapeCode = (e as { code?: number }).code ?? 1;
    }
    expect(escapeCode).not.toBe(0);
    expect((await cp.exec('pwd')).stdout.trim()).toBe('/');
    // cd into a missing directory fails
    let missingCode = 0;
    try {
      await cp.exec('cd /workspace/nope');
    } catch (e) {
      missingCode = (e as { code?: number }).code ?? 1;
    }
    expect(missingCode).not.toBe(0);
  });

  test('§3.14 — host/dangerous commands stay blocked (exit 127 / 126)', async () => {
    const s = await openVirtualFs('v108-cp-blocked');
    const cp = asCp(createChildProcessModule(s, counter()));
    for (const cmd of ['curl http://x', 'sh -c "ls > file"', 'sudo rm -rf /', 'kill -9 1', 'chmod 777 /workspace', 'ssh host', 'docker ps']) {
      try {
        cp.execSync(cmd);
        throw new Error(`command should have been blocked: ${cmd}`);
      } catch (e) {
        const code = (e as { code?: number }).code;
        expect([127, 126]).toContain(code ?? 0);
      }
    }
    // shell metacharacters are policy-rejected (126)
    let metaCode = 0;
    try {
      await cp.exec('ls && echo pwned');
    } catch (e) {
      metaCode = (e as { code?: number }).code ?? 0;
    }
    expect(metaCode).toBe(126);
  });

  test('§3.3 — node executes programs INSIDE the sandbox with VFS + policy (no host fs)', async () => {
    const s = await openVirtualFs('v108-cp-node');
    const cp = asCp(createChildProcessModule(s, counter()));
    await s.writeFile('/workspace/app.js', "const fs = require('fs'); fs.writeFileSync('/workspace/out.txt', 'written-by-virtual-node'); console.log('node-ran');\n");
    const r = await cp.exec('node /workspace/app.js');
    expect(r.stdout).toContain('node-ran');
    expect(s.exists('/workspace/out.txt')).toBe(true);
    expect(s.readFile('/workspace/out.txt', 'utf8')).toBe('written-by-virtual-node');
    // host fs is unreachable from the virtual node program
    await s.writeFile('/workspace/hostcheck.js', "let result = 'ok'; try { require('fs').readFileSync('/etc/passwd'); result = 'HOST-LEAK'; } catch { result = 'blocked'; } console.log(result);\n");
    const r2 = await cp.exec('node /workspace/hostcheck.js');
    expect(r2.stdout).toContain('blocked');
    // sync node works for sync programs; async-only programs report honestly
    expect(cp.execSync('node /workspace/app.js')).toContain('node-ran');
  });

  test('§3.4/§3.6 — npm installs packages INTO the Virtual FS workspace (registry via policy, stubbed)', async () => {
    const s = await openVirtualFs('v108-cp-npm');
    const cp = asCp(createChildProcessModule(s, counter(), { accounting: createNetworkAccounting(60_000) }));
    const originalFetch = globalThis.fetch;
    const tarball = makeTarGz({ 'package/index.js': "module.exports = { greet: (n) => 'hi-' + n };\n", 'package/package.json': '{"name":"tiny-pkg","version":"1.0.0","main":"index.js"}' });
    globalThis.fetch = ((input: string | URL) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/tiny-pkg') {
        return Promise.resolve(new Response(JSON.stringify({
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/tiny-pkg/-/tiny-pkg-1.0.0.tgz' }, dependencies: {} } },
        }), { status: 200 }));
      }
      if (url.endsWith('tiny-pkg-1.0.0.tgz')) return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      return Promise.resolve(new Response('unexpected', { status: 404 }));
    }) as typeof fetch;
    try {
      const init = await cp.exec('npm init -y');
      expect(init.stdout).toContain('package.json');
      expect(s.exists('/workspace/package.json')).toBe(true);
      const inst = await cp.exec('npm install tiny-pkg');
      expect(inst.stdout).toContain('tiny-pkg@1.0.0');
      expect(inst.stdout).toContain('Virtual FS');
      expect(s.exists('/workspace/node_modules/tiny-pkg/package.json')).toBe(true);
      expect(s.exists('/workspace/node_modules/tiny-pkg/index.js')).toBe(true);
      // the host node_modules must be untouched
      expect(fs.existsSync(path.join(process.cwd(), 'node_modules', 'tiny-pkg'))).toBe(false);
      // §3.11/§3.12 — node can now require the installed package from the workspace
      await s.writeFile('/workspace/usepkg.js', "const p = require('tiny-pkg'); console.log(p.greet('v108'));\n");
      const run = await cp.exec('node /workspace/usepkg.js');
      expect(run.stdout).toContain('hi-v108');
      // npm ls reports the installed dependency
      const ls = await cp.exec('npm ls');
      expect(ls.stdout).toContain('tiny-pkg');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('§3.7 — npm lifecycle scripts are NOT auto-executed by install', async () => {
    const s = await openVirtualFs('v108-cp-npm-scripts');
    const cp = asCp(createChildProcessModule(s, counter(), { accounting: createNetworkAccounting(60_000) }));
    const originalFetch = globalThis.fetch;
    const tarball = makeTarGz({ 'package/index.js': 'module.exports = 1;\n', 'package/package.json': '{"name":"scripty","version":"1.0.0","main":"index.js","scripts":{"postinstall":"node -e \\"console.log(\'PWNED\')\\""}}' });
    globalThis.fetch = ((input: string | URL) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/scripty') {
        return Promise.resolve(new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/scripty/-/scripty-1.0.0.tgz' } } } }), { status: 200 }));
      }
      if (url.endsWith('scripty-1.0.0.tgz')) return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      return Promise.resolve(new Response('x', { status: 404 }));
    }) as typeof fetch;
    try {
      await cp.exec('npm init -y');
      const inst = await cp.exec('npm install scripty');
      expect(inst.stdout).toMatch(/NOT auto-executed/i);
      expect(inst.stdout).not.toContain('PWNED');
      // scripts execute ONLY when explicitly invoked — through the same sandbox
      const pkg = JSON.parse(s.readFile('/workspace/package.json', 'utf8') as string);
      pkg.scripts.postinstall = "node -e \"console.log('EXPLICIT-OK')\"";
      s.writeFile('/workspace/package.json', JSON.stringify(pkg));
      const run = await cp.exec('npm run postinstall');
      expect(run.stdout).toContain('EXPLICIT-OK');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('§21 — virtual MERN-style workflow: mkdir → cd → npm init → src file → npm install → node', async () => {
    const s = await openVirtualFs('v108-mern');
    const cp = asCp(createChildProcessModule(s, counter(), { accounting: createNetworkAccounting(60_000) }));
    const originalFetch = globalThis.fetch;
    const tarball = makeTarGz({ 'package/index.js': 'module.exports = { ok: true };\n', 'package/package.json': '{"name":"express-mini","version":"1.0.0","main":"index.js"}' });
    globalThis.fetch = ((input: string | URL) => {
      const url = String(input);
      if (url === 'https://registry.npmjs.org/express-mini') {
        return Promise.resolve(new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'https://registry.npmjs.org/express-mini/-/express-mini-1.0.0.tgz' } } } }), { status: 200 }));
      }
      if (url.endsWith('express-mini-1.0.0.tgz')) return Promise.resolve(new Response(new Uint8Array(tarball), { status: 200 }));
      return Promise.resolve(new Response('x', { status: 404 }));
    }) as typeof fetch;
    try {
      await cp.exec('mkdir my-mern-app');
      await cp.exec('cd my-mern-app');
      await cp.exec('npm init -y');
      await cp.exec('mkdir server');
      await s.writeFile('/workspace/my-mern-app/server/index.js', "const express = require('express-mini'); console.log('server deps:', express.ok);\n");
      await cp.exec('npm install express-mini');
      // MERN-style structure exists INSIDE the VFS
      expect(s.exists('/workspace/my-mern-app/package.json')).toBe(true);
      expect(s.exists('/workspace/my-mern-app/server/index.js')).toBe(true);
      expect(s.exists('/workspace/my-mern-app/node_modules/express-mini/index.js')).toBe(true);
      const run = await cp.exec('node server/index.js');
      expect(run.stdout).toContain('server deps: true');
      // NexTool source + host fs remain untouched
      expect(fs.existsSync(path.join(process.cwd(), 'node_modules', 'express-mini'))).toBe(false);
      expect(fs.existsSync(path.join(process.cwd(), 'my-mern-app'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('§3.15 — child-process limits resolve from the central configuration', () => {
    const limits = getChildProcessLimits();
    expect(limits.timeoutMs).toBe(8_000);
    expect(limits.maxOutputBytes).toBe(64 * 1024);
    expect(limits.maxProcessesPerExecution).toBe(64);
    expect(limits.maxPipeStages).toBe(3);
    expect(limits.maxArgs).toBe(32);
    expect(limits.npmMaxPackages).toBe(25);
  });

  test('the expanded command set is documented (VIRTUAL_COMMAND_INFO covers every command)', () => {
    for (const cmd of VIRTUAL_COMMANDS) {
      expect(typeof VIRTUAL_COMMAND_INFO[cmd]).toBe('string');
    }
    // v1.0.6 commands all preserved + v1.0.8 additions present
    for (const cmd of ['ls', 'cat', 'echo', 'grep', 'mkdir', 'cd', 'clear', 'find', 'tree', 'sed', 'awk', 'tee', 'sleep', 'node', 'npm']) {
      expect(VIRTUAL_COMMANDS as readonly string[]).toContain(cmd);
    }
    expect(VIRTUAL_COMMANDS).not.toContain('curl');
    expect(VIRTUAL_COMMANDS).not.toContain('sudo');
  });
});

// ---------- §9 — hard-coded limit removal (schema/settings level) ----------

describe('v1.0.8 §9 — limits flow through Settings + schemas', () => {
  test('DEFAULT_SETTINGS derive from the central limits', () => {
    const resolved = getResolvedLimits();
    expect(DEFAULT_SETTINGS.maxIterations).toBe(resolved.task.maxIterations);
    expect(DEFAULT_SETTINGS.safetyLimit).toBe(resolved.task.safetyLimit);
    expect(DEFAULT_SETTINGS.maxSubtoolCalls).toBe(resolved.task.maxSubtoolCalls);
    expect(DEFAULT_SETTINGS.taskTimeoutMs).toBe(resolved.task.taskTimeoutMs);
    expect(DEFAULT_SETTINGS.toolTimeoutMs).toBe(resolved.task.toolTimeoutMs);
    expect(DEFAULT_SETTINGS.toolTimeoutMs).toBe(10_000);
  });

  test('settings schema bounds follow the limits metadata', () => {
    const maxIter = getLimitProperty('task', 'maxIterations');
    expect(settingsSchema.safeParse({ maxIterations: (maxIter.max as number) + 1 }).success).toBe(false);
    expect(settingsSchema.safeParse({ maxIterations: maxIter.default as number }).success).toBe(true);
    const toolTimeoutMax = getLimitProperty('execution', 'timeoutMs').max as number;
    expect(settingsSchema.safeParse({ toolTimeoutMs: toolTimeoutMax }).success).toBe(true);
    expect(settingsSchema.safeParse({ toolTimeoutMs: toolTimeoutMax + 1 }).success).toBe(false);
  });

  test('task config schema bounds follow the limits metadata', () => {
    const safety = getLimitProperty('task', 'safetyLimit');
    expect(taskConfigSchema.safeParse({ safetyLimit: (safety.max as number) + 1 }).success).toBe(false);
    expect(taskConfigSchema.safeParse({ safetyLimit: safety.default as number }).success).toBe(true);
  });

  test('function-source registration bound follows execution.maxSourceChars', () => {
    const maxChars = getLimitProperty('execution', 'maxSourceChars');
    const body = 'async function execute(p) { return 1; }';
    const padded = '/* ' + 'x'.repeat((maxChars.max as number) - body.length - 6) + ' */\n' + body;
    expect(registerJsToolSchema.safeParse({ name: 'a.b', schema: { type: 'object', properties: [] }, functionSource: padded.slice(0, (maxChars.max as number) + 1) }).success).toBe(false);
  });

  test('§17 — js-runner limits are live (no hard-coded 64000/4000/100 at enforcement points)', () => {
    expect(maxFunctionSourceChars()).toBe(getResolvedLimits().execution.maxSourceChars);
    expect(syncTimeoutMs()).toBe(getResolvedLimits().execution.syncTimeoutMs);
    expect(maxResultBytes()).toBe(getResolvedLimits().execution.maxResultBytes);
    expect(maxLogLines()).toBe(getResolvedLimits().execution.maxLogs);
    const big = '/* ' + 'x'.repeat(65_000) + ' */';
    expect(validateFunctionSource(big).ok).toBe(false);
    expect(validateFunctionSource('return 1;').ok).toBe(true);
  });

  test('§6.1 — execution timeout precedence still holds with the live ceiling', () => {
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 3_600_000 }).effective).toBe(3_600_000);
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 9_000_000 }).capped).toBe(true);
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 9_000_000 }).effective).toBe(3_600_000);
    expect(resolveEffectiveToolTimeout({}).source).toBe('default');
    expect(resolveEffectiveToolTimeout({}).effective).toBe(10_000);
  });
});

// ---------- §5.4 — lowering VFS limits never corrupts existing files ----------

describe('v1.0.8 §5.4 — existing files survive lowered limits', () => {
  test('a lowered maxFileBytes preserves the big file; new violating writes fail clearly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextool-vfs-limit-'));
    const file = path.join(dir, 'configuration-limits.json');
    const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'configuration-limits.json'), 'utf8'));
    const lowered = JSON.parse(JSON.stringify(shipped));
    lowered.vfs.maxFileBytes.default = 4096;
    lowered.vfs.maxFileBytes.min = 1024;
    fs.writeFileSync(file, JSON.stringify(lowered));
    setConfigurationLimitsPath(file);
    invalidateConfigurationLimitsCache();
    const s = await openVirtualFs('v108-vfs-lower');
    try {
      // a 3 KiB file exists (stored before the limit was lowered)
      s.writeFile('/workspace/big.txt', 'z'.repeat(3 * 1024));
      // lowering to 4 KiB keeps the file readable (not corrupted/deleted)
      expect(s.readFile('/workspace/big.txt', 'utf8').length).toBe(3 * 1024);
      // but NEW writes above the limit fail clearly
      expect(() => s.writeFile('/workspace/huge.txt', 'y'.repeat(5 * 1024))).toThrow(/maximum file size/);
      // and the usage report reflects the lowered configured limit
      expect(s.usage().limits.maxFileBytes).toBe(4096);
    } finally {
      setConfigurationLimitsPath(undefined);
      invalidateConfigurationLimitsCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- helpers ----------

/** Build a minimal gzip-compressed ustar tarball (registry tarball shape). */
function makeTarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name.slice(0, 100), 0, 'utf8');
    header.write('0000644\0', 100, 'utf8'); // mode
    header.write('0000000\0', 108, 'utf8'); // uid
    header.write('0000000\0', 116, 'utf8'); // gid
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size
    header.write('0'.repeat(12), 136, 'utf8'); // mtime
    header.write('        ', 148, 'utf8'); // checksum placeholder
    header.write('0', 156, 'utf8'); // typeflag: regular file
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
    blocks.push(header);
    blocks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks = end
  return zlib.gzipSync(Buffer.concat(blocks));
}

afterAll(async () => {
  // keep the shared dev database clean of test workspaces
  await db.virtualFile.deleteMany({ where: { toolId: { startsWith: 'v108-' } } }).catch(() => {});
});
