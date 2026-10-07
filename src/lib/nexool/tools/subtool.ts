/**
 * NexTool v1.0.13 (§14) — the SUBTOOL API: `await context.tools.call(name, params)`.
 *
 * Lets a tool execute ANOTHER registered NexTool tool. The implementation
 * reuses THE ONE execution path — it calls the same `executeTool()` the task
 * runtime uses, so every subtool call is a REAL ToolExecution (tool.* events,
 * stats, history entries, effective-timeout resolution, serializable-result
 * contract) visible through the normal executions listing.
 *
 * Safety model (fail closed, per spec §14):
 *  - MAX DEPTH: a top-level execution is depth 0; each tools.call level +1.
 *    Calls that would exceed SUBTOOL_MAX_DEPTH (shipped 3) are rejected with
 *    SUBTOOL_DEPTH before anything runs.
 *  - CALL BUDGET: at most SUBTOOL_MAX_CALLS (shipped 20) subtool calls per
 *    top-level execution — the budget object is SHARED down the whole call
 *    tree, so nested subtools draw from the same pool.
 *  - RECURSION: the active tool-name chain is threaded through every level;
 *    a tool calling itself, or any cycle (A→B→A), is rejected with
 *    SUBTOOL_CYCLE before execution.
 *  - CANCELLATION: the parent execution's AbortSignal (task stop) is
 *    inherited; every subtool call rejects immediately when aborted.
 *  - TIME BUDGET: the parent execution deadline (deadlineAt) is inherited;
 *    the executor clamps a subtool's effective timeout so it can never
 *    outlive its parent's budget.
 *  - APPROVAL: subtool calls SKIP the interactive approval gate — they run
 *    under the parent tool's already-granted approval. The called tool must
 *    exist and be ENABLED; disabled tools fail with TOOL_DISABLED.
 *  - TEST MODE (Tool IDE): the API is provided but clearly limited — it can
 *    only invoke BUILT-IN tools (environment 'builtin'), the same depth/call
 *    caps apply, and everything else fails with an honest SUBTOOL_TEST_MODE
 *    error (documented in tool-runtime-declarations.ts).
 *
 * Observability: every call emits `subtool.started` / `subtool.completed` /
 * `subtool.failed` (priority 6) carrying { parentExecutionId, taskId,
 * subtoolExecutionId, tool, depth, durationMs?, error? } alongside the normal
 * tool.* events of the subtool execution itself.
 */

import { emitEvent } from '../eventbus';
import { ToolFailure } from './handler';
import { executeTool } from './executor';
import { getToolDef, isToolEnabled } from './registry';

/** Maximum subtool nesting depth (configurable constant — shipped value 3). */
export const SUBTOOL_MAX_DEPTH = 3;

/** Maximum subtool calls per top-level execution (configurable constant — shipped 20). */
export const SUBTOOL_MAX_CALLS = 20;

/** Shared call budget for one top-level execution (threaded down the tree). */
export interface SubtoolBudget {
  calls: number;
}

/**
 * v1.0.13 §14 — what a subtool CALLER hands to executor.executeTool: the
 * PARENT-side info. The executor derives the CHILD SubtoolLink from it by
 * appending the executed tool to the chain (chain = [...parentChain, tool]).
 * This keeps the parent/child relationship explicit at the executor boundary.
 */
export interface SubtoolParentInfo {
  /** Tool-name chain from the top-level execution down to (and including)
   *  the CALLING tool. The executed tool is appended by the executor. */
  parentChain: string[];
  /** The DEPTH OF THE EXECUTED CALL (caller depth + 1). */
  depth: number;
  /** Shared budget across the whole subtool tree of the top-level execution. */
  budget: SubtoolBudget;
  /** Execution id of the calling tool (observability on events). */
  parentExecutionId: string;
  /** Epoch-ms deadline of the top-level execution (subtools never outlive it). */
  deadlineAt?: number;
}

/**
 * The executor-threaded subtool state for ONE execution. Built by
 * executor.executeTool for every handler context; handler factories wrap it
 * into the sandbox-facing SandboxToolsApi.
 */
export interface SubtoolLink {
  /** Tool-name chain from the top-level execution down to (and including) THIS execution. */
  chain: string[];
  /** 0 = top-level execution; each tools.call level adds 1. */
  depth: number;
  /** Shared budget across the whole subtool tree of the top-level execution. */
  budget: SubtoolBudget;
  /** Epoch-ms deadline of the top-level execution (subtools never outlive it). */
  deadlineAt?: number;
  /** Parent/task cancellation signal. */
  signal?: AbortSignal;
}

/** The `context.tools` surface handed to tool code (all tool environments). */
export interface SandboxToolsApi {
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

function subtoolEvent(opts: {
  taskId?: string;
  type: 'subtool.started' | 'subtool.completed' | 'subtool.failed';
  parentExecutionId: string;
  subtoolExecutionId: string;
  tool: string;
  depth: number;
  message: string;
  durationMs?: number;
  error?: { code: string; message: string };
}): void {
  void emitEvent({
    taskId: opts.taskId,
    type: opts.type,
    source: 'tool',
    message: opts.message,
    data: {
      parentExecutionId: opts.parentExecutionId,
      taskId: opts.taskId ?? null,
      subtoolExecutionId: opts.subtoolExecutionId,
      tool: opts.tool,
      depth: opts.depth,
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      ...(opts.error ? { error: opts.error } : {}),
    },
    priority: 6,
  });
}

/**
 * Build the sandbox-facing tools API for one execution. `link` comes from the
 * executor's HandlerContext (production) or the test runner (test mode).
 */
export function createSandboxToolsApi(
  link: SubtoolLink,
  opts: { mode: 'test' | 'production'; taskId?: string; executionId: string },
): SandboxToolsApi {
  const call = async (toolName: string, params?: Record<string, unknown>): Promise<unknown> => {
    // ---- validation (before anything runs; no events for invalid calls) ----
    const name = typeof toolName === 'string' ? toolName.trim() : '';
    if (!name) {
      throw new ToolFailure('tools.call requires a non-empty tool name string (e.g. "fs.list").', 'INVALID_PARAMS');
    }
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      throw new ToolFailure('tools.call params must be a JSON object of tool parameters.', 'INVALID_PARAMS');
    }
    if (link.signal?.aborted) {
      throw new ToolFailure('Execution was cancelled — subtool call not started.', 'CANCELLED');
    }
    if (link.depth + 1 > SUBTOOL_MAX_DEPTH) {
      throw new ToolFailure(
        `Subtool depth limit reached: this call would run at depth ${link.depth + 1} but the maximum is ${SUBTOOL_MAX_DEPTH}.`,
        'SUBTOOL_DEPTH',
      );
    }
    if (link.budget.calls >= SUBTOOL_MAX_CALLS) {
      throw new ToolFailure(
        `Subtool call limit reached: at most ${SUBTOOL_MAX_CALLS} subtool calls are allowed per top-level execution.`,
        'SUBTOOL_LIMIT',
      );
    }
    if (link.chain.includes(name)) {
      throw new ToolFailure(
        `Subtool recursion blocked: "${name}" is already active in the call chain (${link.chain.join(' → ')}). Direct and indirect recursion are not allowed.`,
        'SUBTOOL_CYCLE',
      );
    }

    const def = await getToolDef(name);
    if (!def) {
      throw new ToolFailure(`Subtool not found in registry: "${name}".`, 'UNKNOWN_TOOL');
    }
    if (opts.mode === 'test' && def.environment !== 'builtin') {
      throw new ToolFailure(
        `tools.call in test mode can only invoke built-in tools (environment "builtin") — "${name}" is a ${def.environment} tool.`,
        'SUBTOOL_TEST_MODE',
      );
    }
    if (!(await isToolEnabled(name))) {
      throw new ToolFailure(`Subtool "${name}" is disabled and cannot be called.`, 'TOOL_DISABLED');
    }

    link.budget.calls += 1;
    const subtoolExecutionId = `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    const remainingMs = link.deadlineAt ? Math.max(link.deadlineAt - Date.now(), 250) : undefined;

    subtoolEvent({
      taskId: opts.taskId,
      type: 'subtool.started',
      parentExecutionId: opts.executionId,
      subtoolExecutionId,
      tool: name,
      depth: link.depth + 1,
      message: `Subtool call: ${link.chain[link.chain.length - 1] ?? 'task'} → ${name} (depth ${link.depth + 1})`,
    });

    try {
      // THE ONE execution path — the same executeTool the task runtime uses.
      // Approval gate: intentionally skipped (the parent tool's execution was
      // already approved); the enabled-check above stays authoritative.
      const execution = await executeTool(name, params ?? {}, {
        taskId: opts.taskId,
        signal: link.signal,
        timeoutMs: remainingMs,
        executionId: subtoolExecutionId,
        subtool: {
          parentChain: link.chain,
          depth: link.depth + 1,
          budget: link.budget,
          parentExecutionId: opts.executionId,
          deadlineAt: link.deadlineAt,
        },
      });
      const durationMs = Date.now() - startedAt;
      if (execution.status === 'completed') {
        subtoolEvent({
          taskId: opts.taskId,
          type: 'subtool.completed',
          parentExecutionId: opts.executionId,
          subtoolExecutionId,
          tool: name,
          depth: link.depth + 1,
          durationMs,
          message: `Subtool ${name} completed (${durationMs}ms)`,
        });
        return execution.result;
      }
      const err = execution.error ?? { code: 'TOOL_FAILURE', message: `Subtool "${name}" finished with status ${execution.status}.` };
      subtoolEvent({
        taskId: opts.taskId,
        type: 'subtool.failed',
        parentExecutionId: opts.executionId,
        subtoolExecutionId,
        tool: name,
        depth: link.depth + 1,
        durationMs,
        error: err,
        message: `Subtool ${name} failed: ${err.message.slice(0, 200)}`,
      });
      throw new ToolFailure(`Subtool "${name}" failed: ${err.message}`, err.code);
    } catch (err) {
      // executeTool NEVER throws — anything here was thrown above (already
      // emitted) or is an unexpected infrastructure error; emit honestly once.
      if (!(err instanceof ToolFailure) || !['SUBTOOL_DEPTH', 'SUBTOOL_LIMIT', 'SUBTOOL_CYCLE', 'UNKNOWN_TOOL', 'TOOL_DISABLED', 'SUBTOOL_TEST_MODE', 'CANCELLED', 'INVALID_PARAMS'].includes(err.code)) {
        const errInfo = { code: 'SUBTOOL_FAILURE', message: err instanceof Error ? err.message : String(err) };
        subtoolEvent({
          taskId: opts.taskId,
          type: 'subtool.failed',
          parentExecutionId: opts.executionId,
          subtoolExecutionId,
          tool: name,
          depth: link.depth + 1,
          durationMs: Date.now() - startedAt,
          error: errInfo,
          message: `Subtool ${name} failed: ${errInfo.message.slice(0, 200)}`,
        });
      }
      throw err;
    }
  };

  const api: SandboxToolsApi = {
    call,
    maxDepth: SUBTOOL_MAX_DEPTH,
    maxCalls: SUBTOOL_MAX_CALLS,
    usedCalls: () => link.budget.calls,
    remainingCalls: () => Math.max(SUBTOOL_MAX_CALLS - link.budget.calls, 0),
    depth: link.depth,
  };
  return api;
}
