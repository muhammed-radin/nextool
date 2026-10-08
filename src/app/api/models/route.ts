/**
 * /api/models — GET engine info + registered packages.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { getMetrics } from '@/lib/nexool/eventbus';
import { CORE_MODULE_NAME, CORE_MODULE_VERSION, APP_VERSION } from '@/lib/nexool/version';
import { parquetAdapterInfo } from '@/lib/nexool/datasets/parquet';
import { getActiveTrainedModel } from '@/lib/nexool/training/current-model';
import * as tf from '@tensorflow/tfjs';
import type { ActiveEngineInfo, ModelPackageInfo } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const metrics = getMetrics();
  const engine: ActiveEngineInfo = {
    name: CORE_MODULE_NAME,
    version: CORE_MODULE_VERSION,
    architecture: 'LLM CoreModule (tool-matching + parameter generation heads via structured prompting)',
    backend: 'z-ai-web-dev-sdk (server-side)',
    status: 'active',
    coreCalls: metrics.coreCalls,
    avgLatencyMs: metrics.coreCalls > 0 ? Math.round(metrics.totalCoreLatencyMs / metrics.coreCalls) : 0,
    lastDecisionAt: metrics.lastDecisionAt,
    notes: `TensorFlow.js ${tf.version.tfjs ?? ''} is installed (CPU backend) — real training, benchmark inference and native model packaging are available. The LLM CoreModule is the active decision engine; since v1.0.15 the CURRENT TRAINED CHECKPOINT (see currentModel) feeds a tool suggestion into every CoreModule decision and serves as the first fallback when the LLM is unavailable; the heuristic-fallback matcher covers outages without an active checkpoint.`,
  };

  const rows = await db.modelRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  // v1.0.3: the Parquet adapter is real (@dsnp/parquetjs) — capability comes
  // from the actual module load, never a hardcoded flag.
  const parquet = await parquetAdapterInfo();
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

  // v1.0.15 — the CURRENT TRAINED MODEL (registry status='active'): the
  // checkpoint the runtime classifier actually serves. Reported separately
  // from the llm-core decision engine and from the application version.
  const currentModel = await getActiveTrainedModel();

  return ok({
    engine,
    packages,
    currentModel,
    adapters: { tfjs: true, nextoolManifest: true, parquet: parquet.available },
    appVersion: APP_VERSION,
  });
}
