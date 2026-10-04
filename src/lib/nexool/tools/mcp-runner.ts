/**
 * NexTool v1.0.12 — MCP tool runner (the `mcp` environment handler).
 *
 * Mirrors the freedom-node-runner pattern: a THIN adapter between the native
 * executor (executeTool → ToolHandler) and a dedicated runtime. Here the
 * runtime is the MCP client: every call resolves credentials/connector at
 * execution time (§1.14 — definitions never carry secrets) and proxies the
 * call to the remote MCP server through the official SDK client.
 *
 * Lifecycle participation (§1.12): the executor wraps this handler exactly
 * like every other tool — execution ID, tool.started/completed/failed/timeout/
 * cancelled events, stats, history, durationMs, timeout watchdog and
 * cancellation all come from the executor unchanged. This runner's ONLY job
 * is to translate MCP failures into the structured ToolFailure system with
 * STABLE codes (§1.18) so one MCP tool failing can never crash the task
 * runtime (the executor never throws to callers).
 */

import { ToolFailure } from './handler';
import type { HandlerContext, ToolHandler } from './handler';
import type { McpToolRef } from '../types';
import { McpAuthError, McpConnectionError, McpProtocolError } from '../mcp/client';
import { getLiveClient } from '../mcp/runtime-registry';
import { db } from '@/lib/db';

/** Load the connector row for display names / status truth in errors. */
async function connectorLabel(connectorId: string): Promise<string> {
  try {
    const row = await db.mcpConnector.findUnique({ where: { id: connectorId }, select: { name: true, status: true } });
    return row ? `"${row.name}" (status: ${row.status})` : `"${connectorId}"`;
  } catch {
    return `"${connectorId}"`;
  }
}

/**
 * Build the executor handler for an environment='mcp' tool definition.
 * The returned handler NEVER throws anything but ToolFailure with a stable
 * code — every MCP-level failure becomes a structured tool failure.
 */
export function makeMcpHandler(ref: McpToolRef): ToolHandler {
  return async (params: Record<string, unknown>, ctx: HandlerContext): Promise<unknown> => {
    return runMcpTool(ref, params, ctx);
  };
}

export async function runMcpTool(
  ref: McpToolRef,
  params: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<unknown> {
  const client = getLiveClient(ref.connectorId);
  if (!client) {
    // §1.17 — a disconnected connector makes its imported tools unavailable.
    // The tool RECORD stays intact; reconnect restores availability.
    const label = await connectorLabel(ref.connectorId);
    throw new ToolFailure(
      `MCP connector ${label} is not connected — tool "${ref.mcpToolName}" is unavailable until the connector reconnects.`,
      'MCP_NOT_CONNECTED',
    );
  }

  try {
    // The executor's watchdog (ctx.timeoutMs) is the outer bound; the SDK
    // request timeout mirrors it so the in-flight request aborts too.
    const res = await client.callTool(ref.mcpToolName, params, ctx.timeoutMs);
    if (res.isError) {
      // The REMOTE tool reported a failure (MCP isError result).
      throw new ToolFailure(
        `MCP tool "${ref.mcpToolName}" failed on the remote server${res.text ? `: ${res.text.slice(0, 500)}` : '.'}`,
        'MCP_REMOTE_FAILURE',
      );
    }
    // Normalized result — text-first, with raw blocks + structured content
    // preserved for the Observer and the task history.
    return {
      server: ref.serverName,
      tool: ref.mcpToolName,
      text: res.text,
      ...(res.content.length > 0 ? { content: res.content } : {}),
      ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
    };
  } catch (err) {
    if (err instanceof ToolFailure) throw err;
    if (err instanceof McpAuthError) {
      throw new ToolFailure(
        `MCP tool "${ref.mcpToolName}" requires valid credentials: ${err.message}`,
        'MCP_AUTH_REQUIRED',
      );
    }
    if (err instanceof McpConnectionError) {
      throw new ToolFailure(
        `MCP tool "${ref.mcpToolName}" could not reach the server: ${err.message}`,
        'MCP_CONNECTION_FAILED',
      );
    }
    if (err instanceof McpProtocolError) {
      throw new ToolFailure(err.message, err.code);
    }
    // Unknown MCP-layer error — stable generic code, message preserved.
    throw new ToolFailure(
      err instanceof Error ? err.message : String(err),
      'MCP_PROTOCOL_ERROR',
    );
  }
}
