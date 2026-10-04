/**
 * GET  /api/benchmark — list benchmark runs (history)
 * POST /api/benchmark — run a REAL benchmark synchronously (returns full metrics)
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { runBenchmark } from '@/lib/nexool/training/benchmark';
import { createBenchmarkRunSchema } from '@/lib/nexool/schemas';
import type { BenchmarkConfig, BenchmarkMetrics, BenchmarkRunSummary } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function toSummary(row: {
  id: string; label: string | null; modelKey: string; datasetId: string;
  datasetName: string; datasetVersion: string; status: string;
  metrics: string; durationMs: number; error: string | null; createdAt: Date;
}): BenchmarkRunSummary {
  return {
    id: row.id,
    label: row.label,
    modelKey: row.modelKey,
    datasetId: row.datasetId,
    datasetName: row.datasetName,
    datasetVersion: row.datasetVersion,
    status: row.status as BenchmarkRunSummary['status'],
    metrics: JSON.parse(row.metrics) as BenchmarkMetrics,
    durationMs: row.durationMs,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET() {
  try {
    const rows = await db.benchmarkRunRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return ok(rows.map(toSummary));
  } catch (err) {
    return fail('BENCHMARK_LIST_FAILED', err instanceof Error ? err.message : 'Failed to list benchmark runs', 500);
  }
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, createBenchmarkRunSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data as BenchmarkConfig & { label?: string };

  try {
    const dataset = await db.datasetRecord.findUnique({ where: { id: body.datasetId }, select: { id: true } });
    if (!dataset) return fail('NOT_FOUND', `Dataset not found: ${body.datasetId}`, 404);

    const result = await runBenchmark(body);
    if (!result.ok) return fail('BENCHMARK_FAILED', result.error ?? 'Benchmark failed', 400);
    const row = await db.benchmarkRunRecord.findUnique({ where: { id: result.runId as string } });
    if (!row) return fail('BENCHMARK_FAILED', 'Benchmark run vanished after completion', 500);
    return ok(toSummary(row), 201);
  } catch (err) {
    return fail('BENCHMARK_FAILED', err instanceof Error ? err.message : 'Benchmark failed', 500);
  }
}
