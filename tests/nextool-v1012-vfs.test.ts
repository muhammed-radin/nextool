/**
 * NexTool Q1 v1.0.12 — PHASE 3 GLOBAL SHARED VFS + PHASE 4 fs.* TOOLS.
 *
 * Covers the acceptance matrix for the v1.0.12 filesystem architecture change:
 *  - §3.1/§3.3  shared semantics: two DISTINCT tool contexts (js-function and
 *               nodejs, plus two registry-registered tools) see ONE VFS —
 *               A writes /notes/test.txt "hello" → B reads "hello"
 *  - §3.4       cross-task persistence (write in one task, read in a later one)
 *  - §3.5/§3.6  real restart persistence: the VFS lives on DISK under
 *               <repo>/data/vfs/ and a fresh service object resumes it
 *  - §3.7       path security: ../secret, ../../etc/passwd, absolute host
 *               paths, nested traversal, encoded traversal all REJECTED
 *  - §3.8       symlink escape: a symlink planted inside the VFS root never
 *               becomes an escape route
 *  - §3.9       limits: still resolved live from config/configuration-limits.json
 *  - §3.10/§3.11 freedom-node regression: keeps COMPLETE host freedom (writes
 *               outside the VFS root), shared VFS untouched by it
 *  - §4         fs.* tools: registered BUILT-INs (non-exportable) callable
 *               end-to-end: list/read/write/getpath/hasfile/hasfolder/
 *               infofile/createfolder/deletefile/deletefolder
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  getVfsLimits,
  getVfsRoot,
  hostAccessError,
  normalizeVirtualPath,
  openGlobalVfs,
  openVirtualFs,
  resetVfsServiceForTests,
  VirtualFsError,
} from '../src/lib/nexool/tools/vfs';
import { runJsTool } from '../src/lib/nexool/tools/js-runner';
import { runNodeTool } from '../src/lib/nexool/tools/node-runner';
import { runFreedomNodeTool } from '../src/lib/nexool/tools/freedom-node-runner';
import { BUILTIN_TOOLS, resolveHandler } from '../src/lib/nexool/tools/registry';
import type { ToolDefinition } from '../src/lib/nexool/types';
import { isToolExportable, toolExportClass } from '../src/lib/nexool/tool-portable';
import type { HandlerContext } from '../src/lib/nexool/tools/handler';

const ROOT = getVfsRoot();

function runCtx(executionId: string, taskId?: string) {
  return { executionId, taskId, mode: 'test' as const, now: new Date().toISOString(), log: () => {} };
}

const handlerCtx: HandlerContext = { executionId: 'v1012-fs-tools' };

beforeAll(() => {
  // Start the suite from a known-empty shared VFS (the scaffold is recreated
  // by the service on first use).
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  resetVfsServiceForTests();
});

afterAll(() => {
  // Remove this suite's own tree so other suites start clean too.
  for (const p of ['notes', 'docs', 'workspace/data.json', 'workspace/b64.bin', 'workspace/fs-tool-big.bin']) {
    try {
      fs.rmSync(path.join(ROOT, p), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ---------- §3.1/§3.3 — ONE shared VFS across tools ----------

describe('v1.0.12 §3 — the GLOBAL SHARED VFS', () => {
  test('§3.3 tool A (nodejs) writes /notes/test.txt "hello" → tool B reads "hello" — distinct tool contexts, one VFS', async () => {
    const writeRun = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        "  fs.mkdirSync('/notes', { recursive: true });",
        "  fs.writeFileSync('/notes/test.txt', 'hello');",
        "  return fs.readFileSync('/notes/test.txt', 'utf8');",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-shared-a', 'task-shared'),
      { toolId: 'v1012-tool-a', vfs: openGlobalVfs() },
    );
    expect(writeRun.ok).toBe(true);
    expect(writeRun.result).toBe('hello');

    // A DIFFERENT tool id in a LATER execution reads the same file.
    const readRun = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        "  return fs.readFileSync('/notes/test.txt', 'utf8');",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-shared-b', 'task-shared'),
      { toolId: 'v1012-tool-b', vfs: openGlobalVfs() },
    );
    expect(readRun.ok).toBe(true);
    expect(readRun.result).toBe('hello');
  });

  test('§3.11 js-function → shared restricted VFS: a js tool require()s modules the node tool stored', async () => {
    // nodejs tool stores a shared VFS module (the js-function runtime has no
    // fs surface — it reaches the shared VFS through restricted require()).
    const storeRun = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        `  fs.writeFileSync('/workspace/shared-lib.js', 'module.exports.greet = (n) => "hi-" + n;');`,
        "  fs.writeFileSync('/workspace/shared-config.json', JSON.stringify({ store: 'shared' }));",
        "  return 'stored';",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-js-store'),
      { toolId: 'v1012-js-store-tool', vfs: openGlobalVfs() },
    );
    expect(storeRun.ok).toBe(true);

    // js-function tool (different toolId) reads the SAME shared VFS modules.
    const jsRun = await runJsTool(
      [
        'async function execute(params, context) {',
        "  const lib = require('/workspace/shared-lib.js');",
        "  const cfg = require('/workspace/shared-config.json');",
        '  return { greet: lib.greet("js"), store: cfg.store };',
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-js-read'),
      { toolId: 'v1012-js-read-tool', vfs: openGlobalVfs() },
    );
    expect(jsRun.ok).toBe(true);
    expect(jsRun.result).toEqual({ greet: 'hi-js', store: 'shared' });
  });

  test('§3.12 two registry-registered tools (production handler wiring) share one VFS', async () => {
    const defA: ToolDefinition = {
      name: 'v1012.registry.writer',
      description: 'writes into the shared VFS',
      category: 'utility',
      environment: 'nodejs',
      functionSource: "async function execute(p) { const fs = require('fs'); fs.writeFileSync('/notes/registry.txt', 'from-A'); return 'written'; }",
      schema: { type: 'object', properties: [] },
    };
    const defB: ToolDefinition = {
      name: 'v1012.registry.reader',
      description: 'reads what the other registered tool wrote',
      category: 'utility',
      environment: 'nodejs',
      functionSource: "async function execute(p) { const fs = require('fs'); return fs.readFileSync('/notes/registry.txt', 'utf8'); }",
      schema: { type: 'object', properties: [] },
    };
    const handlerA = resolveHandler(defA);
    const handlerB = resolveHandler(defB);
    expect(handlerA).toBeDefined();
    expect(handlerB).toBeDefined();
    expect(await handlerA!({}, handlerCtx)).toBe('written');
    expect(await handlerB!({}, handlerCtx)).toBe('from-A');
  });

  test('§3.12 openVirtualFs() ignores the legacy per-tool id — every caller gets THE singleton', () => {
    expect(openVirtualFs('tool-a')).toBe(openGlobalVfs());
    expect(openVirtualFs('tool-b')).toBe(openGlobalVfs());
    expect(openVirtualFs()).toBe(openGlobalVfs());
  });

  test('§3.4 cross-task persistence: task 1 writes /workspace/data.json → task 2 (js-function) reads it', async () => {
    const writeRun = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        "  fs.writeFileSync('/workspace/data.json', JSON.stringify({ owner: 'task-1', items: [1, 2, 3] }));",
        "  return 'stored';",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-task1-exec', 'v1012-task-1'),
      { toolId: 'v1012-task-tool', vfs: openGlobalVfs() },
    );
    expect(writeRun.ok).toBe(true);

    // A LATER execution in a LATER task reads the SAME file through the
    // js-function runtime's restricted VFS require().
    const readRun = await runJsTool(
      [
        'async function execute(params, context) {',
        "  return require('/workspace/data.json');",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-task2-exec', 'v1012-task-2'),
      { toolId: 'v1012-task-tool', vfs: openGlobalVfs() },
    );
    expect(readRun.ok).toBe(true);
    expect(readRun.result).toEqual({ owner: 'task-1', items: [1, 2, 3] });
  });

  test('§3.5/§3.6 real persistence: the VFS root is on disk and a FRESH service instance resumes it', () => {
    const vfs = openGlobalVfs();
    vfs.writeFile('/notes/durable.txt', 'survives-restart');
    // the file physically exists on the HOST filesystem under the VFS root
    const hostPath = path.join(ROOT, 'notes', 'durable.txt');
    expect(fs.existsSync(hostPath)).toBe(true);
    expect(fs.readFileSync(hostPath, 'utf8')).toBe('survives-restart');

    // simulate an application restart: drop the service object, rebuild FROM DISK
    resetVfsServiceForTests();
    const fresh = openGlobalVfs();
    expect(fresh).not.toBe(vfs);
    expect(fresh.readFile('/notes/durable.txt', 'utf8')).toBe('survives-restart');
    // workspace scaffold is re-created on the fresh instance
    for (const dir of ['/input', '/output', '/tmp', '/data', '/workspace']) {
      expect(fresh.stat(dir).kind).toBe('dir');
    }
  });
});

// ---------- §3.7/§3.8 — path + symlink security ----------

describe('v1.0.12 §3.7/§3.8 — VFS root is the security boundary', () => {
  const vfs = openGlobalVfs();

  test('§3.7 traversal, encoded traversal and host paths are REJECTED on every API', () => {
    const hostDb = path.join(process.cwd(), 'db', 'dev.db');
    const hostile = [
      '../secret',
      '../../etc/passwd',
      '/notes/../../etc/passwd',
      '/a/../../etc/passwd',
      '/notes/%2e%2e/%2e%2e/secret', // encoded traversal beyond the root
      '%2e%2e/%2e%2e/secret',
      hostDb, // absolute HOST path (the runtime cwd prefix)
      `${process.cwd()}/package.json`,
      'C:/Windows/system32/config', // drive-letter host path
    ];
    for (const bad of hostile) {
      for (const op of [
        () => vfs.readFile(bad),
        () => vfs.writeFile(bad, 'x'),
        () => vfs.stat(bad),
        () => vfs.readdir(bad),
        () => vfs.rm(bad),
        () => vfs.realpath(bad),
        () => normalizeVirtualPath(bad),
      ]) {
        let err: unknown;
        try {
          op();
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(VirtualFsError);
        expect((err as VirtualFsError).code).toBe('VFS_ACCESS');
        expect((err as VirtualFsError).name).toBe('VirtualFSAccessError');
      }
      // the boolean probe never reports a hostile path as existing
      expect(vfs.exists(bad)).toBe(false);
    }
    // nothing was created outside by the rejected attempts
    expect(fs.existsSync(path.join(ROOT, '..', 'secret'))).toBe(false);
  });

  test('§3.7 in-root traversal still normalizes (documented legacy behavior)', () => {
    expect(normalizeVirtualPath('/data/%2e%2e/secret')).toBe('/secret');
    expect(normalizeVirtualPath('/data/sub/../y.txt')).toBe('/data/y.txt');
    expect(hostAccessError('x').code).toBe('VFS_ACCESS');
  });

  test('§3.8 a symlink planted inside the root can never become an escape route', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nextool-vfs-escape-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET');
    try {
      // file symlink pointing OUTSIDE the root
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ROOT, 'esc-file'));
      expect(() => vfs.readFile('/esc-file')).toThrow(/symbolic link/);
      expect(() => vfs.readFile('/esc-file', 'utf8')).toThrow(VirtualFsError);
      expect(() => vfs.writeFile('/esc-file', 'overwritten!')).toThrow(VirtualFsError);
      expect(() => vfs.stat('/esc-file')).toThrow(VirtualFsError);
      expect(vfs.exists('/esc-file')).toBe(false);
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('TOP-SECRET'); // untouched

      // directory symlink pointing OUTSIDE the root
      fs.symlinkSync(outside, path.join(ROOT, 'esc-dir'));
      expect(() => vfs.readdir('/esc-dir')).toThrow(/symbolic link/);
      expect(() => vfs.stat('/esc-dir/secret.txt')).toThrow(VirtualFsError);
      expect(() => vfs.writeFile('/esc-dir/planted.txt', 'x')).toThrow(VirtualFsError);
      expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);

      // symlink hidden DEEPER inside an inner directory
      fs.mkdirSync(path.join(ROOT, 'real'), { recursive: true });
      fs.symlinkSync(outside, path.join(ROOT, 'real', 'link'));
      expect(() => vfs.readFile('/real/link/secret.txt')).toThrow(/symbolic link/);
      expect(() => vfs.writeFile('/real/link/escaped.txt', 'x')).toThrow(VirtualFsError);

      // renames/copies cannot smuggle a symlink either
      expect(() => vfs.rename('/esc-file', '/moved-escape')).toThrow(VirtualFsError);
      vfs.mkdir('/copy-src', { recursive: true });
      expect(() => vfs.copy('/', '/copy-dst')).toThrow(VirtualFsError); // dir copy into its own subtree → EINVAL
      expect(fs.existsSync(path.join(ROOT, 'copy-dst'))).toBe(false);
    } finally {
      for (const p of ['esc-file', 'esc-dir', 'real', 'copy-src']) {
        fs.rmSync(path.join(ROOT, p), { recursive: true, force: true });
      }
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------- §3.9 — limits remain the configuration's authority ----------

describe('v1.0.12 §3.9 — centralized limits still govern the shared VFS', () => {
  test('a write larger than vfs.maxFileBytes is rejected with VFS_LIMIT', () => {
    const vfs = openGlobalVfs();
    const limits = getVfsLimits();
    expect(() => vfs.writeFile('/workspace/too-big.bin', Buffer.alloc(limits.maxFileBytes + 1))).toThrow(/maximum file size/);
    try {
      vfs.writeFile('/workspace/too-big.bin', Buffer.alloc(limits.maxFileBytes + 1));
      expect.unreachable();
    } catch (e) {
      expect((e as VirtualFsError).code).toBe('VFS_LIMIT');
    }
    expect(vfs.exists('/workspace/too-big.bin')).toBe(false);
  });

  test('limits are resolved LIVE from config/configuration-limits.json', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'configuration-limits.json'), 'utf8')) as {
      vfs: Record<string, { default: number }>;
    };
    const limits = getVfsLimits();
    expect(limits.maxFileBytes).toBe(shipped.vfs.maxFileBytes.default);
    expect(limits.maxTotalBytes).toBe(shipped.vfs.maxTotalBytes.default);
    expect(limits.maxEntries).toBe(shipped.vfs.maxEntries.default);
    expect(limits.maxDepth).toBe(shipped.vfs.maxDepth.default);
    expect(limits.maxPathLength).toBe(shipped.vfs.maxPathLength.default);
    const usage = openGlobalVfs().usage();
    expect(usage.limits).toEqual(limits);
    expect(usage.usedBytes).toBeGreaterThan(0);
    expect(usage.files).toBeGreaterThan(0);
  });
});

// ---------- §3.10/§3.11 — freedom-node stays completely free ----------

describe('v1.0.12 §3.10 — freedom-node regression (complete host freedom)', () => {
  test('freedom-node writes OUTSIDE the VFS root to a temp dir and never routes through the shared VFS', async () => {
    const target = path.join(os.tmpdir(), `nextool-freedom-v1012-${Date.now()}.txt`);
    const run = await runFreedomNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(params, context) {',
        '  fs.writeFileSync(params.target, "freedom-host-write");',
        '  return fs.readFileSync(params.target, "utf8");',
        '}',
      ].join('\n'),
      { target },
      runCtx('v1012-freedom-exec'),
      { toolId: 'v1012-freedom-tool' }, // NOTE: no vfs in the freedom execution contract
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe('freedom-host-write');
    // the write really happened OUTSIDE the VFS root
    expect(fs.existsSync(target)).toBe(true);
    expect(target.startsWith(ROOT)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('freedom-host-write');
    // and the shared VFS never received it
    expect(fs.existsSync(path.join(ROOT, path.basename(target)))).toBe(false);
    fs.rmSync(target, { force: true });
  });
});

// ---------- §4 — native fs.* built-in tools ----------

describe('v1.0.12 §4 — fs.* built-in tools over the shared VFS', () => {
  const FS_TOOLS = [
    'fs.list', 'fs.readfile', 'fs.writefile', 'fs.getpath', 'fs.hasfile', 'fs.hasfolder',
    'fs.infofile', 'fs.createfolder', 'fs.deletefile', 'fs.deletefolder',
  ];

  const call = async (name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const def = BUILTIN_TOOLS.find((d) => d.name === name);
    if (!def) throw new Error(`builtin definition missing: ${name}`);
    const handler = resolveHandler(def);
    if (!handler) throw new Error(`handler missing: ${name}`);
    return (await handler(params, handlerCtx)) as Record<string, unknown>;
  };

  test('all ten fs.* tools are registered BUILT-INs and are NOT exportable (§2.2)', () => {
    for (const name of FS_TOOLS) {
      const def = BUILTIN_TOOLS.find((d) => d.name === name);
      expect(def).toBeDefined();
      expect(def!.environment).toBe('builtin');
      expect(toolExportClass(def!.environment)).toBe('builtin');
      expect(isToolExportable(def!)).toBe(false);
      expect(resolveHandler(def!)).toBeDefined();
    }
  });

  test('full lifecycle: createfolder → writefile → hasfolder/hasfile → list → readfile → infofile → getpath → deletefile → deletefolder', async () => {
    expect(await call('fs.createfolder', { path: '/docs/v1012' })).toMatchObject({ path: '/docs/v1012', created: true, kind: 'dir' });
    expect(await call('fs.hasfolder', { path: '/docs/v1012' })).toMatchObject({ path: '/docs/v1012', exists: true });

    const written = await call('fs.writefile', { path: '/docs/v1012/hello.txt', content: 'hello fs tools' });
    expect(written).toMatchObject({ path: '/docs/v1012/hello.txt', size: 'hello fs tools'.length });
    expect(await call('fs.hasfile', { path: '/docs/v1012/hello.txt' })).toMatchObject({ exists: true });
    // hasfile is false for directories; hasfolder is false for files
    expect(await call('fs.hasfile', { path: '/docs/v1012' })).toMatchObject({ exists: false });
    expect(await call('fs.hasfolder', { path: '/docs/v1012/hello.txt' })).toMatchObject({ exists: false });

    const listed = await call('fs.list', { path: '/docs/v1012' });
    expect(listed.path).toBe('/docs/v1012');
    expect((listed.entries as { name: string; kind: string }[]).map((e) => e.name)).toContain('hello.txt');
    expect((listed.entries as { name: string; kind: string }[]).find((e) => e.name === 'hello.txt')?.kind).toBe('file');

    const read = await call('fs.readfile', { path: '/docs/v1012/hello.txt' });
    expect(read.content).toBe('hello fs tools');
    expect(read.encoding).toBe('utf8');

    const info = await call('fs.infofile', { path: '/docs/v1012/hello.txt' });
    expect(info).toMatchObject({ name: 'hello.txt', path: '/docs/v1012/hello.txt', kind: 'file', size: 'hello fs tools'.length });
    expect(typeof info.createdAt).toBe('string');
    expect(typeof info.updatedAt).toBe('string');
    // metadata must NEVER leak the host location
    expect(JSON.stringify(info)).not.toContain(ROOT);
    expect(JSON.stringify(info)).not.toContain(process.cwd());

    const got = await call('fs.getpath', { path: '/docs/./v1012/../v1012/hello.txt' });
    expect(got.path).toBe('/docs/v1012/hello.txt');
    expect(JSON.stringify(got)).not.toContain(ROOT);

    expect(await call('fs.deletefile', { path: '/docs/v1012/hello.txt' })).toMatchObject({ deleted: true });
    expect(await call('fs.hasfile', { path: '/docs/v1012/hello.txt' })).toMatchObject({ exists: false });
    expect(await call('fs.deletefolder', { path: '/docs' })).toMatchObject({ deleted: true });
    expect(await call('fs.hasfolder', { path: '/docs' })).toMatchObject({ exists: false });
  });

  test('fs.writefile base64 round trip and shared visibility from the sandboxed fs API', async () => {
    const bytes = [0, 1, 2, 254, 255];
    await call('fs.writefile', { path: '/workspace/b64.bin', content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
    const raw = openGlobalVfs().readFile('/workspace/b64.bin') as Buffer;
    expect([...raw]).toEqual(bytes);

    // a nodejs sandbox reads the SAME file through require('fs')
    const run = await runNodeTool(
      [
        "const fs = require('fs');",
        'async function execute(p, c) {',
        "  const stat = fs.statSync('/workspace/b64.bin');",
        "  return { size: stat.size, kind: 'file' };",
        '}',
      ].join('\n'),
      {},
      runCtx('v1012-fs-tool-visibility'),
      { toolId: 'v1012-fs-visibility', vfs: openGlobalVfs() },
    );
    expect(run.ok).toBe(true);
    expect(run.result).toEqual({ size: 5, kind: 'file' });
  });

  test('fs.* tools enforce the same path security and limits as the sandbox fs', async () => {
    // traversal is rejected (as a structured ToolFailure carrying VFS_ACCESS), never rewritten
    await expect(call('fs.readfile', { path: '../../etc/passwd' })).rejects.toThrow(/host filesystem is not permitted/);
    await expect(call('fs.writefile', { path: '/x/../../etc/passwd', content: 'x' })).rejects.toThrow(/host filesystem is not permitted/);
    await expect(call('fs.getpath', { path: '../../etc/passwd' })).rejects.toThrow(/host filesystem is not permitted/);
    await expect(call('fs.hasfile', { path: `${process.cwd()}/db/dev.db` })).resolves.toMatchObject({ exists: false });
    // absolute host paths never round-trip
    await expect(call('fs.getpath', { path: `${process.cwd()}/db/dev.db` })).rejects.toThrow(/host filesystem is not permitted/);
    // file-size limit flows through fs.writefile as a structured ToolFailure
    const limits = getVfsLimits();
    let err: { code?: string } | undefined;
    try {
      await call('fs.writefile', { path: '/workspace/fs-tool-big.bin', content: 'x'.repeat(limits.maxFileBytes + 1) });
      expect.unreachable();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe('VFS_LIMIT');
  });
});
