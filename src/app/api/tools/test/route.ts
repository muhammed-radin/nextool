/**
 * POST /api/tools/test — controlled test execution of a tool.
 *
 * v1.0.91 RESTORATION: this route file went missing AGAIN after the v1.0.8
 * backup restore (the same regression the v1.0.5 fix notes in docs/api.md) —
 * Tool IDE "Test Tool" requests fell through to /api/tools/[name], which only
 * exports GET/PUT/DELETE, so Next.js answered HTTP 405 Method Not Allowed and
 * the UI surfaced `REQUEST_FAILED: Invalid response from /api/tools/test
 * (HTTP 405)`. This dedicated route is the ONLY test path (it never mutates
 * editor or registry state).
 *
 * Request (exactly one of):
 *  - { name, params? }                              — registered tool
 *  - { functionSource, params?, environment? }      — unsaved Tool IDE source
 * Optional timeoutMs (v1.0.7) / networkTimeoutMs (v1.0.9).
 *
 * Response: { mode: "registered" | "test-source", environment, status,
 * durationMs, result, error, params, logs[] }.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { getToolDef, testToolSource } from '@/lib/nexool/tools/registry';
import { executeTool } from '@/lib/nexool/tools/executor';
import { testToolSchema } from '@/lib/nexool/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Map a testToolSource outcome to the documented status vocabulary. */
function statusFromTestRun(run: { ok: boolean; error?: { code: string; message: string } | undefined }): 'completed' | 'timeout' | 'failed' {
  if (run.ok) return 'completed';
  if (run.error?.code === 'TIMEOUT') return 'timeout';
  return 'failed';
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, testToolSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // Registered-tool mode — js/nodejs tools run their SAVED source through the
  // real sandbox in test mode (interactive helpers auto-resolve, scratch VFS);
  // every other environment runs the real handler pipeline via executeTool.
  if (body.name) {
    try {
      const def = await getToolDef(body.name);
      if (!def) return fail('NOT_FOUND', `Tool not found: ${body.name}`, 404);
      if ((def.environment === 'js-function' || def.environment === 'nodejs') && typeof def.functionSource === 'string' && def.functionSource.trim()) {
        const run = await testToolSource(def.functionSource, body.params ?? {}, {
          environment: def.environment,
          timeoutMs: body.timeoutMs ?? def.timeoutMs,
          networkTimeoutMs: body.networkTimeoutMs,
        });
        return ok({
          mode: 'registered' as const,
          environment: def.environment,
          status: statusFromTestRun(run),
          durationMs: run.durationMs,
          result: run.result ?? null,
          error: run.error ?? null,
          params: body.params ?? {},
          logs: run.logs,
        });
      }
      const execution = await executeTool(def.name, body.params ?? {}, {
        timeoutMs: body.timeoutMs,
        networkTimeoutMs: body.networkTimeoutMs,
      });
      return ok({
        mode: 'registered' as const,
        environment: def.environment,
        status: execution.status,
        durationMs: execution.durationMs ?? 0,
        result: execution.result ?? null,
        error: execution.error ?? null,
        params: execution.params ?? body.params ?? {},
        logs: [] as string[],
      });
    } catch (err) {
      return fail('TEST_FAILED', err instanceof Error ? err.message : 'Tool test failed', 500);
    }
  }

  // Test-source mode — the unsaved Tool IDE source, sandboxed.
  try {
    const run = await testToolSource(body.functionSource ?? '', body.params ?? {}, {
      environment: body.environment,
      timeoutMs: body.timeoutMs,
      networkTimeoutMs: body.networkTimeoutMs,
    });
    return ok({
      mode: 'test-source' as const,
      environment: body.environment ?? 'js-function',
      status: statusFromTestRun(run),
      durationMs: run.durationMs,
      result: run.result ?? null,
      error: run.error ?? null,
      params: body.params ?? {},
      logs: run.logs,
    });
  } catch (err) {
    return fail('TEST_FAILED', err instanceof Error ? err.message : 'Tool test failed', 500);
  }
}
