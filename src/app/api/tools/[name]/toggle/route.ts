/**
 * POST /api/tools/[name]/toggle — enable/disable a tool. Body: { enabled: boolean }
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { toggleTool } from '@/lib/nexool/tools/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  enabled?: boolean;
}

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const body = await readJson<Body>(req);
  if (typeof body?.enabled !== 'boolean') {
    return fail('INVALID_PARAMS', 'enabled (boolean) is required');
  }
  try {
    const entry = await toggleTool(decodeURIComponent(name), body.enabled);
    return ok(entry);
  } catch {
    return fail('NOT_FOUND', `Tool not found: ${name}`, 404);
  }
}
