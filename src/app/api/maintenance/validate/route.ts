/**
 * GET /api/maintenance/validate — v1.0.7 §4.11 runtime dependency validation.
 *
 * Checks that the active model exists (built-in llm-core engine), model
 * manifest/artifact metadata parses, required datasets exist and all
 * dataset/model references resolve. Reports clear errors — never creates
 * replacements.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { validateRuntimeDependencies } from '@/lib/nexool/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const report = await validateRuntimeDependencies();
  return ok(report);
}
