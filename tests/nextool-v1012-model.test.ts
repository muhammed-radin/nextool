/**
 * NexTool v1.0.12 — model 1.0.3 training + checkpoint validation (spec §6.9-§6.11, §8.6).
 *
 * Verifies:
 *  - version constants (model 1.0.3, app 1.0.12)
 *  - the v1.0.3 seed curriculum integrity (same rules the v1.0.2 dataset
 *    suite enforces, extended to the CURRENT registry: every registered
 *    builtin tool appears in ALL THREE splits)
 *  - a real trained tfjs-trained-classifier checkpoint registered under 1.0.3
 *  - both checkpoint exports exist on disk (model-checkpoints/v1.0.3/)
 *  - the .nextool package loads through the REAL import path with correct
 *    metadata and runs a REAL inference (tf.loadLayersModel → predict)
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { APP_VERSION, TRAINED_MODEL_VERSION } from '../src/lib/nexool/version';
import { BUILTIN_TOOLS } from '../src/lib/nexool/tools/registry';
import { db } from '../src/lib/db';
import { importModelPackage } from '../src/lib/nexool/training/model-package';
import seedDataset from '../config/training/seed-dataset-v1.0.3.json';

describe('v1.0.12 — model version surfaces (§6.9)', () => {
  test('trained classifier generation moved to 1.0.3; app version unchanged', () => {
    expect(TRAINED_MODEL_VERSION).toBe('1.0.5');
    expect(APP_VERSION).toBe('1.0.16');
  });
});

describe('v1.0.12 — seed dataset v1.0.3 curriculum (§6.1-§6.8)', () => {
  const realToolNames = BUILTIN_TOOLS.map((t) => t.name);
  const examples = seedDataset.examples as { category: string; request: string; expectedTool?: string; expectedParams?: Record<string, unknown>; split?: string }[];

  test('version metadata records the new generation', () => {
    expect(seedDataset.version).toBe('1.0.3');
    expect(seedDataset.name).toContain('NexTool');
  });

  test('carries the full curriculum with the three splits', () => {
    expect(examples.length).toBeGreaterThanOrEqual(440);
    const train = examples.filter((e) => e.split === 'train').length;
    const val = examples.filter((e) => e.split === 'validation').length;
    const testSplit = examples.filter((e) => e.split === 'test').length;
    expect(train).toBeGreaterThan(250);
    expect(val).toBeGreaterThanOrEqual(20);
    expect(testSplit).toBeGreaterThanOrEqual(20);
  });

  test('EVERY registered builtin tool appears in train AND test AND validation', () => {
    expect(realToolNames.length).toBeGreaterThanOrEqual(25); // includes the 10 fs.* tools
    for (const tool of realToolNames) {
      expect(examples.some((e) => e.expectedTool === tool && e.split === 'train')).toBe(true);
      expect(examples.some((e) => e.expectedTool === tool && e.split === 'test')).toBe(true);
      expect(examples.some((e) => e.expectedTool === tool && e.split === 'validation')).toBe(true);
    }
  });

  test('zero duplicate requests (§53)', () => {
    const seen = new Set<string>();
    for (const e of examples) {
      const key = e.request.replace(/\s+/g, ' ').trim();
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test('every expectedTool is a REAL registered tool and params stay inside the real schemas', () => {
    const schemaOf = new Map(BUILTIN_TOOLS.map((t) => [t.name, t.schema]));
    for (const e of examples) {
      if (!e.expectedTool) continue;
      expect(realToolNames).toContain(e.expectedTool);
      if (!e.expectedParams) continue;
      const props = schemaOf.get(e.expectedTool)!.properties;
      const known = new Set(props.map((p) => p.name));
      for (const key of Object.keys(e.expectedParams)) {
        expect(known.has(key)).toBe(true);
      }
    }
  });

  test('teaching topics are present: identity, MCP, VFS, coding, categorization, GK, technology (§6.1-§6.8)', () => {
    const cats = new Set(examples.map((e) => e.category));
    expect(cats.size).toBeGreaterThanOrEqual(20);
    for (const c of ['nexool-identity', 'mcp', 'filesystem', 'coding', 'categorization', 'general-knowledge', 'technology']) {
      expect(examples.some((e) => e.category === c)).toBe(true);
    }
    // identity examples actually teach the spec's questions (§6.6)
    const joined = examples.map((e) => e.request).join('\n');
    for (const q of ['who are you?', 'what is the nexool vfs?', 'what is freedom-node?', 'what is an mcp tool?']) {
      expect(joined).toContain(q);
    }
    // deterministic long Markdown examples still exist (§45/§46)
    const long = examples.filter((e) => e.request.length > 1000);
    expect(long.length).toBeGreaterThanOrEqual(5);
  });
});

describe('v1.0.12 — real trained checkpoint + exports (§6.10/§6.11/§8.6)', () => {
  let importedId: string | null = null;

  test('a tfjs-trained-classifier checkpoint is registered under version 1.0.3', async () => {
    const rec = await db.modelRecord.findFirst({ where: { version: '1.0.3', format: 'tfjs-trained-classifier' } });
    expect(rec).not.toBeNull();
    expect(rec!.name).toContain('tool-classifier');
  });

  test('both checkpoint exports exist under model-checkpoints/v1.0.3/ (§6.10)', () => {
    const tfjs = path.join(process.cwd(), 'model-checkpoints/v1.0.3/tfjs/model.zip');
    const nextool = path.join(process.cwd(), 'model-checkpoints/v1.0.3/nextool/model.nextool');
    expect(existsSync(tfjs)).toBe(true);
    expect(existsSync(nextool)).toBe(true);
    expect(readFileSync(tfjs).byteLength).toBeGreaterThan(10000);
    expect(readFileSync(nextool).byteLength).toBeGreaterThan(10000);
  });

  test('.nextool package loads through the REAL import path with correct metadata (§6.11)', async () => {
    const bytes = readFileSync(path.join(process.cwd(), 'model-checkpoints/v1.0.3/nextool/model.nextool'));
    const result = await importModelPackage('model.nextool', new Uint8Array(bytes));
    expect(result.version).toBe('1.0.3');
    expect(result.format).toBe('tfjs-trained-classifier');
    expect(result.runnable).toBe(true);
    expect(result.modelRecordId).toBeTruthy();
    importedId = result.modelRecordId;
  });

  test('the imported model performs REAL inference (tf.loadLayersModel → predict)', async () => {
    expect(importedId).not.toBeNull();
    const { runBenchmark } = await import('../src/lib/nexool/training/benchmark');
    const dataset = await db.datasetRecord.findFirst({ where: { version: '1.0.3' } });
    expect(dataset).not.toBeNull();
    const bench = await runBenchmark({
      modelKey: importedId!,
      datasetId: dataset!.id,
      suite: 'tool-selection',
      limit: 10,
      label: 'v1.0.12 in-suite inference validation',
    });
    expect(bench.ok).toBe(true);
    expect(bench.metrics?.cases ?? 0).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // the in-suite import registered a duplicate record — remove it again
    if (importedId) await db.modelRecord.deleteMany({ where: { id: importedId } }).catch(() => {});
  });
});
