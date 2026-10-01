/**
 * /api/models — GET engine info + registered packages.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { getMetrics } from '@/lib/nexool/eventbus';
import type { ActiveEngineInfo, ModelPackageInfo } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const metrics = getMetrics();
  const engine: ActiveEngineInfo = {
    name: 'llm-core',
    version: '1.0.0',
    architecture: 'LLM CoreModule (tool-matching + parameter generation heads via structured prompting)',
    backend: 'z-ai-web-dev-sdk (server-side)',
    status: 'active',
    coreCalls: metrics.coreCalls,
    avgLatencyMs: metrics.coreCalls > 0 ? Math.round(metrics.totalCoreLatencyMs / metrics.coreCalls) : 0,
    lastDecisionAt: metrics.lastDecisionAt,
    notes: 'TensorFlow.js runtime is not installed in this environment. The LLM CoreModule is the active engine; the heuristic-fallback matcher covers SDK outages.',
  };

  const rows = await db.modelRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  const packages: ModelPackageInfo[] = rows.map((r) => {
    let manifest: Record<string, unknown> = {};
    try { manifest = JSON.parse(r.manifest) as Record<string, unknown>; } catch { /* keep empty */ }
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      format: r.format,
      status: r.status as ModelPackageInfo['status'],
      sizeBytes: r.sizeBytes ?? undefined,
      note: r.note ?? undefined,
      createdAt: r.createdAt.toISOString(),
      manifest,
    };
  });

  return ok({
    engine,
    packages,
    adapters: { tfjs: false, nextoolManifest: true, parquet: false },
  });
}
