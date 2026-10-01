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
];

// ---------- Handler registry ----------

type DynamicHandlerKind = NonNullable<ToolDefinition['handlerKind']>;

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
  return async () => {
    if (!url) throw new ToolFailure('http_get tool has no configured url', 'INVALID_CONFIG');
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
  };

  const builtin = builtinMap[def.name];
  if (builtin) {
    s.handlers.set(def.name, builtin);
    return builtin;
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
  enabled: boolean;
  stats: ToolStats;
  createdAt: string;
}

function rowToEntry(row: {
  name: string; description: string; purpose: string | null; category: string;
  environment: string; definition: string; handlerKind: string | null; enabled: boolean;
  callCount: number; successCount: number; failureCount: number; timeoutCount: number;
  totalMs: number; createdAt: Date;
}): ToolEntryFull {
  let def: ToolDefinition;
  try {
    def = JSON.parse(row.definition) as ToolDefinition;
  } catch {
    def = { name: row.name, description: row.description, category: row.category, environment: 'builtin', schema: { type: 'object', properties: [] } };
  }
  return {
    name: row.name,
    description: row.description,
    purpose: row.purpose ?? undefined,
    category: row.category,
    environment: (row.environment as ToolDefinition['environment']) ?? 'builtin',
    definition: def,
    schema: def.schema ?? { type: 'object', properties: [] },
    handlerKind: row.handlerKind ?? undefined,
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
const HANDLER_KINDS: DynamicHandlerKind[] = ['echo', 'delay', 'http_get', 'uuid'];

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
