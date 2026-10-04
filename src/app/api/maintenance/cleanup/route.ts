/**
 * /api/maintenance/cleanup — v1.0.7 §4/§5 model/dataset resource cleanup.
 *
 * GET  — dependency analysis + dry-run cleanup report (never deletes).
 * POST — body { "dryRun": true } (default) reports only; { "dryRun": false }
 *        deletes ONLY confirmed orphaned records (no inbound references from
 *        training jobs, benchmark runs, or active status). Idempotent.
 *
 * The report is the traceable §4.8 output: protected / candidates / removed /
 * failed + broken-reference warnings.
 */
import { ok, parseBody } from '@/lib/nexool/api-helpers';
import { maintenanceCleanupSchema } from '@/lib/nexool/schemas';
import { runResourceCleanup } from '@/lib/nexool/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const report = await runResourceCleanup(true);
  return ok(report);
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, maintenanceCleanupSchema);
  if (parsed.error) return parsed.error;
  const dryRun = parsed.data.dryRun !== false;
  const report = await runResourceCleanup(dryRun);
  return ok(report);
}
