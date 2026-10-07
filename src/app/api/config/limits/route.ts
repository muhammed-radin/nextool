/**
 * /api/config/limits — the Configuration Registry API (v1.0.8 §10 + v1.0.14 §17/§18).
 *
 * GET              → the RESOLVED configuration-limit metadata from the ONE
 *                    authoritative config/configuration-limits.json.
 * GET ?preset=…    → a full preset limits JSON: "standard" (shipped defaults)
 *                    or "unrestricted" (⚠ everything at its maximum — the UI
 *                    renders a persistent warning before applying it).
 * PUT              → SAVE a full limits JSON: validate (structure/types/
 *                    ranges/required fields) BEFORE writing; only a fully
 *                    valid object replaces the file. The loader cache is
 *                    invalidated so the runtime hot-reloads within ~2 s —
 *                    the change affects the REAL runtime (VFS, execution,
 *                    network, terminal, task limits), not just the UI.
 *
 * Only configuration METADATA is exposed — no environment variables, no
 * secrets, no host paths beyond the documented file name (spec §10).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail, ok } from '@/lib/nexool/api-helpers';
import {
  getConfigurationLimits,
  getResolvedLimits,
  invalidateConfigurationLimitsCache,
  validateLimitsObject,
  ConfigurationLimitsError,
} from '@/lib/nexool/config-limits';
import { standardPreset, unrestrictedPreset } from '@/lib/nexool/limits-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Where the loader reads the file — reused so a save always writes the file
 *  the runtime actually consumes (env override honored). */
function limitsFilePath(): string {
  return process.env.NEXTOOL_LIMITS_FILE ?? path.join(process.cwd(), 'config', 'configuration-limits.json');
}

export async function GET(req: Request) {
  const preset = new URL(req.url).searchParams.get('preset');
  if (preset) {
    // v1.0.14 §18 — presets are generated from the SHIPPED snapshot (standard)
    // or the current file (unrestricted, so custom sections survive).
    if (preset === 'standard') {
      return ok({ preset, limits: standardPreset() });
    }
    if (preset === 'unrestricted') {
      try {
        return ok({ preset, limits: unrestrictedPreset(getConfigurationLimits()) });
      } catch {
        return ok({ preset, limits: unrestrictedPreset() });
      }
    }
    return fail('UNKNOWN_PRESET', `Unknown preset "${preset}" — use "standard" or "unrestricted".`, 400);
  }
  try {
    const limits = getConfigurationLimits();
    const resolved = getResolvedLimits();
    return ok({
      limits,
      resolved,
      source: 'config/configuration-limits.json',
    });
  } catch (err) {
    // Invalid limits file → a CLEAR error the UI renders (spec §7.7).
    return fail(
      'CONFIGURATION_LIMITS_INVALID',
      err instanceof Error ? err.message : 'configuration-limits.json is invalid.',
      500,
    );
  }
}

/** v1.0.14 §17.2/§18.1 — save/import: validate FIRST, then write. */
export async function PUT(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    return fail('INVALID_JSON', `Request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
  }

  // §18.1 — full validation before anything is written: structure, types,
  // required fields, ranges/relationships. The current configuration is NOT
  // touched until validation succeeds.
  const issues = validateLimitsObject(raw);
  if (issues.length > 0) {
    return fail(
      'CONFIGURATION_LIMITS_INVALID',
      `The submitted limits object failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'}): ${issues.join(' | ')}`,
      400,
    );
  }

  const filePath = limitsFilePath();
  try {
    const serialized = `${JSON.stringify(raw, null, 2)}\n`;
    // atomic write: temp file + rename so the loader never reads a half file
    const tmp = `${filePath}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, serialized, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    return fail(
      'LIMITS_WRITE_FAILED',
      `Cannot write the limits file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // hot reload: the next access re-reads the file (≤2 s) — no restart needed.
  invalidateConfigurationLimitsCache();

  try {
    const limits = getConfigurationLimits();
    const resolved = getResolvedLimits();
    return ok({ saved: true, limits, resolved, source: filePath });
  } catch (err) {
    // Extremely defensive: validation passed but the loader still objects.
    const message = err instanceof ConfigurationLimitsError
      ? err.issues.join(' ')
      : err instanceof Error ? err.message : 'Reload failed.';
    return fail('CONFIGURATION_LIMITS_INVALID', message, 500);
  }
}
