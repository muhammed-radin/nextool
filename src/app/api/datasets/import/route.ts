/**
 * POST /api/datasets/import — DatasetImportPayload → DatasetRecord with split counts.
 * Body validated with datasetImportSchema (zod) — v1.0.1 §54.
 * Validation: examples non-empty array, each { category, request }; cap 5000.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { datasetImportSchema } from '@/lib/nexool/schemas';
import type { DatasetInfo, DatasetExample } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const parsed = await parseBody(req, datasetImportSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const valid: DatasetExample[] = body.examples.map((ex) => ({
    category: ex.category,
    request: ex.request,
    expectedTool: ex.expectedTool,
    expectedParams: ex.expectedParams,
    split: ex.split ?? 'train',
  }));

  const trainSize = valid.filter((e) => e.split === 'train').length;
  const valSize = valid.filter((e) => e.split === 'validation').length;
  const testSize = valid.filter((e) => e.split === 'test').length;
  const categories = [...new Set(valid.map((e) => e.category))];

  const row = await db.datasetRecord.create({
    data: {
      name: body.name,
      version: body.version,
      format: 'json',
      trainSize,
      valSize,
      testSize,
      examples: JSON.stringify(valid),
      categories: JSON.stringify(categories),
      note: body.note ?? null,
    },
  });

  const dataset: DatasetInfo = {
    id: row.id,
    name: row.name,
    version: row.version,
    format: 'json',
    trainSize: row.trainSize,
    valSize: row.valSize,
    testSize: row.testSize,
    categories,
    note: row.note ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return ok(dataset, 201);
}
