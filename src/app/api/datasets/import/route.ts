/**
 * POST /api/datasets/import — DatasetImportPayload → DatasetRecord with split counts.
 * Validation: examples non-empty array, each { category, request }; cap 5000.
 */
import { ok, fail, readJson } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import type { DatasetInfo, DatasetExample } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_EXAMPLES = 5000;

interface ImportBody {
  name?: unknown;
  version?: unknown;
  examples?: unknown;
  note?: unknown;
}

export async function POST(req: Request) {
  const body = await readJson<ImportBody>(req);
  if (!body || typeof body.name !== 'string' || !body.name.trim()) {
    return fail('INVALID_PARAMS', 'name (string) is required');
  }
  if (typeof body.version !== 'string' || !body.version.trim()) {
    return fail('INVALID_PARAMS', 'version (string) is required');
  }
  if (!Array.isArray(body.examples) || body.examples.length === 0) {
    return fail('INVALID_PARAMS', 'examples must be a non-empty array of { category, request }');
  }
  if (body.examples.length > MAX_EXAMPLES) {
    return fail('INVALID_PARAMS', `Too many examples (max ${MAX_EXAMPLES}, got ${body.examples.length})`);
  }

  const valid: DatasetExample[] = [];
  const errors: string[] = [];
  body.examples.forEach((raw, i) => {
    const ex = raw as Partial<DatasetExample>;
    if (!ex || typeof ex.category !== 'string' || !ex.category.trim()) {
      errors.push(`examples[${i}].category must be a string`);
      return;
    }
    if (typeof ex.request !== 'string' || !ex.request.trim()) {
      errors.push(`examples[${i}].request must be a string`);
      return;
    }
    valid.push({
      category: ex.category.trim(),
      request: ex.request.trim(),
      expectedTool: typeof ex.expectedTool === 'string' ? ex.expectedTool : undefined,
      expectedParams: ex.expectedParams && typeof ex.expectedParams === 'object' && !Array.isArray(ex.expectedParams)
        ? ex.expectedParams as Record<string, unknown>
        : undefined,
      split: ex.split === 'validation' || ex.split === 'test' ? ex.split : 'train',
    });
  });

  if (errors.length > 0) {
    return fail('INVALID_EXAMPLES', `Invalid examples: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`);
  }

  const trainSize = valid.filter((e) => e.split === 'train').length;
  const valSize = valid.filter((e) => e.split === 'validation').length;
  const testSize = valid.filter((e) => e.split === 'test').length;
  const categories = [...new Set(valid.map((e) => e.category))];

  const row = await db.datasetRecord.create({
    data: {
      name: body.name.trim(),
      version: body.version.trim(),
      format: 'json',
      trainSize,
      valSize,
      testSize,
      examples: JSON.stringify(valid),
      categories: JSON.stringify(categories),
      note: typeof body.note === 'string' ? body.note : null,
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
