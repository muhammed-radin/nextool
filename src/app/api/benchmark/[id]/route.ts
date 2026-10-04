/**
 * GET /api/benchmark/[id] — one historical run incl. per-case results
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import type { BenchmarkCaseResult, BenchmarkConfig, BenchmarkMetrics, BenchmarkRunDetail, BenchmarkRunSummary } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const row = await db.benchmarkRunRecord.findUnique({ where: { id } });
    if (!row) return fail('NOT_FOUND', `Benchmark run not found: ${id}`, 404);
    const summary: Omit<BenchmarkRunDetail, 'config' | 'cases'> = {
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
    const detail: BenchmarkRunDetail = {
      ...summary,
      config: JSON.parse(row.config) as BenchmarkConfig,
      cases: JSON.parse(row.cases) as BenchmarkCaseResult[],
    };
    return ok(detail);
  } catch (err) {
    return fail('BENCHMARK_GET_FAILED', err instanceof Error ? err.message : 'Failed to load benchmark run', 500);
  }
}
