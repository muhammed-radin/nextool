/**
 * /api/connectors/[id] — one MCP connector (v1.0.12).
 * GET    — connector detail (REAL status, credential PRESENCE only, imported tools)
 * PATCH  — rename / reconfigure / enable-disable (a config change drops the live session)
 * DELETE — remove the connector + its imported tools (the REMOTE server is untouched)
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { deleteConnector, getConnectorDTOById, McpConnectorFailure, updateConnector } from '@/lib/nexool/mcp/connector-manager';
import { updateConnectorSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const connector = await getConnectorDTOById(decodeURIComponent(id));
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure && err.code === 'CONNECTOR_NOT_FOUND') {
      return fail(err.code, err.message, 404);
    }
    return fail('CONNECTOR_LOOKUP_FAILED', err instanceof Error ? err.message : 'Connector lookup failed', 500);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = await parseBody(req, updateConnectorSchema);
  if (parsed.error) return parsed.error;
  try {
    const connector = await updateConnector(decodeURIComponent(id), parsed.data);
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status = err.code === 'CONNECTOR_NOT_FOUND' ? 404 : err.code === 'CONNECTOR_ALREADY_EXISTS' ? 409 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('CONNECTOR_UPDATE_FAILED', err instanceof Error ? err.message : 'Connector update failed', 500);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const result = await deleteConnector(decodeURIComponent(id));
    return ok(result);
  } catch (err) {
    if (err instanceof McpConnectorFailure && err.code === 'CONNECTOR_NOT_FOUND') {
      return fail(err.code, err.message, 404);
    }
    return fail('CONNECTOR_DELETE_FAILED', err instanceof Error ? err.message : 'Connector deletion failed', 500);
  }
}
