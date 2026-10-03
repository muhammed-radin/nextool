/**
 * NexTool v1.0.6 → v1.0.8 — centralized Tool Import Resolver (spec §6–§6.7, v1.0.8 §2/§15).
 *
 *   Tool import
 *       ↓
 *   resolveToolImport
 *       ├── Virtual FS            ./x.js  ./x.mjs  ./x.json  /data/x.json
 *       ├── Allowed Node API      crypto  path  buffer … (+ node: prefix)
 *       ├── Allowed URL           https://… / http://… (POLICY-GATED, v1.0.8: enabled by default)
 *       └── Approved package      (none today — honestly reported)
 *
 * BOTH environments route require()/import() through THIS resolver — there is
 * no second, incompatible resolver (§6.7). VFS modules run CommonJS plus a
 * conservative ESM transform (export default/const/let/var/function/class and
 * `export { a, b as c }`).
 *
 * v1.0.8 (§2/§15): URL imports are ENABLED by default and governed EXCLUSIVELY
 * by the central network policy — network.allowUrlImports, network.timeoutMs,
 * network.maxResponseBytes (module size cap — the separate v1.0.6
 * urlImportMaxBytes constant was removed), network.maxRedirects and
 * network.maxRequestsPerExecution. The policy is checked BEFORE the module
 * cache: a currently-blocked URL can never be satisfied from a stale cached
 * module (§2.6). URL modules execute inside the SAME sandbox boundary as the
 * importing tool (§2.4): their require() goes through the importing
 * environment's bare resolver — a URL module never gains host filesystem,
 * process or child-process access. Unsupported schemes (file:, data:, node:)
 * are rejected by the network policy (§2.2).
 *
 * This module also hosts the shared dynamic-import() source transform used by
 * BOTH sandbox runners (moved here in v1.0.8 so js-runner can support URL
 * imports too — §2 "both environments").
 */

import vm from 'node:vm';
import { getNetworkPolicy, NetworkPolicyError, parsePolicyUrl, policyFetch, type NetworkAccounting } from './sandbox-net';
import { getResolvedLimits } from '../config-limits';
import { resolveAllowedModule } from './node-runner';
import type { VirtualFsSession } from './vfs';

export interface ImportContext {
  /** Owning tool (ToolRecord.name) — scopes VFS module imports. */
  toolId?: string;
  /** The executing tool's workspace snapshot. */
  vfs?: VirtualFsSession;
  accounting: NetworkAccounting;
  /** Per-execution module cache (VFS + URL modules). */
  moduleCache: Map<string, unknown>;
  /** v1.0.6 — bare-specifier fallback for the CALLING environment (nodejs
   *  tools resolve fs/child_process/http/… through their context modules;
   *  js-function tools reject them). require() and import() stay ONE resolver.
   *  v1.0.8 §2.4 — URL-imported modules inherit this resolver too. */
  resolveBare?: (specifier: string) => unknown;
}

export class ImportResolutionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportResolutionError';
    this.code = code;
  }
}

// ---------- shared dynamic import() transform (v1.0.8) ----------

/** Sandbox binding name the import() transform rewrites to. */
export const RUNTIME_IMPORT_SHIM = '__nexoolDynamicImport';

function regexAllowedAfter(prev: string): boolean {
  if (!prev) return true;
  const last = prev.slice(-1);
  if (/[\w)$]/.test(last)) return false;
  return true;
}

/**
 * Rewrite dynamic `import(...)` call sites to `__nexoolDynamicImport(...)`
 * while respecting strings, template literals, comments and regex literals.
 * Shared by the js-function and nodejs runners so `await import(url)` reaches
 * the policy-gated resolver in BOTH environments (v1.0.8 §2).
 */
export function transformDynamicImports(source: string): string {
  let out = '';
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' | 'regex' = 'code';
  const templateStack: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? '';
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out += ch; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out += ch + next; i++; continue; }
      if (ch === "'") { mode = 'single'; out += ch; continue; }
      if (ch === '"') { mode = 'double'; out += ch; continue; }
      if (ch === '`') { mode = 'template'; templateStack.push(false); out += ch; continue; }
      if (ch === '/') { mode = regexAllowedAfter(out) ? 'regex' : 'code'; out += ch; continue; }
      if (ch === 'i' && source.startsWith('import', i) && !/[\w$.]/.test(out.slice(-1))) {
        let j = i + 'import'.length;
        while (j < source.length && /\s/.test(source[j])) j++;
        if (source[j] === '(') {
          out += RUNTIME_IMPORT_SHIM;
          i += 'import'.length - 1;
          continue;
        }
      }
      out += ch;
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; out += ch; continue; }
    if (mode === 'block') { if (ch === '*' && next === '/') { mode = 'code'; out += '*/'; i++; } else out += ch; continue; }
    if (mode === 'single') {
      if (ch === '\\') { out += ch + next; i++; continue; }
      if (ch === "'" || ch === '\n') mode = 'code';
      out += ch; continue;
    }
    if (mode === 'double') {
      if (ch === '\\') { out += ch + next; i++; continue; }
      if (ch === '"' || ch === '\n') mode = 'code';
      out += ch; continue;
    }
    if (mode === 'regex') {
      if (ch === '\\') { out += ch + next; i++; continue; }
      if (ch === '/' || ch === '\n') mode = 'code';
      out += ch; continue;
    }
    if (ch === '\\') { out += ch + next; i++; continue; }
    if (ch === '`') { templateStack.pop(); mode = 'code'; out += ch; continue; }
    if (ch === '$' && next === '{') { templateStack.push(true); mode = 'code'; out += '${'; i++; continue; }
    out += ch;
  }
  return out;
}

// ---------- module compilation ----------

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

function normalizeRelative(fromDir: string, spec: string): string {
  const parts = (spec.startsWith('/') ? spec : `${fromDir}/${spec}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function withExtensions(p: string): string[] {
  const hasExt = /\.[a-z0-9]+$/i.test(p);
  return hasExt ? [p] : [`${p}.js`, `${p}.mjs`, `${p}.json`, p];
}

/** Conservative ESM → CommonJS transform for VFS/URL modules (documented limits). */
export function transformEsmExports(source: string): string {
  const namedExports: string[] = [];
  let out = source;
  // export { a, b as c };
  out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, list: string) => {
    for (const part of list.split(',')) {
      const item = part.trim();
      if (!item) continue;
      const asMatch = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(item);
      namedExports.push(asMatch ? `${asMatch[1]}: ${asMatch[2]}` : `${item}: ${item}`);
    }
    return '';
  });
  // export default <expr|function|class>
  out = out.replace(/export\s+default\s+/g, '__nexoolDefault = ');
  // export const/let/var name
  out = out.replace(/export\s+(const|let|var)\s+([\w$]+)/g, (_m, kw: string, name: string) => {
    namedExports.push(`${name}: ${name}`);
    return `${kw} ${name}`;
  });
  // export function name / export async function name / export class Name
  out = out.replace(/export\s+(async\s+)?(function|class)\s+([\w$]+)/g, (_m, asyncKw: string | undefined, kind: string, name: string) => {
    namedExports.push(`${name}: ${name}`);
    return `${asyncKw ?? ''}${kind} ${name}`;
  });
  const tail = namedExports.length > 0
    ? `\nObject.assign(module.exports, { ${namedExports.join(', ')} });`
    : '';
  return `let __nexoolDefault;\n${out}${tail}\nif (__nexoolDefault !== undefined) module.exports.default = __nexoolDefault;\n`;
}

function compileVfsModule(
  ctx: ImportContext,
  modulePath: string,
  code: string,
): unknown {
  if (ctx.moduleCache.has(modulePath)) return ctx.moduleCache.get(modulePath);
  const moduleObj = { exports: {} as Record<string, unknown> };

  const localRequire = (specifier: string): unknown => {
    // Relative requires resolve inside the VFS (synchronously from the snapshot).
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      const resolved = resolveVfsFileSync(ctx, modulePath, specifier);
      if (resolved === null) {
        throw new ImportResolutionError('MODULE_NOT_FOUND', `Cannot find module '${specifier}' in the tool's virtual filesystem.`);
      }
      return loadVfsModuleSync(ctx, resolved.path, resolved.code);
    }
    // v1.0.8 §2.4 — bare requires from imported modules inherit the CALLING
    // environment's resolver (same sandbox boundary; no host escape route).
    return ctx.resolveBare ? ctx.resolveBare(specifier) : resolveAllowedModule(specifier);
  };

  ctx.moduleCache.set(modulePath, moduleObj.exports);
  const transformed = transformEsmExports(code);
  const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${transformed}\n})`;
  try {
    const compiled = new vm.Script(wrapper, { filename: `vfs:${modulePath}` });
    const fn = compiled.runInNewContext({
      module: moduleObj,
      exports: moduleObj.exports,
      require: localRequire,
      __filename: modulePath,
      __dirname: dirname(modulePath),
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {} },
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
    }) as (...a: unknown[]) => void;
    fn(moduleObj.exports, localRequire, moduleObj, modulePath, dirname(modulePath));
  } catch (err) {
    ctx.moduleCache.delete(modulePath);
    throw new ImportResolutionError('MODULE_ERROR', `VFS module "${modulePath}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
  ctx.moduleCache.set(modulePath, moduleObj.exports);
  return moduleObj.exports;
}

function loadVfsModuleSync(ctx: ImportContext, path: string, code: string): unknown {
  if (path.endsWith('.json')) {
    try {
      return JSON.parse(code);
    } catch {
      throw new ImportResolutionError('MODULE_ERROR', `VFS module "${path}" is not valid JSON.`);
    }
  }
  return compileVfsModule(ctx, path, code);
}

/**
 * Synchronous VFS require used by the sandbox `require()` (CommonJS semantics).
 * Resolves relative/absolute specifiers inside the tool's workspace snapshot.
 */
export function requireFromVfs(ctx: ImportContext, fromModule: string, specifier: string): unknown {
  if (!ctx.vfs) {
    throw new ImportResolutionError('MODULE_NOT_FOUND', `Module '${specifier}' cannot be resolved: this execution has no virtual filesystem workspace.`);
  }
  const resolved = resolveVfsFileSync(ctx, fromModule, specifier);
  if (resolved === null) {
    throw new ImportResolutionError('MODULE_NOT_FOUND', `Cannot find module '${specifier}' in the tool's virtual filesystem (looked for .js, .mjs, .json).`);
  }
  const cacheKey = `vfs:${resolved.path}`;
  if (ctx.moduleCache.has(cacheKey)) return ctx.moduleCache.get(cacheKey);
  const loaded = loadVfsModuleSync(ctx, resolved.path, resolved.code);
  ctx.moduleCache.set(cacheKey, loaded);
  return loaded;
}

function resolveVfsFileSync(ctx: ImportContext, fromModule: string, specifier: string): { path: string; code: string } | null {
  if (!ctx.vfs) return null;
  const base = normalizeRelative(dirname(fromModule), specifier);
  for (const candidate of withExtensions(base)) {
    try {
      const entry = ctx.vfs.stat(candidate);
      if (entry.kind === 'dir') continue;
      const code = ctx.vfs.readFileSync(candidate, 'utf8') as string;
      return { path: candidate, code };
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveVfsFileAsync(ctx: ImportContext, fromDir: string, specifier: string): Promise<unknown | null> {
  if (!ctx.vfs) return null;
  const base = normalizeRelative(fromDir, specifier);
  for (const candidate of withExtensions(base)) {
    try {
      const entry = ctx.vfs.stat(candidate);
      if (entry.kind === 'dir') continue;
      const code = ctx.vfs.readFileSync(candidate, 'utf8') as string;
      const cacheKey = `vfs:${candidate}`;
      if (ctx.moduleCache.has(cacheKey)) return ctx.moduleCache.get(cacheKey);
      const loaded = loadVfsModuleSync(ctx, candidate, code);
      ctx.moduleCache.set(cacheKey, loaded);
      return loaded;
    } catch (err) {
      if (err instanceof ImportResolutionError) throw err;
      continue;
    }
  }
  return null;
}

/**
 * THE import resolver. Async because URL imports (policy-enabled) are
 * async; VFS and allowlist resolution are effectively instant.
 */
export async function resolveToolImport(
  specifier: string,
  ctx: ImportContext,
  fromDir = '/workspace',
): Promise<unknown> {
  const spec = String(specifier ?? '').trim();
  if (!spec) throw new ImportResolutionError('INVALID_SPECIFIER', 'import() needs a module specifier.');

  // 1) Node built-ins / allowlisted modules (node: prefix normalized inside).
  //    Bare specifiers delegate to the calling environment's resolver so
  //    require() and import() behave IDENTICALLY (§6.7).
  if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('http://') && !spec.startsWith('https://')) {
    return ctx.resolveBare ? ctx.resolveBare(spec) : resolveAllowedModule(spec);
  }

  // 2) URL imports — v1.0.8 §2/§15: policy-gated through the CENTRAL network
  //    policy. The gate is checked BEFORE the cache (§2.6): a URL that is
  //    blocked right now can never be satisfied from a stale cached module.
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    const policy = getNetworkPolicy();
    if (!policy.urlImportsEnabled) {
      throw new ImportResolutionError(
        'URL_IMPORTS_DISABLED',
        'URL imports are disabled by the NexTool network policy (network.allowUrlImports = false). Import from the tool\'s virtual filesystem or the allowlisted Node.js modules.',
      );
    }
    // Validate the URL against the protocol/host policy BEFORE the cache
    // (§2.6): a URL that is blocked right now can never be satisfied from a
    // stale cached module — even when the module bytes are still cached.
    parsePolicyUrl(spec, policy);
    const cacheKey = `url:${spec}`;
    if (ctx.moduleCache.has(cacheKey)) return ctx.moduleCache.get(cacheKey);
    // policyFetch enforces protocol/host policy, network.timeoutMs,
    // network.maxResponseBytes, network.maxRedirects and the per-execution
    // request accounting — the SAME layer as fetch/XHR/http(s) (§2.1/§2.5).
    const res = await policyFetch(spec, { method: 'GET' }, ctx.accounting);
    if (!res.ok) {
      throw new ImportResolutionError('URL_IMPORT_FAILED', `URL import of "${spec}" failed with HTTP ${res.status}.`);
    }
    const code = await res.text();
    // §2.5 — module size cap = network.maxResponseBytes (single source).
    const maxBytes = getResolvedLimits().network.maxResponseBytes;
    if (Buffer.byteLength(code, 'utf8') > maxBytes) {
      throw new ImportResolutionError('URL_IMPORT_TOO_LARGE', `URL import of "${spec}" exceeds the ${maxBytes} byte module size limit (network.maxResponseBytes).`);
    }
    const loaded = compileVfsModule(ctx, spec, code);
    ctx.moduleCache.set(cacheKey, loaded);
    return loaded;
  }

  // 3) Virtual filesystem modules (§6.4).
  if (ctx.vfs) {
    const loaded = await resolveVfsFileAsync(ctx, fromDir, spec);
    if (loaded !== null) return loaded;
    throw new ImportResolutionError(
      'MODULE_NOT_FOUND',
      `Cannot find module '${spec}' in the tool's virtual filesystem (looked for .js, .mjs, .json).`,
    );
  }

  throw new ImportResolutionError(
    'MODULE_NOT_FOUND',
    `Module '${spec}' cannot be resolved: this execution has no virtual filesystem workspace.`,
  );
}

/** Re-export for the network-policy error type consumers. */
export { NetworkPolicyError };
