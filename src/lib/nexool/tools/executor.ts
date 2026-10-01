/**
 * NexTool Tool Runtime — validates params, executes handlers with timeout,
 * records stats/history/events. A tool failure NEVER throws to callers.
 */
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import type { ToolExecution } from '../types';
import { emitEvent } from '../eventbus';
import { getToolDef, recordToolCall, resolveHandler } from './registry';
import type { ToolDefinition, ToolParamDef } from '../types';
import type { HandlerContext } from './handler';

export interface ExecuteOptions {
  timeoutMs?: number;
  taskId?: string;
  signal?: AbortSignal;
  /** v1.0.3: batch info stamped on the execution + events when the call runs
   *  as part of a parallel batch (dependency-aware, capped by the runtime). */
  batch?: { batchId: string; parallelGroup: number };
}

function newExecutionId(): string {
  return `exec_${process.hrtime.bigint().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

// ---------- Param validation / coercion ----------

export function coerceParams(params: Record<string, unknown>, schema: ToolDefinition['schema']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of schema.properties) {
    const v = params[def.name];
    if (v === undefined || v === null) continue;
    out[def.name] = coerceValue(v, def);
  }
  return out;
}

function coerceValue(v: unknown, def: ToolParamDef): unknown {
  switch (def.type) {
    case 'string':
      return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
    case 'number': {
      if (typeof v === 'number') return v;
      const n = Number(v);
      return Number.isFinite(n) ? n : v;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v;
    }
    case 'object':
      if (typeof v === 'object' && !Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : v;
        } catch {
          return v;
        }
      }
      return v;
    case 'array':
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return Array.isArray(parsed) ? parsed : v.split(',').map((s) => s.trim()).filter(Boolean);
        } catch {
          return v.split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      return v;
    default:
      return v;
  }
}

export function validateParams(params: Record<string, unknown>, schema: ToolDefinition['schema']): string[] {
  const errors: string[] = [];
  const known = new Set(schema.properties.map((p) => p.name));

  for (const key of Object.keys(params)) {
    if (!known.has(key)) errors.push(`Unknown param: ${key}`);
  }
  for (const def of schema.properties) {
    const v = params[def.name];
    if (v === undefined || v === null) {
      if (def.required) errors.push(`Missing required param: ${def.name}`);
      continue;
    }
    switch (def.type) {
      case 'string':
        if (typeof v !== 'string') errors.push(`Param ${def.name} must be a string`);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`Param ${def.name} must be a finite number`);
        else {
          if (def.min !== undefined && v < def.min) errors.push(`Param ${def.name} must be >= ${def.min}`);
          if (def.max !== undefined && v > def.max) errors.push(`Param ${def.name} must be <= ${def.max}`);
        }
        break;
      case 'boolean':
        if (typeof v !== 'boolean') errors.push(`Param ${def.name} must be a boolean`);
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v) || v === null) errors.push(`Param ${def.name} must be an object`);
        break;
      case 'array':
        if (!Array.isArray(v)) errors.push(`Param ${def.name} must be an array`);
        break;
    }
    if (def.type === 'string' && typeof v === 'string' && def.enumValues && !def.enumValues.includes(v)) {
      errors.push(`Param ${def.name} must be one of: ${def.enumValues.join(', ')}`);
    }
  }
  return errors;
}

// ---------- Execution ----------

/**
 * Executes a tool. NEVER throws — always resolves with a structured ToolExecution.
 */
export async function executeTool(
  toolName: string,
  rawParams: Record<string, unknown> | undefined,
  opts: ExecuteOptions = {},
): Promise<ToolExecution> {
  const executionId = newExecutionId();
  const startedAt = new Date().toISOString();
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 30_000, 250), 300_000);

  const execution: ToolExecution = {
    executionId,
    tool: toolName,
    status: 'running',
    params: rawParams ?? {},
    startedAt,
  };
  if (opts.batch) {
    execution.batchId = opts.batch.batchId;
    execution.parallelGroup = opts.batch.parallelGroup;
  }

  void emitEvent({
    taskId: opts.taskId,
    type: 'tool.started',
    source: 'tool',
    message: `Executing ${toolName}${opts.batch ? ' (parallel batch)' : ''}`,
    data: { executionId, tool: toolName, params: rawParams ?? {}, ...(opts.batch ? { batchId: opts.batch.batchId, parallelGroup: opts.batch.parallelGroup } : {}) },
    priority: 6,
  });

  const finish = (status: ToolExecution['status'], result?: unknown, error?: ToolExecution['error']): ToolExecution => {
    execution.status = status;
    execution.result = result;
    execution.error = error ?? null;
    execution.completedAt = new Date().toISOString();
    execution.durationMs = Date.now() - Date.parse(startedAt);
    void finalize(execution, opts.taskId);
    return execution;
  };

  try {
    const def = await getToolDef(toolName);
    if (!def) {
      return finish('failed', undefined, { code: 'UNKNOWN_TOOL', message: `Tool not found in registry: ${toolName}` });
    }
    if (opts.signal?.aborted) {
      return finish('cancelled', undefined, { code: 'CANCELLED', message: 'Execution cancelled before start.' });
    }

    // coerce then validate
    const params = coerceParams(rawParams ?? {}, def.schema);
    execution.params = params;
    const errors = validateParams(params, def.schema);
    if (errors.length > 0) {
      return finish('failed', undefined, { code: 'INVALID_PARAMS', message: errors.join('; ') });
    }

    const handler = resolveHandler(def);
    if (!handler) {
      return finish('failed', undefined, { code: 'NO_HANDLER', message: `No handler available for tool: ${toolName}` });
    }

    const ctx: HandlerContext = { taskId: opts.taskId, executionId };
    const result = await Promise.race([
      handler(params, ctx),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`Tool execution timed out after ${timeoutMs}ms`)), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
      new Promise<never>((_, reject) => {
        if (!opts.signal) return;
        const onAbort = () => reject(new Error('cancelled'));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);

    return finish('completed', result, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled' || opts.signal?.aborted) {
      return finish('cancelled', undefined, { code: 'CANCELLED', message: 'Execution cancelled.' });
    }
    const isTimeout = message.includes('timed out');
    return finish(isTimeout ? 'timeout' : 'failed', undefined, {
      code: isTimeout ? 'TIMEOUT' : 'TOOL_FAILURE',
      message,
    });
  }
}

async function finalize(execution: ToolExecution, taskId?: string): Promise<void> {
  const ms = execution.durationMs ?? 0;
  const status = execution.status;

  if (status === 'completed' || status === 'failed' || status === 'timeout') {
    await recordToolCall(execution.tool, status, ms);
  }

  const eventType =
    status === 'completed' ? 'tool.completed' : status === 'timeout' ? 'tool.timeout' : status === 'cancelled' ? 'tool.cancelled' : 'tool.failed';
  const priority = status === 'completed' ? 6 : status === 'timeout' ? 4 : 5;
  void emitEvent({
    taskId,
    type: eventType,
    source: 'tool',
    message: `${execution.tool} → ${status}${execution.error ? `: ${execution.error.message}` : ''}`,
    data: execution as unknown as Record<string, unknown>,
    priority,
  });

  try {
    await db.historyEntry.create({
      data: {
        taskId: taskId ?? null,
        action: execution.tool,
        params: JSON.stringify(execution.params ?? {}),
        result: execution.result !== undefined ? JSON.stringify(execution.result) : null,
        status: status === 'running' || status === 'pending' ? 'failed' : status,
        // v1.0.3: parallel provenance for Task Preview batch grouping
        ...(execution.batchId ? { batchId: execution.batchId, parallelGroup: execution.parallelGroup ?? null } : {}),
      },
    });
  } catch (err) {
    console.error('[executor] history write failed:', err);
  }
}

/** Execute several independent tool calls concurrently (spec §10). */
export async function executeToolsParallel(
  calls: { tool: string; params?: Record<string, unknown> }[],
  opts: ExecuteOptions = {},
): Promise<ToolExecution[]> {
  return Promise.all(calls.map((c) => executeTool(c.tool, c.params, opts)));
}

/**
 * v1.0.3 — execute a parallel batch of independent tool calls with a hard
 * concurrency cap. Calls beyond `maxParallel` run in waves AFTER the current
 * wave completes (dependency-safe: no unlimited concurrency). Each call is
 * independent — one failure never cancels its batch siblings (the runtime
 * dependency graph decides what may continue).
 */
export async function executeParallelBatch(
  batchId: string,
  calls: { tool: string; params?: Record<string, unknown>; parallelGroup: number }[],
  opts: ExecuteOptions & { maxParallel: number } = { maxParallel: 4 },
): Promise<ToolExecution[]> {
  const maxParallel = Math.min(Math.max(Math.round(opts.maxParallel), 1), 8);
  const results: ToolExecution[] = [];
  for (let i = 0; i < calls.length; i += maxParallel) {
    const wave = calls.slice(i, i + maxParallel);
    const waveResults = await Promise.all(
      wave.map((c) =>
        executeTool(c.tool, c.params, {
          ...opts,
          batch: { batchId, parallelGroup: c.parallelGroup },
        }),
      ),
    );
    results.push(...waveResults);
  }
  return results;
}
