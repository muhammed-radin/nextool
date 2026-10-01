/**
 * POST /api/tools/register — alias endpoint for dynamic tool registration
 * (same behavior as POST /api/tools). Body validated with registerToolSchema (zod).
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { registerDynamicTool } from '@/lib/nexool/tools/registry';
import { registerToolSchema } from '@/lib/nexool/schemas';
import type { ToolDefinition } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseBody(req, registerToolSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  try {
    const entry = await registerDynamicTool(
      body.definition as ToolDefinition,
      body.handlerKind,
      body.handlerConfig,
    );
    return ok(entry, 201);
  } catch (err) {
    return fail('REGISTER_FAILED', err instanceof Error ? err.message : 'Tool registration failed', 400);
  }
}
