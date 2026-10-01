/**
 * GET /api/datasets/[id]/export?format=json — export dataset examples.
 * Parquet requests receive an honest 400 (adapter not installed in this environment).
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import type { DatasetInfo, DatasetExample } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PARQUET_MESSAGE = 'Parquet adapter is not installed in this environment. JSON interchange is fully supported.';

function toInfo(row: {
  id: string; name: string; version: string; format: string;
  trainSize: number; valSize: number; testSize: number;
  categories: string | null; note: string | null; createdAt: Date; updatedAt: Date;
}): DatasetInfo {
  let categories: string[] | undefined;
  try { categories = row.categories ? (JSON.parse(row.categories) as string[]) : undefined; } catch { /* undefined */ }
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    format: row.format === 'parquet' ? 'parquet' : 'json',
    trainSize: row.trainSize,
    valSize: row.valSize,
    testSize: row.testSize,
    categories,
    note: row.note ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'json';

  if (format === 'parquet') {
    return fail('PARQUET_UNAVAILABLE', PARQUET_MESSAGE, 400);
  }
  if (format !== 'json') {
    return fail('INVALID_PARAMS', `Unsupported export format: ${format} (json | parquet)`, 400);
  }

  const row = await db.datasetRecord.findUnique({ where: { id } });
  if (!row) return fail('NOT_FOUND', `Dataset not found: ${id}`, 404);

  let examples: DatasetExample[] = [];
  try { examples = JSON.parse(row.examples) as DatasetExample[]; } catch { /* keep empty */ }

  return ok({ dataset: toInfo(row), examples });
}
