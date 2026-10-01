/**
 * POST /api/tools/register — alias endpoint for dynamic tool registration
 * (same behavior as POST /api/tools). Body: { definition, handlerKind?, handlerConfig? }
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { registerDynamicTool } from '@/lib/nexool/tools/registry';
import type { ToolDefinition } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RegisterBody {
  definition?: ToolDefinition;
  handlerKind?: 'echo' | 'delay' | 'http_get' | 'uuid';
  handlerConfig?: Record<string, unknown>;
}

export async function POST(req: Request) {
  const body = await readJson<RegisterBody>(req);
  if (!body?.definition) return fail('INVALID_PARAMS', 'definition (ToolDefinition) is required');
  try {
    const entry = await registerDynamicTool(body.definition, body.handlerKind, body.handlerConfig);
    return ok(entry, 201);
  } catch (err) {
    return fail('REGISTER_FAILED', err instanceof Error ? err.message : 'Tool registration failed', 400);
  }
}
