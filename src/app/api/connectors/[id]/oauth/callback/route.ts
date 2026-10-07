/**
 * /api/connectors/[id]/oauth/callback — OAuth redirect target (v1.0.13 §5.2).
 * GET ?code=…&state=…  (or ?error=… when the provider denied the login)
 *
 * Validates the SINGLE-USE, 10-min-TTL pending state, exchanges the
 * authorization code at the preset token endpoint and stores the tokens via
 * the connector manager (`completeOAuth`) — the browser NEVER sees tokens.
 * Every outcome ends in an HTTP 302 back to the console:
 *   /?oauth=<connectorId>&status=ok|error&detail=…#connectors
 */
import { NextResponse } from 'next/server';
import { completeOAuth, consumeOauthState, markOauthFailure, McpConnectorFailure } from '@/lib/nexool/mcp/connector-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/** Same origin derivation as /oauth/start (forwarded host/proto first). */
function requestOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) {
    const proto = req.headers.get('x-forwarded-proto') ?? (/^(localhost|127\.|0\.0\.0\.0|\[)/.test(host) ? 'http' : 'https');
    return `${proto}://${host}`;
  }
  return new URL(req.url).origin;
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const connectorId = decodeURIComponent(id);
  const url = new URL(req.url);
  const origin = requestOrigin(req);

  const back = (status: 'ok' | 'error', detail: string): NextResponse =>
    NextResponse.redirect(
      new URL(`/?oauth=${encodeURIComponent(connectorId)}&status=${status}&detail=${encodeURIComponent(detail)}#connectors`, origin),
      302,
    );

  const state = url.searchParams.get('state') ?? '';
  const providerError = url.searchParams.get('error');
  const providerErrorDesc = url.searchParams.get('error_description');
  const code = url.searchParams.get('code');

  // Single-use state validation — consumed BEFORE any processing.
  const pending = state ? consumeOauthState(state) : undefined;
  if (!pending) {
    return back('error', 'Unknown, expired or already-used OAuth state — start the login again.');
  }
  if (pending.connectorId !== connectorId) {
    return back('error', 'OAuth state does not belong to this connector — start the login again.');
  }

  if (providerError) {
    const detail = providerErrorDesc ? `${providerError}: ${providerErrorDesc}` : providerError;
    await markOauthFailure(connectorId, detail);
    return back('error', `The provider denied the login (${detail}).`);
  }
  if (!code) {
    const detail = 'The authorization response contained no code.';
    await markOauthFailure(connectorId, detail);
    return back('error', detail);
  }

  try {
    await completeOAuth(connectorId, { code, ...(pending.codeVerifier ? { codeVerifier: pending.codeVerifier } : {}), redirectUri: pending.redirectUri });
    return back('ok', 'Credentials stored server-side.');
  } catch (err) {
    const message = err instanceof McpConnectorFailure ? err.message : err instanceof Error ? err.message : 'Token exchange failed.';
    await markOauthFailure(connectorId, message);
    return back('error', message);
  }
}
