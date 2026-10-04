/**
 * NexTool v1.0.6 — RESTRICTED Node.js tool environment (`environment: "nodejs"`).
 *
 * v1.0.6 (spec §1/§2/§3/§5/§6): the sandbox becomes a genuinely useful but
 * tightly controlled Node.js-compatible runtime:
 *
 *   - require()/import() resolve through the CENTRALIZED import resolver:
 *       ├── allowlisted Node built-ins (static, capability-audited)
 *       ├── fs            → the Virtual FS  (never the host fs, §2.4)
 *       ├── child_process → the VIRTUAL command layer (no host processes, §4)
 *       ├── http / https  → the controlled network layer (§3)
 *       ├── os / timers   → virtualized surfaces
 *       └── VFS modules   → ./helper.js / ./config.json from the workspace
 *   - fetch / XMLHttpRequest / async alert() / async prompt() / async confirm() (§1)
 *   - setTimeout/setInterval (bounded by the execution deadline)
 *   - JSON-serializable results (≤ execution.maxResultBytes, depth ≤ 12)
 *
 * v1.0.8 (§1/§2/§6/§17): async confirm() joins the interaction layer, URL
 * imports work through the centralized resolver, and ALL execution limits
 * (sync cap, heap sentinel, source chars, result bytes, log lines) are
 * resolved from config/configuration-limits.json — no hard-coded limits.
 *
 * Still BLOCKED, with no hidden route around the policy: cluster, vm,
 * worker_threads, net, dgram, dns, process (global + module), the real
 * filesystem, and any module outside the resolver. Sync execution is capped
 * by the vm timeout; async execution by an interaction-aware deadline plus a
 * heap-growth sentinel.
 *
 * Honest limits (documented in docs/security.md): in-process sandbox, not a
 * container; the heap sentinel aborts the tool RESULT when heap growth
 * exceeds execution.heapSentinelBytes but cannot revoke memory already allocated.
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
import {
  createNetworkAccounting,
  createXhrClass,
  createHttpLikeModule,
  policyFetch,
  type NetworkAccounting,
} from './sandbox-net';
import {
  createRuntimeInteractions,
  createTestInteractions,
  type SandboxInteractions,
} from './sandbox-interactive';
import { createFsModule } from './sandbox-fs';
import { createChildProcessModule, CHILD_PROCESS_LIMITS, VIRTUAL_COMMANDS } from './virtual-child-process';
import type { VirtualFsSession } from './vfs';
import {
  resolveToolImport,
  requireFromVfs,
  transformDynamicImports,
  RUNTIME_IMPORT_SHIM,
  type ImportContext,
} from './import-resolver';

/** v1.0.8 — the dynamic-import transform is SHARED with js-runner (moved to
 *  import-resolver.ts); re-exported for backwards compatibility. */
export { transformDynamicImports, RUNTIME_IMPORT_SHIM };

// ---------- execution limits (v1.0.8 §6/§17 — resolved from the CENTRAL limits) ----------

/** Documented SHIPPED defaults (live enforcement reads configuration-limits.json). */
export const NODE_SYNC_TIMEOUT_MS = 4_000;
export const NODE_TOOL_TIMEOUT_MS = 10_000;
export const NODE_MAX_SOURCE_LENGTH = 64_000;
export const NODE_MAX_RESULT_BYTES = 64 * 1024;
export const NODE_LOG_MAX_LINES = 100;
export const NODE_LOG_MAX_CHARS = 2_000;
export const NODE_MEMORY_LIMIT_MB = 256;

export const HTTP_GET_DEFAULT_TIMEOUT_MS = 8000;
export const HTTP_GET_MIN_TIMEOUT_MS = 1000;
export const HTTP_GET_MAX_TIMEOUT_MS = 15_000;

import { getResolvedLimits } from '../config-limits';
import { maxToolTimeoutMs } from './timeout';

/** LIVE execution limits from the central configuration (no hard-coded copies). */
export function getLiveExecutionLimits() {
  try {
    return getResolvedLimits().execution;
  } catch {
    // The limits file is unreadable — keep the shipped defaults so the module
    // stays importable; every enforcement call site re-resolves and reports
    // the configuration error clearly.
    return {
      timeoutMs: NODE_TOOL_TIMEOUT_MS,
      syncTimeoutMs: NODE_SYNC_TIMEOUT_MS,
      heapSentinelBytes: NODE_MEMORY_LIMIT_MB * 1024 * 1024,
      maxSourceChars: NODE_MAX_SOURCE_LENGTH,
      maxResultBytes: NODE_MAX_RESULT_BYTES,
      maxLogs: NODE_LOG_MAX_LINES,
      maxLogLineChars: NODE_LOG_MAX_CHARS,
    };
  }
}

function liveLimits() {
  const e = getLiveExecutionLimits();
  return {
    syncTimeoutMs: e.syncTimeoutMs,
    heapSentinelMb: Math.round(e.heapSentinelBytes / (1024 * 1024)),
    maxSourceChars: e.maxSourceChars,
    maxResultBytes: e.maxResultBytes,
    maxLogs: e.maxLogs,
    maxLogLineChars: e.maxLogLineChars,
    execTimeoutMs: e.timeoutMs,
  };
}

// ---------- module allowlist (§3.2/§5) ----------

export interface AllowedModuleInfo {
  description: string;
  methods: string[];
  /** v1.0.6: true for context-provided virtual/restricted modules. */
  virtual?: boolean;
}

/**
 * The allowlist IS the runtime configuration. Static entries are resolved
 * from the host realm directly; `virtual` entries are built per execution
 * around the tool's own sandbox context (VFS/network/interaction layers).
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
    description: 'Path string utilities (pure string manipulation — works on virtual paths).',
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
  // ----- v1.0.6 virtual/restricted modules (§2/§3/§4/§5) -----
  fs: {
    description: 'The NexTool Virtual File System (per-tool isolated workspace: /input /output /tmp /data /workspace). Never the host filesystem.',
    methods: ['readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'stat', 'lstat', 'rename', 'copyFile', 'unlink', 'rm', 'realpath', 'exists', 'promises', 'readFileSync', 'writeFileSync'],
    virtual: true,
  },
  os: {
    description: 'Virtualized OS surface — fixed sandbox values, no host introspection.',
    methods: ['EOL', 'platform', 'arch', 'hostname', 'tmpdir', 'cpus', 'totalmem', 'freemem'],
    virtual: true,
  },
  timers: {
    description: 'Timers (setTimeout/setInterval) — bounded by the tool execution deadline.',
    methods: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'],
    virtual: true,
  },
  'timers/promises': {
    description: 'Promise-based timers.',
    methods: ['setTimeout', 'setImmediate', 'setInterval'],
    virtual: true,
  },
  http: {
    description: 'Controlled HTTP client routed through the NexTool network policy (same rules as fetch).',
    methods: ['request', 'get', 'METHODS', 'STATUS_CODES'],
    virtual: true,
  },
  https: {
    description: 'Controlled HTTPS client routed through the NexTool network policy (same rules as fetch).',
    methods: ['request', 'get', 'METHODS', 'STATUS_CODES'],
    virtual: true,
  },
  child_process: {
    description: 'RESTRICTED virtual command layer — documented commands executed against the Virtual FS workspace. The host system is never touched.',
    methods: ['exec', 'execSync', 'execFile', 'spawn', 'spawnSync'],
    virtual: true,
  },
};

/** Modules a developer might reach for that are DELIBERATELY unavailable. */
export const NODE_BLOCKED_MODULES: Record<string, string> = {
  cluster: 'multi-process execution is never allowed',
  vm: 'creating further sandboxes is never allowed',
  worker_threads: 'thread execution is never allowed',
  net: 'raw network sockets are never allowed — use the controlled http/https/fetch layer',
  dgram: 'raw network sockets are never allowed',
  dns: 'DNS resolution is not exposed — resolve through the controlled network layer',
  process: 'process manipulation is never allowed',
  perf_hooks: 'performance introspection of the host process is never allowed',
  inspector: 'debugger access is never allowed',
  module: 'module system introspection is never allowed',
  async_hooks: 'host async context introspection is never allowed',
};

function normalizeSpecifier(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

/** Static allowlisted modules resolved via STATIC imports. */
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

/** Resolve a STATIC allowlisted specifier (no fs/child_process here). Throws with the documented wording. */
export function resolveAllowedModule(specifier: string): unknown {
  const name = normalizeSpecifier(String(specifier ?? '').trim());
  if (!name) {
    throw new Error('Module specifier is empty — require() needs an allowlisted module name.');
  }
  if (NODE_BLOCKED_MODULES[name]) {
    throw new Error(`Module "${name}" is not available in the NexTool Node.js environment (${NODE_BLOCKED_MODULES[name]}).`);
  }
  if (name in NODE_MODULE_ALLOWLIST && NODE_MODULE_ALLOWLIST[name].virtual) {
    throw new Error(`Module "${name}" is only available inside a nodejs tool execution — require it at runtime inside your execute function.`);
  }
  if (!(name in ALLOWED_MODULE_OBJECTS)) {
    throw new Error(
      `Module "${name}" is not available in the NexTool Node.js environment. Allowed modules: ${Object.keys(NODE_MODULE_ALLOWLIST).join(', ')}.`,
    );
  }
  return ALLOWED_MODULE_OBJECTS[name];
}

/** importModuleDynamically callback — static allowlist only (compile-time import()). */
function importAllowedModule(specifier: string | number | undefined): Promise<unknown> {
  const name = normalizeSpecifier(String(specifier ?? ''));
  return Promise.resolve(resolveAllowedModule(name));
}

// ---------- virtualized os module (§5) ----------

function createOsModule(): Record<string, unknown> {
  const os: Record<string, unknown> = {
    EOL: '\n',
    platform: () => 'nextool-virtual',
    arch: () => 'x64',
    hostname: () => 'nextool-sandbox',
    type: () => 'NexTool',
    release: () => '1.0.6',
    tmpdir: () => '/tmp',
    cpus: () => [{ model: 'nextool-virtual', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }],
    totalmem: () => NODE_MEMORY_LIMIT_MB * 1024 * 1024,
    freemem: () => NODE_MEMORY_LIMIT_MB * 1024 * 1024,
    userInfo: () => ({ username: 'nextool', homedir: '/workspace', shell: null }),
    loadavg: () => [0, 0, 0],
  };
  os.default = os;
  return os;
}

function createTimersModule(): Record<string, unknown> {
  const timers: Record<string, unknown> = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
  };
  const timersPromises = {
    setTimeout: (ms: number, value?: unknown) => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
    setImmediate: (value?: unknown) => Promise.resolve(value),
    setInterval: () => { throw new Error('timers/promises.setInterval is not available — the execution deadline would abort it.'); },
  };
  timers.promises = timersPromises;
  timers.default = timers;
  return timers;
}

// ---------- sandbox globals documented to tool authors ----------

export interface NodeGlobalInfo {
  name: string;
  type: string;
  description: string;
}

export const NODE_SANDBOX_GLOBALS: NodeGlobalInfo[] = [
  { name: 'params', type: 'ToolParams', description: 'Tool parameters (typed from the tool schema).' },
  { name: 'context', type: 'ToolContext', description: 'executionId, taskId, mode, now, log(...) — same contract as the js-function sandbox.' },
  { name: 'console', type: 'Console', description: 'log/warn/error/info — capped at the configured maxLogs lines, shown in the test panel.' },
  { name: 'fetch', type: '(url, init?) => Promise<Response>', description: 'Controlled fetch — NexTool network policy (http/https, configured network.timeoutMs default 60s, 5 MiB response cap default, private hosts blocked).' },
  { name: 'XMLHttpRequest', type: 'XMLHttpRequest', description: 'Real XHR implementation over the same network policy (async only).' },
  { name: 'alert', type: '(message) => Promise<void>', description: 'Async NexTool alert — emits a tool.user_alert runtime event.' },
  { name: 'prompt', type: '(message, defaultValue?) => Promise<string|null>', description: 'Async NexTool prompt — pauses THIS tool until the user answers, cancels or the 120s timeout hits. Never blocks the runtime.' },
  { name: 'confirm', type: '(message, options?) => Promise<boolean>', description: 'v1.0.8 — Async NexTool confirmation — pauses THIS tool, shows the confirmation UI, ALWAYS resolves to a boolean. Cancellation/timeout resolve false.' },
  { name: 'setTimeout / setInterval', type: 'Timers', description: 'Standard timers — the overall execution deadline still applies.' },
  { name: 'Buffer', type: 'Buffer', description: 'Binary data constructor (from the allowlisted buffer module).' },
  { name: 'TextEncoder', type: 'TextEncoder', description: 'UTF-8 encoding.' },
  { name: 'TextDecoder', type: 'TextDecoder', description: 'UTF-8 decoding.' },
  { name: 'URL', type: 'URL', description: 'URL parsing (same as the main realm).' },
  { name: 'URLSearchParams', type: 'URLSearchParams', description: 'Query string handling.' },
  { name: 'atob / btoa', type: '(string) => string', description: 'Base64 decoding/encoding.' },
  { name: 'structuredClone', type: '<T>(v: T) => T', description: 'Structured deep clone.' },
];

export const NODE_EXECUTION_LIMITS = {
  get timeoutMs() { return liveLimits().execTimeoutMs; },
  get syncTimeoutMs() { return liveLimits().syncTimeoutMs; },
  get memoryLimitMb() { return liveLimits().heapSentinelMb; },
  get maxSourceChars() { return liveLimits().maxSourceChars; },
  get maxResultBytes() { return liveLimits().maxResultBytes; },
  get maxLogLines() { return liveLimits().maxLogs; },
  moduleAllowlist: Object.keys(NODE_MODULE_ALLOWLIST),
  childProcess: CHILD_PROCESS_LIMITS,
  virtualCommands: [...VIRTUAL_COMMANDS],
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

/** v1.0.6 — execution-scoped environment bindings for the nodejs sandbox. */
export interface NodeEnvExecution {
  /** Owning tool (ToolRecord.name) — scopes the VFS workspace. */
  toolId?: string;
  /** Loaded workspace snapshot (attached by the handler factory when toolId is set). */
  vfs?: VirtualFsSession;
  interactions?: SandboxInteractions;
  accounting?: NetworkAccounting;
  moduleCache?: Map<string, unknown>;
  /** v1.0.7 §1 — effective execution timeout (ms) resolved by the tool
   *  runtime (global → tool-specific, capped at 1 h). Defaults to the
   *  documented NODE_TOOL_TIMEOUT_MS (10 s) when absent. Also raised the
   *  ceiling for virtual child_process operations (never shorter than the
   *  hard-coded 8 s when a longer tool timeout is configured). */
  timeoutMs?: number;
  /** v1.0.9 §14 — the EFFECTIVE Network Policy request timeout (ms) resolved
   *  by the handler (request → tool → task → global Settings → default).
   *  When absent the central network.timeoutMs default applies — never the
   *  tool execution timeout. */
  networkTimeoutMs?: number;
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
  const maxChars = liveLimits().maxSourceChars;
  if (source.length > maxChars) {
    return { ok: false, error: `Function source exceeds ${maxChars} characters.` };
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

// ---------- dynamic import() support ----------

// v1.0.8 — the transform + shim binding live in import-resolver.ts (shared
// with js-runner). RUNTIME_IMPORT_SHIM is re-exported above.

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

/** Build the per-execution import context used by require()/import(). */
function createImportContext(
  exec: NodeEnvExecution,
  accounting: NetworkAccounting,
  moduleCache: Map<string, unknown>,
  sandboxRequire: (specifier: string) => unknown,
): ImportContext {
  return {
    toolId: exec.toolId,
    vfs: exec.vfs,
    accounting,
    moduleCache,
    resolveBare: sandboxRequire,
  };
}

/**
 * Execute a nodejs tool. NEVER throws — returns a structured result with the
 * same shape as js-runner so /api/tools/test and the executor share one path.
 * `exec` carries the execution-scoped environment (VFS, interactions, network
 * accounting) — the production handler factory and the test route both wire it.
 */
export function runNodeTool(
  source: string,
  params: Record<string, unknown>,
  context: NodeToolContext,
  exec: NodeEnvExecution = {},
): Promise<NodeToolRunResult> {
  return new Promise((resolve) => {
    const caps = liveLimits();
    const logger: LoggerState = { lines: [] };
    const logs = logger.lines;
    const pushLog = (...parts: unknown[]) => {
      if (logs.length >= caps.maxLogs) return;
      logs.push(parts.map(stringifyLogPart).join(' ').slice(0, caps.maxLogLineChars));
    };

    const accounting = exec.accounting ?? createNetworkAccounting(exec.networkTimeoutMs);
    const moduleCache = exec.moduleCache ?? new Map<string, unknown>();
    const processCount = { n: 0 };

    // v1.0.7 §1 — effective execution timeout (global → tool config); the cap
    // is the LIVE execution.timeoutMs.MAX (shipped 1 h) — v1.0.9 fixes the
    // v1.0.8 regression that clamped to the execution.timeoutMs DEFAULT
    // (10000 ms), killing legitimate long-running tools (spec §14).
    const execTimeoutMs = exec.timeoutMs && Number.isFinite(exec.timeoutMs) && exec.timeoutMs > 0
      ? Math.min(Math.round(exec.timeoutMs), maxToolTimeoutMs())
      : caps.execTimeoutMs;

    // Interaction-aware deadline (§1.6/§1.7): while a prompt waits for the
    // user the deadline is deferred; once resolved it resets. The runtime
    // itself never blocks — only this tool's Promise pends.
    let deadline = Date.now() + execTimeoutMs;
    const deadlineCtl = {
      extendDeadline: () => {
        deadline = Math.max(deadline, Date.now() + 130_000);
      },
      resetDeadline: () => {
        deadline = Date.now() + execTimeoutMs;
      },
    };
    const interactions = exec.interactions
      ?? (context.mode === 'test' ? createTestInteractions() : createRuntimeInteractions(context.taskId, context.executionId, exec.toolId, deadlineCtl));

    let settled = false;
    const finish = (result: NodeToolRunResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      resolve({ ...result, logs: [...logs] });
    };

    const baseline = process.memoryUsage().heapUsed;
    const heapSentinelMb = caps.heapSentinelMb;
    const watchdog = setInterval(() => {
      const grownMb = (process.memoryUsage().heapUsed - baseline) / (1024 * 1024);
      if (grownMb > heapSentinelMb) {
        finish({
          ok: false,
          error: { code: 'MEMORY', message: `Function exceeded the ${heapSentinelMb} MiB heap-growth sentinel and was aborted.` },
          logs: [],
        });
        return;
      }
      if (Date.now() > deadline) {
        finish({ ok: false, error: { code: 'TIMEOUT', message: `Function exceeded ${execTimeoutMs}ms and was aborted.` }, logs: [] });
      }
    }, 250);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    // Context-provided (virtual) modules — built around THIS execution.
    const contextModules: Record<string, () => unknown> = {
      fs: () => exec.vfs ? createFsModule(exec.vfs) : (() => { throw new Error('Module "fs" (Virtual FS) is not available in this execution — no virtual workspace is attached.'); })(),
      os: () => createOsModule(),
      timers: () => createTimersModule(),
      'timers/promises': () => (createTimersModule() as Record<string, unknown>).promises,
      http: () => createHttpLikeModule('http', accounting),
      https: () => createHttpLikeModule('https', accounting),
      child_process: () => exec.vfs ? createChildProcessModule(exec.vfs, processCount, { maxTimeoutMs: execTimeoutMs, accounting }) : (() => { throw new Error('Module "child_process" is not available in this execution — no virtual workspace is attached.'); })(),
    };

    const sandboxRequire = (specifier: string): unknown => {
      const name = normalizeSpecifier(String(specifier ?? '').trim());
      if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
        // §6.4 — VFS module imports resolve inside the tool workspace.
        return requireFromVfs(importCtx, '/workspace/execute.js', name);
      }
      if (NODE_BLOCKED_MODULES[name]) {
        throw new Error(`Module "${name}" is not available in the NexTool Node.js environment (${NODE_BLOCKED_MODULES[name]}).`);
      }
      if (name in contextModules) return contextModules[name]();
      if (name in NODE_MODULE_ALLOWLIST && NODE_MODULE_ALLOWLIST[name].virtual) {
        // e.g. fs without an attached VFS — contextModules throws the pointed error.
        return contextModules[name]();
      }
      return resolveAllowedModule(name);
    };

    // §6.7 — import() resolves through the SAME context-aware resolver as
    // require() (bare specifiers delegate to sandboxRequire).
    const importCtx = createImportContext(exec, accounting, moduleCache, sandboxRequire);
    const dynamicImportShim = (specifier: string): Promise<unknown> => {
      return resolveToolImport(specifier, importCtx);
    };

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
        // §1.1 common APIs
        fetch: (input: string | URL, init?: { method?: string; headers?: Record<string, string>; body?: string }) => policyFetch(input, init ?? {}, accounting),
        XMLHttpRequest: createXhrClass() as unknown,
        alert: interactions.alert,
        prompt: interactions.prompt,
        // v1.0.8 §1 — async confirm(): NexTool confirmation UI, boolean result.
        confirm: interactions.confirm,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Buffer,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob,
        btoa,
        structuredClone,
        // require()/import() are the ONLY module surface — resolver-enforced.
        require: sandboxRequire,
        [RUNTIME_IMPORT_SHIM]: dynamicImportShim,
        // Intentionally NOT provided: process, net, dns, worker_threads, fs host, global escapes.
      });
    } catch (err) {
      finish({ ok: false, error: { code: 'SANDBOX_ERROR', message: err instanceof Error ? err.message : 'Failed to create sandbox.' }, logs: [] });
      return;
    }

    try {
      const compiled = new vm.Script(wrapSource(transformDynamicImports(source)), {
        filename: 'node-tool-function.js',
        importModuleDynamically: importAllowedModule,
      } as vm.ScriptOptions);
      const fn = compiled.runInContext(sandbox, { timeout: caps.syncTimeoutMs }) as
        | ((p: Record<string, unknown>, c: unknown) => Promise<unknown>);
      if (typeof fn !== 'function') {
        finish({ ok: false, error: { code: 'INVALID_FUNCTION', message: 'Source did not compile to an execute function.' }, logs: [] });
        return;
      }
      const host = sandbox as unknown as Record<string, unknown>;
      host.__nexoolRun = fn;
      new vm.Script('__nexoolResult = __nexoolRun(params, context)', { filename: 'node-tool-function.js' })
        .runInContext(sandbox, { timeout: caps.syncTimeoutMs });
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
          // v1.0.9 §14.7 — stable error codes survive the sandbox boundary
          // (NetworkPolicyError.NETWORK_TIMEOUT stays NETWORK_TIMEOUT).
          const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : undefined;
          finish({
            ok: false,
            error: { code: code && code !== 'TOOL_FAILURE' ? code : 'TOOL_FAILURE', message: err instanceof Error ? err.message : String(err) },
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
