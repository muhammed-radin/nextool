/**
 * NexTool v1.0.4 — unit tests (bun test).
 * Covers the pure core of the v1.0.4 features without touching the database:
 *   - tool export JSON preserves the EXACT function source as text (§11/§12/§17)
 *   - tool import validation rejects malformed files (§14) and accepts valid ones (§15)
 *   - conflict copy-name proposal (§16)
 *   - task config schema rejects an empty enabledTools list (§23/§24)
 *   - JSON theme uses the --w-rjv-* variables the installed library reads (§2)
 * Run: bun test tests/
 */
import { describe, expect, test } from 'bun:test';

import {
  exportToolJson, exportToolsJson, parseToolImport, proposeCopyName, validateImportedTool, validateSchemaJson,
  type PortableTool,
} from '../src/lib/nexool/tool-portable';
import { taskConfigSchema } from '../src/lib/nexool/schemas';
import { NextoolDarkTheme } from '../src/components/console/json-theme';
import type { ToolEntry } from '../src/lib/nexool/api-contract';

// ---------- fixtures ----------

const SOURCE = `async function execute(params, context) {
  context.log('wordcount', params);
  const words = String(params.input ?? '').trim().split(/\\s+/).filter(Boolean);
  return { success: true, result: { words: words.length } };
}`;

const ENTRY: ToolEntry = {
  name: 'utility.wordcount',
  description: 'Counts words in a string',
  purpose: 'Demo portability',
  category: 'utility',
  environment: 'js-function',
  schema: {
    type: 'object',
    properties: [
      { name: 'input', type: 'string', required: true, description: 'Text to count' },
    ],
  },
  functionSource: SOURCE,
  toolVersion: '1.2.3',
  enabled: true,
  stats: { callCount: 4, successCount: 4, failureCount: 0, timeoutCount: 0, avgMs: 3, enabled: true },
};

// ---------- export (§11/§12/§17) ----------

describe('tool export JSON (v1.0.4 §11/§12)', () => {
  test('export preserves the exact function source as text', () => {
    const json = exportToolJson(ENTRY, '1.0.4');
    expect(json.functionSource).toBe(SOURCE);
    expect(json.name).toBe('utility.wordcount');
    expect(json.description).toBe('Counts words in a string');
    expect(json.environment).toBe('js-function');
    expect(json.toolVersion).toBe('1.2.3');
    expect(json.nexool?.kind).toBe('nextool.tool');
  });

  test('export keeps the input schema usable (not a placeholder)', () => {
    const json = exportToolJson(ENTRY);
    expect(json.schema.type).toBe('object');
    expect(json.schema.properties?.[0]?.name).toBe('input');
    expect(json.schema.properties?.[0]?.type).toBe('string');
  });

  test('export-all returns one portable object per EXPORTABLE tool (v1.0.12 §2.2: built-ins excluded)', () => {
    const list = exportToolsJson([ENTRY, { ...ENTRY, name: 'math.evaluate', functionSource: undefined, environment: 'builtin' }]);
    // v1.0.12 §2.2 — only custom-created tools may be exported; the builtin
    // entry is filtered out instead of exported.
    expect(list.length).toBe(1);
    expect(list[0].name).toBe(ENTRY.name);
    expect(list[0].functionSource).toBe(SOURCE);
  });

  test('export → JSON.stringify → parse round-trip is lossless for the source', () => {
    const json = JSON.parse(JSON.stringify(exportToolJson(ENTRY))) as PortableTool;
    expect(json.functionSource).toBe(SOURCE);
    const validated = validateImportedTool(json);
    expect(validated.ok).toBe(true);
    expect(validated.tool?.functionSource).toBe(SOURCE);
  });
});

// ---------- import validation (§14/§15) ----------

describe('tool import validation (v1.0.4 §14)', () => {
  test('a valid tool file validates with the full definition intact', () => {
    const result = validateImportedTool(exportToolJson(ENTRY));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tool?.name).toBe('utility.wordcount');
    expect(result.tool?.functionSource).toBe(SOURCE);
    expect(result.tool?.schema.properties?.length).toBe(1);
  });

  test('rejects arrays / bundles / non-objects', () => {
    expect(validateImportedTool([ENTRY]).ok).toBe(false);
    expect(validateImportedTool(null).ok).toBe(false);
    expect(validateImportedTool('tool').ok).toBe(false);
  });

  test('rejects missing name / bad name format', () => {
    const noName = validateImportedTool({ description: 'x', schema: { type: 'object', properties: [] }, functionSource: SOURCE });
    expect(noName.ok).toBe(false);
    expect(noName.errors.join(' ')).toContain('"name" is required');

    const badName = validateImportedTool({ name: 'Not A Name', description: 'x', schema: { type: 'object', properties: [] }, functionSource: SOURCE });
    expect(badName.ok).toBe(false);
    expect(badName.errors.join(' ')).toContain('namespace.action');
  });

  test('rejects js-function tools without function code', () => {
    const result = validateImportedTool({ name: 'a.b', description: 'x', schema: { type: 'object', properties: [] } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('"functionSource" is required');
  });

  test('rejects missing/invalid schema and bad param types', () => {
    const noSchema = validateImportedTool({ name: 'a.b', description: 'x', functionSource: SOURCE });
    expect(noSchema.ok).toBe(false);
    expect(noSchema.errors.join(' ')).toContain('"schema" is required');

    expect(typeof validateSchemaJson({ type: 'list', properties: [] })).toBe('string');
    expect(typeof validateSchemaJson({ type: 'object', properties: [{ name: 'x', type: 'float' }] })).toBe('string');
    expect(typeof validateSchemaJson({ type: 'object', properties: [{ type: 'string' }] })).toBe('string');
  });

  test('rejects builtin/virtual environments (read-only registry tools)', () => {
    const result = validateImportedTool({ name: 'a.b', description: 'x', environment: 'builtin', schema: { type: 'object', properties: [] }, functionSource: SOURCE });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('cannot be imported');
  });

  test('accepts a bare-array schema (register-dialog format)', () => {
    const result = validateImportedTool({
      name: 'a.b', description: 'x', functionSource: SOURCE,
      schema: [{ name: 'q', type: 'string', required: true }],
    });
    expect(result.ok).toBe(true);
    expect(result.tool?.schema.properties?.[0]?.name).toBe('q');
  });

  test('dynamic handler imports require a known handlerKind', () => {
    const bad = validateImportedTool({ name: 'a.b', description: 'x', environment: 'dynamic', schema: { type: 'object', properties: [] } });
    expect(bad.ok).toBe(false);
    const good = validateImportedTool({ name: 'a.b', description: 'x', environment: 'dynamic', schema: { type: 'object', properties: [] }, handlerKind: 'echo', handlerConfig: {} });
    expect(good.ok).toBe(true);
    expect(good.tool?.handlerKind).toBe('echo');
  });
});

describe('tool import parsing + conflicts (v1.0.4 §15/§16)', () => {
  test('parseToolImport rejects invalid JSON with a readable error', () => {
    const parsed = parseToolImport('{ not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Invalid JSON');
  });

  test('parseToolImport rejects multi-tool bundles with guidance', () => {
    const arr = parseToolImport('[{"name":"a.b"}]');
    expect(arr.ok).toBe(false);
    const bundle = parseToolImport('{"tools":[{"name":"a.b"}]}');
    expect(bundle.ok).toBe(false);
  });

  test('proposeCopyName yields base.copy then base.copy-N', () => {
    expect(proposeCopyName(new Set(['other.x']), 'utility.wordcount')).toBe('utility.copy');
    expect(proposeCopyName(new Set(['utility.copy']), 'utility.wordcount')).toBe('utility.copy-2');
    expect(proposeCopyName(new Set(['utility.copy', 'utility.copy-2', 'utility.copy-3']), 'utility.wordcount')).toBe('utility.copy-4');
  });
});

// ---------- task tool requirement (§23/§24) ----------

describe('task config schema — tool requirement (v1.0.4 §23/§24)', () => {
  test('a non-empty enabledTools list is accepted', () => {
    const parsed = taskConfigSchema.safeParse({ mode: 'goal', enabledTools: ['echo.echo', 'server.health'] });
    expect(parsed.success).toBe(true);
  });

  test('an explicit EMPTY enabledTools list is rejected', () => {
    const parsed = taskConfigSchema.safeParse({ mode: 'goal', enabledTools: [] });
    expect(parsed.success).toBe(false);
  });

  test('a non-array enabledTools value is rejected', () => {
    const parsed = taskConfigSchema.safeParse({ mode: 'goal', enabledTools: 'echo.echo' });
    expect(parsed.success).toBe(false);
  });
});

// ---------- JSON theme variables (§2) ----------

describe('json tree theme (v1.0.4 §2)', () => {
  test('every token uses the --w-rjv-* namespace the library actually reads', () => {
    const keys = Object.keys(NextoolDarkTheme);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(key.startsWith('--w-rjv-')).toBe(true);
    }
  });

  test('core syntax tokens exist with bright values (contrast on dark bg)', () => {
    const theme = NextoolDarkTheme as Record<string, string>;
    for (const token of [
      '--w-rjv-color',
      '--w-rjv-key-string',
      '--w-rjv-type-string-color',
      '--w-rjv-type-int-color',
      '--w-rjv-type-boolean-color',
      '--w-rjv-type-null-color',
      '--w-rjv-curlybraces-color',
      '--w-rjv-brackets-color',
      '--w-rjv-colon-color',
      '--w-rjv-arrow-color',
    ]) {
      expect(typeof theme[token]).toBe('string');
      // Lightness guard: oklch L channel must be ≥ 0.7 (bright on dark navy).
      const match = /oklch\((0?\.\d+|1(\.0+)?)\s/.exec(theme[token]);
      expect(match).not.toBeNull();
      if (match) expect(Number(match[1])).toBeGreaterThanOrEqual(0.7);
    }
    // Background stays transparent so the glass-inset well shows through.
    expect(theme['--w-rjv-background-color']).toBe('transparent');
  });
});
