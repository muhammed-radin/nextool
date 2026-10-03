/**
 * GET /api/config/limits — the Configuration Registry API (v1.0.8 §10).
 *
 * Exposes the RESOLVED configuration-limit metadata from the ONE authoritative
 * config/configuration-limits.json so the frontend can derive its validation
 * and input metadata from the SAME source as the backend and runtime
 * (spec §8.1–§8.3: input type / min / max / default / unit / description are
 * never duplicated in React components).
 *
 * Only configuration METADATA is exposed — no environment variables, no
 * secrets, no host paths beyond the documented file name (spec §10).
 */
import { fail, ok } from '@/lib/nexool/api-helpers';
import { getConfigurationLimits, getResolvedLimits } from '@/lib/nexool/config-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const limits = getConfigurationLimits();
    const resolved = getResolvedLimits();
    return ok({
      limits,
      resolved,
      source: 'config/configuration-limits.json',
    });
  } catch (err) {
    // Invalid limits file → a CLEAR error the Settings UI renders (spec §7.7).
    return fail(
      'CONFIGURATION_LIMITS_INVALID',
      err instanceof Error ? err.message : 'configuration-limits.json is invalid.',
      500,
    );
  }
}
