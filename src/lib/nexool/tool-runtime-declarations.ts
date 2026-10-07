/**
 * NexTool v1.0.2 — Tool IDE IntelliSense declarations (spec §19-22).
 *
 * ONE shared declaration source consumed by the Monaco editor's JS defaults
 * (extraLib) AND rendered as the "References" pane in the Tool IDE. It
 * documents exactly the runtime API that exists in js-runner.ts — nothing
 * fabricated (spec §21).
 *
 * Schema-driven typing: `buildParamsDeclaration(schema)` turns the tool's
 * ToolSchema into a concrete `params` interface so `params.serverId` etc. get
 * real completion + type hints (spec §20).
 */

import type { ToolSchema } from './types';

const RUNTIME_DECLARATIONS = `
/**
 * NexTool function tool runtime (v1.0.6).
 *
 * Signature: async function execute(params, context) { ... return value; }
 * v1.0.6 — both function environments share the common safe baseline:
 * controlled fetch / XMLHttpRequest, async alert() / prompt() and timers.
 * There is NO process, NO host fs, NO unrestricted network — everything here
 * exists at runtime (spec §1.8: never advertise an API execution rejects).
 */

/** Parameters validated against the tool schema (see the References pane). */
declare function execute(params: ToolParams, context: ToolContext): Promise<ToolResult> | ToolResult;

/** Structured log line — visible in the Tool IDE test panel (max 100 lines). */
declare function log(...parts: unknown[]): void;

/** What a tool may return — must be JSON-serializable (max 64 KiB, depth 12). */
type ToolResult = unknown;

/** v1.0.13 §14 — subtool API exposed as context.tools on the execution context. */
interface SandboxToolsApi {
  /** Execute another registered NexTool tool and await its result object. */
  call(toolName: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Configured maximum subtool depth (shipped 3). */
  readonly maxDepth: number;
  /** Configured maximum calls per top-level execution (shipped 20). */
  readonly maxCalls: number;
  /** Calls already consumed by this execution tree. */
  usedCalls(): number;
  /** Calls left before SUBTOOL_LIMIT is raised. */
  remainingCalls(): number;
  /** Depth of the execution holding this API (0 = top level). */
  readonly depth: number;
}

interface ToolContext {
  /** Unique id of this execution (e.g. "exec_...", "test_..."). */
  executionId: string;
  /** Owning task id — null during Tool IDE test runs. */
  taskId: string | null;
  /** "test" for Tool IDE test runs, "production" for real task executions. */
  mode: 'test' | 'production';
  /** ISO timestamp at invocation. */
  now: string;
  /** Log helper — collected and shown in the test panel. */
  log: (...parts: unknown[]) => void;
  /** v1.0.13 §14 — the SUBTOOL API: await context.tools.call(name, params)
   *  executes another registered tool through THE ONE execution path
   *  (real ToolExecution, depth/budget/recursion enforced). */
  tools: SandboxToolsApi;
}

// ---- v1.0.6 §1.2/§1.5/§1.6 — controlled network + interaction APIs ----
interface NexToolResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null; has(name: string): boolean; forEach(cb: (value: string, key: string) => void): void };
  json(): Promise<unknown>;
  text(): Promise<string>;
}
declare function fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<NexToolResponse>;
/** v1.0.14 §20 — INTERACTIVE alert: the OK dialog pauses THIS tool until the
 *  operator dismisses it (or the 120s window auto-dismisses). */
declare function alert(message: string): Promise<void>;
/** v1.0.14 §22 — INTERACTIVE prompt with advanced input types. Accepts a
 *  plain message OR a structured spec. Pauses THIS tool until the user
 *  answers in the console/assistant UI, cancels (null), or the 120s window
 *  expires (null). type "file" resolves to a JSON string
 *  { name, mimeType, size, content? } (content only for small files). */
declare function prompt(
  message: string | {
    message: string;
    type?: 'text' | 'textarea' | 'number' | 'email' | 'password' | 'url' | 'search' | 'date' | 'time' | 'datetime-local' | 'month' | 'week' | 'color' | 'file';
    placeholder?: string;
    defaultValue?: string;
  },
  defaultValue?: string,
): Promise<string | null>;
/** v1.0.8 §1 — async NexTool confirmation: ALWAYS resolves to a boolean.
 *  Pauses the tool until the user answers the confirmation UI, cancels
 *  (false) or the 120s window expires (false). */
declare function confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
/** v1.0.13 — async NexTool choice question: the operator picks ONE offered
 *  option; resolves the chosen VALUE string, or null on cancel/timeout.
 *  Options are strings or { value, label? } objects (max 12). */
declare function askForUserAsChoice(message: string, choices: Array<string | { value: string; label?: string }>, options?: { default?: string }): Promise<string | null>;
declare function setTimeout(cb: (...args: unknown[]) => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare function setInterval(cb: (...args: unknown[]) => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;

// ---- available ES builtins inside the sandbox ----
declare const JSON: JSON;
declare const Math: Math;
declare const Date: DateConstructor;
declare const Number: NumberConstructor;
declare const String: StringConstructor;
declare const Boolean: BooleanConstructor;
declare const Array: ArrayConstructor;
declare const Object: ObjectConstructor;
declare const RegExp: RegExpConstructor;
declare const Error: ErrorConstructor;
declare const Map: MapConstructor;
declare const Set: SetConstructor;
declare const isNaN: (n: number) => boolean;
declare const isFinite: (n: number) => boolean;
declare const parseFloat: (s: string) => number;
declare const parseInt: (s: string, radix?: number) => number;
`;

/** JSON-schema-ish ToolParamDef → TS type. */
function paramType(type: string): string {
  switch (type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'Record<string, unknown>';
    case 'array': return 'unknown[]';
    default: return 'unknown';
  }
}

/**
 * Build a concrete `interface ToolParams` from the tool's schema so the editor
 * understands `params.<name>` (spec §20). Enum values become union types.
 */
export function buildParamsDeclaration(schema: ToolSchema | undefined | null): string {
  const props = schema?.properties ?? [];
  if (props.length === 0) {
    return 'interface ToolParams extends Record<string, unknown> {}\n';
  }
  const lines: string[] = ['/** Typed from the tool schema (Schema pane). */', 'interface ToolParams {'];
  for (const p of props) {
    let t = paramType(p.type);
    if (p.type === 'string' && p.enumValues && p.enumValues.length > 0) {
      t = p.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
    }
    const doc = p.description ? `  /** ${p.description}${p.generation ? ` (${p.generation})` : ''} */\n` : '';
    lines.push(`${doc}  ${p.name}${p.required ? '' : '?'}: ${t};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** Full extraLib text for a tool: runtime API + schema-driven params. */
export function buildToolExtraLib(schema: ToolSchema | undefined | null): string {
  return `${RUNTIME_DECLARATIONS}\n${buildParamsDeclaration(schema)}`;
}

/** Human-readable reference entries rendered in the Tool IDE References pane. */
export function getReferenceEntries(schema: ToolSchema | undefined | null): {
  name: string; type: string; description: string;
}[] {
  return [
    { name: 'params', type: 'ToolParams', description: 'Validated tool parameters — typed from your schema below.' },
    { name: 'context.executionId', type: 'string', description: 'Unique id of this execution run.' },
    { name: 'context.taskId', type: 'string | null', description: 'Owning task id; null during Tool IDE tests.' },
    { name: 'context.mode', type: '"test" | "production"', description: 'Distinguishes Tool IDE test runs from real task executions.' },
    { name: 'context.now', type: 'string', description: 'ISO timestamp captured at invocation.' },
    { name: 'context.log(...)', type: '(...parts: unknown[]) => void', description: 'Log lines (max 100) surfaced in the test panel.' },
    { name: 'await context.tools.call(name, params?)', type: '(toolName, params?) => Promise<unknown>', description: 'v1.0.13 §14 SUBTOOL API — executes another registered tool as a REAL ToolExecution. Max depth 3, max 20 calls per top-level execution, recursion/cycles rejected. Test mode: built-in tools only.' },
    { name: 'await fetch(url, init?)', type: '(url, init?) => Promise<Response>', description: 'v1.0.8 controlled fetch — http/https only, 60s timeout default (network.timeoutMs), 5 MiB response cap default, private hosts blocked, max 56 requests per execution default — all configurable via the central limits.' },
    { name: 'await alert(message)', type: '(message) => Promise<void>', description: 'v1.0.14 — INTERACTIVE alert dialog: pauses THIS tool until the operator clicks OK (or the 120s window auto-dismisses).' },
    { name: 'await prompt(message | spec, default?)', type: '(string | { message, type?, placeholder?, defaultValue? }) => Promise<string | null>', description: 'v1.0.14 §22 — INTERACTIVE prompt with advanced input types: text, textarea, number, email, password, url, search, date, time, datetime-local, month, week, color, file (file resolves to a JSON string { name, mimeType, size, content? }). Pauses THIS tool until the user answers, cancels, or 120s pass. Never blocks the runtime.' },
    { name: 'await confirm(message, options?)', type: '(message, options?: { default?: boolean }) => Promise<boolean>', description: 'v1.0.8 — NexTool confirmation UI. ALWAYS resolves to a boolean; cancellation/timeout resolve false.' },
    { name: 'await askForUserAsChoice(message, choices, options?)', type: '(message, choices: Array<string | { value, label? }>, options?: { default?: string }) => Promise<string | null>', description: 'v1.0.13 — multiple-choice operator question. Renders one button per option in the console; resolves the chosen VALUE (or null on cancel/timeout — never a fabricated option). Max 12 options.' },
    { name: 'setTimeout / setInterval', type: 'Timers', description: 'Standard timers — the overall execution deadline still applies.' },
    ...(() => {
      const props = schema?.properties ?? [];
      if (props.length === 0) return [];
      return [{
        name: 'params.*',
        type: props.map((p) => `${p.name}${p.required ? '' : '?'}:${paramType(p.type)}`).join(' · '),
        description: 'Schema-derived parameters (typed in IntelliSense).',
      }];
    })(),
  ];
}

// ==================== v1.0.5 — nodejs environment (§3.6/§3.7) ====================

/**
 * Light-but-real type surface for the RESTRICTED Node.js environment. The
 * generated extraLib includes ONLY modules present in the runtime's allowlist
 * (mirrored by /api/tools/environments — the same source the reference panel
 * renders). Non-allowlisted module ids hit the final `require(id: string)`
 * overload, so IntelliSense NEVER suggests a module the runtime would reject.
 */
const NODE_MODULE_TYPE_SURFACE: Record<string, string> = {
  buffer: `interface NodeBufferModule {
  Buffer: typeof Buffer;
}`,
  crypto: `interface NodeHash {
  update(data: string | Buffer): NodeHash;
  digest(encoding?: string): string | Buffer;
}
interface NodeHmac {
  update(data: string | Buffer): NodeHmac;
  digest(encoding?: string): string | Buffer;
}
interface NodeCryptoModule {
  createHash(algorithm: string): NodeHash;
  createHmac(algorithm: string, key: string): NodeHmac;
  randomBytes(size: number): Buffer;
  randomUUID(): string;
  timingSafeEqual(a: Buffer, b: Buffer): boolean;
}`,
  events: `interface NodeEventsModule {
  EventEmitter: new () => {
    on(event: string, listener: (...args: unknown[]) => void): void;
    once(event: string, listener: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): boolean;
    off(event: string, listener: (...args: unknown[]) => void): void;
  };
  once(emitter: unknown, name: string): Promise<unknown[]>;
}`,
  path: `interface NodePathModule {
  join(...segments: string[]): string;
  resolve(...segments: string[]): string;
  basename(p: string, ext?: string): string;
  dirname(p: string): string;
  extname(p: string): string;
  parse(p: string): { root: string; dir: string; base: string; ext: string; name: string };
  format(p: Partial<{ root: string; dir: string; base: string; ext: string; name: string }>): string;
  isAbsolute(p: string): boolean;
  sep: string;
}`,
  querystring: `interface NodeQuerystringModule {
  parse(str: string, sep?: string, eq?: string): Record<string, unknown>;
  stringify(obj: Record<string, unknown>, sep?: string, eq?: string): string;
  escape(str: string): string;
  unescape(str: string): string;
}`,
  string_decoder: `interface NodeStringDecoder {
  write(buffer: Buffer): string;
  end(buffer?: Buffer): string;
}
interface NodeStringDecoderModule {
  StringDecoder: new (encoding?: string) => NodeStringDecoder;
}`,
  url: `interface NodeUrlModule {
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  pathToFileURL(p: string): URL;
  fileURLToPath(url: URL | string): string;
}`,
  util: `interface NodeUtilModule {
  inspect(value: unknown, options?: { depth?: number; colors?: boolean; breakLength?: number }): string;
  format(format: string, ...args: unknown[]): string;
  types: Record<string, (value: unknown) => boolean>;
  promisify(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown>;
}`,
  assert: `interface NodeAssertModule {
  ok(value: unknown, message?: string): void;
  equal(actual: unknown, expected: unknown, message?: string): void;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  deepEqual(actual: unknown, expected: unknown, message?: string): void;
  strictEqual(actual: unknown, expected: unknown, message?: string): void;
  throws(fn: () => unknown, message?: string): void;
  fail(message?: string): never;
}`,
  zlib: `interface NodeZlibModule {
  gzipSync(data: string | Buffer, options?: Record<string, unknown>): Buffer;
  gunzipSync(data: Buffer, options?: Record<string, unknown>): Buffer;
  deflateSync(data: string | Buffer, options?: Record<string, unknown>): Buffer;
  inflateSync(data: Buffer, options?: Record<string, unknown>): Buffer;
  brotliCompressSync(data: string | Buffer): Buffer;
  brotliDecompressSync(data: Buffer): Buffer;
}`,
  // ---- v1.0.6 virtual/restricted modules (§2/§3/§4/§5) ----
  fs: `interface NexToolVfsStats {
  path: string;
  kind: 'file' | 'dir';
  size: number;
  createdAt: string;
  updatedAt: string;
}
interface NexToolVfsPromises {
  readFile(path: string, encoding?: string): Promise<string | BufferInstance>;
  writeFile(path: string, data: string | BufferInstance): Promise<void>;
  appendFile(path: string, data: string | BufferInstance): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<NexToolVfsStats>;
  lstat(path: string): Promise<NexToolVfsStats>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}
interface NexToolVfsModule {
  readFile(path: string, encoding?: string): Promise<string | BufferInstance>;
  writeFile(path: string, data: string | BufferInstance): Promise<void>;
  appendFile(path: string, data: string | BufferInstance): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<NexToolVfsStats>;
  lstat(path: string): Promise<NexToolVfsStats>;
  rename(oldPath: string, newPath: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  realpath(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  readFileSync(path: string, encoding?: string): string | BufferInstance;
  writeFileSync(path: string, data: string | BufferInstance): void;
  appendFileSync(path: string, data: string | BufferInstance): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readdirSync(path: string): string[];
  statSync(path: string): NexToolVfsStats;
  lstatSync(path: string): NexToolVfsStats;
  renameSync(oldPath: string, newPath: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  realpathSync(path: string): string;
  promises: NexToolVfsPromises;
  usage(): { usedBytes: number; files: number; limits: Record<string, number> };
  /** Virtual FS workspace: /input /output /tmp /data /workspace — NEVER the host fs. */
}`,
  os: `interface NexToolOsModule {
  EOL: string;
  platform(): 'nextool-virtual';
  arch(): string;
  hostname(): 'nextool-sandbox';
  type(): string;
  tmpdir(): '/tmp';
  cpus(): { model: string; speed: number; times: Record<string, number> }[];
  totalmem(): number;
  freemem(): number;
  userInfo(): { username: string; homedir: string; shell: null };
  loadavg(): number[];
}`,
  timers: `interface NexToolTimersModule {
  setTimeout(cb: (...args: unknown[]) => void, ms?: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(cb: (...args: unknown[]) => void, ms?: number): unknown;
  clearInterval(id: unknown): void;
  setImmediate(cb: (...args: unknown[]) => void): unknown;
  clearImmediate(id: unknown): void;
  promises: {
    setTimeout(ms: number, value?: unknown): Promise<unknown>;
    setImmediate(value?: unknown): Promise<unknown>;
  };
}`,
  'timers/promises': `interface NexToolTimersPromisesModule {
  setTimeout(ms: number, value?: unknown): Promise<unknown>;
  setImmediate(value?: unknown): Promise<unknown>;
}`,
  http: `interface NexToolIncomingMessage {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  on(event: 'data', cb: (chunk: string) => void): void;
  on(event: 'end', cb: () => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}
interface NexToolClientRequest {
  on(event: 'response', cb: (res: NexToolIncomingMessage) => void): NexToolClientRequest;
  on(event: 'error', cb: (err: Error) => void): NexToolClientRequest;
  write(chunk?: string | BufferInstance): NexToolClientRequest;
  end(chunk?: string | BufferInstance): NexToolClientRequest;
  abort(): void;
  setTimeout(ms: number, cb?: () => void): NexToolClientRequest;
}
interface NexToolHttpModule {
  request(options: string, callback?: (res: NexToolIncomingMessage) => void): NexToolClientRequest;
  get(options: string, callback?: (res: NexToolIncomingMessage) => void): NexToolClientRequest;
  METHODS: string[];
  STATUS_CODES: Record<string, string>;
  /** Routed through the NexTool network policy — same rules as fetch. */
}`,
  https: `interface NexToolHttpsModule {
  request(options: string, callback?: (res: NexToolIncomingMessage) => void): NexToolClientRequest;
  get(options: string, callback?: (res: NexToolIncomingMessage) => void): NexToolClientRequest;
  METHODS: string[];
  STATUS_CODES: Record<string, string>;
}`,
  child_process: `interface NexToolExecResult {
  stdout: string;
  stderr: string;
}
interface NexToolVirtualChild {
  stdout: { on(event: 'data', cb: (chunk: string) => void): void };
  stderr: { on(event: 'data', cb: (chunk: string) => void): void };
  exitCode: number | null;
  on(event: 'exit' | 'close', cb: (code: number) => void): void;
  kill(): boolean;
}
interface NexToolChildProcessModule {
  exec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<NexToolExecResult>;
  execSync(command: string, options?: { cwd?: string; env?: Record<string, string> }): string;
  execFile(file: string, args?: string[], options?: { cwd?: string }): Promise<NexToolExecResult>;
  spawn(command: string, args?: string[], options?: { cwd?: string }): NexToolVirtualChild;
  spawnSync(command: string, args?: string[], options?: { cwd?: string }): { status: number; stdout: string; stderr: string };
  /** Virtual commands on the VFS workspace — the host system is NEVER touched. */
}`,
};

const NODE_GLOBALS_DECLARATIONS = `
// ---- globals available in the nodejs sandbox (restricted Node.js env) ----
declare const Buffer: {
  from(value: string, encoding?: string): BufferInstance;
  alloc(size: number, fill?: string | number): BufferInstance;
  concat(list: BufferInstance[]): BufferInstance;
  isBuffer(value: unknown): value is BufferInstance;
  byteLength(value: string, encoding?: string): number;
};
interface BufferInstance {
  length: number;
  toString(encoding?: string, start?: number, end?: number): string;
  toJSON(): { type: string; data: number[] };
  equals(other: BufferInstance): boolean;
  slice(start?: number, end?: number): BufferInstance;
  write(text: string, encoding?: string): number;
}
declare const TextEncoder: new () => { encode(input?: string): Uint8Array; encoding: string };
declare const TextDecoder: new (label?: string) => { decode(input?: Uint8Array | BufferInstance): string; encoding: string };
declare const URL: typeof URL;
declare const URLSearchParams: typeof URLSearchParams;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function structuredClone<T>(value: T): T;
`;

/**
 * extraLib for a `nodejs` tool: the shared runtime contract + restricted
 * Node.js surface built from the LIVE allowlist (§3.7 — IntelliSense knows
 * exactly what the runtime accepts, nothing more).
 */
export function buildNodeExtraLib(
  schema: ToolSchema | undefined | null,
  node: { modules: Record<string, unknown> } | null | undefined,
): string {
  const allowlist = node?.modules ? Object.keys(node.modules) : [];
  const requireOverloads: string[] = [];
  for (const name of allowlist) {
    const iface = NODE_MODULE_TYPE_SURFACE[name] ?? `interface NodeModule_${name.replace(/[^a-z0-9]/gi, '_')} { [key: string]: unknown }`;
    const safe = `NodeModule_${name.replace(/[^a-z0-9]/gi, '_')}`;
    requireOverloads.push(`${iface}\ndeclare function require(id: '${name}'): ${safe};\ndeclare function require(id: 'node:${name}'): ${safe};`);
  }
  requireOverloads.push(
    `/** Relative ids ('./helper.js') resolve inside the tool's Virtual FS workspace;\n *  any other module is rejected at runtime — see the References pane. */\ndeclare function require(id: string): unknown;`,
  );
  return `${RUNTIME_DECLARATIONS}\n${NODE_GLOBALS_DECLARATIONS}\n${requireOverloads.join('\n')}\n\n${buildParamsDeclaration(schema)}`;
}

/** Reference entries for the nodejs environment pane (rendered alongside the live allowlist data). */
export function getNodeReferenceEntries(schema: ToolSchema | undefined | null): {
  name: string; type: string; description: string;
}[] {
  return [
    ...getReferenceEntries(schema),
    { name: 'require(...)', type: '(id: string) => module', description: 'Allowlisted Node modules, virtual modules (fs/child_process/http/…) and VFS-relative files — anything else fails with a clear error.' },
    { name: 'await import(...)', type: '(id: string) => Promise<module>', description: 'Dynamic import passes through the SAME centralized resolver as require().' },
    { name: 'require("fs")', type: 'NexToolVfsModule', description: 'The Virtual File System — persistent per-tool workspace (/input /output /tmp /data /workspace). Never the host fs.' },
    { name: 'require("child_process")', type: 'NexToolChildProcessModule', description: 'RESTRICTED virtual commands (ls, cat, grep, wc, …) executed against the VFS workspace — no host processes.' },
    { name: 'require("http") / require("https")', type: 'NexToolHttpModule', description: 'Controlled HTTP(S) client routed through the same network policy as fetch.' },
    { name: 'Buffer', type: 'Buffer', description: 'Binary data — also importable from the "buffer" module.' },
    { name: 'TextEncoder / TextDecoder', type: 'constructor', description: 'UTF-8 conversion helpers.' },
    { name: 'URL / URLSearchParams', type: 'constructor', description: 'URL parsing without network access.' },
  ];
}
