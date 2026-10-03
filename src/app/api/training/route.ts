/**
 * GET  /api/training          — list training jobs (newest first)
 * POST /api/training          — create + START a real training job (fire-and-forget runner)
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { runTrainingJob, resolveTrainingConfig } from '@/lib/nexool/training/engine';
import { createTrainingJobSchema } from '@/lib/nexool/schemas';
import type { TrainingJobSummary, TrainingConfig } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function toSummary(row: {
  id: string; datasetId: string; datasetName: string; datasetVersion: string;
  status: string; config: string; epochs: number; epochsDone: number;
  error: string | null; modelRecordId: string | null;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date;
}): TrainingJobSummary {
  return {
    id: row.id,
    datasetId: row.datasetId,
    datasetName: row.datasetName,
    datasetVersion: row.datasetVersion,
    status: row.status as TrainingJobSummary['status'],
    config: JSON.parse(row.config) as TrainingConfig,
    epochs: row.epochs,
    epochsDone: row.epochsDone,
    error: row.error,
    modelRecordId: row.modelRecordId,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET() {
  try {
    const rows = await db.trainingJobRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return ok(rows.map(toSummary));
  } catch (err) {
    return fail('TRAINING_LIST_FAILED', err instanceof Error ? err.message : 'Failed to list training jobs', 500);
  }
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, createTrainingJobSchema);
  if (parsed.error) return parsed.error;
  const { datasetId, config } = parsed.data;

  try {
    const dataset = await db.datasetRecord.findUnique({ where: { id: datasetId } });
    if (!dataset) return fail('NOT_FOUND', `Dataset not found: ${datasetId}`, 404);

    const resolved = resolveTrainingConfig(config);
    const job = await db.trainingJobRecord.create({
      data: {
        datasetId: dataset.id,
        datasetName: dataset.name,
        datasetVersion: dataset.version,
        status: 'queued',
        config: JSON.stringify(resolved),
        epochs: resolved.epochs,
      },
    });

    // Real asynchronous runner — progress is persisted to the job row and the
    // UI polls GET /api/training/[id]. Same engine the CLI uses.
    void runTrainingJob({ jobId: job.id, datasetId: dataset.id, config: resolved }).catch(() => undefined);

    return ok(toSummary({ ...job, config: JSON.stringify(resolved) }), 202);
  } catch (err) {
    return fail('TRAINING_CREATE_FAILED', err instanceof Error ? err.message : 'Failed to create training job', 500);
  }
}
