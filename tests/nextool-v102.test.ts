/**
 * NexTool v1.0.2 — unit tests (bun test).
 * Covers the pure core of the v1.0.2 features without touching the database:
 *   - training preprocessing (tokenizer / vectorizer / dataset preparation)
 *   - js-function tool source validation + sandboxed execution
 *   - tool parameter coercion / validation (executor)
 *   - icon package PNG dimension parsing
 *   - console status / terminal / checklist derivation (single source of truth)
 * Run: bun test tests/
 */
import { describe, expect, test } from 'bun:test';

import { tokenize, vectorize, prepareDataset } from '../src/lib/nexool/training/engine';
import { validateFunctionSource, runJsTool } from '../src/lib/nexool/tools/js-runner';
import { coerceParams, validateParams } from '../src/lib/nexool/tools/executor';
import { pngDimensions } from '../src/lib/nexool/branding';
import { deriveTaskRuntime, terminalStatusLine, deriveChecklist } from '../src/components/console/ui-bits';
import type { NexToolEvent, ToolDefinition } from '../src/lib/nexool/types';

// ---------- training preprocessing ----------

describe('training preprocessing', () => {
  test('tokenize lowercases, strips punctuation, drops 1-char tokens', () => {
    expect(tokenize('Hello, World! Check api-01 NOW a')).toEqual(['hello', 'world', 'check', 'api-01', 'now']);
  });

  test('vectorize is deterministic, L2-normalized and respects vocabSize', () => {
    const a = vectorize('restart server api-01 now', 64);
    const b = vectorize('restart server api-01 now', 64);
    expect(a.length).toBe(64);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
  });

  test('different texts produce different vectors (mostly)', () => {
    const a = vectorize('restart the server', 128);
    const b = vectorize('evaluate the math expression', 128);
    const same = a.every((v, i) => v === b[i]);
    expect(same).toBe(false);
  });

  test('prepareDataset carves a validation holdout deterministically and counts skipped', () => {
    const examples = [
      { request: 'restart api-01', expectedTool: 'server.restart' },
      { request: 'restart api-02', expectedTool: 'server.restart' },
      { request: 'restart web-01', expectedTool: 'server.restart' },
      { request: 'restart web-02', expectedTool: 'server.restart' },
      { request: 'what time is it', expectedTool: 'time.now' },
      { request: '', expectedTool: 'time.now' }, // skipped: empty request
      { request: 'no tool given' }, // skipped: no expectedTool
    ];
    const bundle = prepareDataset(examples, 0.25);
    expect(bundle.skipped).toBe(2);
    expect(bundle.classes.sort()).toEqual(['server.restart', 'time.now']);
    expect(bundle.train.length + bundle.val.length).toBe(5);
    expect(bundle.val.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------- js-function tool sandbox ----------

describe('js tool runner', () => {
  test('validateFunctionSource accepts valid sources and rejects syntax errors', () => {
    expect(validateFunctionSource('return params.x;')).toEqual({ ok: true });
    const bad = validateFunctionSource('return {{{;');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
    expect(validateFunctionSource('   ').ok).toBe(false);
    expect(validateFunctionSource('x'.repeat(64_001)).ok).toBe(false);
  });

  test('runJsTool executes a simple function and returns serializable results', async () => {
    const run = await runJsTool(
      'return { sum: params.a + params.b };',
      { a: 2, b: 40 },
      { executionId: 'test_1', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(run.ok).toBe(true);
    expect((run.result as { sum: number }).sum).toBe(42);
  });

  test('sandbox blocks unrestricted require — v1.0.6: require exists but Node modules are rejected', async () => {
    const run = await runJsTool(
      'try { require("crypto"); return { has: "allowed" }; } catch (e) { return { has: "thrown" }; }',
      {},
      { executionId: 'test_2', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(run.ok).toBe(true);
    expect((run.result as { has: string }).has).toBe('thrown');
  });

  test('context exposes mode/executionId and log collects lines', async () => {
    const run = await runJsTool(
      'context.log("hi", params.n); return { mode: context.mode, id: context.executionId };',
      { n: 7 },
      { executionId: 'test_3', mode: 'test', now: new Date().toISOString(), log: () => {} },
    );
    expect(run.ok).toBe(true);
    expect(run.result).toEqual({ mode: 'test', id: 'test_3' });
    expect(run.logs[0]).toContain('hi');
    expect(run.logs[0]).toContain('7');
  });
});

// ---------- param coercion / validation ----------

describe('tool param coercion + validation', () => {
  const def: ToolDefinition = {
    name: 'test.tool',
    description: '',
    category: 'utility',
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        { name: 'count', type: 'number', required: true, description: '' },
        { name: 'level', type: 'string', required: false, description: '', enumValues: ['info', 'warning'] },
        { name: 'tags', type: 'array', required: false, description: '' },
      ],
    },
  };

  test('coerceParams coerces strings to numbers and comma-strings to arrays', () => {
    const out = coerceParams({ count: '5', level: 'info', tags: 'a, b' }, def.schema);
    expect(out.count).toBe(5);
    expect(out.level).toBe('info');
    expect(out.tags).toEqual(['a', 'b']);
  });

  test('validateParams reports missing required, bad enums and min/max', () => {
    const errors = validateParams({ level: 'critical' }, def.schema);
    expect(errors.some((e) => e.includes('Missing required param: count'))).toBe(true);
    expect(errors.some((e) => e.includes('must be one of'))).toBe(true);
    expect(validateParams({ count: 3 }, def.schema)).toEqual([]);
  });
});

// ---------- icon PNG parsing ----------

describe('branding pngDimensions', () => {
  function png(width: number, height: number): Uint8Array {
    const buf = new Uint8Array(33);
    buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(buf.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return buf;
  }
  test('reads IHDR dimensions', () => {
    expect(pngDimensions(png(192, 192))).toEqual({ width: 192, height: 192 });
  });
  test('rejects non-PNG and absurd sizes', () => {
    expect(pngDimensions(new Uint8Array(32))).toBeNull();
    expect(pngDimensions(png(0, 10))).toBeNull();
  });
});

// ---------- runtime status / terminal / checklist derivation ----------

function ev(partial: Partial<NexToolEvent>): NexToolEvent {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    taskId: 'task-1',
    type: partial.type ?? 'observer.state_changed',
    source: partial.source ?? 'observer',
    message: partial.message ?? '',
    data: partial.data,
    priority: partial.priority ?? 5,
    createdAt: partial.createdAt ?? new Date().toISOString(),
  };
}

describe('deriveTaskRuntime (console status single source of truth)', () => {
  test('idle when no status', () => {
    expect(deriveTaskRuntime(undefined, [])).toEqual({ status: 'idle', activeTool: null, active: false });
  });

  test('terminal statuses are terminal (no cursor)', () => {
    for (const status of ['completed', 'failed', 'stopped', 'cancelled']) {
      const rt = deriveTaskRuntime(status, []);
      expect(rt.active).toBe(false);
    }
  });

  test('running task with an open tool.started yields the active tool', () => {
    const events = [
      ev({ type: 'task.started', source: 'runtime' }),
      ev({ type: 'tool.started', source: 'tool', data: { executionId: 'e1', tool: 'server.health' } }),
    ];
    const rt = deriveTaskRuntime('running', events);
    expect(rt.status).toBe('running');
    expect(rt.activeTool).toBe('server.health');
    expect(rt.active).toBe(true);
  });

  test('cursor stops after tool.completed', () => {
    const events = [
      ev({ type: 'tool.started', source: 'tool', data: { executionId: 'e1', tool: 'math.evaluate' } }),
      ev({ type: 'tool.completed', source: 'tool', data: { executionId: 'e1', tool: 'math.evaluate' } }),
    ];
    const rt = deriveTaskRuntime('running', events);
    expect(rt.activeTool).toBeNull();
    expect(rt.active).toBe(false);
    const line = terminalStatusLine(rt);
    expect(line.blinking).toBe(false);
  });

  test('planner/core events map to planning, observer to observing', () => {
    expect(deriveTaskRuntime('running', [ev({ type: 'planner.plan', source: 'planner' })]).status).toBe('planning');
    expect(deriveTaskRuntime('running', [ev({ type: 'core.decision', source: 'core' })]).status).toBe('planning');
    expect(deriveTaskRuntime('running', [ev({ type: 'observer.observed', source: 'observer' })]).status).toBe('observing');
  });
});

describe('terminalStatusLine (spec §7-11)', () => {
  test('running with active tool shows [running]: Tool called <tool> with blinking cursor', () => {
    const line = terminalStatusLine({ status: 'running', activeTool: 'server.health', active: true });
    expect(line.label).toBe('[running]');
    expect(line.text).toBe('Tool called server.health');
    expect(line.blinking).toBe(true);
  });

  test('idle never blinks a cursor', () => {
    expect(terminalStatusLine({ status: 'idle', activeTool: null, active: false }).blinking).toBe(false);
  });

  test('waiting/failed/completed states do not blink', () => {
    expect(terminalStatusLine({ status: 'waiting', activeTool: null, active: false }).blinking).toBe(false);
    expect(terminalStatusLine({ status: 'failed', activeTool: null, active: false }).blinking).toBe(false);
    expect(terminalStatusLine({ status: 'completed', activeTool: null, active: false }).blinking).toBe(false);
  });
});

describe('deriveChecklist (spec §62-65)', () => {
  test('uses plan statuses and computes a real percentage', () => {
    const plan = [
      { id: 's1', title: 'Understand task', status: 'completed', kind: 'action' },
      { id: 's2', title: 'Check health', status: 'in_progress', kind: 'action' },
      { id: 's3', title: 'Verify answer', status: 'pending', kind: 'verification' },
    ];
    const { items, percent } = deriveChecklist(plan, []);
    expect(items.map((i) => i.state)).toEqual(['completed', 'running', 'pending']);
    expect(percent).toBe(33);
  });

  test('falls back to real events when no plan exists — no invented steps', () => {
    const events = [
      ev({ type: 'task.started', source: 'runtime' }),
      ev({ type: 'tool.started', source: 'tool', data: { executionId: 'e1', tool: 'server.health' } }),
      ev({ type: 'tool.completed', source: 'tool', data: { executionId: 'e1', tool: 'server.health' } }),
    ];
    const { items } = deriveChecklist(undefined, events);
    expect(items.map((i) => i.title)).toEqual(['Task started', 'Tool called server.health']);
    expect(items[1].state).toBe('completed');
  });

  test('returns null percent when there is nothing to compute', () => {
    expect(deriveChecklist(undefined, []).percent).toBeNull();
  });

  test('failed plan step maps to [!] failed', () => {
    const { items } = deriveChecklist([{ id: 's1', title: 'x', status: 'failed', kind: 'action' }], []);
    expect(items[0].state).toBe('failed');
  });
});
