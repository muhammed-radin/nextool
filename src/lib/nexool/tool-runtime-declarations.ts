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
 * NexTool js-function tool runtime (v1.0.2).
 *
 * Signature: async function execute(params, context) { ... return value; }
 * The sandbox exposes ONLY what is documented here — no require, no process,
 * no fetch, no timers (documented limitation, see docs/tool-development.md).
 */

/** Parameters validated against the tool schema (see the References pane). */
declare function execute(params: ToolParams, context: ToolContext): Promise<ToolResult> | ToolResult;

/** Structured log line — visible in the Tool IDE test panel (max 100 lines). */
declare function log(...parts: unknown[]): void;

/** What a tool may return — must be JSON-serializable (max 64 KiB, depth 12). */
type ToolResult = unknown;

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
}

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
    `/** Any other module is rejected at runtime — see the References pane. */\ndeclare function require(id: string): never;`,
  );
  return `${RUNTIME_DECLARATIONS}\n${NODE_GLOBALS_DECLARATIONS}\n${requireOverloads.join('\n')}\n\n${buildParamsDeclaration(schema)}`;
}

/** Reference entries for the nodejs environment pane (rendered alongside the live allowlist data). */
export function getNodeReferenceEntries(schema: ToolSchema | undefined | null): {
  name: string; type: string; description: string;
}[] {
  return [
    ...getReferenceEntries(schema),
    { name: 'require(...)', type: '(id: string) => module', description: 'Allowlisted Node.js modules only — unknown ids fail with a clear error.' },
    { name: 'await import(...)', type: '(id: string) => Promise<module>', description: 'Dynamic import passes through the SAME allowlist as require().' },
    { name: 'Buffer', type: 'Buffer', description: 'Binary data — also importable from the "buffer" module.' },
    { name: 'TextEncoder / TextDecoder', type: 'constructor', description: 'UTF-8 conversion helpers.' },
    { name: 'URL / URLSearchParams', type: 'constructor', description: 'URL parsing without network access.' },
  ];
}
