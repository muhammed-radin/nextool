/**
 * Shared tool handler types.
 */
import type { SubtoolLink } from './subtool';

export interface HandlerContext {
  taskId?: string;
  executionId: string;
  /** v1.0.7 §1 — the EFFECTIVE tool execution timeout (ms) resolved by the
   *  executor (global default → tool-specific config, capped at 1 hour).
   *  Handlers and sandbox layers derive their child-operation timeouts from
   *  this value instead of hard-coded constants. */
  timeoutMs?: number;
  /** v1.0.9 §14 — the task-level Network Policy request timeout (ms) when the
   *  run/task config supplies one (precedence layer 3). Handlers resolve the
   *  effective per-request timeout from request → tool → THIS → global
   *  Settings → shipped default; it is deliberately NOT derived from
   *  timeoutMs. */
  networkTimeoutMs?: number;
  /** v1.0.13 §14 — the executor-threaded subtool link for THIS execution
   *  (call chain, depth, shared budget). Present for every real execution;
   *  function handlers wrap it into the sandbox-facing `context.tools` API. */
  subtool?: SubtoolLink;
}

export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: HandlerContext,
) => Promise<unknown>;

export class ToolFailure extends Error {
  code: string;
  constructor(message: string, code = 'TOOL_FAILURE') {
    super(message);
    this.code = code;
  }
}
