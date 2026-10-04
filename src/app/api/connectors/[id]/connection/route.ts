/**
 * /api/connectors/[id]/connection — connect / disconnect / reconnect (v1.0.12).
 * The resulting status is the REAL state of the MCP session — never faked:
 *   connect    → connected | auth_required | error
 *   disconnect → disconnected (imported tools stay registered, unavailable)
 *   reconnect  → connected | auth_required | error
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { connectConnector, disconnectConnector, McpConnectorFailure, reconnectConnector } from '@/lib/nexool/mcp/connector-manager';
import { connectorConnectionSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = await parseBody(req, connectorConnectionSchema);
  if (parsed.error) return parsed.error;
  const connectorId = decodeURIComponent(id);
  try {
    const connector =
      parsed.data.action === 'connect'
        ? await connectConnector(connectorId)
        : parsed.data.action === 'reconnect'
          ? await reconnectConnector(connectorId)
          : await disconnectConnector(connectorId);
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      // auth_required/connection failures are EXPECTED states, not crashes —
      // 200 with the honest status would be defensible, but the caller asked
      // for an action that did not complete, so 4xx communicates it clearly.
      const status =
        err.code === 'CONNECTOR_NOT_FOUND' ? 404
        : err.code === 'CONNECTOR_DISABLED' ? 403
        : err.code === 'MCP_AUTH_REQUIRED' ? 401
        : 502;
      return fail(err.code, err.message, status);
    }
    return fail('CONNECTION_FAILED', err instanceof Error ? err.message : 'Connection action failed', 500);
  }
}
