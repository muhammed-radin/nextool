/**
 * POST /api/tools/[name]/toggle — enable/disable a tool.
 * Body validated with toggleToolSchema (zod) — v1.0.1 §54.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { toggleTool } from '@/lib/nexool/tools/registry';
import { toggleToolSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const parsed = await parseBody(req, toggleToolSchema);
  if (parsed.error) return parsed.error;
  try {
    const entry = await toggleTool(decodeURIComponent(name), parsed.data.enabled);
    return ok(entry);
  } catch {
    return fail('NOT_FOUND', `Tool not found: ${name}`, 404);
  }
}
