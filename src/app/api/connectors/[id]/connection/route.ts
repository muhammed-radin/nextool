/**
 * /api/connectors/[id]/connection — connect / disconnect / reconnect / refresh-auth.
 * The resulting status is the REAL state of the MCP session — never faked:
 *   connect      → connected | auth_required | error
 *   disconnect   → disconnected (imported tools stay registered, unavailable)
 *   reconnect    → connected | auth_required | error
 *   refresh-auth → §5.4 token refresh (v1.0.13) — rotates the stored access
 *                  token via the provider's refresh-token grant; throws a
 *                  structured failure when no refresh token/endpoint exists.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { zodMessage } from '@/lib/nexool/schemas';
import { connectorConnectionSchema } from '@/lib/nexool/schemas';
import {
  connectConnector,
  disconnectConnector,
  McpConnectorFailure,
  reconnectConnector,
  refreshConnectorToken,
} from '@/lib/nexool/mcp/connector-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Map a connector failure to the same honest status codes as the legacy actions. */
function failureStatus(err: McpConnectorFailure): number {
  return err.code === 'CONNECTOR_NOT_FOUND' ? 404
    : err.code === 'CONNECTOR_DISABLED' ? 403
    : err.code === 'MCP_AUTH_REQUIRED' ? 401
    : err.code === 'OAUTH_NOT_CONFIGURED' || err.code === 'OAUTH_REFRESH_UNAVAILABLE' ? 400
    : 502;
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const connectorId = decodeURIComponent(id);
  // The body is read ONCE (refresh-auth is a v1.0.13 addition beyond the
  // v1.0.12 zod schema, so the dispatch happens before schema validation).
  const raw = await req.text();
  let parsedRaw: unknown = null;
  try {
    parsedRaw = raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return fail('INVALID_PARAMS', 'Request body must be valid JSON', 400);
  }
  const action = parsedRaw && typeof parsedRaw === 'object' && !Array.isArray(parsedRaw)
    ? (parsedRaw as { action?: unknown }).action
    : undefined;

  // §5.4 — refresh-auth: rotate the stored access token via the refresh grant.
  if (action === 'refresh-auth') {
    try {
      const result = await refreshConnectorToken(connectorId);
      return ok(result);
    } catch (err) {
      if (err instanceof McpConnectorFailure) return fail(err.code, err.message, failureStatus(err));
      return fail('REFRESH_AUTH_FAILED', err instanceof Error ? err.message : 'Token refresh failed', 500);
    }
  }

  // Legacy actions — identical behavior to v1.0.12 (schema-validated).
  const legacy = connectorConnectionSchema.safeParse(parsedRaw);
  if (!legacy.success) {
    return fail('INVALID_PARAMS', `Invalid request — ${zodMessage(legacy.error)}`, 400);
  }
  try {
    const connector =
      legacy.data.action === 'connect'
        ? await connectConnector(connectorId)
        : legacy.data.action === 'reconnect'
          ? await reconnectConnector(connectorId)
          : await disconnectConnector(connectorId);
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      // auth_required/connection failures are EXPECTED states, not crashes —
      // 200 with the honest status would be defensible, but the caller asked
      // for an action that did not complete, so 4xx communicates it clearly.
      return fail(err.code, err.message, failureStatus(err));
    }
    return fail('CONNECTION_FAILED', err instanceof Error ? err.message : 'Connection action failed', 500);
  }
}
