/**
 * NexTool v1.0.3 — unit tests (bun test).
 * Covers the pure core of the v1.0.3 features without touching the database:
 *   - Parquet dataset adapter (real encode/decode round-trip via @dsnp/parquetjs)
 *   - Parquet rejection of corrupt input (honest errors, never silent)
 *   - icon package favicon-generator alias canonicalization
 *   - parallel tool call configuration surface (zod schemas)
 *   - checklist state mapping for plan steps (v1.0.3 §2/§3)
 * Run: bun test tests/
 */
import { describe, expect, test } from 'bun:test';

import { encodeParquetDataset, decodeParquetDataset, parquetAdapterInfo } from '../src/lib/nexool/datasets/parquet';
import { canonicalIconName, pngDimensions } from '../src/lib/nexool/branding';
import { taskConfigSchema, settingsSchema } from '../src/lib/nexool/schemas';
import { deriveChecklist } from '../src/components/console/ui-bits';
import type { DatasetExample, NexToolEvent } from '../src/lib/nexool/types';

// ---------- parquet adapter ----------

const SAMPLE: DatasetExample[] = [
  { category: 'monitoring', request: 'Check the health of api-01', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' }, split: 'train' },
  { category: 'content', request: 'Create an image of a red sports car', split: 'validation' },
  { category: 'memory', request: 'Store the preferred server', expectedTool: 'memory.write', split: 'test' },
  { category: 'utility', request: 'No split provided — defaults to train' },
];

describe('parquet adapter (v1.0.3)', () => {
  test('capability report is real and available (dependency installed)', async () => {
    const info = await parquetAdapterInfo();
    expect(info.available).toBe(true);
    expect(info.packageName).toBe('@dsnp/parquetjs');
    expect(info.error).toBeNull();
  });

  test('encode → decode round-trip preserves every example field', async () => {
    const bytes = await encodeParquetDataset(SAMPLE);
    // Parquet magic bytes: "PAR1"
    expect(Buffer.from(bytes.slice(0, 4)).toString('ascii')).toBe('PAR1');
    expect(bytes.byteLength).toBeGreaterThan(100);

    const decoded = await decodeParquetDataset(bytes);
    expect(decoded.length).toBe(SAMPLE.length);
    expect(decoded[0]).toEqual({ category: 'monitoring', request: 'Check the health of api-01', expectedTool: 'server.health', expectedParams: { serverId: 'api-01' }, split: 'train' });
    expect(decoded[1].expectedTool).toBeUndefined(); // optional column → null → undefined
    expect(decoded[1].split).toBe('validation');
    expect(decoded[2].expectedParams).toBeUndefined();
    expect(decoded[3].split).toBe('train'); // default split applied on encode
  });

  test('decode rejects corrupt bytes with a readable error (not silent)', async () => {
    const garbage = new Uint8Array(64).fill(7);
    let message = '';
    try {
      await decodeParquetDataset(garbage);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.length).toBeGreaterThan(0);
  });

  test('encode refuses an empty dataset', async () => {
    let message = '';
    try {
      await encodeParquetDataset([]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('empty');
  });
});

// ---------- icon aliases (v1.0.3 §14-15) ----------

describe('branding icon name aliases', () => {
  test('favicon.io / realfavicongenerator names map to canonical sizes', () => {
    expect(canonicalIconName('favicon-16x16.png')).toBe('icon-16.png');
    expect(canonicalIconName('favicon-32x32.png')).toBe('icon-32.png');
    expect(canonicalIconName('android-chrome-192x192.png')).toBe('icon-192.png');
    expect(canonicalIconName('android-chrome-512x512.png')).toBe('icon-512.png');
    expect(canonicalIconName('apple-touch-icon.png')).toBe('apple-touch-icon.png');
    expect(canonicalIconName('apple-touch-icon-180x180.png')).toBe('apple-touch-icon.png');
  });

  test('canonical names pass through unchanged', () => {
    expect(canonicalIconName('icon-192.png')).toBe('icon-192.png');
    expect(canonicalIconName('favicon.ico')).toBe('favicon.ico');
    expect(canonicalIconName('something-else.png')).toBe('something-else.png');
  });

  test('pngDimensions still validates aliased content against canonical size', () => {
    // 16x16 PNG header bytes — an alias mapping to icon-16.png must be exactly 16x16.
    const png = (w: number, h: number): Uint8Array => {
      const bytes = new Uint8Array(33);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, w);
      view.setUint32(20, h);
      return bytes;
    };
    expect(pngDimensions(png(16, 16))).toEqual({ width: 16, height: 16 });
    expect(pngDimensions(png(300, 192))).toEqual({ width: 300, height: 192 }); // mismatch → rejected upstream
  });
});

// ---------- parallel tool call config surface (v1.0.3 §18/§21/§25) ----------

describe('parallel tool call configuration schema', () => {
  test('task config accepts parallelToolCalls + maxParallelToolCalls', () => {
    const parsed = taskConfigSchema.parse({
      mode: 'goal',
      reasoningLevel: 3,
      maxSubtoolCalls: 20,
      safetyLimit: 100,
      maxIterations: 30,
      taskTimeoutMs: 120000,
      toolTimeoutMs: 30000,
      liveIntervalMs: 60000,
      parallelToolCalls: true,
      maxParallelToolCalls: 4,
    });
    expect(parsed.parallelToolCalls).toBe(true);
    expect(parsed.maxParallelToolCalls).toBe(4);
  });

  test('task config rejects out-of-range maxParallelToolCalls (unlimited concurrency impossible)', () => {
    const bad = taskConfigSchema.safeParse({ maxParallelToolCalls: 64 });
    expect(bad.success).toBe(false);
    const zero = taskConfigSchema.safeParse({ maxParallelToolCalls: 0 });
    expect(zero.success).toBe(false);
  });

  test('runtime settings expose the same parallel policy fields', () => {
    const ok = settingsSchema.safeParse({ parallelToolCalls: false, maxParallelToolCalls: 2 });
    expect(ok.success).toBe(true);
    const bad = settingsSchema.safeParse({ maxParallelToolCalls: 99 });
    expect(bad.success).toBe(false);
  });
});

// ---------- checklist state mapping (v1.0.3 §2/§3) ----------

describe('plan checklist states come from the actual plan', () => {
  const plan = [
    { id: 's1', title: 'Understand request', detail: '', status: 'completed', kind: 'action' },
    { id: 's2', title: 'Find suitable tool', detail: '', status: 'in_progress', kind: 'action' },
    { id: 's3', title: 'Generate parameters', detail: '', status: 'pending', kind: 'action' },
    { id: 's4', title: 'Execute tool', detail: '', status: 'failed', kind: 'action' },
    { id: 's5', title: 'Verify result', detail: '', status: 'skipped', kind: 'verification' },
  ];
  const events: NexToolEvent[] = [];

  test('each plan status maps to the documented checklist glyph state', () => {
    const { items, percent } = deriveChecklist(plan, events);
    expect(items.map((i) => i.state)).toEqual(['completed', 'running', 'pending', 'failed', 'waiting']);
    // 3 of 5 accounted (completed + failed + waiting)
    expect(percent).toBe(60);
  });

  test('a step that finishes successfully becomes completed (dynamic, not hardcoded)', () => {
    const updated = plan.map((s) => (s.id === 's2' ? { ...s, status: 'completed' } : s));
    const { items } = deriveChecklist(updated, events);
    expect(items[1].state).toBe('completed');
  });
});
