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
import { resolveEffectiveToolTimeout, maxToolTimeoutMs } from './timeout';
import { hasPendingInteraction } from './sandbox-interactive';
import type { SubtoolParentInfo } from './subtool';
import { requestVerification, summarizeResult } from '../verification';

export interface ExecuteOptions {
  timeoutMs?: number;
  /** v1.0.9 §14 — task-level Network Policy request timeout (ms); forwarded
   *  to the handler context where the effective per-request timeout is
   *  resolved (request → tool → task → global Settings → shipped default). */
  networkTimeoutMs?: number;
  taskId?: string;
  signal?: AbortSignal;
  /** v1.0.3: batch info stamped on the execution + events when the call runs
   *  as part of a parallel batch (dependency-aware, capped by the runtime). */
  batch?: { batchId: string; parallelGroup: number };
  /** v1.0.13 §14 — caller-supplied execution id (subtool calls pass their
   *  pre-generated `sub_…` id so every layer correlates). Absent = generated. */
  executionId?: string;
  /** v1.0.13 §14 — the caller-supplied PARENT info for subtool executions
   *  (chain/depth/budget/deadline). The executor derives the executed call's
   *  SubtoolLink by appending the executed tool to the chain. Absent = a
   *  fresh root link is created so `context.tools` always exists. */
  subtool?: SubtoolParentInfo;
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
 *
 * v1.0.7 §1 — the effective timeout is resolved with the documented
 * precedence (ToolDefinition.timeoutMs → caller/task default → 10 s default)
 * and hard-capped at the live runtime maximum (execution.timeoutMs.max —
 * shipped 1 h) so no tool can bypass it. The
 * resolved value is stamped on the execution, handed to the handler context
 * (network / VFS / child-process layers derive their timeouts from it) and
 * reported in timeout errors — never a hard-coded 10000ms.
 */
export async function executeTool(
  toolName: string,
  rawParams: Record<string, unknown> | undefined,
  opts: ExecuteOptions = {},
): Promise<ToolExecution> {
  // v1.0.13 §14 — subtool calls carry their own pre-generated execution id.
  const executionId = opts.executionId ?? newExecutionId();
  const startedAt = new Date().toISOString();

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

    // v1.0.7 §1 — resolve the effective timeout: tool-specific → task/global
    // default (opts.timeoutMs) → 10 s default; hard cap at 1 hour.
    const resolved = resolveEffectiveToolTimeout({ toolTimeoutMs: def.timeoutMs, fallbackTimeoutMs: opts.timeoutMs });
    const timeoutMs = resolved.effective;
    execution.timeoutMs = timeoutMs;

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

    const ctx: HandlerContext = {
      taskId: opts.taskId,
      executionId,
      timeoutMs,
      networkTimeoutMs: opts.networkTimeoutMs,
      // v1.0.13 §14 — EVERY production execution gets a subtool link: derived
      // from the caller's parent info (chain gets the executed tool appended)
      // or a fresh root link (chain=[this tool], depth 0, fresh budget) so
      // `context.tools` works for top-level tools too. The signal threads
      // cancellation down the whole subtool tree.
      subtool: opts.subtool
        ? {
          chain: [...opts.subtool.parentChain, toolName],
          depth: opts.subtool.depth,
          budget: opts.subtool.budget,
          deadlineAt: opts.subtool.deadlineAt,
          signal: opts.signal,
        }
        : { chain: [toolName], depth: 0, budget: { calls: 0 }, signal: opts.signal },
    };
    const startedEpoch = Date.now();
    const result = await Promise.race([
      handler(params, ctx),
      // v1.0.8 §1.2 — the watchdog is INTERACTION-AWARE: while this execution
      // waits for a user answer (confirm()/prompt()) it defers, and once the
      // interaction completes the FULL budget is restored (reset semantics,
      // mirroring the sandbox deadline). Interactions self-clear via their own
      // 120s windows, so a never-answered request cannot hang the executor.
      new Promise<never>((_, reject) => {
        let deadline = startedEpoch + timeoutMs;
        let wasWaiting = false;
        const watchdog = setInterval(() => {
          const waiting = hasPendingInteraction(executionId);
          if (waiting) {
            wasWaiting = true;
            return; // deferred — the user has not answered yet
          }
          if (wasWaiting) {
            // the interaction just completed: restore the full budget
            wasWaiting = false;
            deadline = Date.now() + timeoutMs;
          }
          if (Date.now() > deadline) {
            clearInterval(watchdog);
            const elapsedMs = Date.now() - startedEpoch;
            // v1.0.7 §1 — the error reports the ACTUAL effective timeout (tool,
            // operation, effective timeout, elapsed time, reason) — never a
            // hard-coded 10000ms when another timeout was configured.
            reject(new ToolTimeoutError(toolName, 'tool_execution', timeoutMs, elapsedMs));
          }
        }, 250);
        if (typeof watchdog.unref === 'function') watchdog.unref();
      }),
      new Promise<never>((_, reject) => {
        if (!opts.signal) return;
        const onAbort = () => reject(new Error('cancelled'));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);

    // v1.0.13 — VERIFICATION LATCH: a tool flagged verificationLatch holds
    // its COMPLETED execution open until the operator verifies the result.
    // Top-level task executions only (subtool calls run under the parent's
    // context; test runs have no operator). Outcomes: verified → complete;
    // rejected → structured VERIFICATION_REJECTED failure; timeout →
    // auto-verified with a warning event (review gate, not a security gate);
    // cancelled → the execution completes as cancelled.
    if (def.verificationLatch === true && opts.taskId && !opts.subtool && !opts.signal?.aborted) {
      const outcome = await requestVerification({
        taskId: opts.taskId,
        executionId,
        tool: toolName,
        resultSummary: summarizeResult(result),
      });
      if (outcome === 'rejected') {
        return finish('failed', undefined, {
          code: 'VERIFICATION_REJECTED',
          message: `The result of ${toolName} was rejected by the operator during verification.`,
        });
      }
      if (outcome === 'cancelled') {
        return finish('cancelled', undefined, { code: 'CANCELLED', message: 'Task stopped while awaiting result verification.' });
      }
      // 'verified' | 'timeout' → the execution completes normally.
    }

    return finish('completed', result, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'cancelled' || opts.signal?.aborted) {
      return finish('cancelled', undefined, { code: 'CANCELLED', message: 'Execution cancelled.' });
    }
    // v1.0.9 §14.7 — stable error codes survive the handler boundary:
    // NetworkPolicyError.NETWORK_TIMEOUT stays NETWORK_TIMEOUT (a Network
    // Policy request timeout is never re-labelled as a tool execution
    // timeout). ToolFailure/ToolTimeoutError codes flow unchanged.
    const errCode = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : undefined;
    const isTimeout = err instanceof ToolTimeoutError || message.includes('timed out');
    return finish(isTimeout ? 'timeout' : 'failed', undefined, {
      code: isTimeout ? 'TIMEOUT' : errCode === 'NETWORK_TIMEOUT' ? 'NETWORK_TIMEOUT' : errCode && errCode !== 'TOOL_FAILURE' ? errCode : 'TOOL_FAILURE',
      message,
    });
  }
}

/**
 * v1.0.7 §1 — structured timeout failure carrying tool, operation, effective
 * timeout, elapsed time and reason. Message shape (stable for tools/logs):
 *   Tool "server.health" timed out after 300000ms.
 */
export class ToolTimeoutError extends Error {
  code = 'TIMEOUT';
  tool: string;
  operation: string;
  effectiveTimeoutMs: number;
  elapsedMs: number;
  reason: string;
  constructor(tool: string, operation: string, effectiveTimeoutMs: number, elapsedMs: number) {
    super(`Tool "${tool}" timed out after ${effectiveTimeoutMs}ms.`);
    this.name = 'ToolTimeoutError';
    this.tool = tool;
    this.operation = operation;
    this.effectiveTimeoutMs = effectiveTimeoutMs;
    this.elapsedMs = elapsedMs;
    this.reason = `${operation} watchdog: execution exceeded the effective timeout (${effectiveTimeoutMs}ms${maxToolTimeoutMs() <= effectiveTimeoutMs ? ', runtime maximum' : ''}).`;
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
    // v1.0.7 — timeout events carry the effective timeout for traceability.
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
