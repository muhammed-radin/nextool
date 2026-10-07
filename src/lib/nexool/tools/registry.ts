/**
 * NexTool Tool Registry — DB-backed (ToolRecord), seeds built-in tools on first init.
 * Handlers live in-memory (globalThis map); definitions + stats live in SQLite.
 */
import { db } from '@/lib/db';
import type { ToolDefinition, ToolParamDef, ToolStats } from '../types';
import type { ToolHandler, HandlerContext } from './handler';
import { ToolFailure } from './handler';
import {
  systemInfo, mathEvaluate, textAnalyze, timeNow, uuidGenerate, echoEcho, delayWait,
} from './builtin';
import { serverList, serverHealth, serverRestart, serviceRestart } from './virtual';
import { memoryStore, memoryRecall } from './memory';
import { notificationSend } from './notify';
import { imageGenerate } from './image';
import { runJsTool, validateFunctionSource, JS_TOOL_TIMEOUT_MS } from './js-runner';
import { runNodeTool, validateNodeFunctionSource, NODE_TOOL_TIMEOUT_MS } from './node-runner';
import {
  runFreedomNodeTool,
  validateFreedomNodeSource,
  isFreedomNodeAuthorized,
  freedomDisabledError,
} from './freedom-node-runner';
import { resolveNetworkRequestTimeoutForExecution, clampNetworkTimeoutMs } from './network-timeout';
// v1.0.12 §3 — ONE runtime-level shared VFS serves every restricted tool.
import { openGlobalVfs } from './vfs';
// v1.0.12 §4 — native fs.* built-in tools (operate on the shared VFS only).
import {
  FS_TOOL_DEFINITIONS,
  fsCreateFolder,
  fsDeleteFile,
  fsDeleteFolder,
  fsGetPath,
  fsHasFile,
  fsHasFolder,
  fsInfoFile,
  fsList,
  fsReadFile,
  fsWriteFile,
} from './fs-tools';
import { createNetworkAccounting } from './sandbox-net';
import { createTestInteractions } from './sandbox-interactive';
import { createSandboxToolsApi } from './subtool';
import { makeMcpHandler } from './mcp-runner';

// module-scoped syntax cache (compile once per source)
const syntaxCache = new Map<string, { ok: true } | { ok: false; error: string }>();
function validateFunctionSourceCached(source: string): { ok: true } | { ok: false; error: string } {
  const key = `${source.length}:${source}`;
  const cached = syntaxCache.get(key);
  if (cached) return cached;
  const result = validateFunctionSource(source);
  if (syntaxCache.size > 50) syntaxCache.clear();
  syntaxCache.set(key, result);
  return result;
}

/** v1.0.11 — freedom-node syntax validation (same authoring contract). */
function validateFreedomSourceCached(source: string): { ok: true } | { ok: false; error: string } {
  const key = `freedom:${source.length}:${source}`;
  const cached = syntaxCache.get(key);
  if (cached) return cached;
  const result = validateFreedomNodeSource(source);
  if (syntaxCache.size > 50) syntaxCache.clear();
  syntaxCache.set(key, result);
  return result;
}

// ---------- Built-in definitions ----------

function p(
  name: string, type: ToolParamDef['type'], required: boolean, description: string,
  extra: Partial<ToolParamDef> = {},
): ToolParamDef {
  return { name, type, required, description, ...extra };
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'server.health',
    description: 'Checks the health status of a server in the virtual environment.',
    purpose: 'Observe server state before deciding on recovery actions.',
    category: 'monitoring',
    environment: 'virtual-env',
    schema: { type: 'object', properties: [p('serverId', 'string', true, 'Server identifier, e.g. api-01, web-01, db-01', { generation: 'extractive' })] },
  },
  {
    name: 'server.restart',
    description: 'Restarts a server in the virtual environment; it becomes healthy after ~2.5 seconds.',
    purpose: 'Recover an unhealthy or degraded server.',
    category: 'automation',
    environment: 'virtual-env',
    schema: { type: 'object', properties: [p('serverId', 'string', true, 'Server identifier, e.g. api-01', { generation: 'extractive' })] },
  },
  {
    name: 'service.restart',
    description: 'Restarts a service running on a server (alias of server.restart).',
    purpose: 'Recover a failing service.',
    category: 'automation',
    environment: 'virtual-env',
    schema: { type: 'object', properties: [p('serverId', 'string', true, 'Server identifier, e.g. api-01', { generation: 'extractive' })] },
  },
  {
    name: 'server.list',
    description: 'Lists all servers in the virtual environment with health, CPU and memory.',
    purpose: 'Get an overview of the environment.',
    category: 'monitoring',
    environment: 'virtual-env',
    schema: { type: 'object', properties: [] },
  },
  {
    name: 'system.info',
    description: 'Returns real host system information: hostname, platform, CPU count, memory, load average, uptime.',
    purpose: 'Inspect the actual machine the runtime runs on.',
    category: 'monitoring',
    environment: 'builtin',
    schema: { type: 'object', properties: [] },
  },
  {
    name: 'math.evaluate',
    description: 'Evaluates a safe arithmetic expression (+ - * / % parentheses).',
    purpose: 'Compute numeric results.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('expression', 'string', true, 'Arithmetic expression, e.g. (2+3)*4', { generation: 'extractive' })] },
  },
  {
    name: 'text.analyze',
    description: 'Analyzes text: characters, words, sentences, paragraphs and top words.',
    purpose: 'Inspect text statistics.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('text', 'string', true, 'Text to analyze', { generation: 'extractive' })] },
  },
  {
    name: 'time.now',
    description: 'Returns the current time: ISO string, unix ms and formatted in a timezone.',
    purpose: 'Get the current time.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('timezone', 'string', false, 'IANA timezone, e.g. Asia/Kolkata (default UTC)', { generation: 'extractive' })] },
  },
  {
    name: 'uuid.generate',
    description: 'Generates 1-10 UUIDv4 identifiers.',
    purpose: 'Produce unique identifiers.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('count', 'number', false, 'How many UUIDs (1-10, default 1)', { generation: 'extractive', min: 1, max: 10 })] },
  },
  {
    name: 'echo.echo',
    description: 'Echoes a message back. Useful for runtime verification.',
    purpose: 'Test the tool runtime.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('message', 'string', true, 'Message to echo', { generation: 'extractive' })] },
  },
  {
    name: 'delay.wait',
    description: 'Waits for a given number of milliseconds (100-10000) then returns the waited time.',
    purpose: 'Test asynchronous execution and pacing.',
    category: 'utility',
    environment: 'builtin',
    schema: { type: 'object', properties: [p('ms', 'number', false, 'Milliseconds to wait (100-10000)', { generation: 'extractive', min: 100, max: 10000 })] },
  },
  {
    name: 'memory.store',
    description: 'Stores a value in persistent memory under a unique key (upsert).',
    purpose: 'Remember long-term information.',
    category: 'memory',
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('key', 'string', true, 'Unique memory key', { generation: 'extractive' }),
        p('value', 'object', true, 'Value to store (any JSON)', { generation: 'extractive' }),
        p('tags', 'array', false, 'Optional tags', { generation: 'extractive' }),
      ],
    },
  },
  {
    name: 'memory.recall',
    description: 'Recalls a memory entry by key or fuzzy-searches entries by query.',
    purpose: 'Retrieve persistent knowledge.',
    category: 'memory',
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('key', 'string', false, 'Exact memory key', { generation: 'extractive' }),
        p('query', 'string', false, 'Fuzzy search over keys, tags and values', { generation: 'extractive' }),
      ],
    },
  },
  {
    name: 'notification.send',
    description: 'Sends a notification with a level (info, warning, critical).',
    purpose: 'Inform the user about important events.',
    category: 'notification',
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('title', 'string', true, 'Notification title', { generation: 'constructive' }),
        p('body', 'string', false, 'Notification body', { generation: 'constructive' }),
        p('level', 'string', false, 'Severity level', { generation: 'constructive', enumValues: ['info', 'warning', 'critical'] }),
      ],
    },
  },
  {
    name: 'image.generate',
    description: 'Generates an image from a textual description and returns the file path.',
    purpose: 'Produce visual artifacts.',
    category: 'content',
    environment: 'builtin',
    schema: {
      type: 'object',
      properties: [
        p('prompt', 'string', true, 'Rich image description', { generation: 'constructive' }),
        p('size', 'string', false, 'Image size', { generation: 'constructive', enumValues: ['1024x1024', '768x1344', '864x1152', '1344x768', '1152x864', '1440x720', '720x1440'] }),
        p('style', 'string', false, 'Visual style, e.g. photorealistic', { generation: 'constructive' }),
      ],
    },
  },
  // v1.0.12 §4 — native fs.* tools over the GLOBAL SHARED VFS (never the
  // host fs). environment 'builtin' → toolExportClass 'builtin' → never
  // exportable (§2.2).
  ...FS_TOOL_DEFINITIONS,
];

// ---------- Handler registry ----------

interface HandlerState {
  handlers: Map<string, ToolHandler>;
  seeded: boolean;
}

const g = globalThis as unknown as { __nextoolRegistry?: HandlerState };

function handlerState(): HandlerState {
  if (!g.__nextoolRegistry) {
    g.__nextoolRegistry = { handlers: new Map(), seeded: false };
  }
  return g.__nextoolRegistry;
}

function makeHttpGetHandler(config: Record<string, unknown>): ToolHandler {
  const url = typeof config.url === 'string' ? config.url : '';
  const rawTimeout = typeof config.timeout === 'number' ? config.timeout : Number(config.timeout);
  const configuredTimeoutMs = Number.isFinite(rawTimeout)
    ? Math.min(Math.max(Math.round(rawTimeout), 1_000), 15_000)
    : 8000;
  // v1.0.7 §1 — the handler request timeout may now exceed the old 15 s cap
  // when the tool's EFFECTIVE execution timeout is longer; it can never exceed
  // that effective timeout (runtime-enforced ceiling).
  return async (_params, ctx) => {
    const effective = ctx.timeoutMs && ctx.timeoutMs > 0 ? ctx.timeoutMs : 15_000;
    const timeoutMs = Math.min(Math.max(configuredTimeoutMs, 1_000), Math.max(15_000, effective));
    if (!url) throw new ToolFailure('http_get tool has no configured url', 'INVALID_CONFIG');
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, body: text.slice(0, 2000) };
  };
}

export function resolveHandler(def: ToolDefinition): ToolHandler | undefined {
  const s = handlerState();
  const existing = s.handlers.get(def.name);
  if (existing) return existing;

  const builtinMap: Record<string, ToolHandler> = {
    'system.info': systemInfo,
    'math.evaluate': mathEvaluate,
    'text.analyze': textAnalyze,
    'time.now': timeNow,
    'uuid.generate': uuidGenerate,
    'echo.echo': echoEcho,
    'delay.wait': delayWait,
    'server.list': serverList,
    'server.health': serverHealth,
    'server.restart': serverRestart,
    'service.restart': serviceRestart,
    'memory.store': memoryStore,
    'memory.recall': memoryRecall,
    'notification.send': notificationSend,
    'image.generate': imageGenerate,
    // v1.0.12 §4 — shared-VFS filesystem tools
    'fs.list': fsList,
    'fs.readfile': fsReadFile,
    'fs.writefile': fsWriteFile,
    'fs.getpath': fsGetPath,
    'fs.hasfile': fsHasFile,
    'fs.hasfolder': fsHasFolder,
    'fs.infofile': fsInfoFile,
    'fs.createfolder': fsCreateFolder,
    'fs.deletefile': fsDeleteFile,
    'fs.deletefolder': fsDeleteFolder,
  };

  const builtin = builtinMap[def.name];
  if (builtin) {
    s.handlers.set(def.name, builtin);
    return builtin;
  }

  if (def.environment === 'js-function' && typeof def.functionSource === 'string' && def.functionSource.trim()) {
    const jsHandler = makeJsHandler(def.name, def.functionSource, def.networkTimeoutMs);
    s.handlers.set(def.name, jsHandler);
    return jsHandler;
  }

  // v1.0.5 — nodejs environment executes through the restricted Node.js sandbox.
  if (def.environment === 'nodejs' && typeof def.functionSource === 'string' && def.functionSource.trim()) {
    const nodeHandler = makeNodeHandler(def.name, def.functionSource, def.networkTimeoutMs);
    s.handlers.set(def.name, nodeHandler);
    return nodeHandler;
  }

  // v1.0.11 — freedom-node executes through the DEDICATED unrestricted runner
  // (§31): the restricted js/node runners are untouched. The real-fs/network
  // escape is gated server-side by the central `fs` configuration (fail closed).
  if (def.environment === 'freedom-node' && typeof def.functionSource === 'string' && def.functionSource.trim()) {
    const freedomHandler = makeFreedomNodeHandler(def.name, def.functionSource);
    s.handlers.set(def.name, freedomHandler);
    return freedomHandler;
  }

  // v1.0.12 — mcp environment: the handler proxies the call through the owning
  // connector to the remote MCP server (official SDK client). MCP protocol
  // handling stays in mcp-runner + mcp/client — the executor contract is
  // unchanged (same lifecycle, same structured failures).
  if (def.environment === 'mcp' && def.mcp) {
    const mcpHandler = makeMcpHandler(def.mcp);
    s.handlers.set(def.name, mcpHandler);
    return mcpHandler;
  }

  if (def.environment === 'dynamic' && def.handlerKind) {
    const config = def.handlerConfig ?? {};
    let dynamic: ToolHandler | undefined;
    switch (def.handlerKind) {
      case 'echo': dynamic = echoEcho; break;
      case 'delay': dynamic = delayWait; break;
      case 'uuid': dynamic = uuidGenerate; break;
      case 'http_get': dynamic = makeHttpGetHandler(config); break;
    }
    if (dynamic) {
      s.handlers.set(def.name, dynamic);
      return dynamic;
    }
  }
  return undefined;
}

// ---------- Seeding ----------

export async function ensureToolsSeeded(): Promise<void> {
  const s = handlerState();
  if (s.seeded) return;
  s.seeded = true;
  try {
    for (const def of BUILTIN_TOOLS) {
      await db.toolRecord.upsert({
        where: { name: def.name },
        update: {
          description: def.description,
          purpose: def.purpose ?? null,
          category: def.category,
          environment: def.environment,
          definition: JSON.stringify(def),
        },
        create: {
          name: def.name,
          description: def.description,
          purpose: def.purpose ?? null,
          category: def.category,
          environment: def.environment,
          definition: JSON.stringify(def),
          handlerKind: null,
          handlerConfig: null,
          enabled: true,
        },
      });
    }
  } catch (err) {
    s.seeded = false;
    console.error('[registry] seeding failed:', err);
  }
}

// ---------- Queries ----------

export interface ToolEntryFull {
  name: string;
  description: string;
  purpose?: string;
  category: string;
  environment: ToolDefinition['environment'];
  definition: ToolDefinition;
  schema: ToolDefinition['schema'];
  handlerKind?: string;
  /** v1.0.5: dynamic handler configuration (parsed). */
  handlerConfig?: Record<string, unknown>;
  /** v1.0.2: JavaScript source for js-function tools. */
  functionSource?: string;
  /** v1.0.2: user-facing tool version string. */
  toolVersion?: string;
  /** v1.0.5: user metadata key/value pairs. */
  metadata?: Record<string, string>;
  /** v1.0.6: per-tool auto-execute policy (default false = approval required). */
  autoExecute?: boolean;
  /** v1.0.13: verification latch — completed executions wait for operator verification. */
  verificationLatch?: boolean;
  /** v1.0.7 §1: tool-specific execution timeout (ms) — overrides the global
   *  default; runtime caps at 1 hour. Undefined = use global default. */
  timeoutMs?: number;
  /** v1.0.9 §14: tool-specific Network Policy request timeout (ms).
   *  Undefined = use task policy → global Settings → shipped default. */
  networkTimeoutMs?: number;
  enabled: boolean;
  stats: ToolStats;
  createdAt: string;
}

function rowToEntry(row: {
  name: string; description: string; purpose: string | null; category: string;
  environment: string; definition: string; handlerKind: string | null; handlerConfig?: string | null;
  functionSource?: string | null;
  toolVersion?: string | null; enabled: boolean;
  callCount: number; successCount: number; failureCount: number; timeoutCount: number;
  totalMs: number; createdAt: Date;
}): ToolEntryFull {
  let def: ToolDefinition;
  try {
    def = JSON.parse(row.definition) as ToolDefinition;
  } catch {
    def = { name: row.name, description: row.description, category: row.category, environment: 'builtin', schema: { type: 'object', properties: [] } };
  }
  const source = row.functionSource ?? def.functionSource;
  return {
    name: row.name,
    description: row.description,
    purpose: row.purpose ?? undefined,
    category: row.category,
    environment: (row.environment as ToolDefinition['environment']) ?? 'builtin',
    definition: def,
    schema: def.schema ?? { type: 'object', properties: [] },
    handlerKind: row.handlerKind ?? undefined,
    handlerConfig: (() => {
      if (row.handlerConfig) {
        try { return JSON.parse(row.handlerConfig) as Record<string, unknown>; } catch { return undefined; }
      }
      return def.handlerConfig && typeof def.handlerConfig === 'object' ? def.handlerConfig : undefined;
    })(),
    functionSource: source ?? undefined,
    toolVersion: row.toolVersion ?? def.toolVersion ?? undefined,
    metadata: def.metadata && typeof def.metadata === 'object' ? def.metadata : undefined,
    /** v1.0.6: per-tool auto-execute policy (default false = approval required). */
    autoExecute: def.autoExecute === true,
    /** v1.0.13: verification latch (default OFF). */
    verificationLatch: def.verificationLatch === true,
    /** v1.0.7 §1: tool-specific execution timeout (ms). */
    timeoutMs: typeof def.timeoutMs === 'number' && Number.isFinite(def.timeoutMs) && def.timeoutMs > 0 ? def.timeoutMs : undefined,
    /** v1.0.9 §14: tool-specific Network Policy request timeout (ms). */
    networkTimeoutMs: typeof def.networkTimeoutMs === 'number' && Number.isFinite(def.networkTimeoutMs) && def.networkTimeoutMs > 0 ? def.networkTimeoutMs : undefined,
    enabled: row.enabled,
    stats: {
      callCount: row.callCount,
      successCount: row.successCount,
      failureCount: row.failureCount,
      timeoutCount: row.timeoutCount,
      avgMs: row.callCount > 0 ? Math.round(row.totalMs / row.callCount) : 0,
      enabled: row.enabled,
    },
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listTools(): Promise<ToolEntryFull[]> {
  await ensureToolsSeeded();
  const rows = await db.toolRecord.findMany({ orderBy: [{ environment: 'asc' }, { name: 'asc' }] });
  return rows.map(rowToEntry);
}

export async function getToolEntry(name: string): Promise<ToolEntryFull | undefined> {
  const row = await db.toolRecord.findUnique({ where: { name } });
  return row ? rowToEntry(row) : undefined;
}

export async function getEnabledToolDefs(enabledFilter?: string[]): Promise<ToolDefinition[]> {
  await ensureToolsSeeded();
  const rows = await db.toolRecord.findMany({ where: { enabled: true } });
  let defs = rows.map((r) => rowToEntry(r).definition);
  if (enabledFilter && enabledFilter.length > 0) {
    const allow = new Set(enabledFilter);
    defs = defs.filter((d) => allow.has(d.name));
  }
  return defs;
}

export async function getToolDef(name: string): Promise<ToolDefinition | undefined> {
  const row = await db.toolRecord.findUnique({ where: { name } });
  if (!row) return undefined;
  return rowToEntry(row).definition;
}

export async function isToolEnabled(name: string): Promise<boolean> {
  const row = await db.toolRecord.findUnique({ where: { name }, select: { enabled: true } });
  return row?.enabled ?? false;
}

// ---------- Mutations ----------

const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*$/;
/**
 * v1.0.5 §2.5 — the REAL dynamic handler-kind registry. The Tool IDE env
 * selector/handler UI reads this via GET /api/tools/environments — never a
 * hardcoded frontend copy.
 */
const HANDLER_KINDS = ['echo', 'delay', 'http_get', 'uuid'] as const;
type DynamicHandlerKind = (typeof HANDLER_KINDS)[number];

export interface HandlerKindInfo {
  kind: DynamicHandlerKind;
  label: string;
  description: string;
  /** Structured configuration fields the Tool IDE renders per kind (§2.6). */
  configFields: {
    key: string;
    label: string;
    type: 'string' | 'number';
    required: boolean;
    description: string;
    min?: number;
    max?: number;
    placeholder?: string;
  }[];
}

export const HANDLER_KIND_INFO: HandlerKindInfo[] = [
  {
    kind: 'echo', label: 'Echo', description: 'Echoes the "message" request param back. No handler configuration.',
    configFields: [],
  },
  {
    kind: 'delay', label: 'Delay', description: 'Waits for the "ms" request parameter (100–10000). No handler configuration.',
    configFields: [],
  },
  {
    kind: 'http_get', label: 'HTTP GET', description: 'Fetches a configured URL at execution time and returns status + body (first 2000 chars).',
    configFields: [
      { key: 'url', label: 'URL', type: 'string', required: true, description: 'Absolute http(s) URL fetched when the tool executes.', placeholder: 'https://api.example.com/status' },
      { key: 'timeout', label: 'Timeout (ms)', type: 'number', required: false, description: 'Abort the request after this many milliseconds (1000–15000, default 8000). The effective tool execution timeout (v1.0.7) is the real ceiling — a longer tool timeout raises it, never lowers it below the policy.', min: 1000, max: 15000, placeholder: '8000' },
    ],
  },
  {
    kind: 'uuid', label: 'UUID', description: 'Generates UUIDv4s — count from the "count" request parameter (1–10). No handler configuration.',
    configFields: [],
  },
];

export function isHandlerKind(kind: string): kind is DynamicHandlerKind {
  return (HANDLER_KINDS as readonly string[]).includes(kind);
}

// module-scoped nodejs syntax cache (same pattern as the js cache)
function validateNodeSourceCached(source: string): { ok: true } | { ok: false; error: string } {
  const key = `node:${source.length}:${source}`;
  const cached = syntaxCache.get(key);
  if (cached) return cached;
  const result = validateNodeFunctionSource(source);
  if (syntaxCache.size > 50) syntaxCache.clear();
  syntaxCache.set(key, result);
  return result;
}

/** v1.0.5 — metadata must be a flat string→string record (structured key/value UI). */
function assertStringRecord(value: Record<string, unknown>, field: string): void {
  for (const [k, v] of Object.entries(value)) {
    if (!k.trim()) throw new ToolFailure(`${field} keys must be non-empty strings.`, 'INVALID_PARAMS');
    if (typeof v !== 'string') {
      throw new ToolFailure(`${field}["${k}"] must be a string value (the metadata editor stores string key/value pairs).`, 'INVALID_PARAMS');
    }
  }
  if (Object.keys(value).length > 50) {
    throw new ToolFailure(`${field} supports at most 50 key/value pairs.`, 'INVALID_PARAMS');
  }
}

export async function registerDynamicTool(
  definition: ToolDefinition,
  handlerKind?: DynamicHandlerKind,
  handlerConfig?: Record<string, unknown>,
): Promise<ToolEntryFull> {
  await ensureToolsSeeded();
  if (!definition || typeof definition !== 'object') {
    throw new ToolFailure('definition object is required', 'INVALID_PARAMS');
  }
  if (!TOOL_NAME_RE.test(definition.name)) {
    throw new ToolFailure('Tool name must match pattern "namespace.action" (lowercase, dots/dashes allowed).', 'INVALID_PARAMS');
  }
  const env = definition.environment ?? 'dynamic';
  if (env === 'dynamic' && (!handlerKind || !HANDLER_KINDS.includes(handlerKind))) {
    throw new ToolFailure(`Dynamic tools require handlerKind, one of: ${HANDLER_KINDS.join(', ')}`, 'INVALID_PARAMS');
  }
  if (env === 'js-function' || env === 'nodejs') {
    throw new ToolFailure(`${env} tools must be registered via registerJsTool (POST /api/tools/js)`, 'INVALID_PARAMS');
  }
  const def: ToolDefinition = {
    ...definition,
    description: definition.description || 'User-registered dynamic tool.',
    category: definition.category || 'general',
    environment: env,
    schema: definition.schema && Array.isArray(definition.schema.properties) ? definition.schema : { type: 'object', properties: [] },
    handlerKind: env === 'dynamic' ? handlerKind : undefined,
    handlerConfig: env === 'dynamic' ? (handlerConfig ?? {}) : undefined,
  };

  const exists = await db.toolRecord.findUnique({ where: { name: def.name } });
  if (exists) throw new ToolFailure(`Tool already registered: ${def.name}`, 'ALREADY_EXISTS');

  const row = await db.toolRecord.create({
    data: {
      name: def.name,
      description: def.description,
      purpose: def.purpose ?? null,
      category: def.category,
      environment: def.environment,
      definition: JSON.stringify(def),
      handlerKind: def.handlerKind ?? null,
      handlerConfig: def.handlerConfig ? JSON.stringify(def.handlerConfig) : null,
      enabled: true,
    },
  });
  // resolve handler eagerly so it is cached
  resolveHandler(def);
  return rowToEntry(row);
}

export interface JsToolRegistration {
  name: string;
  description?: string;
  purpose?: string;
  category?: string;
  schema: ToolDefinition['schema'];
  functionSource: string;
  toolVersion?: string;
  /** v1.0.5: function-sandbox environment — js-function (default) or nodejs. */
  environment?: 'js-function' | 'nodejs' | 'freedom-node';
  /** v1.0.5: structured user metadata key/value pairs. */
  metadata?: Record<string, string>;
  /** v1.0.6 §9.2: per-tool auto-execute configuration (persists with the tool). */
  autoExecute?: boolean;
  /** v1.0.13 — verification latch: hold COMPLETED executions of this tool
   *  open until the operator verifies the result (review gate). */
  verificationLatch?: boolean;
  /** v1.0.7 §1: tool-specific execution timeout (ms, 1000–3600000). */
  timeoutMs?: number;
  /** v1.0.9 §14: tool-specific Network Policy request timeout (ms). */
  networkTimeoutMs?: number;
  enabled?: boolean;
}

/**
 * Register a function-sandbox tool (js-function | nodejs | freedom-node —
 * Tool IDE "Save"). Validates name uniqueness, schema shape and function
 * syntax per environment; broken definitions never become active tools
 * (v1.0.2 §24/§25). freedom-node registers like the other function
 * environments; its RUNTIME escape stays gated by the central fs config.
 */
export async function registerJsTool(input: JsToolRegistration): Promise<ToolEntryFull> {
  await ensureToolsSeeded();
  const environment = input.environment === 'nodejs'
    ? 'nodejs'
    : input.environment === 'freedom-node'
      ? 'freedom-node'
      : 'js-function';
  if (!TOOL_NAME_RE.test(input.name)) {
    throw new ToolFailure('Tool name must match pattern "namespace.action" (lowercase, dots/dashes allowed).', 'INVALID_PARAMS');
  }
  if (typeof input.functionSource !== 'string' || input.functionSource.trim().length === 0) {
    throw new ToolFailure('functionSource is required for function tools.', 'INVALID_PARAMS');
  }
  if (input.metadata !== undefined) {
    assertStringRecord(input.metadata, 'metadata');
  }
  const syntax = environment === 'nodejs'
    ? validateNodeSourceCached(input.functionSource)
    : environment === 'freedom-node'
      ? validateFreedomSourceCached(input.functionSource)
      : validateFunctionSourceCached(input.functionSource);
  if (!syntax.ok) throw new ToolFailure(`Function source rejected: ${syntax.error}`, 'INVALID_FUNCTION');
  if (!input.schema || !Array.isArray(input.schema.properties)) {
    throw new ToolFailure('schema with a properties array is required.', 'INVALID_PARAMS');
  }

  const def: ToolDefinition = {
    name: input.name,
    description: input.description?.trim() || 'User-authored JavaScript tool.',
    purpose: input.purpose?.trim() || undefined,
    category: input.category?.trim() || 'general',
    environment,
    schema: input.schema,
    functionSource: input.functionSource,
    toolVersion: input.toolVersion?.trim() || undefined,
    ...(input.metadata && Object.keys(input.metadata).length > 0 ? { metadata: input.metadata } : {}),
    // v1.0.11 §40 — tri-state auto-execution: undefined = INHERIT (the tool
    // does not force a decision; the hierarchy resolves it). An explicit
    // boolean persists as the tool-level config.
    ...(input.autoExecute !== undefined ? { autoExecute: input.autoExecute === true } : {}),
    // v1.0.13 — verification latch (default OFF: execution completes directly).
    ...(input.verificationLatch !== undefined ? { verificationLatch: input.verificationLatch === true } : {}),
    // v1.0.7 §1 — tool-specific execution timeout (runtime also clamps).
    ...(typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? { timeoutMs: Math.min(Math.max(Math.round(input.timeoutMs), 1_000), 3_600_000) }
      : {}),
    // v1.0.9 §14 — tool-specific Network Policy request timeout (clamped
    // into the central network.timeoutMs bounds as defense in depth).
    ...(typeof input.networkTimeoutMs === 'number' && Number.isFinite(input.networkTimeoutMs) && input.networkTimeoutMs > 0
      ? { networkTimeoutMs: clampNetworkTimeoutMs(input.networkTimeoutMs) }
      : {}),
  };

  const exists = await db.toolRecord.findUnique({ where: { name: def.name } });
  if (exists) throw new ToolFailure(`Tool already registered: ${def.name}`, 'ALREADY_EXISTS');

  const row = await db.toolRecord.create({
    data: {
      name: def.name,
      description: def.description,
      purpose: def.purpose ?? null,
      category: def.category,
      environment,
      definition: JSON.stringify(def),
      functionSource: input.functionSource,
      toolVersion: def.toolVersion ?? null,
      enabled: input.enabled ?? true,
    },
  });
  return rowToEntry(row);
}

/**
 * Update an existing user-editable tool (dynamic or js-function). Built-in and
 * virtual-env tools are read-only code — their definitions may not be replaced.
 */
export async function updateTool(
  name: string,
  input: Partial<JsToolRegistration> & {
    enabled?: boolean;
    /** v1.0.5: dynamic tools only — validated against the real handler registry. */
    handlerKind?: string;
    handlerConfig?: Record<string, unknown>;
  },
): Promise<ToolEntryFull> {
  const current = await db.toolRecord.findUnique({ where: { name } });
  if (!current) throw new ToolFailure(`Tool not found: ${name}`, 'NOT_FOUND');
  if (current.environment === 'builtin' || current.environment === 'virtual-env') {
    throw new ToolFailure(`Built-in tool ${name} is read-only. Duplicate it to customize.`, 'READ_ONLY');
  }
  // v1.0.12 — mcp tools are managed by their connector (Connectors page):
  // their identity/schema come from the remote server, not the Tool IDE.
  if (current.environment === 'mcp') {
    throw new ToolFailure(`MCP tool ${name} is managed by its connector — refresh or re-import it from the Connectors page.`, 'MANAGED_BY_CONNECTOR');
  }

  const currentDef = JSON.parse(current.definition) as ToolDefinition;
  const currentEnvironment = current.environment as ToolDefinition['environment'];
  // v1.0.5 — js-function ⇄ nodejs ⇄ freedom-node switches are allowed for
  // user function tools (all store functionSource); dynamic/builtin/virtual-env
  // keep their env.
  const nextEnvironment: ToolDefinition['environment'] =
    input.environment !== undefined && (currentEnvironment === 'js-function' || currentEnvironment === 'nodejs' || currentEnvironment === 'freedom-node')
      ? input.environment
      : currentEnvironment;
  const nextSchema = input.schema && Array.isArray(input.schema.properties) ? input.schema : currentDef.schema;
  const nextDescription = input.description !== undefined ? input.description.trim() || current.description : current.description;
  const nextPurpose = input.purpose !== undefined ? input.purpose.trim() || null : current.purpose;
  const nextCategory = input.category !== undefined ? input.category.trim() || current.category : current.category;
  const nextVersion = input.toolVersion !== undefined ? input.toolVersion.trim() || null : current.toolVersion;
  const nextSource = input.functionSource !== undefined ? input.functionSource : current.functionSource;
  // v1.0.5 — metadata round trip: undefined keeps stored pairs, object replaces.
  const storedMetadata = currentDef.metadata ?? {};
  const nextMetadata = input.metadata !== undefined ? input.metadata : storedMetadata;
  if (input.metadata !== undefined) assertStringRecord(input.metadata, 'metadata');
  // v1.0.6 §9.2/v1.0.11 §40 — autoExecute persists with the tool. An explicit
  // boolean replaces it; undefined KEEPS the inherit state (no coercion).
  const nextAutoExecute = input.autoExecute !== undefined
    ? input.autoExecute === true
    : currentDef.autoExecute;
  // v1.0.13 — the verification latch persists with the tool (explicit boolean
  // replaces; undefined keeps the stored state).
  const nextVerificationLatch = input.verificationLatch !== undefined
    ? input.verificationLatch === true
    : currentDef.verificationLatch;
  // v1.0.7 §1 — per-tool execution timeout (undefined keeps stored value; the
  // runtime clamps the stored definition as defense in depth).
  const nextTimeoutMs = input.timeoutMs !== undefined
    ? (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(Math.max(Math.round(input.timeoutMs), 1_000), 3_600_000)
      : undefined)
    : (typeof currentDef.timeoutMs === 'number' && currentDef.timeoutMs > 0 ? currentDef.timeoutMs : undefined);
  // v1.0.9 §14 — per-tool Network Policy request timeout (undefined keeps
  // stored value; explicit null-ish input clears it; runtime clamps as
  // defense in depth).
  const nextNetworkTimeoutMs = input.networkTimeoutMs !== undefined
    ? (typeof input.networkTimeoutMs === 'number' && Number.isFinite(input.networkTimeoutMs) && input.networkTimeoutMs > 0
      ? clampNetworkTimeoutMs(input.networkTimeoutMs)
      : undefined)
    : (typeof currentDef.networkTimeoutMs === 'number' && currentDef.networkTimeoutMs > 0 ? currentDef.networkTimeoutMs : undefined);

  if (nextEnvironment === 'js-function' || nextEnvironment === 'nodejs' || nextEnvironment === 'freedom-node') {
    if (typeof nextSource !== 'string' || nextSource.trim().length === 0) {
      throw new ToolFailure(`${nextEnvironment} tools require functionSource.`, 'INVALID_PARAMS');
    }
    const syntax = nextEnvironment === 'nodejs'
      ? validateNodeSourceCached(nextSource)
      : nextEnvironment === 'freedom-node'
        ? validateFreedomSourceCached(nextSource)
        : validateFunctionSourceCached(nextSource);
    if (!syntax.ok) throw new ToolFailure(`Function source rejected: ${syntax.error}`, 'INVALID_FUNCTION');
  }

  // v1.0.5 §2.6/§2.8 — dynamic handler kind/config are editable with validation.
  const nextHandlerKind = currentEnvironment === 'dynamic'
    ? (input.handlerKind !== undefined ? input.handlerKind : (currentDef.handlerKind ?? current.handlerKind ?? undefined))
    : undefined;
  if (nextHandlerKind !== undefined && !isHandlerKind(nextHandlerKind)) {
    throw new ToolFailure(`handlerKind must be one of: ${HANDLER_KINDS.join(', ')}`, 'INVALID_PARAMS');
  }
  let nextHandlerConfig: Record<string, unknown> | undefined;
  if (currentEnvironment === 'dynamic') {
    if (input.handlerConfig !== undefined) {
      if (input.handlerConfig === null || typeof input.handlerConfig !== 'object' || Array.isArray(input.handlerConfig)) {
        throw new ToolFailure('handlerConfig must be a JSON object.', 'INVALID_PARAMS');
      }
      nextHandlerConfig = input.handlerConfig;
    } else {
      nextHandlerConfig = currentDef.handlerConfig ?? (() => { try { return current.handlerConfig ? (JSON.parse(current.handlerConfig) as Record<string, unknown>) : {}; } catch { return {}; } })();
    }
  }

  const nextDef: ToolDefinition = {
    ...currentDef,
    description: nextDescription,
    purpose: nextPurpose ?? undefined,
    category: nextCategory,
    environment: nextEnvironment,
    schema: nextSchema,
    functionSource: nextEnvironment === 'js-function' || nextEnvironment === 'nodejs' || nextEnvironment === 'freedom-node' ? nextSource ?? undefined : undefined,
    toolVersion: nextVersion ?? undefined,
    autoExecute: nextAutoExecute,
    verificationLatch: nextVerificationLatch,
    ...(nextTimeoutMs !== undefined ? { timeoutMs: nextTimeoutMs } : {}),
    ...(nextNetworkTimeoutMs !== undefined ? { networkTimeoutMs: nextNetworkTimeoutMs } : {}),
    ...(Object.keys(nextMetadata).length > 0 ? { metadata: nextMetadata } : {}),
    ...(currentEnvironment === 'dynamic'
      ? { handlerKind: nextHandlerKind, handlerConfig: nextHandlerConfig ?? {} }
      : {}),
  };

  const row = await db.toolRecord.update({
    where: { name },
    data: {
      description: nextDescription,
      purpose: nextPurpose,
      category: nextCategory,
      environment: nextEnvironment,
      definition: JSON.stringify(nextDef),
      functionSource: nextEnvironment === 'js-function' || nextEnvironment === 'nodejs' || nextEnvironment === 'freedom-node' ? nextSource : null,
      toolVersion: nextVersion,
      ...(currentEnvironment === 'dynamic' ? { handlerKind: nextHandlerKind ?? null, handlerConfig: JSON.stringify(nextHandlerConfig ?? {}) } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });
  // Drop any cached handler so the next execution picks up the new source/config.
  handlerState().handlers.delete(name);
  return rowToEntry(row);
}

/** Delete a user tool. Built-ins cannot be deleted. */
export async function deleteTool(name: string): Promise<{ deleted: boolean; name: string }> {
  const current = await db.toolRecord.findUnique({ where: { name }, select: { environment: true } });
  if (!current) throw new ToolFailure(`Tool not found: ${name}`, 'NOT_FOUND');
  if (current.environment === 'builtin' || current.environment === 'virtual-env') {
    throw new ToolFailure(`Built-in tool ${name} cannot be deleted. Disable it instead.`, 'READ_ONLY');
  }
  // v1.0.12 — mcp tools are managed by their connector (Connectors page):
  // removing them here would silently detach them from the import bookkeeping.
  if (current.environment === 'mcp') {
    throw new ToolFailure(`MCP tool ${name} is managed by its connector — remove it from the Connectors page.`, 'MANAGED_BY_CONNECTOR');
  }
  await db.toolRecord.delete({ where: { name } });
  handlerState().handlers.delete(name);
  return { deleted: true, name };
}

// ---------- v1.0.2: js-function tool handlers ----------

/**
 * Build the sandboxed handler for a js-function tool from its stored source.
 * v1.0.6 — each execution gets the shared runtime layers: network policy
 * accounting, interaction events (alert/prompt) and, when the tool owns one,
 * its persistent Virtual FS workspace (restricted require() of VFS modules).
 * v1.0.9 §14 — the per-request Network Policy timeout is resolved from
 * request → tool → task → global Settings → shipped default (NEVER from the
 * tool execution timeout); the tool's effective execution timeout only caps it.
 */
function makeJsHandler(name: string, source: string, networkTimeoutMs?: number): ToolHandler {
  return async (params, ctx) => {
    // v1.0.12 §3.1/§3.12 — every restricted tool receives THE ONE shared
    // runtime VFS (per-tool workspaces were removed).
    const vfs = openGlobalVfs();
    const net = await resolveNetworkRequestTimeoutForExecution({
      toolNetworkTimeoutMs: networkTimeoutMs,
      taskNetworkTimeoutMs: ctx.networkTimeoutMs,
      toolExecutionTimeoutMs: ctx.timeoutMs,
    });
    const run = await runJsTool(
      source,
      params,
      {
        executionId: ctx.executionId,
        taskId: ctx.taskId,
        mode: 'production',
        now: new Date().toISOString(),
        log: () => {}, // production logs are intentionally discarded (kept capped in tests)
      },
      {
        toolId: name,
        vfs,
        // v1.0.13 §14 — the SUBTOOL API: built from the executor-threaded
        // link (present on every production execution since the executor
        // creates a root link when none was supplied).
        ...(ctx.subtool ? { tools: createSandboxToolsApi(ctx.subtool, { mode: 'production', taskId: ctx.taskId, executionId: ctx.executionId }) } : {}),
        // v1.0.7 §1 — the sandbox deadline inherits the EFFECTIVE execution
        // timeout resolved by the executor.
        // v1.0.9 §14 — the network accounting inherits the EFFECTIVE Network
        // Policy request timeout (NOT the tool execution timeout).
        // v1.0.8 §1.2 — interactions are created by the RUNNER so the
        // interaction-aware deadline controller is wired (confirm()/prompt()
        // defer the sandbox watchdog while the user answers).
        accounting: createNetworkAccounting(net.effective),
        moduleCache: new Map(),
        timeoutMs: ctx.timeoutMs,
        networkTimeoutMs: net.effective,
      },
    );
    if (!run.ok) {
      throw new ToolFailure(run.error?.message ?? 'js-function tool failed', run.error?.code ?? 'TOOL_FAILURE');
    }
    return run.result;
  };
}

/** v1.0.5 → v1.0.7 — nodejs handler with the expanded runtime environment.
 *  v1.0.9 §14 — same Network Policy request-timeout resolution as js-function. */
function makeNodeHandler(name: string, source: string, networkTimeoutMs?: number): ToolHandler {
  return async (params, ctx) => {
    // v1.0.12 §3.1/§3.12 — every restricted tool receives THE ONE shared
    // runtime VFS (per-tool workspaces were removed).
    const vfs = openGlobalVfs();
    const net = await resolveNetworkRequestTimeoutForExecution({
      toolNetworkTimeoutMs: networkTimeoutMs,
      taskNetworkTimeoutMs: ctx.networkTimeoutMs,
      toolExecutionTimeoutMs: ctx.timeoutMs,
    });
    const run = await runNodeTool(
      source,
      params,
      {
        executionId: ctx.executionId,
        taskId: ctx.taskId,
        mode: 'production',
        now: new Date().toISOString(),
        log: () => {},
      },
      {
        toolId: name,
        vfs,
        // v1.0.13 §14 — the SUBTOOL API (same as the js-function handler).
        ...(ctx.subtool ? { tools: createSandboxToolsApi(ctx.subtool, { mode: 'production', taskId: ctx.taskId, executionId: ctx.executionId }) } : {}),
        // v1.0.7 §1 — sandbox deadline and the virtual child_process ceiling
        // inherit the EFFECTIVE execution timeout.
        // v1.0.9 §14 — network accounting inherits the EFFECTIVE Network
        // Policy request timeout (NOT the tool execution timeout).
        accounting: createNetworkAccounting(net.effective),
        moduleCache: new Map(),
        timeoutMs: ctx.timeoutMs,
        networkTimeoutMs: net.effective,
      },
    );
    if (!run.ok) {
      throw new ToolFailure(run.error?.message ?? 'nodejs tool failed', run.error?.code ?? 'TOOL_FAILURE');
    }
    return run.result;
  };
}

/**
 * v1.0.11 — freedom-node handler: the DEDICATED unrestricted runtime (§31).
 * No VFS session, no Network Policy accounting — REAL fs/network/process.
 * The executor-level timeout/cancellation still wraps this handler (§32).
 */
function makeFreedomNodeHandler(name: string, source: string): ToolHandler {
  return async (params, ctx) => {
    const run = await runFreedomNodeTool(
      source,
      params,
      {
        executionId: ctx.executionId,
        taskId: ctx.taskId,
        mode: 'production',
        now: new Date().toISOString(),
        log: () => {}, // production logs are intentionally discarded (kept capped in tests)
      },
      {
        toolId: name,
        timeoutMs: ctx.timeoutMs,
      },
    );
    if (!run.ok) {
      throw new ToolFailure(run.error?.message ?? 'freedom-node tool failed', run.error?.code ?? 'TOOL_FAILURE');
    }
    return run.result;
  };
}

/**
 * Test-only execution of a function tool source (Tool IDE "Test Tool").
 * v1.0.5: `environment` routes the source to the matching sandbox —
 * "js-function" (default), "nodejs" or "freedom-node". The runner is the SAME
 * one production uses, so tests exercise the real runtime contract.
 * v1.0.6: tests ran with an EPHEMERAL scratch VFS workspace.
 * v1.0.12 §3.1/§3.12: the per-tool VFS was REMOVED — test runs now use THE
 * ONE shared runtime VFS, exactly like production executions, so a test can
 * seed a file and a later task/tool can read it.
 */
export async function testToolSource(
  source: string,
  params: Record<string, unknown>,
  opts: {
    taskId?: string;
    environment?: 'js-function' | 'nodejs' | 'freedom-node';
    /** v1.0.7 §1 — effective test execution timeout (ms). */
    timeoutMs?: number;
    /** v1.0.9 §14 — Network Policy request timeout for the test run (ms). */
    networkTimeoutMs?: number;
  } = {},
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string }; logs: string[]; durationMs: number }> {
  const started = Date.now();
  const executionId = `test_${Date.now().toString(36)}`;
  const executionLabel = `__test_${executionId}`; // execution label only — NOT a VFS root
  const vfs = openGlobalVfs(); // v1.0.12 §3 — the shared runtime VFS
  // v1.0.9 §14 — resolve the effective per-request Network Policy timeout for
  // the test run (explicit override wins; otherwise Settings/global/default).
  const net = await resolveNetworkRequestTimeoutForExecution({
    requestOverrideMs: opts.networkTimeoutMs,
    toolExecutionTimeoutMs: opts.timeoutMs,
  });
  const ctx = {
    executionId,
    taskId: opts.taskId,
    mode: 'test' as const,
    now: new Date().toISOString(),
    log: () => {},
  };
  // v1.0.11 — freedom-node test runs go through the DEDICATED freedom
  // runner with the same server-side fs gate as production (fail closed).
  // The gate is checked BEFORE the sandbox is built; a denied test reports
  // FREEDOM_DISABLED honestly instead of silently degrading the sandbox.
  if (opts.environment === 'freedom-node') {
    if (!isFreedomNodeAuthorized()) {
      return { ok: false, error: freedomDisabledError(), logs: [], durationMs: Date.now() - started };
    }
    const run = await runFreedomNodeTool(source, params, ctx, {
      toolId: executionLabel,
      interactions: createTestInteractions(),
      timeoutMs: opts.timeoutMs,
    });
    return { ...run, durationMs: Date.now() - started };
  }
  const run = opts.environment === 'nodejs'
    ? await runNodeTool(source, params, ctx, {
      toolId: executionLabel,
      vfs,
      interactions: createTestInteractions(),
      // v1.0.13 §14 — test mode: the API exists but is LIMITED (built-in
      // tools only, same depth/call caps; SUBTOOL_TEST_MODE otherwise).
      tools: createSandboxToolsApi({ chain: [executionLabel], depth: 0, budget: { calls: 0 } }, { mode: 'test', taskId: opts.taskId, executionId }),
      accounting: createNetworkAccounting(net.effective),
      moduleCache: new Map(),
      timeoutMs: opts.timeoutMs,
      networkTimeoutMs: net.effective,
    })
    : await runJsTool(source, params, ctx, {
      toolId: executionLabel,
      vfs,
      interactions: createTestInteractions(),
      // v1.0.13 §14 — test mode: the API exists but is LIMITED (built-in
      // tools only, same depth/call caps; SUBTOOL_TEST_MODE otherwise).
      tools: createSandboxToolsApi({ chain: [executionLabel], depth: 0, budget: { calls: 0 } }, { mode: 'test', taskId: opts.taskId, executionId }),
      accounting: createNetworkAccounting(net.effective),
      moduleCache: new Map(),
      timeoutMs: opts.timeoutMs,
      networkTimeoutMs: net.effective,
    });
  return { ...run, durationMs: Date.now() - started };
}

/** Back-compat alias (v1.0.2 name) — delegates to testToolSource with the js sandbox. */
export const testJsToolSource = (
  source: string,
  params: Record<string, unknown>,
  opts: { taskId?: string; /** v1.0.7 §1 — effective execution timeout (ms). */ timeoutMs?: number } = {},
) => testToolSource(source, params, opts);

export { JS_TOOL_TIMEOUT_MS, NODE_TOOL_TIMEOUT_MS };

/**
 * v1.0.12 — drop a cached handler so the next execution rebuilds it (used by
 * the MCP connector manager after import/refresh/enable/disable/remove).
 */
export function invalidateCachedHandler(name: string): void {
  handlerState().handlers.delete(name);
}

export async function toggleTool(name: string, enabled: boolean): Promise<ToolEntryFull> {
  const row = await db.toolRecord.update({ where: { name }, data: { enabled } });
  return rowToEntry(row);
}

export async function recordToolCall(name: string, status: 'completed' | 'failed' | 'timeout', ms: number): Promise<void> {
  try {
    const data: Record<string, unknown> = { callCount: { increment: 1 }, totalMs: { increment: Math.max(0, Math.round(ms)) } };
    if (status === 'completed') data.successCount = { increment: 1 };
    else if (status === 'timeout') data.timeoutCount = { increment: 1 };
    else data.failureCount = { increment: 1 };
    await db.toolRecord.update({ where: { name }, data });
  } catch (err) {
    console.error(`[registry] stats update failed for ${name}:`, err);
  }
}

export type { HandlerContext };
