/**
 * /api/connectors/[id]/tools — MCP tool discovery, import and management (v1.0.12).
 * GET  — discover tools on the connected MCP server (name, description,
 *        inputSchema, remoteHash, imported flag) — requires a live session.
 * POST — actions:
 *   { action: "import", names: string[] }        → import/UPDATE selected tools
 *   { action: "refresh", name? | names? }        → schema refresh (metadata preserved)
 *   { action: "toggle", name, enabled }          → enable/disable an imported tool
 *   { action: "remove", name }                   → remove from NexTool (remote untouched)
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import {
  discoverTools,
  importTools,
  McpConnectorFailure,
  refreshTools,
  removeImportedTool,
  setImportedToolEnabled,
} from '@/lib/nexool/mcp/connector-manager';
import { connectorToolsActionSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const data = await discoverTools(decodeURIComponent(id));
    return ok(data);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status = err.code === 'CONNECTOR_NOT_FOUND' ? 404 : err.code === 'MCP_NOT_CONNECTED' ? 409 : 502;
      return fail(err.code, err.message, status);
    }
    return fail('DISCOVERY_FAILED', err instanceof Error ? err.message : 'Tool discovery failed', 500);
  }
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = await parseBody(req, connectorToolsActionSchema);
  if (parsed.error) return parsed.error;
  const connectorId = decodeURIComponent(id);
  const { action, names, name, enabled } = parsed.data;
  try {
    if (action === 'import') {
      if (!names || names.length === 0) return fail('INVALID_PARAMS', '"names" is required for the import action (at least one tool).', 400);
      return ok(await importTools(connectorId, names));
    }
    if (action === 'refresh') {
      return ok(await refreshTools(connectorId, name ? [name] : names));
    }
    if (action === 'toggle') {
      if (!name) return fail('INVALID_PARAMS', '"name" is required for the toggle action.', 400);
      if (enabled === undefined) return fail('INVALID_PARAMS', '"enabled" is required for the toggle action.', 400);
      return ok(await setImportedToolEnabled(connectorId, name, enabled));
    }
    if (action === 'remove') {
      if (!name) return fail('INVALID_PARAMS', '"name" is required for the remove action.', 400);
      return ok(await removeImportedTool(connectorId, name));
    }
    return fail('INVALID_PARAMS', `Unknown action: ${String(action)}`, 400);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status =
        err.code === 'CONNECTOR_NOT_FOUND' ? 404
        : err.code === 'TOOL_NOT_FOUND' ? 404
        : err.code === 'MCP_NOT_CONNECTED' ? 409
        : err.code === 'INVALID_PARAMS' ? 400
        : 502;
      return fail(err.code, err.message, status);
    }
    return fail('TOOL_ACTION_FAILED', err instanceof Error ? err.message : 'Tool action failed', 500);
  }
}
