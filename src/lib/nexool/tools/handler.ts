/**
 * Shared tool handler types.
 */
export interface HandlerContext {
  taskId?: string;
  executionId: string;
  /** v1.0.7 §1 — the EFFECTIVE tool execution timeout (ms) resolved by the
   *  executor (global default → tool-specific config, capped at 1 hour).
   *  Handlers and sandbox layers derive their child-operation timeouts from
   *  this value instead of hard-coded constants. */
  timeoutMs?: number;
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
