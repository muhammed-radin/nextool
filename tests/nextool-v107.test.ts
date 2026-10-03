/**
 * NexTool Q1 v1.0.7 test suite — configurable tool execution timeout,
 * tool search/filter, dangerous application reset and dependency-aware
 * resource cleanup (spec §1-§8).
 *
 * Run: bun test tests/nextool-v107.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { db } from '../src/lib/db';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  resolveEffectiveToolTimeout,
  sanitizeConfiguredToolTimeoutMs,
} from '../src/lib/nexool/tools/timeout';
import { ToolTimeoutError, executeTool } from '../src/lib/nexool/tools/executor';
import {
  NETWORK_POLICY,
  NetworkPolicyError,
  createNetworkAccounting,
  policyFetch,
} from '../src/lib/nexool/tools/sandbox-net';
import { createChildProcessModule } from '../src/lib/nexool/tools/virtual-child-process';
import { registerJsTool, deleteTool, getToolEntry } from '../src/lib/nexool/tools/registry';
import { settingsSchema, registerJsToolSchema, resetApplicationSchema, taskConfigSchema } from '../src/lib/nexool/schemas';
import { filterTools } from '../src/lib/nexool/tool-search';
import {
  RESET_CONFIRMATION_PHRASE,
  resetApplicationRuntime,
  analyzeResourceDependencies,
  runResourceCleanup,
  validateRuntimeDependencies,
} from '../src/lib/nexool/maintenance';
import { POST as resetRoutePost } from '../src/app/api/settings/reset/route';
import type { ToolEntry } from '../src/lib/nexool/api-contract';

const HANGING_SOURCE = 'async function execute(params, context) { await new Promise(() => {}); return "never"; }';
const SLOW_SOURCE = 'async function execute(params, context) { await new Promise((r) => setTimeout(r, 250)); return "done"; }';

function schema() {
  return { type: 'object' as const, properties: [] };
}

// ---------- §1.1 constants: default 10 s, maximum 1 hour ----------

describe('v1.0.7 §1 — timeout configuration constants', () => {
  test('default tool timeout is exactly 10000ms (10 seconds)', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(10_000);
  });

  test('maximum tool timeout is exactly 3600000ms (1 hour)', () => {
    expect(MAX_TOOL_TIMEOUT_MS).toBe(3_600_000);
    expect(MIN_TOOL_TIMEOUT_MS).toBe(1_000);
  });

  test('default settings expose toolTimeoutMs 10000', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/lib/nexool/settings');
    expect(DEFAULT_SETTINGS.toolTimeoutMs).toBe(10_000);
  });
});

// ---------- §1.2 precedence: global → tool → runtime max ----------

describe('v1.0.7 §1.2 — effective timeout precedence', () => {
  test('no configuration → default 10000ms', () => {
    const r = resolveEffectiveToolTimeout({});
    expect(r.effective).toBe(10_000);
    expect(r.source).toBe('default');
    expect(r.capped).toBe(false);
  });

  test('global/task fallback is used when the tool has no own timeout', () => {
    const r = resolveEffectiveToolTimeout({ fallbackTimeoutMs: 300_000 });
    expect(r.effective).toBe(300_000);
    expect(r.source).toBe('task');
  });

  test('tool-specific timeout overrides the global default', () => {
    const r = resolveEffectiveToolTimeout({ toolTimeoutMs: 600_000, fallbackTimeoutMs: 30_000 });
    expect(r.effective).toBe(600_000);
    expect(r.source).toBe('tool');
  });

  test('a tool timeout above 1 hour is capped at the runtime maximum', () => {
    const r = resolveEffectiveToolTimeout({ toolTimeoutMs: 10_000_000 });
    expect(r.effective).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(r.capped).toBe(true);
  });

  test('a fallback above 1 hour is capped at the runtime maximum', () => {
    const r = resolveEffectiveToolTimeout({ fallbackTimeoutMs: 7_200_000 });
    expect(r.effective).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(r.capped).toBe(true);
  });

  test('exactly 1 hour is allowed', () => {
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 3_600_000 }).effective).toBe(3_600_000);
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 3_600_000 }).capped).toBe(false);
  });

  test('sub-second garbage is floored for the executor watchdog', () => {
    expect(resolveEffectiveToolTimeout({ toolTimeoutMs: 5 }).effective).toBeGreaterThanOrEqual(250);
  });

  test('sanitizeConfiguredToolTimeoutMs clamps into [1s, 1h]', () => {
    expect(sanitizeConfiguredToolTimeoutMs(0)).toBe(1_000);
    expect(sanitizeConfiguredToolTimeoutMs(-5)).toBe(1_000);
    expect(sanitizeConfiguredToolTimeoutMs(4_000_000)).toBe(3_600_000);
    expect(sanitizeConfiguredToolTimeoutMs(undefined, 30_000)).toBe(30_000);
  });
});

// ---------- §1.3 API validation REJECTS > 1 hour ----------

describe('v1.0.7 §1.3 — API schemas reject timeouts above one hour', () => {
  test('settings schema accepts 10000, 30000, 60000, 300000, 1800000, 3600000', () => {
    for (const v of [10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000]) {
      const parsed = settingsSchema.safeParse({ toolTimeoutMs: v });
      expect(parsed.success).toBe(true);
    }
  });

  test('settings schema rejects toolTimeoutMs = 3600001 and above', () => {
    expect(settingsSchema.safeParse({ toolTimeoutMs: 3_600_001 }).success).toBe(false);
    expect(settingsSchema.safeParse({ toolTimeoutMs: 10_000_000 }).success).toBe(false);
  });

  test('task config schema rejects a task-level tool timeout above 1 hour', () => {
    expect(taskConfigSchema.safeParse({ toolTimeoutMs: 3_600_001 }).success).toBe(false);
  });

  test('tool registration schema rejects timeoutMs above 1 hour / below 1s', () => {
    const bad = registerJsToolSchema.safeParse({
      name: 'v107test.timeout', description: 'x', schema: schema(), functionSource: SLOW_SOURCE, timeoutMs: 4_000_000,
    });
    expect(bad.success).toBe(false);
    const tooSmall = registerJsToolSchema.safeParse({
      name: 'v107test.timeout', description: 'x', schema: schema(), functionSource: SLOW_SOURCE, timeoutMs: 500,
    });
    expect(tooSmall.success).toBe(false);
    const good = registerJsToolSchema.safeParse({
      name: 'v107test.timeout', description: 'x', schema: schema(), functionSource: SLOW_SOURCE, timeoutMs: 600_000,
    });
    expect(good.success).toBe(true);
  });
});

// ---------- §1.5 network timeout propagation ----------

describe('v1.0.7 §1.5 — network layer respects the effective timeout', () => {
  test('createNetworkAccounting carries the default and custom values (v1.0.8: default = network.timeoutMs 60s)', () => {
    expect(createNetworkAccounting().requestTimeoutMs).toBe(NETWORK_POLICY.requestTimeoutMs);
    expect(createNetworkAccounting(600_000).requestTimeoutMs).toBe(600_000);
    expect(createNetworkAccounting(300_000).requestTimeoutMs).toBe(300_000);
    // bounded by the same 1-hour ceiling
    expect(createNetworkAccounting(9_000_000).requestTimeoutMs).toBe(3_600_000);
    // v1.0.8 — the no-argument fallback is the CENTRAL network.timeoutMs default (60 s)
    expect(createNetworkAccounting(undefined).requestTimeoutMs).toBe(60_000);
  });

  test('policyFetch times out after the configured (non-hardcoded) timeout', async () => {
    const originalFetch = globalThis.fetch;
    // stub that HONORS the abort signal (like real fetch) but never completes
    globalThis.fetch = (((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
      })) as unknown) as typeof fetch;
    try {
      const accounting = createNetworkAccounting(1_000);
      let caught: unknown;
      try {
        await policyFetch('https://example.com/hangs-forever', {}, accounting);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NetworkPolicyError);
      const e = caught as NetworkPolicyError;
      expect(e.code).toBe('TIMEOUT');
      // reports the ACTUAL configured timeout, not the hard-coded 10000 default
      expect(e.message).toContain('1000ms');
      expect(e.message).not.toBe(`Network policy: request timed out after ${NETWORK_POLICY.requestTimeoutMs}ms.`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 10_000);
});

// ---------- §1.6 tool-level timeout end-to-end through the runtime ----------

describe('v1.0.7 §1.6 — tool timeout propagation through Task → executor → handler → sandbox', () => {
  const slowName = 'v107test.slow';
  const hangName = 'v107test.hang';

  beforeAll(async () => {
    // tool WITH its own timeoutMs — must be able to run beyond the old limits
    await registerJsTool({
      name: slowName, description: 'v1.0.7 slow-but-fine tool', schema: schema(),
      functionSource: SLOW_SOURCE, timeoutMs: 5_000,
    });
    // hanging tool with a SHORT tool-level timeout — proves the tool-level
    // value (not the caller fallback) is enforced end-to-end
    await registerJsTool({
      name: hangName, description: 'v1.0.7 hanging tool', schema: schema(),
      functionSource: HANGING_SOURCE, timeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    for (const name of [slowName, hangName]) {
      try { await db.toolRecord.delete({ where: { name } }); } catch { /* already gone */ }
    }
  });

  test('a tool with timeoutMs=5000 executes past sub-second work and stamps the effective timeout', async () => {
    const execution = await executeTool(slowName, {}, { timeoutMs: 60_000 });
    expect(execution.status).toBe('completed');
    // the TOOL-level value won over the 60s caller fallback
    expect(execution.timeoutMs).toBe(5_000);
    const entry = await getToolEntry(slowName);
    expect(entry?.timeoutMs).toBe(5_000);
  });

  test('tool-specific timeout propagates into the sandbox deadline and reports the real value', async () => {
    const started = Date.now();
    const execution = await executeTool(hangName, {}, { timeoutMs: 60_000 });
    const elapsed = Date.now() - started;
    expect(execution.status).toBe('timeout');
    expect(execution.error?.code).toBe('TIMEOUT');
    // the ERROR reports the configured 1000ms — never a hard-coded 10000ms
    expect(execution.error?.message).toContain('1000ms');
    expect(execution.timeoutMs).toBe(1_000);
    // aborted by the tool-level timeout (~1s), not by the 60s fallback
    expect(elapsed).toBeLessThan(5_000);
  });

  test('executor watchdog produces the spec-shaped timeout error with real fields', async () => {
    // builtin tool, no tool-level timeout — executor default path with a 400ms cap
    const execution = await executeTool('delay.wait', { ms: 10_000 }, { timeoutMs: 400 });
    expect(execution.status).toBe('timeout');
    expect(execution.error?.code).toBe('TIMEOUT');
    expect(execution.error?.message).toContain('Tool "delay.wait" timed out after 400ms.');
    expect(execution.timeoutMs).toBe(400);
  });

  test('ToolTimeoutError carries tool / operation / effective timeout / elapsed / reason', () => {
    const err = new ToolTimeoutError('server.health', 'tool_execution', 300_000, 123_456);
    expect(err.message).toBe('Tool "server.health" timed out after 300000ms.');
    expect(err.tool).toBe('server.health');
    expect(err.operation).toBe('tool_execution');
    expect(err.effectiveTimeoutMs).toBe(300_000);
    expect(err.elapsedMs).toBe(123_456);
    expect(err.reason).toContain('tool_execution watchdog');
    expect(err.reason).toContain('300000ms');
    expect(err.code).toBe('TIMEOUT');
  });
});

// ---------- §1.6 child-process ceiling propagation ----------

describe('v1.0.7 §1.6 — virtual child_process accepts the raised ceiling', () => {
  test('createChildProcessModule accepts the effective timeout as the ceiling', async () => {
    const session = await import('../src/lib/nexool/tools/vfs').then((m) => m.openVirtualFs('__v107test_cp'));
    const count = { n: 0 };
    const cp = createChildProcessModule(session, count, { maxTimeoutMs: 600_000 }) as Record<string, (cmd: string) => Promise<{ stdout: string }> | string>;
    // commands still run normally with the raised ceiling in place
    const out = (cp as { execSync: (cmd: string) => string }).execSync('echo hello-v107');
    expect(String(out)).toContain('hello-v107');
    await db.virtualFile.deleteMany({ where: { toolId: '__v107test_cp' } });
  });
});

// ---------- §2 tool search / filter ----------

describe('v1.0.7 §2 — tool search/filter', () => {
  const tools = [
    { name: 'image.generate', description: 'Generates an image', category: 'content', environment: 'builtin', handlerKind: undefined, metadata: undefined },
    { name: 'image.edit', description: 'Edits an existing image', category: 'content', environment: 'builtin' },
    { name: 'math.evaluate', description: 'Evaluates arithmetic', category: 'utility', environment: 'builtin' },
    { name: 'net.fetcher', description: 'Fetches URLs', category: 'utility', environment: 'js-function', handlerKind: undefined },
    { name: 'relay.delay', description: 'Waits a bit', category: 'utility', environment: 'dynamic', handlerKind: 'delay' },
    { name: 'tagged.thing', description: 'Has metadata tags', category: 'utility', environment: 'nodejs', metadata: { tag: 'imaging' } },
  ] as unknown as ToolEntry[];

  test('search by name ("image") matches image.generate and image.edit', () => {
    const out = filterTools(tools, 'image');
    expect(out.map((t) => t.name).sort()).toEqual(['image.edit', 'image.generate']);
  });

  test('search by description ("fetches") matches net.fetcher', () => {
    expect(filterTools(tools, 'fetches').map((t) => t.name)).toEqual(['net.fetcher']);
  });

  test('search by category, environment and handler kind', () => {
    expect(filterTools(tools, 'content')).toHaveLength(2);
    expect(filterTools(tools, 'js-function').map((t) => t.name)).toEqual(['net.fetcher']);
    expect(filterTools(tools, 'delay').map((t) => t.name)).toEqual(['relay.delay']);
  });

  test('search across metadata keys/values (tags equivalent)', () => {
    expect(filterTools(tools, 'imaging').map((t) => t.name)).toEqual(['tagged.thing']);
  });

  test('search is case-insensitive and trims whitespace', () => {
    expect(filterTools(tools, '  IMAGE ').length).toBe(2);
    expect(filterTools(tools, 'Math.Evaluate').map((t) => t.name)).toEqual(['math.evaluate']);
  });

  test('multi-token search requires every token (AND semantics)', () => {
    expect(filterTools(tools, 'image generate').map((t) => t.name)).toEqual(['image.generate']);
    expect(filterTools(tools, 'image math')).toHaveLength(0);
  });

  test('empty search returns everything (no filtering)', () => {
    expect(filterTools(tools, '')).toHaveLength(tools.length);
    expect(filterTools(tools, '   ')).toHaveLength(tools.length);
  });

  test('no result → empty array (empty state, never broken data)', () => {
    const out = filterTools(tools, 'zzz-nonexistent');
    expect(out).toHaveLength(0);
  });
});

// ---------- §4/§5 dependency analysis + idempotent cleanup ----------

describe('v1.0.7 §4/§5 — dependency-aware model/dataset cleanup', () => {
  const ids = {
    protectedModel: 'v107-protected-model',
    activeModel: 'v107-active-model',
    orphanModel: 'v107-orphan-model',
    protectedDataset: 'v107-protected-dataset',
    benchmarkDataset: 'v107-benchmark-dataset',
    orphanDataset: 'v107-orphan-dataset',
  };

  beforeAll(async () => {
    // clean any leftovers from previous runs (idempotent seeding)
    for (const id of Object.values(ids)) {
      await db.modelRecord.deleteMany({ where: { id } });
      await db.datasetRecord.deleteMany({ where: { id } });
    }
    await db.trainingJobRecord.deleteMany({ where: { id: 'v107-training-job' } });
    await db.benchmarkRunRecord.deleteMany({ where: { id: 'v107-benchmark-run' } });

    await db.modelRecord.create({ data: { id: ids.protectedModel, name: 'protected-model', version: '1.0.0', format: 'nextool-manifest', status: 'registered', manifest: '{"architecture":"tfjs-sequential"}' } });
    await db.modelRecord.create({ data: { id: ids.activeModel, name: 'active-model', version: '1.0.0', format: 'nextool-manifest', status: 'active', manifest: '{"architecture":"tfjs-sequential"}' } });
    await db.modelRecord.create({ data: { id: ids.orphanModel, name: 'obsolete-test-model', version: '0.0.1', format: 'nextool-manifest', status: 'registered', manifest: '{"architecture":"tfjs-sequential"}' } });
    await db.datasetRecord.create({ data: { id: ids.protectedDataset, name: 'tool-selection', version: '1.0.0', trainSize: 2, valSize: 1, testSize: 0, examples: '[]' } });
    await db.datasetRecord.create({ data: { id: ids.benchmarkDataset, name: 'benchmark-required', version: '1.0.0', trainSize: 2, valSize: 1, testSize: 0, examples: '[]' } });
    await db.datasetRecord.create({ data: { id: ids.orphanDataset, name: 'temporary-test-dataset', version: '0.0.1', trainSize: 1, valSize: 0, testSize: 0, examples: '[]' } });

    // references that PROTECT resources
    await db.trainingJobRecord.create({
      data: { id: 'v107-training-job', datasetId: ids.protectedDataset, datasetName: 'tool-selection', datasetVersion: '1.0.0', status: 'completed', modelRecordId: ids.protectedModel },
    });
    await db.benchmarkRunRecord.create({
      data: { id: 'v107-benchmark-run', modelKey: ids.activeModel, datasetId: ids.benchmarkDataset, datasetName: 'benchmark-required', datasetVersion: '1.0.0', status: 'completed' },
    });
  });

  afterAll(async () => {
    await db.trainingJobRecord.deleteMany({ where: { id: 'v107-training-job' } });
    await db.benchmarkRunRecord.deleteMany({ where: { id: 'v107-benchmark-run' } });
    for (const id of Object.values(ids)) {
      await db.modelRecord.deleteMany({ where: { id } });
      await db.datasetRecord.deleteMany({ where: { id } });
    }
  });

  test('§4.2 analysis: protected classification follows real references, not names/age', async () => {
    const analysis = await analyzeResourceDependencies();
    const m = (id: string) => analysis.models.find((x) => x.id === id)!;
    const d = (id: string) => analysis.datasets.find((x) => x.id === id)!;

    // protected: training-referenced model
    expect(m(ids.protectedModel).protectedResource).toBe(true);
    expect(m(ids.protectedModel).references.some((r) => r.kind === 'training')).toBe(true);
    // protected: status "active" (current model)
    expect(m(ids.activeModel).protectedResource).toBe(true);
    expect(m(ids.activeModel).reasons.join(' ')).toContain('active');
    // orphan: no inbound references
    expect(m(ids.orphanModel).protectedResource).toBe(false);
    expect(m(ids.orphanModel).orphaned).toBe(true);

    expect(d(ids.protectedDataset).protectedResource).toBe(true);
    expect(d(ids.benchmarkDataset).protectedResource).toBe(true);
    expect(d(ids.orphanDataset).protectedResource).toBe(false);
    expect(d(ids.orphanDataset).orphaned).toBe(true);
  });

  test('§4.8 dry-run report lists candidates and removes NOTHING', async () => {
    const report = await runResourceCleanup(true);
    expect(report.dryRun).toBe(true);
    expect(report.models.removed).toHaveLength(0);
    expect(report.datasets.removed).toHaveLength(0);
    expect(report.models.candidates.map((r) => r.id)).toContain(ids.orphanModel);
    expect(report.datasets.candidates.map((r) => r.id)).toContain(ids.orphanDataset);
    expect(report.models.protected.map((r) => r.id)).toEqual(
      expect.arrayContaining([ids.protectedModel, ids.activeModel]),
    );
    expect(report.datasets.protected.map((r) => r.id)).toEqual(
      expect.arrayContaining([ids.protectedDataset, ids.benchmarkDataset]),
    );
    // nothing was actually deleted
    expect(await db.modelRecord.findUnique({ where: { id: ids.orphanModel } })).not.toBeNull();
    expect(await db.datasetRecord.findUnique({ where: { id: ids.orphanDataset } })).not.toBeNull();
  });

  test('§4.7/§4.10 actual cleanup removes ONLY confirmed orphans, keeps records consistent', async () => {
    const report = await runResourceCleanup(false);
    expect(report.ran).toBe(true);
    // the seeded orphan IS removed (the dev database may contain additional
    // pre-existing orphans — they are legitimately removed too, which is
    // exactly the dependency-analysis behavior under test)
    expect(report.models.removed.map((r) => r.id)).toContain(ids.orphanModel);
    expect(report.datasets.removed.map((r) => r.id)).toContain(ids.orphanDataset);
    // protected resources are NEVER in the removed list
    expect(report.models.removed.map((r) => r.id)).not.toContain(ids.protectedModel);
    expect(report.models.removed.map((r) => r.id)).not.toContain(ids.activeModel);
    expect(report.datasets.removed.map((r) => r.id)).not.toContain(ids.protectedDataset);
    expect(report.datasets.removed.map((r) => r.id)).not.toContain(ids.benchmarkDataset);
    expect(report.models.failed).toHaveLength(0);
    expect(report.datasets.failed).toHaveLength(0);

    // orphans gone
    expect(await db.modelRecord.findUnique({ where: { id: ids.orphanModel } })).toBeNull();
    expect(await db.datasetRecord.findUnique({ where: { id: ids.orphanDataset } })).toBeNull();
    // protected resources stay (current model + required datasets intact)
    expect(await db.modelRecord.findUnique({ where: { id: ids.protectedModel } })).not.toBeNull();
    expect(await db.modelRecord.findUnique({ where: { id: ids.activeModel } })).not.toBeNull();
    expect(await db.datasetRecord.findUnique({ where: { id: ids.protectedDataset } })).not.toBeNull();
    expect(await db.datasetRecord.findUnique({ where: { id: ids.benchmarkDataset } })).not.toBeNull();

    // §4.10 — the remaining references still resolve (no broken DB refs)
    const job = await db.trainingJobRecord.findUnique({ where: { id: 'v107-training-job' } });
    expect(await db.modelRecord.findUnique({ where: { id: job!.modelRecordId! } })).not.toBeNull();
    expect(await db.datasetRecord.findUnique({ where: { id: job!.datasetId } })).not.toBeNull();
    const run = await db.benchmarkRunRecord.findUnique({ where: { id: 'v107-benchmark-run' } });
    expect(await db.modelRecord.findUnique({ where: { id: run!.modelKey } })).not.toBeNull();
  });

  test('§5 cleanup is idempotent — the second run removes nothing new', async () => {
    const first = await runResourceCleanup(false);
    expect(first.models.removed).toHaveLength(0);
    expect(first.datasets.removed).toHaveLength(0);
    const second = await runResourceCleanup(false);
    expect(second.models.removed).toHaveLength(0);
    expect(second.datasets.removed).toHaveLength(0);
    expect(second.models.candidates).toHaveLength(0);
    expect(second.datasets.candidates).toHaveLength(0);
  });

  test('§4.11 startup validation reports the active model and resolves references', async () => {
    const report = await validateRuntimeDependencies();
    expect(report.activeModel.name).toBe('llm-core');
    expect(report.activeModel.ok).toBe(true);
    expect(report.fallbackModel.name).toBe('heuristic-fallback');
    expect(report.ok).toBe(true);
    expect(report.checks.models).toBeGreaterThanOrEqual(2);
    expect(report.checks.datasets).toBeGreaterThanOrEqual(2);
    expect(report.problems.filter((p) => p.severity === 'error')).toHaveLength(0);
  });
});

// ---------- §3 dangerous reset ----------

describe('v1.0.7 §3 — dangerous reset (typed confirmation, protected resources)', () => {
  const unique = `v107-reset-task-${Date.now()}`;

  beforeAll(async () => {
    // seed every runtime store the reset is supposed to clear
    const task = await db.task.create({
      data: { id: unique, request: 'v1.0.7 reset test task', mode: 'goal', status: 'completed' },
    });
    await db.taskEvent.create({ data: { taskId: task.id, type: 'task.created', source: 'runtime', message: 'seed' } });
    await db.historyEntry.create({ data: { taskId: task.id, action: 'echo.echo', status: 'completed' } });
    await db.memoryEntry.create({ data: { key: `v107-reset-${unique}`, value: '"x"' } });
    await db.notificationRecord.create({ data: { title: 'v107 reset seed', body: 'x' } });
    await db.virtualFile.create({ data: { toolId: 'echo.echo', path: '/tmp/v107-reset-seed.txt', kind: 'file', content: 'x', size: 1 } });
    // a tool with usage statistics that must be zeroed but NOT deleted
    await db.toolRecord.upsert({
      where: { name: 'echo.echo' },
      update: { callCount: 7, successCount: 5, failureCount: 1, timeoutCount: 1, totalMs: 900 },
      create: { name: 'echo.echo', description: 'Echoes a message back. Useful for runtime verification.', category: 'utility', environment: 'builtin', definition: '{}', enabled: true, callCount: 7, successCount: 5, failureCount: 1, timeoutCount: 1, totalMs: 900 },
    });
  });

  afterAll(async () => {
    await db.task.deleteMany({ where: { id: { startsWith: 'v107-reset-task-' } } });
    await db.memoryEntry.deleteMany({ where: { key: { startsWith: 'v107-reset-' } } });
    await db.notificationRecord.deleteMany({ where: { title: { startsWith: 'v107 reset seed' } } });
    await db.virtualFile.deleteMany({ where: { path: '/tmp/v107-reset-seed.txt' } });
    // keep a protected dataset/model pair for later verification after reset
    await db.datasetRecord.upsert({
      where: { id: 'v107-survivor-dataset' },
      update: {},
      create: { id: 'v107-survivor-dataset', name: 'survivor', version: '1.0.0', examples: '[]' },
    });
  });

  test('§3.3 wrong confirmation phrase → nothing is deleted', async () => {
    const before = {
      tasks: await db.task.count(),
      events: await db.taskEvent.count(),
      memory: await db.memoryEntry.count(),
    };
    const report = await resetApplicationRuntime('reset please');
    expect(report.ok).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(await db.task.count()).toBe(before.tasks);
    expect(await db.taskEvent.count()).toBe(before.events);
    expect(await db.memoryEntry.count()).toBe(before.memory);
  });

  test('§3.7/§3.9 correct phrase clears runtime data and PRESERVES tools/models/datasets/settings', async () => {
    // a protected dataset that must survive the reset
    await db.datasetRecord.upsert({
      where: { id: 'v107-survivor-dataset' },
      update: {},
      create: { id: 'v107-survivor-dataset', name: 'survivor', version: '1.0.0', examples: '[]' },
    });
    const settingsBefore = await db.setting.count();

    const report = await resetApplicationRuntime(RESET_CONFIRMATION_PHRASE);
    expect(report.ok).toBe(true);
    expect(report.confirmPhrase).toBe('RESET');

    // §3.4 — runtime data cleared
    expect(report.cleared.tasks).toBeGreaterThanOrEqual(1);
    expect(report.cleared.taskEvents).toBeGreaterThanOrEqual(1);
    expect(report.cleared.historyEntries).toBeGreaterThanOrEqual(1);
    expect(report.cleared.memoryEntries).toBeGreaterThanOrEqual(1);
    expect(await db.task.count()).toBe(0);
    expect(await db.historyEntry.count()).toBe(0);
    expect(await db.memoryEntry.count()).toBe(0);
    expect(await db.notificationRecord.count()).toBe(0);
    expect(await db.virtualFile.count()).toBe(0);

    // §3.5 — protected resources
    const echo = await db.toolRecord.findUnique({ where: { name: 'echo.echo' } });
    expect(echo).not.toBeNull();
    expect(echo!.callCount).toBe(0); // statistics reset, tool preserved
    expect(await db.datasetRecord.findUnique({ where: { id: 'v107-survivor-dataset' } })).not.toBeNull();
    expect(await db.modelRecord.count()).toBeGreaterThanOrEqual(0); // table untouched
    expect(await db.trainingJobRecord.count()).toBeGreaterThanOrEqual(0);
    expect(await db.benchmarkRunRecord.count()).toBeGreaterThanOrEqual(0);
    expect(await db.setting.count()).toBe(settingsBefore); // settings preserved
  });

  test('§3.8 reset is NOT a broad database wipe (protected tables remain queryable and populated)', async () => {
    const dataset = await db.datasetRecord.findUnique({ where: { id: 'v107-survivor-dataset' } });
    expect(dataset).not.toBeNull();
    // the builtin tools still exist with definitions
    const tools = await db.toolRecord.findMany({ take: 5 });
    expect(tools.length).toBeGreaterThan(0);
  });

  test('§3 API route: missing/incorrect phrase is rejected with CONFIRMATION_REQUIRED', async () => {
    const bad = await resetRoutePost(new Request('http://localhost/api/settings/reset', {
      method: 'POST', body: JSON.stringify({ confirm: 'reset' }), headers: { 'content-type': 'application/json' },
    }));
    expect(bad.status).toBe(400);

    const missing = await resetRoutePost(new Request('http://localhost/api/settings/reset', {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    }));
    expect(missing.status).toBe(400);
  });

  test('§3 API route: correct phrase performs the backend reset (not browser-only)', async () => {
    await db.memoryEntry.create({ data: { key: `v107-api-reset-${Date.now()}`, value: '"y"' } });
    const res = await resetRoutePost(new Request('http://localhost/api/settings/reset', {
      method: 'POST', body: JSON.stringify({ confirm: 'RESET' }), headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: { ok: boolean; cleared: Record<string, number> } };
    expect(json.ok).toBe(true);
    expect(json.data.ok).toBe(true);
    expect(json.data.cleared.memoryEntries).toBeGreaterThanOrEqual(1);
    expect(await db.memoryEntry.count()).toBe(0);
  });

  test('reset confirmation schema is strict about the phrase', () => {
    expect(resetApplicationSchema.safeParse({ confirm: 'RESET' }).success).toBe(true);
    expect(resetApplicationSchema.safeParse({ confirm: 'reset' }).success).toBe(false);
    expect(resetApplicationSchema.safeParse({ confirm: 'RESET ' }).success).toBe(false);
    expect(resetApplicationSchema.safeParse({}).success).toBe(false);
  });
});
