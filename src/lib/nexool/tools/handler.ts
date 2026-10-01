/**
 * Shared tool handler types.
 */
export interface HandlerContext {
  taskId?: string;
  executionId: string;
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
