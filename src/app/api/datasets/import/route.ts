/**
 * POST /api/datasets/import — DatasetImportPayload → DatasetRecord with split counts.
 * Body validated with datasetImportSchema (zod) — v1.0.1 §54.
 * Validation: examples non-empty array, each { category, request }; cap 5000.
 *
 * v1.0.3 — TWO ways to import:
 *   1. application/json            → { name, version, examples[], note? } (unchanged)
 *   2. multipart/form-data         → file=dataset.parquet (decoded by the REAL
 *     Parquet adapter, @dsnp/parquetjs) or file=dataset.json ({ examples[] }),
 *     with name/version/note supplied as form fields.
 *
 * Imported examples always land in the registry as structured records; the
 * record's `format` honestly reflects the interchange format used to import.
 */
import { ok, fail, parseBody } from '@/lib/nexool/api-helpers';
import { db } from '@/lib/db';
import { datasetImportSchema, zodMessage } from '@/lib/nexool/schemas';
import { decodeParquetDataset } from '@/lib/nexool/datasets/parquet';
import type { DatasetInfo, DatasetExample } from '@/lib/nexool/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB — mirrors model import cap

interface ImportInput {
  name: string;
  version: string;
  examples: DatasetExample[];
  note?: string;
  format: 'json' | 'parquet';
}

async function importFromMultipart(req: Request): Promise<{ data?: ImportInput; error?: { code: string; message: string } }> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { error: { code: 'INVALID_PARAMS', message: 'Malformed multipart body.' } };
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return { error: { code: 'INVALID_PARAMS', message: 'multipart body requires a "file" field (.parquet or .json).' } };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: { code: 'INVALID_PARAMS', message: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit.` } };
  }

  const name = String(form.get('name') ?? '').trim();
  const version = String(form.get('version') ?? '1.0.0').trim();
  const note = String(form.get('note') ?? '').trim();

  const lower = file.name.toLowerCase();
  try {
    if (lower.endsWith('.parquet')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const examples = await decodeParquetDataset(bytes);
      return {
        data: {
          name: name || file.name.replace(/\.parquet$/i, ''),
          version: version || '1.0.0',
          examples,
          ...(note ? { note } : {}),
          format: 'parquet',
        },
      };
    }
    if (lower.endsWith('.json')) {
      const parsed = JSON.parse(await file.text()) as Partial<ImportInput> | DatasetExample[];
      const examples = Array.isArray(parsed) ? parsed : parsed.examples;
      if (!Array.isArray(examples) || examples.length === 0) {
        return { error: { code: 'INVALID_PARAMS', message: 'JSON file must contain an examples array.' } };
      }
      return {
        data: {
          name: name || (Array.isArray(parsed) ? '' : String(parsed.name ?? '')) || file.name.replace(/\.json$/i, ''),
          version: version || (Array.isArray(parsed) ? '1.0.0' : String((parsed as Partial<ImportInput>).version ?? '1.0.0')),
          examples: examples as DatasetExample[],
          ...(note ? { note } : {}),
          format: 'json',
        },
      };
    }
    return { error: { code: 'INVALID_PARAMS', message: 'Unsupported file type — use .parquet or .json.' } };
  } catch (err) {
    return { error: { code: 'INVALID_PARAMS', message: err instanceof Error ? err.message : 'File could not be decoded.' } };
  }
}

export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? '';

  let input: ImportInput;
  if (contentType.includes('multipart/form-data')) {
    const mp = await importFromMultipart(req);
    if (mp.error) return fail(mp.error.code, mp.error.message, 400);
    input = mp.data as ImportInput;
    // Re-validate through the same zod surface as the JSON path.
    const parsed = datasetImportSchema.safeParse({
      name: input.name,
      version: input.version,
      examples: input.examples,
      ...(input.note ? { note: input.note } : {}),
    });
    if (!parsed.success) {
      return fail('INVALID_PARAMS', `Import payload rejected after decode — ${zodMessage(parsed.error)}`, 400);
    }
  } else {
    const parsed = await parseBody(req, datasetImportSchema);
    if (parsed.error) return parsed.error;
    input = { ...parsed.data, format: 'json' };
  }

  const valid: DatasetExample[] = input.examples.map((ex) => ({
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
      name: input.name,
      version: input.version,
      format: input.format,
      trainSize,
      valSize,
      testSize,
      examples: JSON.stringify(valid),
      categories: JSON.stringify(categories),
      note: input.note ?? null,
    },
  });

  const dataset: DatasetInfo = {
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
  return ok(dataset, 201);
}
