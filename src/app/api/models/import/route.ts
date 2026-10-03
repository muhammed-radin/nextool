/**
 * POST /api/models/import — multipart upload of a model package
 * (.nextool | .zip | .json). Validates compatibility (TFJS load check for
 * binary packages) and registers the model. Returns the import result with
 * real metadata + warnings.
 */
import { ok, fail } from '@/lib/nexool/api-helpers';
import { importModelPackage } from '@/lib/nexool/training/model-package';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const form = await req.formData().catch(() => null);
    if (!form) return fail('INVALID_PARAMS', 'Expected multipart/form-data with a "file" field', 400);
    const file = form.get('file');
    if (!(file instanceof File)) return fail('INVALID_PARAMS', 'Field "file" (the package) is required', 400);
    if (file.size > MAX_BYTES) return fail('INVALID_PARAMS', `Package exceeds ${MAX_BYTES / 1024 / 1024} MiB limit`, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await importModelPackage(file.name, bytes);
    return ok(result, 201);
  } catch (err) {
    return fail('IMPORT_FAILED', err instanceof Error ? err.message : 'Model import failed', 400);
  }
}
