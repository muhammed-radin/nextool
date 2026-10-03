/**
 * POST /api/settings/reset — v1.0.7 §3 "Reset Application Data".
 *
 * DESTRUCTIVE, explicitly confirmed operation: the body must contain the
 * exact typed confirmation phrase { "confirm": "RESET" } (§3.3). The backend
 * performs the actual reset (never browser-only) through the maintenance
 * layer, which clears RUNTIME data only — tools, models, datasets, training
 * artifacts and settings are structurally protected (§3.5).
 *
 * The route follows the existing API conventions (ApiEnvelope + zod).
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { resetApplicationSchema } from '@/lib/nexool/schemas';
import { resetApplicationRuntime } from '@/lib/nexool/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseBody(req, resetApplicationSchema, 'CONFIRMATION_REQUIRED');
  if (parsed.error) return parsed.error;
  try {
    const report = await resetApplicationRuntime(parsed.data.confirm);
    if (!report.ok) {
      return fail('RESET_FAILED', report.failures[0] ?? 'Reset failed — nothing was changed.', 500);
    }
    return ok(report);
  } catch (err) {
    return fail('RESET_FAILED', err instanceof Error ? err.message : 'Application data reset failed.', 500);
  }
}
