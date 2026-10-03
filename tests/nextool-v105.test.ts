/**
 * NexTool v1.0.5 — unit tests (bun test).
 * Covers the pure core of the v1.0.5 features without touching the database:
 *   §1  editor source-sync invariants (test never clears code)
 *   §2  structured metadata round trip (export/import) + schema validation
 *   §3  restricted Node.js environment (allowlist, require/import, blocked
 *       modules, timeouts, output limits) + dynamic-import transform
 *   §5  portable nodejs tools (§3.10 export/import compatibility)
 *   §6  documentation link resolver (slug normalization, externals, headings)
 * Run: bun test tests/
 */
import { describe, expect, test } from 'bun:test';
import vm from 'node:vm';

import {
  coerceEditorChange, readMonacoValue,
} from '../src/lib/nexool/editor-source';
import {
  docLinkAnchor, headingSlug, isExternalHref, isInternalDocLink, isInPageAnchor,
  normalizeDocHref, resolveDocSlug,
} from '../src/lib/nexool/docs-link-resolver';
import {
  exportToolJson, parseToolImport, validateImportedTool,
  type PortableTool,
} from '../src/lib/nexool/tool-portable';
import {
  NODE_EXECUTION_LIMITS, NODE_MODULE_ALLOWLIST, runNodeTool, transformDynamicImports, validateNodeFunctionSource,
} from '../src/lib/nexool/tools/node-runner';
import { registerJsToolSchema, testToolSchema, updateToolSchema } from '../src/lib/nexool/schemas';
import type { ToolEntry } from '../src/lib/nexool/api-contract';

const TEST_CTX = { executionId: 'test', mode: 'test' as const, now: new Date().toISOString(), log: () => {} };

// ==================== §1 — editor source-sync invariants ====================

describe('editor source sync (v1.0.5 §1)', () => {
  test('coerceEditorChange never lets a non-string onChange clear the source', () => {
    expect(coerceEditorChange(undefined, 'code A')).toBe('code A');
    expect(coerceEditorChange(null, 'code A')).toBe('code A');
    expect(coerceEditorChange(42, 'code A')).toBe('code A');
    expect(coerceEditorChange('next', 'code A')).toBe('next');
  });

  test('a genuine user clearing (empty string) is honored', () => {
    expect(coerceEditorChange('', 'code A')).toBe('');
  });

  test('readMonacoValue returns the model value while the editor is alive', () => {
    expect(readMonacoValue(() => 'visible code', 'fallback')).toBe('visible code');
  });

  test('readMonacoValue falls back to state when the model is disposed (throws)', () => {
    const disposed = () => { throw new Error('Model is disposed'); };
    expect(readMonacoValue(disposed, 'state code')).toBe('state code');
  });

  test('readMonacoValue falls back on non-string values', () => {
    expect(readMonacoValue(() => undefined, 'state code')).toBe('state code');
    expect(readMonacoValue(() => null, 'state code')).toBe('state code');
  });

  test('unsaved code survives a test round-trip (§1.3/§1.4 semantics)', () => {
    // The editor flow: read → test → no write-back. Simulated here:
    const source = 'return "B";'; // user edited (saved was "A")
    const modelRead = () => source; // what Monaco shows
    const codeForTest = readMonacoValue(modelRead, source);
    expect(codeForTest).toBe('return "B";'); // test executes the EDITED code
    // after the test completes, nothing mutates the editor source:
    expect(coerceEditorChange(undefined, source)).toBe('return "B";');
  });
});

// ==================== §2 — structured metadata round trip ====================

const META_ENTRY: ToolEntry = {
  name: 'utility.wordcount',
  description: 'Counts words in a string',
  category: 'utility',
  environment: 'js-function',
  schema: { type: 'object', properties: [] },
  functionSource: 'async function execute(params) { return params; }',
  toolVersion: '1.2.3',
  metadata: { owner: 'platform', environment: 'production' },
  enabled: true,
  stats: { callCount: 0, successCount: 0, failureCount: 0, timeoutCount: 0, avgMs: 0, enabled: true },
};

describe('metadata round trip (v1.0.5 §2.8)', () => {
  test('export preserves the structured metadata key/value pairs', () => {
    const json = exportToolJson(META_ENTRY);
    expect(json.metadata).toEqual({ owner: 'platform', environment: 'production' });
  });

  test('export → stringify → parse → validate keeps metadata intact', () => {
    const parsed = JSON.parse(JSON.stringify(exportToolJson(META_ENTRY))) as PortableTool;
    const result = validateImportedTool(parsed);
    expect(result.ok).toBe(true);
    expect(result.tool?.metadata).toEqual({ owner: 'platform', environment: 'production' });
    expect(result.tool?.functionSource).toBe(META_ENTRY.functionSource);
  });

  test('import rejects non-string metadata values (structured editor contract)', () => {
    const result = validateImportedTool({ ...META_ENTRY, metadata: { owner: 42 } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('metadata');
  });

  test('import rejects metadata that is not an object', () => {
    const result = validateImportedTool({ ...META_ENTRY, metadata: 'nope' });
    expect(result.ok).toBe(false);
  });

  test('tools without metadata export/import cleanly (optional field)', () => {
    const bare = { ...META_ENTRY, metadata: undefined };
    const parsed = JSON.parse(JSON.stringify(exportToolJson(bare))) as PortableTool;
    expect('metadata' in parsed).toBe(false);
    const result = validateImportedTool(parsed);
    expect(result.ok).toBe(true);
  });
});

// ==================== §3 — restricted Node.js environment ====================

describe('nodejs sandbox — module allowlist (v1.0.5 §3.2-3.5)', () => {
  test('allowed require() works', async () => {
    const run = await runNodeTool(
      `async function execute() { const crypto = require('crypto'); return { uuid: crypto.randomUUID() }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(true);
    expect(String((run.result as { uuid: string }).uuid)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('node:-prefixed specifiers resolve through the same allowlist', async () => {
    const run = await runNodeTool(
      `async function execute() { const { join } = require('node:path'); return { p: join('a', 'b') }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(true);
    expect((run.result as { p: string }).p).toBe('a/b');
  });

  test('allowed dynamic import() works (§3.5)', async () => {
    const run = await runNodeTool(
      `async function execute() { const mod = await import('crypto'); return { hasHash: typeof mod.createHash }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(true);
    expect((run.result as { hasHash: string }).hasHash).toBe('function');
  });

  test('blocked module require() fails with the §3.4 wording', async () => {
    const run = await runNodeTool(
      `async function execute() { const c = require('cluster'); return c; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain('Module "cluster" is not available in the NexTool Node.js environment');
  });

  test('v1.0.6 — fs (Virtual FS) without an attached workspace fails with a pointed error', async () => {
    const run = await runNodeTool(
      `async function execute() { return typeof require('fs'); }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain('no virtual workspace is attached');
  });

  test('blocked dynamic import() passes through the SAME allowlist', async () => {
    const run = await runNodeTool(
      `async function execute() { return await import('cluster'); }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain('cluster');
  });

  test('unknown module fails with the allowlist enumerated', async () => {
    const run = await runNodeTool(
      `async function execute() { return require('some-module'); }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.message).toContain('some-module');
    expect(run.error?.message).toContain('crypto');
  });

  test('process is NOT available as a global (§3.3)', async () => {
    const run = await runNodeTool(
      `async function execute() { return typeof process; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe('undefined');
  });

  test('host-dangerous modules stay blocked in the runtime config (v1.0.6 revision)', () => {
    // v1.0.6: fs/os/http/https/child_process joined the allowlist as VIRTUAL,
    // context-provided modules; raw host capability modules stay blocked.
    for (const mod of ['cluster', 'vm', 'worker_threads', 'net', 'dgram', 'dns', 'process']) {
      expect(NODE_EXECUTION_LIMITS.moduleAllowlist).not.toContain(mod);
    }
    for (const mod of ['fs', 'os', 'http', 'https', 'child_process']) {
      expect(NODE_EXECUTION_LIMITS.moduleAllowlist).toContain(mod);
    }
    expect(Object.keys(NODE_MODULE_ALLOWLIST)).toContain('crypto');
  });
});

describe('nodejs sandbox — execution limits (v1.0.5 §3.8)', () => {
  test('sync infinite loop (no await) is stopped by the vm sync timeout', async () => {
    const run = await runNodeTool(
      `async function execute() { let x = 0; for (;;) { x = x + 1; } return x; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('TIMEOUT');
  }, 20_000);

  test('oversized results are rejected (64 KiB cap)', async () => {
    const run = await runNodeTool(
      `async function execute() { return { blob: 'x'.repeat(200 * 1024) }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('NOT_SERIALIZABLE');
  });

  test('non-serializable results are rejected', async () => {
    const run = await runNodeTool(
      `async function execute() { return { fn: () => 1 }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(false);
    expect(run.error?.code).toBe('NOT_SERIALIZABLE');
  });

  test('source validation rejects empty/oversized sources', () => {
    expect(validateNodeFunctionSource('   ').ok).toBe(false);
    expect(validateNodeFunctionSource('x'.repeat(65_000)).ok).toBe(false);
    expect(validateNodeFunctionSource('async function execute(){ return 1; }').ok).toBe(true);
  });
});

describe('dynamic import transform (v1.0.5 §3.5 implementation detail)', () => {
  test('rewrites import call sites to the allowlist shim', () => {
    expect(transformDynamicImports('await import("crypto")')).toBe('await __nexoolDynamicImport("crypto")');
    expect(transformDynamicImports('import ( "x" )')).toBe('__nexoolDynamicImport ( "x" )');
  });

  test('does not touch property access or identifiers containing import', () => {
    expect(transformDynamicImports('foo.import("x")')).toBe('foo.import("x")');
    expect(transformDynamicImports('myimport("x")')).toBe('myimport("x")');
    expect(transformDynamicImports('import.meta.url')).toBe('import.meta.url');
  });

  test('string literals containing import() are preserved', () => {
    expect(transformDynamicImports('const s = "import(x)";')).toBe('const s = "import(x)";');
    expect(transformDynamicImports("const s = 'await import(x)';")).toBe("const s = 'await import(x)';");
  });

  test('comments containing import() are preserved', () => {
    expect(transformDynamicImports('// import("x")\nconst a = 1;')).toBe('// import("x")\nconst a = 1;');
    expect(transformDynamicImports('/* import("y") */ const b = 2;')).toBe('/* import("y") */ const b = 2;');
  });

  test('regex literals containing import( are preserved (division vs regex)', () => {
    expect(transformDynamicImports('const re = /import\\(/;')).toBe('const re = /import\\(/;');
    expect(transformDynamicImports('const half = 10 / 2 / 5;')).toBe('const half = 10 / 2 / 5;');
  });

  test('template literals keep their inner text; interpolated code is transformed', () => {
    expect(transformDynamicImports('const t = `import(x)`;')).toBe('const t = `import(x)`;');
    expect(transformDynamicImports('const t = `${ await import("crypto") }`;'))
      .toBe('const t = `${ await __nexoolDynamicImport("crypto") }`;');
  });

  test('escaped characters survive string scanning', () => {
    expect(transformDynamicImports('const s = "a\\"import(";')).toBe('const s = "a\\"import(";');
  });
});

// ==================== §3.10 — nodejs portability ====================

const NODEJS_ENTRY: ToolEntry = {
  name: 'ops.hashid',
  description: 'Generates a hash id',
  category: 'utility',
  environment: 'nodejs',
  schema: { type: 'object', properties: [{ name: 'input', type: 'string', required: true, description: 'text' }] },
  functionSource: `async function execute(params) { const crypto = require('crypto'); return crypto.createHash('sha256').update(params.input).digest('hex'); }`,
  metadata: { owner: 'platform' },
  enabled: true,
  stats: { callCount: 0, successCount: 0, failureCount: 0, timeoutCount: 0, avgMs: 0, enabled: true },
};

describe('nodejs tool portability (v1.0.5 §3.10)', () => {
  test('nodejs export keeps environment + exact function source + metadata', () => {
    const json = exportToolJson(NODEJS_ENTRY);
    expect(json.environment).toBe('nodejs');
    expect(json.functionSource).toBe(NODEJS_ENTRY.functionSource);
    expect(json.metadata).toEqual({ owner: 'platform' });
  });

  test('a nodejs tool file validates and round-trips losslessly', () => {
    const parsed = JSON.parse(JSON.stringify(exportToolJson(NODEJS_ENTRY))) as PortableTool;
    const result = validateImportedTool(parsed);
    expect(result.ok).toBe(true);
    expect(result.tool?.environment).toBe('nodejs');
    expect(result.tool?.functionSource).toBe(NODEJS_ENTRY.functionSource);
  });

  test('nodejs import requires functionSource', () => {
    const result = validateImportedTool({ name: 'a.b', description: 'x', environment: 'nodejs', schema: { type: 'object', properties: [] } });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('"functionSource" is required for nodejs tools');
  });

  test('nodejs import still rejects unknown environments (builtin/virtual-env)', () => {
    for (const env of ['builtin', 'virtual-env', 'puppet']) {
      const result = validateImportedTool({ name: 'a.b', description: 'x', environment: env, schema: { type: 'object', properties: [] }, functionSource: 'async function execute(){}' });
      expect(result.ok).toBe(false);
    }
  });
});

// ==================== §2 — request schemas accept the new fields ====================

describe('schemas — v1.0.5 environment + metadata', () => {
  test('registerJsToolSchema accepts environment nodejs + metadata', () => {
    const parsed = registerJsToolSchema.safeParse({
      name: 'ops.hashid', schema: { type: 'object', properties: [] },
      functionSource: 'async function execute(){}', environment: 'nodejs',
      metadata: { owner: 'platform' },
    });
    expect(parsed.success).toBe(true);
  });

  test('registerJsToolSchema rejects unknown environments and non-string metadata', () => {
    const badEnv = registerJsToolSchema.safeParse({
      name: 'a.b', schema: { type: 'object', properties: [] },
      functionSource: 'x', environment: 'puppet',
    });
    expect(badEnv.success).toBe(false);
    const badMeta = registerJsToolSchema.safeParse({
      name: 'a.b', schema: { type: 'object', properties: [] },
      functionSource: 'x', metadata: { owner: 1 },
    });
    expect(badMeta.success).toBe(false);
  });

  test('updateToolSchema accepts the environment switch + dynamic handler fields', () => {
    const envSwitch = updateToolSchema.safeParse({ environment: 'nodejs' });
    expect(envSwitch.success).toBe(true);
    const handler = updateToolSchema.safeParse({ handlerKind: 'http_get', handlerConfig: { url: 'https://x', timeout: 4000 } });
    expect(handler.success).toBe(true);
    const badKind = updateToolSchema.safeParse({ handlerKind: 'fork_bomb' });
    expect(badKind.success).toBe(false);
  });

  test('testToolSchema accepts the environment hint', () => {
    expect(testToolSchema.safeParse({ functionSource: 'x', environment: 'nodejs' }).success).toBe(true);
    expect(testToolSchema.safeParse({ functionSource: 'x', environment: 'builtin' }).success).toBe(false);
    expect(testToolSchema.safeParse({ name: 'echo.echo', params: {} }).success).toBe(true);
  });
});

// ==================== §6 — documentation link resolver ====================

const SLUGS = ['README', 'api', 'core-module', 'tool-development', 'tools', 'tool-runtime'];

describe('docs link resolver (v1.0.5 §6)', () => {
  test('classifies external / anchor / internal links', () => {
    expect(isExternalHref('https://example.com/x')).toBe(true);
    expect(isExternalHref('http://localhost:3000/api')).toBe(true);
    expect(isExternalHref('mailto:a@b.c')).toBe(true);
    expect(isExternalHref('core-module.md')).toBe(false);
    expect(isInPageAnchor('#section')).toBe(true);
    expect(isInPageAnchor('core-module.md#overview')).toBe(false);
    expect(isInternalDocLink('../ai-core/core-module.md')).toBe(true);
    expect(isInternalDocLink('/api/tools')).toBe(false);
  });

  test('§6.3 normalization: ./x.md, ../dir/x.md, x.md and bare slugs', () => {
    expect(normalizeDocHref('core-module.md')).toBe('core-module');
    expect(normalizeDocHref('./core-module.md')).toBe('core-module');
    expect(normalizeDocHref('../ai-core/core-module.md')).toBe('core-module');
    expect(normalizeDocHref('../realtime/realtime.md')).toBe('realtime');
    expect(normalizeDocHref('core-module')).toBe('core-module');
  });

  test('resolution validates against the ACTUAL documentation index', () => {
    expect(resolveDocSlug('../ai-core/core-module.md', SLUGS)).toBe('core-module');
    expect(resolveDocSlug('./tools.md', SLUGS)).toBe('tools');
    expect(resolveDocHrefFixture('tool-development.md')).toBe('tool-development');
  });

  function resolveDocHrefFixture(href: string): string | null {
    return resolveDocSlug(href, SLUGS);
  }

  test('a genuinely missing page resolves to null (in-viewer error state, §6.5)', () => {
    expect(resolveDocSlug('not-a-real-page.md', SLUGS)).toBeNull();
    expect(resolveDocSlug('https://example.com', SLUGS)).toBeNull();
  });

  test('anchors are extracted without breaking slug resolution', () => {
    expect(docLinkAnchor('tools.md#tool-export--import-as-json-v104')).toBe('tool-export--import-as-json-v104');
    expect(docLinkAnchor('tools.md')).toBe('');
    expect(resolveDocSlug('tools.md#anchor', SLUGS)).toBe('tools');
  });

  test('headingSlug is GitHub-style and stable for anchor matching', () => {
    expect(headingSlug('Tool Export / Import as JSON (v1.0.4)')).toBe('tool-export--import-as-json-v104');
    expect(headingSlug('  What is `CoreModule`?  ')).toBe('what-is-coremodule');
    expect(headingSlug('A -- B')).toBe('a----b'); // GitHub parity: hyphens kept, each space → one dash
  });

  test('resolves case-insensitively as a fallback (README.md)', () => {
    expect(resolveDocSlug('readme.md', SLUGS)).toBe('README');
  });
});

// ==================== vm integration: the transform output executes ====================

describe('transformed nodejs source executes inside the sandbox', () => {
  test('await import(...) reaches the allowlist shim end-to-end', async () => {
    const run = await runNodeTool(
      `async function execute() { const m = await import('crypto'); const h = m.createHash('sha256').update('x').digest('hex'); return { len: h.length }; }`,
      {}, TEST_CTX,
    );
    expect(run.ok).toBe(true);
    expect((run.result as { len: number }).len).toBe(64);
  });

  test('the transformed source compiles standalone (no vm-module flag dependency)', () => {
    const transformed = transformDynamicImports('const m = await import("crypto");');
    const script = new vm.Script(transformed, { filename: 'probe.js' });
    expect(script).toBeDefined();
    expect(transformed).not.toContain('await import(');
  });
});
