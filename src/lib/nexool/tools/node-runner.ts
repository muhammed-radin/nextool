/**
 * NexTool v1.0.5 — RESTRICTED Node.js tool environment (`environment: "nodejs"`).
 *
 * Purpose (spec §3): practical JavaScript tools that need selected Node.js
 * capabilities — `require(...)` / `await import(...)` for an EXPLICIT module
 * allowlist — without becoming unrestricted server-side code execution.
 *
 * Architecture (one execution path, same contract as js-runner):
 *
 *   Stored functionSource (execute(params, context))
 *        ↓  vm.Script + importModuleDynamically
 *   contextified sandbox { params, context, console, Buffer, TextEncoder… require() }
 *        ↓  allowlist-checked require()/import()      (§3.4/§3.5)
 *   JSON-serializable result (≤ 64 KiB, depth ≤ 12)
 *
 * Hard guarantees:
 *  - require()/import() resolve ONLY modules in NODE_MODULE_ALLOWLIST; anything
 *    else fails with `Module "x" is not available in the NexTool Node.js environment.`
 *  - child_process / cluster / vm / worker_threads / fs / os / net / process
 *    are NOT resolvable and `process` is NOT injected as a global (§3.3).
 *  - Sync execution is capped by the vm timeout; async execution is bounded by
 *    an internal watchdog (promise-level) plus a heap-growth sentinel.
 *  - Results must be JSON-serializable (same rules as the js-function sandbox).
 *
 * Honest limits (documented in docs/tool-development.md): this is an in-process
 * sandbox, not a container. The heap sentinel aborts the tool RESULT when heap
 * growth exceeds NODE_MEMORY_LIMIT_MB, but it cannot revoke memory already
 * allocated by the host realm (e.g. a runaway Buffer). The allowlist keeps
 * every reachable API bounded and free of process/fs/network escape paths.
 */
import vm from 'node:vm';
import nodeAssert from 'node:assert';
import nodeBuffer from 'node:buffer';
import nodeCrypto from 'node:crypto';
import nodeEvents from 'node:events';
import nodePath from 'node:path';
import nodeQuerystring from 'node:querystring';
import nodeStringDecoder from 'node:string_decoder';
import nodeUrl from 'node:url';
import nodeUtil from 'node:util';
import nodeZlib from 'node:zlib';
import { ensureSerializable } from './js-runner';

// ---------- execution limits (§3.8) ----------

/** Hard cap for synchronous execution inside the vm (same as js-function env). */
export const NODE_SYNC_TIMEOUT_MS = 4000;

/** Watchdog for the whole async execution (same as JS_TOOL_TIMEOUT_MS). */
export const NODE_TOOL_TIMEOUT_MS = 10_000;

/** Maximum chars of user function source accepted (same as js-function env). */
export const NODE_MAX_SOURCE_LENGTH = 64_000;

/** Maximum serialized result size (same 64 KiB cap as js-function env). */
export const NODE_MAX_RESULT_BYTES = 64 * 1024;

/** Log line caps (same as js-function env). */
export const NODE_LOG_MAX_LINES = 100;
export const NODE_LOG_MAX_CHARS = 2000;

/**
 * Heap-growth sentinel: if the process heap grows by more than this while a
 * nodejs tool is running, the tool is resolved with a MEMORY error (§3.8).
 * 256 MiB — generous for data processing tools, far below OOM territory.
 */
export const NODE_MEMORY_LIMIT_MB = 256;

/** Handler-config bounds for the http_get dynamic handler (§2.6). */
export const HTTP_GET_DEFAULT_TIMEOUT_MS = 8000;
export const HTTP_GET_MIN_TIMEOUT_MS = 1000;
export const HTTP_GET_MAX_TIMEOUT_MS = 15_000;

// ---------- module allowlist (§3.2) ----------

export interface AllowedModuleInfo {
  /** What the module is for (shown in the Tool IDE reference panel). */
  description: string;
  /** Representative methods/globals — powers the reference panel + IntelliSense. */
  methods: string[];
}

/**
 * The allowlist IS the runtime configuration (§3.6: the reference panel reads
 * this — nothing duplicated). Every entry is capability-audited: none of these
 * modules exposes process, filesystem, network sockets, subprocesses or threads.
 */
export const NODE_MODULE_ALLOWLIST: Record<string, AllowedModuleInfo> = {
  buffer: {
    description: 'Buffer class for binary data (also available as a global).',
    methods: ['Buffer.from', 'Buffer.alloc', 'Buffer.concat', 'Buffer.isBuffer'],
  },
  crypto: {
    description: 'Hashes, HMACs, random bytes, UUIDs and other cryptography primitives.',
    methods: ['createHash', 'createHmac', 'randomBytes', 'randomUUID', 'timingSafeEqual'],
  },
  events: {
    description: 'EventEmitter for event-driven tool logic.',
    methods: ['EventEmitter', 'once', 'on'],
  },
  path: {
    description: 'Path string utilities (pure string manipulation — no filesystem access).',
    methods: ['join', 'resolve', 'basename', 'dirname', 'extname', 'parse', 'format'],
  },
  querystring: {
    description: 'URL query string parsing and formatting.',
    methods: ['parse', 'stringify', 'escape', 'unescape'],
  },
  string_decoder: {
    description: 'Stateful buffer → string decoding that respects multi-byte characters.',
    methods: ['StringDecoder'],
  },
  url: {
    description: 'URL parsing and formatting (legacy API on top of the global URL).',
    methods: ['URL', 'URLSearchParams', 'pathToFileURL', 'fileURLToPath'],
  },
  util: {
    description: 'Formatting, type checks and promise utilities.',
    methods: ['inspect', 'format', 'types', 'promisify', 'deprecate'],
  },
  assert: {
    description: 'Assertion helpers for validating tool assumptions.',
    methods: ['ok', 'equal', 'deepEqual', 'strictEqual', 'throws'],
  },
  zlib: {
    description: 'Compression (gzip/deflate/brotli) for data-processing tools.',
    methods: ['gzipSync', 'gunzipSync', 'deflateSync', 'inflateSync', 'brotliCompressSync', 'brotliDecompressSync'],
  },
};

/** Modules a developer might reach for that are DELIBERATELY unavailable (§3.3). */
export const NODE_BLOCKED_MODULES: Record<string, string> = {
  child_process: 'subprocess execution is never allowed',
  cluster: 'multi-process execution is never allowed',
  vm: 'creating further sandboxes is never allowed',
  worker_threads: 'thread execution is never allowed',
  fs: 'unrestricted filesystem access is never allowed',
  os: 'OS-level information/introspection is never allowed',
  net: 'raw network sockets are never allowed',
  dgram: 'raw network sockets are never allowed',
  http: 'unrestricted networking is never allowed',
  https: 'unrestricted networking is never allowed',
  process: 'process manipulation is never allowed',
};

function normalizeSpecifier(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

/**
 * Allowlisted modules resolved via STATIC imports — the same objects the host
 * uses, delivered into the sandbox only through this map. A module not in the
 * map simply has no binding here: there is no dynamic require/import path that
 * could reach it (§3.3 — no escape from the sandbox).
 */
const ALLOWED_MODULE_OBJECTS: Record<string, unknown> = {
  buffer: nodeBuffer,
  crypto: nodeCrypto,
  events: nodeEvents,
  path: nodePath,
  querystring: nodeQuerystring,
  string_decoder: nodeStringDecoder,
  url: nodeUrl,
  util: nodeUtil,
  assert: nodeAssert,
  zlib: nodeZlib,
};

/** Resolve a specifier through the allowlist. Throws with the §3.4 wording. */
export function resolveAllowedModule(specifier: string): unknown {
  const name = normalizeSpecifier(String(specifier ?? '').trim());
  if (!name) {
    throw new Error('Module specifier is empty — require() needs an allowlisted module name.');
  }
  if (NODE_BLOCKED_MODULES[name]) {
    throw new Error(`Module "${name}" is not available in the NexTool Node.js environment (${NODE_BLOCKED_MODULES[name]}).`);
  }
  if (!(name in ALLOWED_MODULE_OBJECTS)) {
    throw new Error(
      `Module "${name}" is not available in the NexTool Node.js environment. Allowed modules: ${Object.keys(NODE_MODULE_ALLOWLIST).join(', ')}.`,
    );
  }
  return ALLOWED_MODULE_OBJECTS[name];
}

/** importModuleDynamically callback — same allowlist as require() (§3.5). */
function importAllowedModule(specifier: string | number | undefined): Promise<unknown> {
  const name = normalizeSpecifier(String(specifier ?? ''));
  return Promise.resolve(resolveAllowedModule(name));
}

// ---------- globals exposed to the sandbox (§3.6 "available globals") ----------

export interface NodeGlobalInfo {
  name: string;
  type: string;
  description: string;
}

export const NODE_SANDBOX_GLOBALS: NodeGlobalInfo[] = [
  { name: 'params', type: 'ToolParams', description: 'Tool parameters (typed from the tool schema).' },
  { name: 'context', type: 'ToolContext', description: 'executionId, taskId, mode, now, log(...) — same contract as the js-function sandbox.' },
  { name: 'console', type: 'Console', description: 'log/warn/error/info — capped at 100 lines, shown in the test panel.' },
  { name: 'Buffer', type: 'Buffer', description: 'Binary data constructor (from the allowlisted buffer module).' },
  { name: 'TextEncoder', type: 'TextEncoder', description: 'UTF-8 encoding.' },
  { name: 'TextDecoder', type: 'TextDecoder', description: 'UTF-8 decoding.' },
  { name: 'URL', type: 'URL', description: 'URL parsing (same as the main realm).' },
  { name: 'URLSearchParams', type: 'URLSearchParams', description: 'Query string handling.' },
  { name: 'atob / btoa', type: '(string) => string', description: 'Base64 decoding/encoding.' },
  { name: 'structuredClone', type: '<T>(v: T) => T', description: 'Structured deep clone.' },
];

export const NODE_EXECUTION_LIMITS = {
  timeoutMs: NODE_TOOL_TIMEOUT_MS,
  syncTimeoutMs: NODE_SYNC_TIMEOUT_MS,
  memoryLimitMb: NODE_MEMORY_LIMIT_MB,
  maxSourceChars: NODE_MAX_SOURCE_LENGTH,
  maxResultBytes: NODE_MAX_RESULT_BYTES,
  maxLogLines: NODE_LOG_MAX_LINES,
  moduleAllowlist: Object.keys(NODE_MODULE_ALLOWLIST),
};

// ---------- source handling ----------

export interface NodeToolContext {
  executionId: string;
  taskId?: string;
  mode: 'test' | 'production';
  now: string;
  log: (...parts: unknown[]) => void;
}

export interface NodeToolRunResult {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  logs: string[];
}

export function declaresExecute(source: string): boolean {
  return /(?:async\s+)?function\s+execute\s*\(/.test(source)
    || /(?:const|let|var)\s+execute\s*=/.test(source);
}

function wrapSource(source: string): string {
  return declaresExecute(source)
    ? `${source}\nexecute`
    : `(async function execute(params, context) {\n${source}\n})`;
}

/** Compile-time validation for nodejs tool sources (same wrapping as runNodeTool). */
export function validateNodeFunctionSource(source: string): { ok: true } | { ok: false; error: string } {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { ok: false, error: 'Function source is empty.' };
  }
  if (source.length > NODE_MAX_SOURCE_LENGTH) {
    return { ok: false, error: `Function source exceeds ${NODE_MAX_SOURCE_LENGTH} characters.` };
  }
  try {
    const probe = new vm.Script(wrapSource(transformDynamicImports(source)), {
      filename: 'node-tool-function.js',
      importModuleDynamically: importAllowedModule,
    } as vm.ScriptOptions);
    probe.runInNewContext({ __nexoolDynamicImport: importAllowedModule });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Syntax error in function source.' };
  }
}

// ---------- dynamic import() support (§3.5) ----------

/**
 * Node's vm.Script dynamic-import callback requires --experimental-vm-modules
 * on stock Node — a flag the NexTool runtime cannot assume. Instead, dynamic
 * `import("x")` CALL SITES are rewritten to `__nexoolDynamicImport("x")`
 * before compilation; the shim resolves through the SAME allowlist as
 * require(). The scanner is string/comment/regex-aware so literals like
 * `const s = "import(x)"` or `/import\(/` are never touched.
 */
const RUNTIME_IMPORT_SHIM = '__nexoolDynamicImport';

/** A `/` starts a regex literal when the previous meaningful token allows it. */
function regexAllowedAfter(prev: string): boolean {
  if (!prev) return true;
  const last = prev.slice(-1);
  if (/[\w)$]/.test(last)) return false; // identifier/number/`)`/`]` → division
  return true; // operators, punctuators, start of line
}

export function transformDynamicImports(source: string): string {
  let out = '';
  let mode: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' | 'regex' = 'code';
  const templateStack: boolean[] = []; // per-template: inside ${ ... } ?
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
      // import call site: `import` not preceded by word char/dot, then `(`
      if (ch === 'i' && source.startsWith('import', i) && !/[\w$.]/.test(out.slice(-1))) {
        let j = i + 'import'.length;
        while (j < source.length && /\s/.test(source[j])) j++;
        if (source[j] === '(') {
          out += RUNTIME_IMPORT_SHIM;
          i += 'import'.length - 1; // whitespace + '(' are copied verbatim
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
    // template string
    if (ch === '\\') { out += ch + next; i++; continue; }
    if (ch === '`') { templateStack.pop(); mode = templateStack.length > 0 && templateStack[templateStack.length - 1] ? 'code' : 'code'; out += ch; continue; }
    if (ch === '$' && next === '{') { templateStack.push(true); mode = 'code'; out += '${'; i++; continue; }
    out += ch;
  }
  return out;
}

// ---------- execution ----------

interface LoggerState {
  lines: string[];
}

function stringifyLogPart(part: unknown): string {
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return value;
  }
}

/**
 * Execute a nodejs tool. NEVER throws — returns a structured result with the
 * same shape as js-runner so /api/tools/test and the executor share one path.
 */
export function runNodeTool(
  source: string,
  params: Record<string, unknown>,
  context: NodeToolContext,
): Promise<NodeToolRunResult> {
  return new Promise((resolve) => {
    const logger: LoggerState = { lines: [] };
    const logs = logger.lines;
    const pushLog = (...parts: unknown[]) => {
      if (logs.length >= NODE_LOG_MAX_LINES) return;
      logs.push(parts.map(stringifyLogPart).join(' ').slice(0, NODE_LOG_MAX_CHARS));
    };

    let settled = false;
    const finish = (result: NodeToolRunResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(timer);
      resolve({ ...result, logs: [...logs] });
    };

    // Async watchdog (§3.8): bounds awaits, dynamic import chains, zlib, etc.
    const timer = setTimeout(() => {
      finish({ ok: false, error: { code: 'TIMEOUT', message: `Function exceeded ${NODE_TOOL_TIMEOUT_MS}ms and was aborted.` }, logs: [] });
    }, NODE_TOOL_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    // Heap-growth sentinel (§3.8): aborts the result when the tool allocates
    // beyond NODE_MEMORY_LIMIT_MB. Honest in-process guard — see module docs.
    const baseline = process.memoryUsage().heapUsed;
    const watchdog = setInterval(() => {
      const grownMb = (process.memoryUsage().heapUsed - baseline) / (1024 * 1024);
      if (grownMb > NODE_MEMORY_LIMIT_MB) {
        finish({
          ok: false,
          error: { code: 'MEMORY', message: `Function exceeded the ${NODE_MEMORY_LIMIT_MB} MiB heap-growth limit and was aborted.` },
          logs: [],
        });
      }
    }, 250);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    let sandbox: vm.Context | undefined;
    try {
      sandbox = vm.createContext({
        params: structuredCloneSafe(params),
        context: {
          executionId: context.executionId,
          taskId: context.taskId ?? null,
          mode: context.mode,
          now: context.now,
          log: pushLog,
        },
        console: { log: pushLog, warn: pushLog, error: pushLog, info: pushLog },
        Buffer,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob,
        btoa,
        structuredClone,
        // require()/import() are the ONLY module surface — allowlist-enforced.
        require: (specifier: string) => resolveAllowedModule(specifier),
        [RUNTIME_IMPORT_SHIM]: (specifier: string) => importAllowedModule(specifier),
        // Intentionally NOT provided: process, fs, net, timers, fetch, global escapes.
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'SANDBOX_ERROR', message: err instanceof Error ? err.message : 'Failed to create sandbox.' }, logs: [] });
      return;
    }

    try {
      // §3.5 — dynamic import() call sites are rewritten to the allowlist shim
      // before compilation so import() works without host vm-module flags.
      const compiled = new vm.Script(wrapSource(transformDynamicImports(source)), {
        filename: 'node-tool-function.js',
        importModuleDynamically: importAllowedModule,
      } as vm.ScriptOptions);
      const fn = compiled.runInContext(sandbox, { timeout: NODE_SYNC_TIMEOUT_MS }) as
        | ((p: Record<string, unknown>, c: unknown) => Promise<unknown>);
      if (typeof fn !== 'function') {
        finish({ ok: false, error: { code: 'INVALID_FUNCTION', message: 'Source did not compile to an execute function.' }, logs: [] });
        return;
      }
      // Invoke inside the vm under the sync timeout (§3.8) — bounds no-await
      // bodies without blocking the host event loop (same as js-runner v1.0.5).
      const host = sandbox as unknown as Record<string, unknown>;
      host.__nexoolRun = fn;
      new vm.Script('__nexoolResult = __nexoolRun(params, context)', { filename: 'node-tool-function.js' })
        .runInContext(sandbox, { timeout: NODE_SYNC_TIMEOUT_MS });
      Promise.resolve(host.__nexoolResult)
        .then((value) => {
          const check = ensureSerializable(value);
          if (!check.ok) {
            finish({ ok: false, error: { code: 'NOT_SERIALIZABLE', message: check.message }, logs: [] });
            return;
          }
          finish({ ok: true, result: check.value, logs: [] });
        })
        .catch((err: unknown) => {
          finish({
            ok: false,
            error: { code: 'TOOL_FAILURE', message: err instanceof Error ? err.message : String(err) },
            logs: [],
          });
        });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        ok: false,
        error: {
          code: err instanceof SyntaxError && !message.includes('timed out') ? 'SYNTAX_ERROR' : message.includes('timed out') ? 'TIMEOUT' : 'TOOL_FAILURE',
          message,
        },
        logs: [],
      });
    }
  });
}
