/**
 * /api/datasets/[id] — GET export (?format=json → { dataset, examples };
 * ?format=parquet → REAL binary Parquet download, v1.0.3), DELETE removes the dataset.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { encodeParquetDataset } from '@/lib/nexool/datasets/parquet';
import type { DatasetInfo, DatasetExample } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  if (format !== 'json' && format !== 'parquet') {
    return fail('INVALID_PARAMS', `Unsupported export format: ${format} (json | parquet)`, 400);
  }

  const row = await db.datasetRecord.findUnique({ where: { id } });
  if (!row) return fail('NOT_FOUND', `Dataset not found: ${id}`, 404);

  let examples: DatasetExample[] = [];
  try { examples = JSON.parse(row.examples) as DatasetExample[]; } catch { /* keep empty */ }

  if (format === 'parquet') {
    try {
      const bytes = await encodeParquetDataset(examples);
      const safeName = (row.name || 'dataset').replace(/[^\w.-]+/g, '-');
      const body = new Uint8Array(bytes);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.byteLength),
          'Content-Disposition': `attachment; filename="${safeName}-v${row.version}.parquet"`,
          'Cache-Control': 'no-store',
        },
      });
    } catch (err) {
      return fail('PARQUET_EXPORT_FAILED', err instanceof Error ? err.message : 'Parquet encoding failed.', 500);
    }
  }

  return ok({ dataset: toInfo(row), examples });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await db.datasetRecord.delete({ where: { id } });
    return ok({ deleted: true });
  } catch {
    return fail('NOT_FOUND', `Dataset not found: ${id}`, 404);
  }
}
