/**
 * /api/connectors/[id]/oauth/start — begin the OAuth 2.0 redirect login (v1.0.13 §5.2).
 * POST { method: "oauth2" } → { authorizeUrl, stateExpiresInSeconds }
 *
 * The manager builds the authorize URL from the PROVIDER preset (endpoints,
 * editable scopes, PKCE, extra params) + the connector's stored client
 * credentials, and parks a SINGLE-USE, 10-min-TTL pending state server-side.
 * The browser only receives the authorizeUrl — nothing secret.
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { McpConnectorFailure, startOAuth } from '@/lib/nexool/mcp/connector-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * The public origin the OAuth provider must redirect back to. Behind a
 * reverse proxy the forwarded host/proto is authoritative; the raw request
 * URL is the fallback (local curl testing).
 */
function requestOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto') ?? (/^(localhost|127\.|0\.0\.0\.0|\[)/.test(host) ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await readJson<{ method?: string }>(req);
  if (body === null || body.method !== 'oauth2') {
    return fail('INVALID_PARAMS', 'Expected a JSON body { "method": "oauth2" }.', 400);
  }
  try {
    const result = await startOAuth(decodeURIComponent(id), requestOrigin(req));
    return ok(result);
  } catch (err) {
    if (err instanceof McpConnectorFailure) {
      const status =
        err.code === 'CONNECTOR_NOT_FOUND' || err.code === 'PROVIDER_UNKNOWN' ? 404
        : err.code === 'OAUTH_NOT_CONFIGURED' || err.code === 'OAUTH_CLIENT_ID_MISSING' ? 400
        : 502;
      return fail(err.code, err.message, status);
    }
    return fail('OAUTH_START_FAILED', err instanceof Error ? err.message : 'Failed to start the OAuth login', 500);
  }
}
