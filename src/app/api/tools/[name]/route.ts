/**
 * GET    /api/tools/[name] — single tool entry (full definition incl. js source)
 * PUT    /api/tools/[name] — update a user-editable tool (dynamic | js-function)
 * DELETE /api/tools/[name] — delete a user tool (built-ins rejected)
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { getToolEntry, updateTool, deleteTool } from '@/lib/nexool/tools/registry';
import { ToolFailure } from '@/lib/nexool/tools/handler';
import { updateToolSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ name: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { name } = await params;
  try {
    const entry = await getToolEntry(decodeURIComponent(name));
    if (!entry) return fail('NOT_FOUND', `Tool not found: ${name}`, 404);
    return ok(entry);
  } catch (err) {
    return fail('TOOL_LOOKUP_FAILED', err instanceof Error ? err.message : 'Tool lookup failed', 500);
  }
}

export async function PUT(req: Request, { params }: Params) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const parsed = await parseBody(req, updateToolSchema);
  if (parsed.error) return parsed.error;
  try {
    const entry = await updateTool(decoded, parsed.data);
    return ok(entry);
  } catch (err) {
    if (err instanceof ToolFailure) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'READ_ONLY' ? 403 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('UPDATE_FAILED', err instanceof Error ? err.message : 'Tool update failed', 500);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { name } = await params;
  try {
    const result = await deleteTool(decodeURIComponent(name));
    return ok(result);
  } catch (err) {
    if (err instanceof ToolFailure) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'READ_ONLY' ? 403 : 400;
      return fail(err.code, err.message, status);
    }
    return fail('DELETE_FAILED', err instanceof Error ? err.message : 'Tool deletion failed', 500);
  }
}
