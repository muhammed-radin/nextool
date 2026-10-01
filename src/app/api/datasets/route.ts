/**
 * /api/datasets — GET list; /import POST handled in its own route.
 */
import { ok } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import type { DatasetInfo } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const rows = await db.datasetRecord.findMany({ orderBy: { updatedAt: 'desc' }, take: 100 });
  const datasets: DatasetInfo[] = rows.map((r) => {
    let categories: string[] | undefined;
    try { categories = r.categories ? (JSON.parse(r.categories) as string[]) : undefined; } catch { /* undefined */ }
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      format: r.format === 'parquet' ? 'parquet' : 'json',
      trainSize: r.trainSize,
      valSize: r.valSize,
      testSize: r.testSize,
      categories,
      note: r.note ?? undefined,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
  return ok(datasets);
}
