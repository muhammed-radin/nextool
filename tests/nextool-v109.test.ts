/**
 * NexTool v1.0.9 — unit + regression tests (bun test).
 *
 * §1  Network Policy request-timeout resolution (precedence, clamps, ceiling)
 * §2  Settings persistence — networkRequestTimeoutMs survives via the
 *     existing Settings system (db-backed; original value restored)
 * §3  Network timeout propagation — policyFetch honours the resolved Network
 *     Policy timeout and reports NETWORK_TIMEOUT (never a tool-execution
 *     timeout) with the CONFIGURED value in the message
 * §4  Regression (spec 16.4): 10000ms default → NETWORK_TIMEOUT; 30000ms →
 *     a controlled 15s request completes past 10s; 120000ms → 15s completes
 * §5  Tool-execution timeout distinction (spec 16.5): a NON-network tool
 *     running 15s with tool timeout 30000ms completes — the Network Policy
 *     timeout is never applied to non-network tool execution
 * §6  Task Preview status mapping + reconciliation (spec 16.6): all statuses
 *     map (incl. stopped → Stopped, timeout → Timed out); stale running
 *     events never overwrite terminal states; parallel calls keep individual
 *     statuses
 *
 * Run: bun test tests/nextool-v109.test.ts
 */
import { describe, expect, test } from 'bun:test';

import {
  clampNetworkTimeoutMs,
  defaultNetworkRequestTimeoutMs,
  resolveNetworkRequestTimeoutForExecution,
  resolveNetworkRequestTimeoutMs,
} from '../src/lib/nexool/tools/network-timeout';
import { createNetworkAccounting, policyFetch, NetworkPolicyError } from '../src/lib/nexool/tools/sandbox-net';
import { runJsTool } from '../src/lib/nexool/tools/js-runner';
import {
  executionStatusRank,
  isTerminalExecutionStatus,
  mergeExecutionRecords,
  normalizeExecutionStatus,
  reconcileExecutions,
} from '../src/lib/nexool/execution-merge';
import { EXECUTION_STATUS_LABELS } from '../src/components/console/ui-bits';
import type { ToolExecution } from '../src/lib/nexool/types';

// ---------- helpers ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stub globalThis.fetch with a response that resolves after `delayMs` (or
 *  never). The stub HONOURS init.signal like a real fetch: an aborted request
 *  rejects with the signal's reason (this is what makes the Network Policy
 *  abort observable). */
function hangFetch(delayMs: number | null, body = 'ok'): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      const timer = delayMs === null ? undefined : setTimeout(resolve, delayMs);
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(init?.signal?.reason instanceof Error ? init.signal.reason : new Error('This operation was aborted'));
      };
      if (init?.signal?.aborted) onAbort();
      else init?.signal?.addEventListener('abort', onAbort, { once: true });
    });
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const exec = (partial: Partial<ToolExecution>): ToolExecution => ({
  executionId: partial.executionId ?? `exec_${Math.random().toString(36).slice(2, 8)}`,
  tool: partial.tool ?? 'llm.chat',
  status: partial.status ?? 'running',
  params: {},
  startedAt: partial.startedAt ?? new Date().toISOString(),
  ...partial,
});

// ---------- §1 Network Policy resolution ----------

describe('v1.0.9 §1 — Network Policy request-timeout resolution', () => {
  test('precedence: request → tool → task → global → shipped default', () => {
    const global = resolveNetworkRequestTimeoutMs({ globalSettingMs: 120_000 });
    expect(global.effective).toBe(120_000);
    expect(global.source).toBe('global');

    const task = resolveNetworkRequestTimeoutMs({ taskNetworkTimeoutMs: 30_000, globalSettingMs: 120_000 });
    expect(task.effective).toBe(30_000);
    expect(task.source).toBe('task');

    const tool = resolveNetworkRequestTimeoutMs({ toolNetworkTimeoutMs: 90_000, taskNetworkTimeoutMs: 30_000, globalSettingMs: 120_000 });
    expect(tool.effective).toBe(90_000);
    expect(tool.source).toBe('tool');

    const request = resolveNetworkRequestTimeoutMs({
      requestOverrideMs: 5_000, toolNetworkTimeoutMs: 90_000, taskNetworkTimeoutMs: 30_000, globalSettingMs: 120_000,
    });
    expect(request.effective).toBe(5_000);
    expect(request.source).toBe('request');

    const def = resolveNetworkRequestTimeoutMs({});
    expect(def.effective).toBe(defaultNetworkRequestTimeoutMs());
    expect(def.source).toBe('default');
  });

  test('values clamp into the central network.timeoutMs bounds', () => {
    const low = clampNetworkTimeoutMs(10); // below min (1000)
    expect(low).toBeGreaterThanOrEqual(1000);
    const high = clampNetworkTimeoutMs(99_999_999); // above max (3600000)
    expect(high).toBeLessThanOrEqual(3_600_000);
    expect(clampNetworkTimeoutMs(undefined)).toBe(defaultNetworkRequestTimeoutMs());
  });

  test('the tool execution timeout only CAPS the request timeout — never substitutes it', () => {
    // spec §14.3: tool 300000 + network 120000 → 120000 (NOT 10000, NOT 300000)
    const r = resolveNetworkRequestTimeoutMs({ globalSettingMs: 120_000, toolExecutionTimeoutMs: 300_000 });
    expect(r.effective).toBe(120_000);
    // a request can never outlive its (shorter) tool
    const capped = resolveNetworkRequestTimeoutMs({ globalSettingMs: 120_000, toolExecutionTimeoutMs: 60_000 });
    expect(capped.effective).toBe(60_000);
    expect(capped.capped).toBe(true);
  });

  test('async execution resolver reads the global Settings layer', async () => {
    const r = await resolveNetworkRequestTimeoutForExecution({ toolExecutionTimeoutMs: 300_000 });
    expect(r.effective).toBeGreaterThan(0);
    expect(['global', 'default']).toContain(r.source);
  });
});

// ---------- §2 Settings persistence (db-backed; value restored) ----------

describe('v1.0.9 §2 — Settings persistence for the Network Policy', () => {
  test('networkRequestTimeoutMs persists through updateSettings/getSettings', async () => {
    const { getSettings, updateSettings } = await import('../src/lib/nexool/settings');
    const before = await getSettings(true);
    const original = before.networkRequestTimeoutMs;
    try {
      // spec 14.2 example — a 120000ms setting means a request may live 120 s
      const updated = await updateSettings({ networkRequestTimeoutMs: 120_000 });
      expect(updated.networkRequestTimeoutMs).toBe(120_000);
      // a fresh (force) read reflects the persisted value — survives "restart"
      const reloaded = await getSettings(true);
      expect(reloaded.networkRequestTimeoutMs).toBe(120_000);
      // values above the ceiling are clamped by the runtime (defense in depth)
      const clamped = await updateSettings({ networkRequestTimeoutMs: 999_999_999 });
      expect(clamped.networkRequestTimeoutMs).toBeLessThanOrEqual(3_600_000);
      // out-of-range values are rejected by the API schema — validated here via bounds
      expect(() => clampNetworkTimeoutMs('not-a-number')).not.toThrow();
    } finally {
      await updateSettings({ networkRequestTimeoutMs: original });
    }
  }, 20_000);
});

// ---------- §3/§4 Network timeout propagation + regression ----------

describe('v1.0.9 §3 — Network timeout propagation through policyFetch', () => {
  test('accounting requestTimeoutMs governs the request (not the tool timeout)', async () => {
    const restore = hangFetch(3_000);
    try {
      // resolved network timeout 1000ms — the TOOL timeout (300000) is irrelevant here
      const accounting = createNetworkAccounting(1_000);
      let caught: unknown;
      try {
        await policyFetch('https://nextool.example/hangs', {}, accounting);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NetworkPolicyError);
      const e = caught as NetworkPolicyError;
      expect(e.code).toBe('NETWORK_TIMEOUT');
      expect(e.message).toContain('1000ms');
      expect(e.message).toContain('Network request exceeded the configured timeout');
      expect(e.message).not.toContain('Function exceeded');
    } finally {
      restore();
    }
  }, 15_000);

  test('request-specific override (layer 1) bounds a single request', async () => {
    const restore = hangFetch(3_000);
    try {
      const accounting = createNetworkAccounting(60_000);
      let caught: unknown;
      try {
        await policyFetch('https://nextool.example/hangs', { timeoutMs: 1_000 }, accounting);
      } catch (err) {
        caught = err;
      }
      expect((caught as NetworkPolicyError).code).toBe('NETWORK_TIMEOUT');
      expect((caught as NetworkPolicyError).message).toContain('1000ms');
    } finally {
      restore();
    }
  }, 15_000);
});

describe('v1.0.9 §4 — regression 16.4: requests continue past the old 10s kill', () => {
  test('Network Request Timeout = 10000ms → a hanging request fails with NETWORK_TIMEOUT at ~10s', async () => {
    const restore = hangFetch(null); // never resolves
    try {
      const accounting = createNetworkAccounting(10_000);
      const started = Date.now();
      let caught: unknown;
      try {
        await policyFetch('https://nextool.example/slow-llm', {}, accounting);
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - started;
      expect((caught as NetworkPolicyError).code).toBe('NETWORK_TIMEOUT');
      expect((caught as NetworkPolicyError).message).toContain('10000ms');
      // aborted by the Network Policy at the configured 10s — not earlier
      expect(elapsed).toBeGreaterThanOrEqual(9_500);
    } finally {
      restore();
    }
  }, 30_000);

  test('Network Request Timeout = 30000ms → the same 15s request COMPLETES past 10s', async () => {
    const restore = hangFetch(15_000, '{"ok":true}');
    try {
      const accounting = createNetworkAccounting(30_000);
      const res = await policyFetch('https://nextool.example/slow-llm', {}, accounting);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      restore();
    }
  }, 40_000);

  test('Network Request Timeout = 120000ms → a controlled 15s request completes', async () => {
    const restore = hangFetch(15_000, '{"llm":"done"}');
    try {
      const accounting = createNetworkAccounting(120_000);
      const res = await policyFetch('https://nextool.example/llm.chat', {}, accounting);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"llm":"done"}');
    } finally {
      restore();
    }
  }, 40_000);

  test('js tool whose fetch is slow fails with NETWORK_TIMEOUT (code preserved end-to-end)', async () => {
    const restore = hangFetch(5_000, 'late');
    try {
      const source = `async function execute(params) {
        const res = await fetch('https://nextool.example/slow');
        return await res.text();
      }`;
      const run = await runJsTool(
        source, {},
        { executionId: 'exec_nettest', mode: 'test', now: new Date().toISOString(), log: () => {} },
        { timeoutMs: 30_000, networkTimeoutMs: 1_000 },
      );
      expect(run.ok).toBe(false);
      expect(run.error?.code).toBe('NETWORK_TIMEOUT');
      expect(run.error?.message).toContain('1000ms');
    } finally {
      restore();
    }
  }, 20_000);
});

// ---------- §5 Tool-execution vs network distinction (16.5) ----------

describe('v1.0.9 §5 — regression 16.5: non-network tool runs 15s under a 30s tool timeout', () => {
  test('a pure compute/sleep tool is NOT killed by any network policy timeout', async () => {
    const source = `async function execute(params) {
      // NON-network work: a controlled 15-second sleep, then complete
      await new Promise((resolve) => setTimeout(resolve, params.ms));
      return 'completed';
    }`;
    const run = await runJsTool(
      source, { ms: 15_000 },
      { executionId: 'exec_nonet', mode: 'test', now: new Date().toISOString(), log: () => {} },
      { timeoutMs: 30_000, networkTimeoutMs: 1_000 }, // absurdly small network timeout — irrelevant here
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe('completed');
  }, 40_000);
});

// ---------- §6 Task Preview status mapping + reconciliation (16.6) ----------

describe('v1.0.9 §6 — Task Preview status mapping', () => {
  test('every backend execution status maps 1:1 (spec 15.2)', () => {
    expect(EXECUTION_STATUS_LABELS.pending).toBe('Pending');
    expect(EXECUTION_STATUS_LABELS.running).toBe('Running');
    expect(EXECUTION_STATUS_LABELS.completed).toBe('Completed');
    expect(EXECUTION_STATUS_LABELS.failed).toBe('Failed');
    expect(EXECUTION_STATUS_LABELS.timeout).toBe('Timed out');
    expect(EXECUTION_STATUS_LABELS.cancelled).toBe('Cancelled');
    expect(EXECUTION_STATUS_LABELS.stopped).toBe('Stopped');
  });

  test('terminal statuses are classified and ranked monotonically', () => {
    for (const s of ['completed', 'failed', 'timeout', 'cancelled', 'stopped']) {
      expect(isTerminalExecutionStatus(s)).toBe(true);
    }
    for (const s of ['running', 'pending']) {
      expect(isTerminalExecutionStatus(s)).toBe(false);
    }
    expect(executionStatusRank('completed')).toBeGreaterThan(executionStatusRank('running'));
    expect(executionStatusRank('running')).toBeGreaterThan(executionStatusRank('pending'));
  });
});

describe('v1.0.9 §6 — SSE/polling reconciliation (spec 15.9)', () => {
  test('a stale running snapshot NEVER regresses a terminal state', () => {
    const completed = exec({ executionId: 'exec_1', status: 'completed', completedAt: new Date().toISOString() });
    const staleRunning = exec({ executionId: 'exec_1', status: 'running', startedAt: new Date(Date.now() - 60_000).toISOString() });

    const merged = reconcileExecutions([completed], [staleRunning]);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('completed');
    // and the reverse order — same guarantee
    const merged2 = reconcileExecutions([staleRunning], [completed]);
    expect(merged2[0].status).toBe('completed');
  });

  test('a terminal event beats a NEWER running event (replayed tool.started)', () => {
    const terminal = exec({ executionId: 'exec_2', status: 'failed', completedAt: new Date().toISOString() });
    const newerRunning = exec({ executionId: 'exec_2', status: 'running', startedAt: new Date().toISOString() });
    expect(pick(reconcileExecutions([terminal], [newerRunning]))).toBe('failed');
  });

  test('parallel batch members keep their OWN statuses (spec 15.8)', () => {
    const batch = 'batch_1';
    const a = exec({ executionId: 'exec_a', tool: 'a.ping', status: 'completed', batchId: batch, completedAt: new Date().toISOString() });
    const b = exec({ executionId: 'exec_b', tool: 'b.fail', status: 'failed', batchId: batch, completedAt: new Date().toISOString() });
    const c = exec({ executionId: 'exec_c', tool: 'c.work', status: 'running', batchId: batch });
    const merged = reconcileExecutions([], [a, b, c]);
    const byId = new Map(merged.map((m) => [m.executionId, m.status]));
    expect(byId.get('exec_a')).toBe('completed');
    expect(byId.get('exec_b')).toBe('failed');
    expect(byId.get('exec_c')).toBe('running');
  });

  test('mergeExecutionRecords: history truth wins; event records feed live states; stopped persists', () => {
    const now = new Date();
    const history = [
      {
        id: 'h1', action: 'llm.chat', params: '{"prompt":"hi"}', result: '"hello"',
        status: 'completed', timestamp: now,
      },
    ];
    const events = [
      { type: 'tool.started', data: JSON.stringify({ executionId: 'exec_x', tool: 'llm.chat', status: 'running', startedAt: new Date(now.getTime() - 1000).toISOString() }), createdAt: new Date(now.getTime() - 1000) },
      { type: 'tool.completed', data: JSON.stringify({ executionId: 'exec_x', tool: 'llm.chat', status: 'completed', startedAt: new Date(now.getTime() - 1000).toISOString(), completedAt: now.toISOString(), durationMs: 1000, timeoutMs: 300000, networkTimeoutMs: 120000 }), createdAt: now },
      // a stale replayed started event AFTER completion must not regress it
      { type: 'tool.started', data: JSON.stringify({ executionId: 'exec_x', tool: 'llm.chat', status: 'running', startedAt: new Date(now.getTime() - 1000).toISOString() }), createdAt: new Date(now.getTime() + 5) },
      { type: 'tool.cancelled', data: JSON.stringify({ executionId: 'exec_y', tool: 'other.tool', status: 'cancelled', error: { code: 'CANCELLED', message: 'Execution cancelled.' }, startedAt: now.toISOString(), completedAt: now.toISOString() }), createdAt: now },
    ];
    const merged = mergeExecutionRecords(history, events);
    const byId = new Map(merged.map((m) => [m.executionId, m]));
    const x = byId.get('exec_x');
    expect(x?.status).toBe('completed');
    // the history row pairs with the terminal event record and enriches it
    expect(x?.result).toBe('hello');
    expect(x?.params).toEqual({ prompt: 'hi' });
    expect(x?.durationMs).toBe(1000);
    expect(x?.timeoutMs).toBe(300000);
    expect(x?.networkTimeoutMs).toBe(120000);
    // paired rows do NOT create duplicates
    expect(byId.get('hist_h1')).toBeUndefined();
    expect(byId.get('exec_y')?.status).toBe('cancelled');
  });

  test('normalizeExecutionStatus: stopped survives; unknown becomes failed (never running)', () => {
    expect(normalizeExecutionStatus('stopped')).toBe('stopped');
    expect(normalizeExecutionStatus('timeout')).toBe('timeout');
    expect(normalizeExecutionStatus('garbage')).toBe('failed');
    expect(normalizeExecutionStatus(null)).toBe('failed');
  });
});

function pick(records: ToolExecution[]): string {
  expect(records).toHaveLength(1);
  return records[0].status;
}
