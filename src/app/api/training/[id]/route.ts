/**
 * GET    /api/training/[id]   — full job detail (metrics series + logs)
 * DELETE /api/training/[id]   — cancel a running job (takes effect between epochs) / remove record
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { TRAINING_LOG_CAP } from '@/lib/nexool/training/engine';
import type { TrainingConfig, TrainingEpochMetrics, TrainingJobDetail, TrainingJobStatus, TrainingLogLine } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const row = await db.trainingJobRecord.findUnique({ where: { id } });
    if (!row) return fail('NOT_FOUND', `Training job not found: ${id}`, 404);
    const detail: TrainingJobDetail = {
      id: row.id,
      datasetId: row.datasetId,
      datasetName: row.datasetName,
      datasetVersion: row.datasetVersion,
      status: row.status as TrainingJobStatus,
      config: JSON.parse(row.config) as TrainingConfig,
      epochs: row.epochs,
      epochsDone: row.epochsDone,
      metrics: JSON.parse(row.metrics) as TrainingEpochMetrics[],
      logs: JSON.parse(row.logs) as TrainingLogLine[],
      finalMetrics: row.finalMetrics ? (JSON.parse(row.finalMetrics) as TrainingJobDetail['finalMetrics']) : null,
      error: row.error,
      modelRecordId: row.modelRecordId,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
    return ok(detail);
  } catch (err) {
    return fail('TRAINING_GET_FAILED', err instanceof Error ? err.message : 'Failed to load training job', 500);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const row = await db.trainingJobRecord.findUnique({ where: { id } });
    if (!row) return fail('NOT_FOUND', `Training job not found: ${id}`, 404);
    if (row.status === 'queued' || row.status === 'starting' || row.status === 'running') {
      // Signal cancellation — the runner checks between epochs and stops.
      await db.trainingJobRecord.update({ where: { id }, data: { status: 'cancelled' } });
      return ok({ cancelled: true, id });
    }
    await db.trainingJobRecord.delete({ where: { id } });
    return ok({ deleted: true, id });
  } catch (err) {
    return fail('TRAINING_CANCEL_FAILED', err instanceof Error ? err.message : 'Failed to cancel training job', 500);
  }
}

export { TRAINING_LOG_CAP };
