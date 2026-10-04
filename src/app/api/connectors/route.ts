/**
 * /api/connectors — MCP connector management (v1.0.12).
 * GET  — supported providers (JSON registry) + connector instances w/ REAL status
 * POST — create a connector instance of a registry provider
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { createConnector, listConnectors, McpConnectorFailure } from '@/lib/nexool/mcp/connector-manager';
import { createConnectorSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await listConnectors();
    return ok(data);
  } catch (err) {
    return fail('CONNECTORS_FAILED', err instanceof Error ? err.message : 'Failed to list connectors', 500);
  }
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, createConnectorSchema);
  if (parsed.error) return parsed.error;
  try {
    const connector = await createConnector(parsed.data);
    return ok(connector, 201);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status = err.code === 'PROVIDER_UNKNOWN' || err.code === 'CONNECTOR_NOT_FOUND' ? 404 : err.code === 'PROVIDER_DISABLED' ? 403 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('CONNECTOR_CREATE_FAILED', err instanceof Error ? err.message : 'Connector creation failed', 500);
  }
}
