/**
 * /api/connectors/[id]/credentials — server-side credential storage (v1.0.12).
 * PUT    — set/merge credential fields (validated against the provider auth schema)
 * DELETE — remove the stored credentials
 *
 * SECURITY (spec §1.7): values are written to the McpCredential table ONLY and
 * are NEVER returned by any response — clients see `hasCredentials` and field
 * NAMES. Values are never logged and never enter tool definitions or exports.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { clearCredentials, McpConnectorFailure, setCredentials } from '@/lib/nexool/mcp/connector-manager';
import { connectorCredentialsSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params;
  const parsed = await parseBody(req, connectorCredentialsSchema);
  if (parsed.error) return parsed.error;
  try {
    const connector = await setCredentials(decodeURIComponent(id), parsed.data);
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status = err.code === 'CONNECTOR_NOT_FOUND' ? 404 : err.code === 'MCP_AUTH_REQUIRED' ? 400 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('CREDENTIALS_FAILED', err instanceof Error ? err.message : 'Credential update failed', 500);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const connector = await clearCredentials(decodeURIComponent(id));
    return ok(connector);
  } catch (err) {
    if (err instanceof McpConnectorFailure && err.code === 'CONNECTOR_NOT_FOUND') {
      return fail(err.code, err.message, 404);
    }
    return fail('CREDENTIALS_FAILED', err instanceof Error ? err.message : 'Credential removal failed', 500);
  }
}
