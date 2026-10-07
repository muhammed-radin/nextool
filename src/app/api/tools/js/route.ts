/**
 * POST /api/tools/js — register a function tool authored in the Tool IDE.
 * v1.0.5: accepts environment "js-function" (default) or "nodejs" — ONE
 * registration system, two restricted sandboxes. Function source is validated
 * server-side by the matching sandbox before registration.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { registerJsTool } from '@/lib/nexool/tools/registry';
import { ToolFailure } from '@/lib/nexool/tools/handler';
import { registerJsToolSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseBody(req, registerJsToolSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  try {
    const entry = await registerJsTool({
      name: body.name,
      description: body.description,
      purpose: body.purpose,
      category: body.category,
      toolVersion: body.toolVersion,
      environment: body.environment,
      metadata: body.metadata,
      schema: body.schema,
      functionSource: body.functionSource,
      autoExecute: body.autoExecute,
      // v1.0.13 — verification latch round-trips on create.
      verificationLatch: body.verificationLatch,
      // v1.0.7 §1 — tool-specific execution timeout round-trips on create.
      timeoutMs: body.timeoutMs,
      enabled: body.enabled,
    });
    return ok(entry, 201);
  } catch (err) {
    if (err instanceof ToolFailure) {
      const status = err.code === 'ALREADY_EXISTS' ? 409 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('REGISTER_FAILED', err instanceof Error ? err.message : 'Tool registration failed', 500);
  }
}
